import { access, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { runChild } from '../benchrun/invoke.js'
import { loadConfig, parseDuration } from '../config/load.js'
import { CONFIG_PATH } from '../config/schema.js'
import { discoverBenchmarks, type Benchmark } from '../discover/benchmarks.js'
import { freezableFiles } from '../discover/files.js'
import { snapshot } from '../freeze/freeze.js'
import { hashString } from '../freeze/manifest.js'
import {
  addWorktree,
  branchExists,
  changedFiles,
  createBranch,
  currentBranch,
  deleteBranch,
  headCommit,
  removeWorktree,
} from '../gitx/git.js'
import { detect } from '../pm/detect.js'
import { ok, run, runShell, tail } from '../runner/exec.js'
import { writeBaseline, type BaselineRecord } from '../state/baseline.js'
import { runDir } from '../state/home.js'
import { BRANCH_PREFIX, CANDIDATE_WORKTREE_DIRNAME, FROZEN_DIRNAME, WORKTREE_DIRNAME } from '../state/runnaming.js'
import type { RunCtx } from './runctx.js'

const CHECKOUT_TIMEOUT_MS = 60_000

/**
 * Duration of the smoke measurement run in the worktree. This is
 * deliberately tiny: the point of this run is to prove each benchmark
 * imports and executes without throwing, not to produce a usable
 * measurement -- that is what `eval` (task 19) actually measures, against
 * the config's own `benchtime`.
 */
const SMOKE_BENCHTIME_MS = 20
const SMOKE_WARMUP_MS = 0

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`)
  return 2
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Checks out `ref` in the main repository (not a worktree). None of the
 * already-built `gitx` helpers do this directly: `createBranch` always
 * creates a new branch, and `repointWorktree` operates on a worktree's own
 * checkout, not the main repo's. This is only ever used to move the main
 * repo's checkout OFF the run branch before that branch is deleted --
 * `git branch -D` refuses to delete the branch currently checked out.
 */
async function checkoutRef(root: string, ref: string): Promise<void> {
  const r = await run('git', ['checkout', '-q', ref], { cwd: root, timeoutMs: CHECKOUT_TIMEOUT_MS })
  if (!ok(r)) {
    throw new Error(`git checkout ${ref} failed in ${root} (exit ${r.exitCode}): ${r.stderr.trim()}`)
  }
}

/** Declared benchmark ids that are not among the discovered benchmarks. */
function missingDeclared(declared: readonly string[], discovered: readonly Benchmark[]): string[] {
  const found = new Set(discovered.map((b) => b.id))
  return declared.filter((id) => !found.has(id))
}

/**
 * `baseline`: freezes the tests and benchmarks, creates the run branch,
 * pins a detached worktree at HEAD, installs into it, and PROVES the
 * declared benchmarks actually run there before declaring success.
 *
 * Every refusal below (bad flags, an unclean tree, a reused tag, a
 * benchmark declared in config that no longer exists) happens before the
 * run branch is created and before anything is written to the state
 * directory. Everything after `createBranch` is a mutation, and any
 * failure there is unwound: the worktree is removed, the run directory is
 * deleted, and -- per Ruling 3 -- so is the branch, so a retry with the
 * same tag never needs `-force`.
 */
export async function cmdBaseline(ctx: RunCtx, argv: readonly string[]): Promise<number> {
  let tag: string
  let force: boolean
  try {
    const normalized = argv.map((a) => (/^-[A-Za-z][A-Za-z-]+$/.test(a) ? `-${a}` : a))
    const { values } = parseArgs({
      args: normalized,
      options: {
        tag: { type: 'string' },
        force: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    })
    if (typeof values.tag !== 'string' || values.tag === '') {
      return fail('-tag <tag> is required, e.g. -tag sep6')
    }
    tag = values.tag
    force = values.force === true
  } catch (e) {
    return fail(messageOf(e))
  }

  try {
    // Validates the tag (it becomes a directory name) before anything else
    // runs -- an invalid tag must be refused before any git or filesystem
    // mutation, not discovered midway through one.
    const dir = runDir(ctx.repoRoot, tag)
    const branchName = `${BRANCH_PREFIX}${tag}`

    const detected = await detect(ctx.repoRoot)
    const config = await loadConfig(ctx.configPath)

    // Deliberately `changedFiles(repoRoot, HEAD)` rather than `isClean`
    // (`git status --porcelain`): `isClean` trusts whatever `.gitignore` is
    // on disk, including one the agent just wrote -- the same blind spot
    // fixed in `pipeline/eval.ts` gate 8, and for the identical reason. A
    // baseline pinned while an agent-hidden, uncommitted file sits on disk
    // is exactly as unreproducible as one pinned with any other uncommitted
    // change; `changedFiles` (Priority 2's ignore-immune enumeration) is
    // what actually proves nothing on disk differs from HEAD.
    const headBeforeBaseline = await headCommit(ctx.repoRoot)
    if ((await changedFiles(ctx.repoRoot, headBeforeBaseline)).length > 0) {
      return fail(
        'the working tree is not clean (uncommitted changes or untracked files). A baseline ' +
          'pinned to what is on disk rather than what is committed could not be reproduced by ' +
          'anyone else, including a retry on this same machine after those files are gone. ' +
          'Commit or stash your changes and try again.',
      )
    }

    if (await exists(dir)) {
      if (!force) {
        return fail(
          `a baseline for tag ${JSON.stringify(tag)} already exists at ${dir}; pass -force to replace it`,
        )
      }
      // With -force, tear down whatever the earlier run left behind before
      // anything new is created: removeWorktree first, or git keeps a
      // stale worktree registration and addWorktree below fails.
      for (const name of [WORKTREE_DIRNAME, CANDIDATE_WORKTREE_DIRNAME]) {
        const wt = path.join(dir, name)
        if (!(await exists(wt))) continue
        try {
          await removeWorktree(ctx.repoRoot, wt)
        } catch {
          // Not a registered worktree (e.g. a previous attempt failed
          // before addWorktree ran) -- the rm below still removes it from
          // disk either way.
        }
      }
      await rm(dir, { recursive: true, force: true })
    }

    const discovered = await discoverBenchmarks(ctx.repoRoot)
    const declared = config.benchmarks
    let benchmarks: Benchmark[]
    if (declared.length > 0) {
      const missing = missingDeclared(declared, discovered)
      if (missing.length > 0) {
        return fail(
          `config declares benchmark(s) that no longer exist: ${missing.join(', ')}. Update ` +
            `${CONFIG_PATH} or restore the missing benchmark(s).`,
        )
      }
      const byId = new Map(discovered.map((b) => [b.id, b]))
      benchmarks = declared.map((id) => byId.get(id)!)
    } else {
      benchmarks = discovered
    }
    if (benchmarks.length === 0) {
      return fail('no benchmarks found: there is nothing for this baseline to measure')
    }

    // Everything above is a pure refusal: nothing has been created or
    // written, in git or on disk, past this point.

    const originalBranch = await currentBranch(ctx.repoRoot)
    const originalCommit = await headCommit(ctx.repoRoot)
    const fallbackRef = originalBranch === 'HEAD' ? originalCommit : originalBranch

    // A branch of this name can already exist here for two different
    // reasons, which need two different responses:
    //
    // - The repo is ALREADY checked out on it: this is a `-force` re-run
    //   of a tag whose previous baseline succeeded (a successful run never
    //   switches away from the branch it creates). There is nothing to
    //   recreate -- proceed with the existing checkout, at whatever commit
    //   it is already on.
    //
    //   That last clause is the whole of `-force`'s semantics, and it is
    //   deliberate: the branch is NOT rewound to the commit the previous
    //   baseline pinned. `head` is read below, after this block, so a
    //   branch the agent has since advanced re-pins `frozenCommit` and
    //   `measureCommit` at its CURRENT tip and re-derives the freeze
    //   manifest from that commit's tree. `-force` means "the state of the
    //   repository right now is the new contract," which is exactly what
    //   you want when re-baselining on top of work you have reviewed and
    //   decided to keep.
    //
    //   It is also why nothing in the harness may reach for `-force` on
    //   its own. Run automatically after an interrupted advance, it would
    //   adopt the agent's own commits as the correctness contract without
    //   a human ever seeing them -- so `eval`'s gate 8 self-heals that
    //   case itself instead of advising `-force` (see
    //   `checkWorktreeIntegrity` in `pipeline/eval.ts`). `-force` is a
    //   human's deliberate act, and stays one.
    // - It exists but is checked out nowhere here (a stale branch left
    //   over some other way): safe to delete outright, with no need to
    //   check out away from it first, and recreate fresh below.
    //
    // `createdBranch` records whether THIS invocation is the one that
    // created the branch -- only then does the unwind below delete it
    // (Ruling 3): a branch this invocation merely reused on `-force` was
    // not this run's to destroy on failure.
    let createdBranch = false
    if (await branchExists(ctx.repoRoot, branchName)) {
      if (originalBranch !== branchName) {
        await deleteBranch(ctx.repoRoot, branchName)
        await createBranch(ctx.repoRoot, branchName)
        createdBranch = true
      }
    } else {
      await createBranch(ctx.repoRoot, branchName)
      createdBranch = true
    }

    const worktreeDir = path.join(dir, WORKTREE_DIRNAME)
    const candidateWorktreeDir = path.join(dir, CANDIDATE_WORKTREE_DIRNAME)
    const frozenDir = path.join(dir, FROZEN_DIRNAME)
    const addedWorktrees: string[] = []

    try {
      const head = await headCommit(ctx.repoRoot)

      // `config.unfreeze` names test/bench files deliberately exempted from
      // the freeze (see `renderConfigYaml`'s own comment on the key, and
      // spec section 6) -- they must never be snapshotted or hashed into the
      // manifest in the first place, or gate 3's restore would overwrite the
      // agent's edits to them on every eval regardless of this config.
      const unfreeze = new Set(config.unfreeze)
      const freezable = (await freezableFiles(ctx.repoRoot)).filter((f) => !unfreeze.has(f))
      const manifest = await snapshot(ctx.repoRoot, freezable, frozenDir)

      await addWorktree(ctx.repoRoot, worktreeDir, head)
      addedWorktrees.push(worktreeDir)

      // The candidate side gets its own worktree, created here rather than
      // per-eval so its dependencies are installed exactly once. That is
      // sound because `package.json` and the lockfile are immutable for the
      // life of a run (IMMUTABLE_FILES), so no commit the agent makes can
      // invalidate this install. It costs a second node_modules on disk;
      // the alternative -- measuring the candidate in the user's live
      // working tree -- is what let a measurement and the commit it was
      // credited to disagree.
      await addWorktree(ctx.repoRoot, candidateWorktreeDir, head)
      addedWorktrees.push(candidateWorktreeDir)

      const timeoutMs = parseDuration(config.timeout)

      for (const wt of [worktreeDir, candidateWorktreeDir]) {
        const install = await runShell(detected.installCommand, { cwd: wt, timeoutMs })
        if (!ok(install)) {
          throw new Error(
            `installing dependencies in ${path.basename(wt)} failed (${detected.installCommand}, exit ` +
              `${install.exitCode}): ${tail(install.stderr || install.stdout, 40)}`,
          )
        }
      }

      // The smoke run: prove every declared benchmark actually runs in the
      // worktree before this baseline is declared successful. Without
      // this, a benchmark that cannot execute would produce a "successful"
      // baseline and fail mysteriously at the user's first `eval`.
      for (const b of benchmarks) {
        const result = await runChild({
          cwd: worktreeDir,
          benchFileAbs: path.join(worktreeDir, b.file),
          fn: b.fn,
          id: b.id,
          benchtimeMs: SMOKE_BENCHTIME_MS,
          warmupMs: SMOKE_WARMUP_MS,
          timeoutMs,
          nodeArgs: config.nodeArgs,
        })
        if (!result.ok) {
          throw new Error(`smoke run of ${b.id} failed: ${result.error}`)
        }
      }

      const configText = await readFile(ctx.configPath, 'utf8')
      const lockfileText = await readFile(path.join(ctx.repoRoot, detected.lockfile), 'utf8')

      const record: BaselineRecord = {
        tag,
        // frozenCommit and measureCommit both start at HEAD, identically --
        // measureCommit is the only one of the two that ever advances
        // (after a KEEP), and frozenCommit must never move once set.
        frozenCommit: head,
        measureCommit: head,
        configHash: hashString(configText),
        lockfileHash: hashString(lockfileText),
        lockfileName: detected.lockfile,
        benchmarks: benchmarks.map((b) => b.id),
        manifest,
        createdAt: new Date().toISOString(),
      }
      await writeBaseline(dir, record)

      process.stdout.write(`baseline ${JSON.stringify(tag)} created at ${head.slice(0, 7)}\n`)
      process.stdout.write(`  branch:   ${branchName}\n`)
      process.stdout.write(`  worktree: ${worktreeDir}\n`)
      process.stdout.write(`  state:    ${dir}\n`)
      process.stdout.write('  benchmarks smoke-tested:\n')
      for (const b of benchmarks) process.stdout.write(`    - ${b.id}\n`)
      return 0
    } catch (e) {
      const reason = messageOf(e)
      // Unwind every worktree this invocation actually registered, in
      // reverse order. Tracked as a list rather than a boolean because
      // there are now two, and a failure between the two `addWorktree`
      // calls must not leave the first one registered with git.
      for (const wt of [...addedWorktrees].reverse()) {
        try {
          await removeWorktree(ctx.repoRoot, wt)
        } catch {
          // Best effort -- the directory removal below still gets rid of
          // it on disk even if git's own bookkeeping is left stale.
        }
      }
      await rm(dir, { recursive: true, force: true })
      try {
        // Only ever delete a branch THIS invocation created (Ruling 3) --
        // one it merely reused under `-force` was not this run's to
        // destroy on failure.
        if (createdBranch) {
          if ((await currentBranch(ctx.repoRoot)) === branchName) {
            await checkoutRef(ctx.repoRoot, fallbackRef)
          }
          await deleteBranch(ctx.repoRoot, branchName)
        }
      } catch (unwindErr) {
        return fail(
          `${reason}\n(cleanup also failed to delete branch ${branchName}: ` +
            `${messageOf(unwindErr)}; remove it manually with "git branch -D ${branchName}" before retrying)`,
        )
      }
      return fail(reason)
    }
  } catch (e) {
    return fail(messageOf(e))
  }
}

import { parseArgs } from 'node:util'
import { currentBranch, headCommit, shortSha } from '../gitx/git.js'
import { killGroup } from '../runner/exec.js'
import { readBaseline } from '../state/baseline.js'
import { runDir } from '../state/home.js'
import { readEvalLock } from '../state/lock.js'
import { clearStop, requestStop } from '../state/stop.js'
import type { RunCtx } from './runctx.js'

/**
 * Duplicated from cmd-baseline.ts rather than imported -- see the identical
 * note in cmd-eval.ts. Must match the prefix baseline uses when it creates
 * the run branch, or `-tag` inference from the current branch silently
 * stops working.
 */
const BRANCH_PREFIX = 'autoresearch-typescript/'

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`)
  return 2
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * `-tag`'s default: the tag encoded in the current run branch's name.
 * Duplicated from cmd-eval.ts -- see its doc comment for why.
 */
async function inferTagFromBranch(repoRoot: string): Promise<string> {
  let branch: string
  try {
    branch = await currentBranch(repoRoot)
  } catch (e) {
    throw new Error(`-tag was not given, and the current branch could not be determined: ${messageOf(e)}`)
  }
  if (!branch.startsWith(BRANCH_PREFIX)) {
    throw new Error(
      `-tag was not given, and the current branch (${JSON.stringify(branch)}) is not a run branch ` +
        `(expected "${BRANCH_PREFIX}<tag>"). Pass -tag <tag> explicitly.`,
    )
  }
  const tag = branch.slice(BRANCH_PREFIX.length)
  if (tag === '') {
    throw new Error(`-tag was not given, and the current branch (${JSON.stringify(branch)}) names no tag`)
  }
  return tag
}

async function tryGit<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f()
  } catch {
    return null
  }
}

/**
 * Mirrors lock.ts's private `isAlive` (not exported): EPERM means the
 * process exists but we lack permission to signal it, which is still
 * "alive." Used here only to word the report honestly -- a lock recording a
 * pid that already died (the eval crashed, or a previous `-force` already
 * killed it) must not be reported as "signalled" just because the file is
 * still there; `readEvalLock` itself never checks this (see its own doc
 * comment), so a caller that needs to know still has to.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * `stop`: asks a running (or about-to-run) `eval` loop to end.
 *
 * Plain `stop` only ever writes `stop.json` -- the agent reads it at its
 * next verdict, so the in-flight experiment always finishes and is scored.
 * `-clear` cancels a pending request. `-force` additionally signals the pid
 * recorded in `eval.lock` (if any) to abandon the current experiment right
 * now -- using `runner/exec.ts`'s own exported `killGroup`, so the pid-1
 * refusal lives in exactly one place -- and then reports the repository
 * state that leaves -- including the exact command that would drop the
 * abandoned commit -- WITHOUT running it. Dropping an agent's work is the
 * human's decision, never this tool's.
 */
export async function cmdStop(ctx: RunCtx, argv: readonly string[]): Promise<number> {
  let tag: string | undefined
  let clear: boolean
  let force: boolean
  try {
    const normalized = argv.map((a) => (/^-[A-Za-z][A-Za-z-]+$/.test(a) ? `-${a}` : a))
    const { values } = parseArgs({
      args: normalized,
      options: {
        tag: { type: 'string' },
        clear: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    })
    tag = values.tag
    clear = values.clear === true
    force = values.force === true
  } catch (e) {
    return fail(messageOf(e))
  }

  if (clear && force) {
    return fail('-clear and -force are mutually exclusive')
  }

  let resolvedTag: string
  try {
    resolvedTag = tag ?? (await inferTagFromBranch(ctx.repoRoot))
  } catch (e) {
    return fail(messageOf(e))
  }

  const dir = runDir(ctx.repoRoot, resolvedTag)

  try {
    // Confirms a run actually exists before writing (or clearing) any state
    // for it. A human who mistypes a tag must be told the tag is unknown,
    // not silently handed a stop request that nothing will ever read.
    // readBaseline never creates anything -- only reads -- so a nonexistent
    // run is refused here before any state is touched.
    await readBaseline(dir)
  } catch (e) {
    return fail(messageOf(e))
  }

  if (clear) {
    await clearStop(dir)
    process.stdout.write(`stop request for tag ${JSON.stringify(resolvedTag)} cleared\n`)
    return 0
  }

  await requestStop(dir, force)

  if (!force) {
    process.stdout.write(
      `stop requested for tag ${JSON.stringify(resolvedTag)}: the agent will stop after its current ` +
        'experiment reports a verdict.\n',
    )
    return 0
  }

  process.stdout.write(`stop -force requested for tag ${JSON.stringify(resolvedTag)}.\n`)

  const lock = await readEvalLock(dir)
  const signalled = lock !== null && isPidAlive(lock.pid)
  if (lock === null) {
    process.stdout.write('  no eval lock is currently held: nothing to signal.\n')
  } else if (!signalled) {
    process.stdout.write(
      `  eval.lock names pid ${lock.pid}, but it is no longer running (a previous eval likely ` +
        'crashed, or was already stopped): nothing to signal.\n',
    )
  } else {
    killGroup(lock.pid, 'SIGTERM')
    process.stdout.write(`  signalled pid ${lock.pid} (SIGTERM) to abandon its current experiment.\n`)
  }

  const branch = await tryGit(() => currentBranch(ctx.repoRoot))
  const head = await tryGit(() => headCommit(ctx.repoRoot))

  process.stdout.write(`  current branch: ${branch ?? 'unknown'}\n`)
  process.stdout.write(`  HEAD commit:    ${head === null ? 'unknown' : `${shortSha(head)} (${head})`}\n`)
  // Only claim a commit was actually abandoned when something was really
  // signalled -- with no eval lock held, HEAD is just whatever the last
  // completed experiment left behind, not something this invocation
  // interrupted. Either way, nothing has been changed here; dropping a
  // commit is the human's call, never this tool's, so the reset command is
  // only ever printed, never run.
  process.stdout.write(
    signalled
      ? '  this is very likely the commit for the experiment just abandoned. Nothing here has been\n' +
          '  changed -- dropping it is your call, not this tool\'s. To drop it:\n'
      : '  no eval was running, so nothing was abandoned. If HEAD above is still an unwanted\n' +
          '  experiment, nothing here has been changed -- dropping it is your call. To drop it:\n',
  )
  process.stdout.write('\n    git reset --hard HEAD~1\n')

  return 0
}

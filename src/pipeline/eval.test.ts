import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cmdBaseline } from '../cli/cmd-baseline.js'
import { cmdInit } from '../cli/cmd-init.js'
import type { RunCtx } from '../cli/runctx.js'
import { CONFIG_PATH } from '../config/schema.js'
import { RESULTS_PATH, loadRows } from '../results/results.js'
import { headCommit } from '../gitx/git.js'
import { ok, run } from '../runner/exec.js'
import { readBaseline } from '../state/baseline.js'
import { runDir, STATE_HOME_ENV } from '../state/home.js'
import { requestStop } from '../state/stop.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { runEval } from './eval.js'

function ctxFor(root: string): RunCtx {
  return {
    repoRoot: root,
    configPath: path.join(root, CONFIG_PATH),
    resultsPath: path.join(root, RESULTS_PATH),
    logPath: path.join(root, 'run.log'),
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await run('git', args, { cwd, timeoutMs: 60_000 })
  if (!ok(r)) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

/**
 * Substitutes the value of one or more top-level `key: value` lines in
 * `.autor3search/config.yaml`. `value` must already be YAML-ready (a quoted
 * string via `JSON.stringify`, a bare number, or an array literal) -- this
 * mirrors exactly what `cmd-init`'s own renderer writes, so the edited file
 * stays a config `loadConfig` accepts.
 */
async function patchConfig(ctx: RunCtx, patches: Record<string, string>): Promise<void> {
  let text = await readFile(ctx.configPath, 'utf8')
  for (const [key, value] of Object.entries(patches)) {
    const re = new RegExp(`^${key}:.*$`, 'm')
    if (!re.test(text)) throw new Error(`patchConfig: key not found in config: ${key}`)
    text = text.replace(re, `${key}: ${value}`)
  }
  await writeFile(ctx.configPath, text, 'utf8')
}

/** Runs `init` (optionally patching the generated config first) and commits everything committable. */
async function initWithConfig(root: string, ctx: RunCtx, patches: Record<string, string> = {}): Promise<void> {
  expect(await cmdInit(ctx, [])).toBe(0)
  if (Object.keys(patches).length > 0) await patchConfig(ctx, patches)
  await git(root, ['add', '.autor3search/config.yaml', 'program.md', '.gitignore'])
  await git(root, ['commit', '-q', '-m', 'init: config + program.md'])
}

async function addAndCommit(root: string, rel: string, body: string, message: string): Promise<void> {
  await writeFile(path.join(root, rel), body, 'utf8')
  await git(root, ['add', rel])
  await git(root, ['commit', '-q', '-m', message])
}

/**
 * Advances HEAD past `baseline.measureCommit` with a trivial, in-scope,
 * non-frozen edit and leaves the tree clean -- gate 8's clean-tree and
 * commit-has-moved checks (see `pipeline/eval.ts`) reject any `runEval` call
 * that has not done this, so every test below that exercises a LATER gate
 * (or a successful run) needs a real commit to get there.
 */
async function trivialCommit(root: string): Promise<void> {
  const file = path.join(root, 'src', 'wordcount.ts')
  const text = await readFile(file, 'utf8')
  await writeFile(file, `${text}\n// trivial, in-scope, non-functional edit\n`, 'utf8')
  await git(root, ['add', 'src/wordcount.ts'])
  await git(root, ['commit', '-q', '-m', 'chore: trivial commit to advance HEAD past measureCommit'])
}

const TAG = 'sep6'

/** Fresh demo repo, initialized (with config patches applied before commit) and baselined. */
async function setup(patches: Record<string, string> = {}): Promise<{ root: string; ctx: RunCtx }> {
  const root = await makeDemoRepo()
  const ctx = ctxFor(root)
  await initWithConfig(root, ctx, patches)
  expect(await cmdBaseline(ctx, ['-tag', TAG])).toBe(0)
  return { root, ctx }
}

/** Deterministic, near-instant stand-in for a real benchmark measurement. */
const constMeasureOne = async (): Promise<number> => 1

/**
 * Rounds/benchtime/warmup small enough that a real `runChild` spawn stays
 * fast. `count: 10` (not the minimum 4) deliberately: at 4 the exact
 * two-sided p-value floor is 2/C(8,4) = 2/70 ~= 0.0286, only ~1.75x below
 * ALPHA (0.05) -- thin enough that a loaded CI box's timing noise could
 * occasionally flip a real, large effect below significance. At 10 the
 * floor is 2/C(20,10) ~= 1.08e-5, a ~4600x margin (this is also exactly
 * what the real end-to-end CLI run in task-19-report.md measured).
 */
const FAST_MEASURE_PATCHES: Record<string, string> = {
  count: '10',
  benchtime: JSON.stringify('5ms'),
  warmup: JSON.stringify('0ms'),
}

/**
 * The real fix for the demo fixture's quadratic bug: `chars.concat([c])`
 * allocates and copies a whole new array on every character, costing O(n^2)
 * to build one word. `chars.push(c)` is the linear-time equivalent -- NOT a
 * string-concatenation change (`+=` on a JS string is not quadratic; V8
 * already ropes concatenated strings, so that edit would prove nothing) and
 * NOT a change to `.join('')`, which already exists and is not the bug.
 */
async function applyRealFix(root: string): Promise<void> {
  const file = path.join(root, 'src', 'wordcount.ts')
  const text = await readFile(file, 'utf8')
  const fixed = text.replace('chars = chars.concat([c])', 'chars.push(c)')
  expect(fixed).not.toBe(text) // sanity: the replacement actually matched something
  await writeFile(file, fixed, 'utf8')
  await git(root, ['add', 'src/wordcount.ts'])
  await git(root, ['commit', '-q', '-m', 'fix: push instead of concat in the hot loop'])
}

let stateHomeDir: string
let originalStateHomeEnv: string | undefined
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  originalStateHomeEnv = process.env[STATE_HOME_ENV]
  stateHomeDir = await mkdtemp(path.join(tmpdir(), 'ars-eval-state-'))
  process.env[STATE_HOME_ENV] = stateHomeDir
  // cmdInit/cmdBaseline (used only for setup here) write real progress to
  // stdout/stderr; silenced so this suite's own output stays readable.
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  if (originalStateHomeEnv === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHomeEnv
  await rm(stateHomeDir, { recursive: true, force: true })
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
})

describe('runEval: gate order', () => {
  // Positive control for every "gate rejects before measuring, so the spy
  // is never called" test below: without this, an inverted implementation
  // that measures FIRST and gates afterward (or one that never calls
  // measureOne at all, gate or no gate) would leave every one of those
  // negative assertions vacuously true. This proves measureOne genuinely
  // gets invoked on the one path where nothing should stop it.
  it('positive control: measureOne IS called when no gate rejects', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    await trivialCommit(root)
    const spy = vi.fn(constMeasureOne)

    await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(spy).toHaveBeenCalled()
  })

  it('gate 1: rejects an edit to package.json even under a permissive scope', async () => {
    const { root, ctx } = await setup({ scope: '["**"]' })
    const pkgPath = path.join(root, 'package.json')
    const text = await readFile(pkgPath, 'utf8')
    await writeFile(pkgPath, text.replace('"private": true', '"private": true, "x": 1'), 'utf8')
    await git(root, ['add', 'package.json'])
    await git(root, ['commit', '-q', '-m', 'tamper with package.json'])
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('scope')
    expect(outcome.message).toMatch(/package\.json/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('gate 1: rejects an edit outside scope', async () => {
    const { root, ctx } = await setup()
    await addAndCommit(root, 'notes.txt', 'agent notes\n', 'add a file outside scope')
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('scope')
    expect(outcome.message).toMatch(/notes\.txt/)
    expect(spy).not.toHaveBeenCalled()
  })

  // The scope-gate escape from the final whole-branch review (Priority 2),
  // and its own fix (`gitx/git.ts`'s `changedFiles` doc comment): an
  // agent-created, untracked `.gitignore` is reported as a change IN ITS
  // OWN RIGHT, refusing before whatever it hides is ever trusted --
  // `--exclude-standard`'s output is never relied on while the rules it
  // depends on are unverified, so this refuses on the `.gitignore` itself,
  // not on `evil.ts`. Left uncommitted AND unstaged -- exactly the shape of
  // the exploit -- to prove the gate does not depend on `git add` either.
  it('gate 1: still rejects a tree with an agent-created .gitignore, before whatever it hides is trusted', async () => {
    const { root, ctx } = await setup()
    await mkdir(path.join(root, 'lib'), { recursive: true })
    await writeFile(path.join(root, 'lib', '.gitignore'), '*\n', 'utf8')
    await writeFile(path.join(root, 'lib', 'evil.ts'), 'export const evil = 1\n', 'utf8')
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('scope')
    expect(outcome.message).toMatch(/lib\/\.gitignore/)
    expect(spy).not.toHaveBeenCalled()
  })

  // A normal, committed .gitignore covering the user's own ordinary
  // untracked files (a build log, an editor artifact, ...) must not trip
  // the scope gate. This is the counterpart to the test above -- proof the
  // fix distinguishes "an ordinary ignore rule" from "an unverified one,"
  // rather than distrusting `.gitignore` altogether.
  it('gate 1: does NOT reject an ordinary, committed, unmodified .gitignore covering the user\'s own files', async () => {
    // The extra ignore rule must already be part of `frozenCommit` -- gate 1
    // diffs against it forever, so adding the rule AFTER baseline would
    // itself be an (entirely legitimate, but irrelevant to this test)
    // out-of-scope change to .gitignore. Built manually rather than via
    // `setup()`, which commits before this test gets a chance to extend
    // the generated .gitignore first.
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    expect(await cmdInit(ctx, [])).toBe(0)
    await writeFile(
      path.join(root, '.gitignore'),
      `${await readFile(path.join(root, '.gitignore'), 'utf8')}\n*.local.log\n`,
      'utf8',
    )
    await git(root, ['add', '.autor3search/config.yaml', 'program.md', '.gitignore'])
    await git(root, ['commit', '-q', '-m', 'init, with an ordinary extra gitignore rule'])
    expect(await cmdBaseline(ctx, ['-tag', TAG])).toBe(0)

    // No commit made since baseline -- irrelevant here: whatever gate
    // eventually rejects this (if any), it must not be "scope."
    await writeFile(path.join(root, 'debug.local.log'), 'noise\n', 'utf8')
    const spy = vi.fn(constMeasureOne)

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.failedGate).not.toBe('scope')
  })

  it('gate 2: fails when .autor3search/config.yaml changed since baseline', async () => {
    const { ctx } = await setup()
    // .autor3search/ is gitignored -- this is deliberately an uncommitted,
    // untracked edit, which the scope gate (git-based) cannot even see. Only
    // a direct config-hash comparison catches it.
    await patchConfig(ctx, { max_regress_pct: '99' })
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('config-integrity')
    expect(spy).not.toHaveBeenCalled()
  })

  // A distinct scenario from the "gate 2" test above (unmanifested rather
  // than config tampering), proving the "nothing gets measured" property
  // holds generally across early gates, not just for the one case above.
  it('does not measure anything when an early gate rejects', async () => {
    const { root, ctx } = await setup()
    await addAndCommit(
      root,
      'src/easy.bench.ts',
      'export function benchEasy(): number {\n  return 1\n}\n',
      'add an easier benchmark',
    )
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('unmanifested')
    expect(spy).not.toHaveBeenCalled()
  })

  it('gate 3: restores a weakened test file before running it, and the real assertions then run', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    // The edit is IN SCOPE (src/**) and not immutable -- gate 1 has no
    // objection. It is only frozen content, restored by gate 3.
    await addAndCommit(
      root,
      'src/wordcount.test.ts',
      "import { describe, it } from 'node:test'\ndescribe('countWords', () => { it('does nothing', () => {}) })\n",
      'weaken the test',
    )
    // A deliberately wrong "real" assertion baked into the frozen file would
    // be firmer proof, but the shipped fixture's assertions are already
    // real and correct against the untouched wordcount.ts -- so restoring
    // them and having them PASS is exactly the signal this gate exists to
    // produce.

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: constMeasureOne })

    expect(outcome.restoredFiles).toContain('src/wordcount.test.ts')
    expect(outcome.failedGate).not.toBe('test')
    expect(outcome.verdict.status).not.toBe('fail')
    expect(outcome.verdict.status).not.toBe('crash')
  })

  // The test above cannot tell restore-before-test from restore-after-test
  // apart: the weakened body passes (it asserts nothing) and the restored
  // real body ALSO passes (wordcount.ts itself is untouched), so
  // `failedGate !== 'test'` holds either way. This test discriminates the
  // two: it also breaks the SOURCE (not frozen, so the edit survives) in a
  // way the real, restored assertions catch but the weakened, no-op body
  // would not. If restore ran AFTER gate 7 (or not at all), the weakened
  // body would pass trivially against the broken source and gate 7 would
  // never fail; if restore runs BEFORE gate 7 (the actual, correct order),
  // the real assertions run against the broken source and gate 7 fails.
  it('gate 3 runs BEFORE gate 7: the restored real test then fails against a broken source', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    const wcFile = path.join(root, 'src', 'wordcount.ts')
    const wcText = await readFile(wcFile, 'utf8')
    const broken = wcText.replace('return counts', 'return new Map()') // always returns empty
    expect(broken).not.toBe(wcText)
    await writeFile(wcFile, broken, 'utf8')
    await writeFile(
      path.join(root, 'src', 'wordcount.test.ts'),
      "import { describe, it } from 'node:test'\ndescribe('countWords', () => { it('does nothing', () => {}) })\n",
      'utf8',
    )
    await git(root, ['add', 'src/wordcount.ts', 'src/wordcount.test.ts'])
    await git(root, ['commit', '-q', '-m', 'break source and weaken the test together'])
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.restoredFiles).toContain('src/wordcount.test.ts')
    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('test')
    expect(spy).not.toHaveBeenCalled()
  })

  it('gate 4: rejects a NEW bench file absent from the frozen manifest', async () => {
    const { root, ctx } = await setup()
    await addAndCommit(
      root,
      'src/easy.bench.ts',
      'export function benchEasy(): number {\n  return 1\n}\n',
      'add an easier benchmark',
    )
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('unmanifested')
    expect(outcome.message).toMatch(/src\/easy\.bench\.ts/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('gate 5: FAILs when the typecheck command exits non-zero (a controlled command, not the real toolchain)', async () => {
    const { ctx } = await setup({ typecheck_command: JSON.stringify('node -e "process.exit(1)"') })
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('typecheck')
    expect(spy).not.toHaveBeenCalled()
  })

  it('gate 5: an empty typecheck command SKIPS the gate rather than failing it', async () => {
    // The demo fixture ships with no tsconfig.json, so cmd-init generates an
    // empty typecheck_command -- exactly the case this gate must not treat
    // as a failure.
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    await trivialCommit(root)

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: constMeasureOne })

    expect(outcome.failedGate).not.toBe('typecheck')
    expect(outcome.verdict.status).not.toBe('fail')
  })

  it('gate 6: FAILs when the build command exits non-zero (a controlled command)', async () => {
    const { ctx } = await setup({ build_command: JSON.stringify('node -e "process.exit(1)"') })
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('build')
    expect(spy).not.toHaveBeenCalled()
  })

  it('gate 6: an empty build command SKIPS the gate rather than failing it', async () => {
    // The demo fixture's package.json has no "build" script, so cmd-init
    // generates an empty build_command.
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    await trivialCommit(root)

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: constMeasureOne })

    expect(outcome.failedGate).not.toBe('build')
    expect(outcome.verdict.status).not.toBe('fail')
  })

  it('gate 7: FAILs when the repo test command fails (a controlled command)', async () => {
    const { ctx } = await setup({ test_command: JSON.stringify('node -e "process.exit(1)"') })
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('test')
    expect(spy).not.toHaveBeenCalled()
  })

  it('gate 8: FAILs when the worktree lockfile hash no longer matches', async () => {
    const { root, ctx } = await setup()
    await trivialCommit(root)
    const dir = runDir(root, TAG)
    const worktreeLockfile = path.join(dir, 'baseline-worktree', 'package-lock.json')
    await writeFile(worktreeLockfile, '{"tampered": true}\n', 'utf8')
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('worktree-integrity')
    expect(spy).not.toHaveBeenCalled()
  })

  // The Critical fix from the final whole-branch review: `eval` measures
  // `opts.ctx.repoRoot` -- the live working tree -- while crediting whatever
  // `headCommit` reports. Left unchecked, an agent can apply a real
  // optimization, never commit it, and have that same uncommitted edit
  // measured and KEPT indefinitely, since neither the working tree's
  // cleanliness nor HEAD's position is required to change between runs. See
  // the mutation evidence in final-fix-report.md: with this check removed,
  // this exact scenario reports KEEP.
  it('gate 8: FAILs on an uncommitted, in-scope edit -- an agent must commit before eval can measure it', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    // HEAD is advanced past baseline.measureCommit FIRST (a real, harmless
    // commit), so the "HEAD has not moved" check (below) cannot be what
    // rejects this experiment -- only the clean-tree check can. Without this
    // first commit, an uncommitted edit made straight after baseline is
    // indistinguishable from "HEAD never moved," and would not isolate which
    // of the two checks is doing the rejecting.
    await trivialCommit(root)
    // A real improvement, deliberately left UNCOMMITTED on top of that.
    const file = path.join(root, 'src', 'wordcount.ts')
    const text = await readFile(file, 'utf8')
    const fixed = text.replace('chars = chars.concat([c])', 'chars.push(c)')
    expect(fixed).not.toBe(text)
    await writeFile(file, fixed, 'utf8')
    // A one-sided stand-in (candidate always faster) rather than an empty
    // `vi.fn()` or a constant one: if this check is ever removed, the
    // pipeline must run a genuine measurement through to a real KEEP, not
    // merely avoid crashing -- see the mutation evidence in
    // final-fix-report.md.
    const worktreeDir = path.join(runDir(root, TAG), 'baseline-worktree')
    const sidedMeasureOne = vi.fn(async (dir: string): Promise<number> => (dir === worktreeDir ? 1000 : 10))

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: sidedMeasureOne })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('worktree-integrity')
    expect(outcome.message).toMatch(/not clean/)
    expect(outcome.message).toMatch(/commit your change/i)
    expect(sidedMeasureOne).not.toHaveBeenCalled()
    // No row beyond the fail itself: this is the only experiment recorded.
    const rows = await loadRows(ctx.resultsPath)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('fail')
  })

  // The scoped re-review's finding: Priority 2 made `changedFiles` (and so
  // the SCOPE gate) immune to an agent-created `.gitignore`, but gate 8's
  // clean-tree check originally used `isClean` (`git status --porcelain`),
  // which still trusts whatever `.gitignore` is on disk. A file hidden
  // behind `printf '*\n' > src/lib/.gitignore` -- uncommitted, and INSIDE
  // `scope` (so the scope gate has nothing to object to) -- made `isClean`
  // report a clean tree while the working tree still differed from HEAD:
  // the C1 attack surviving in a narrower, still-live form. Gate 8 now
  // reuses `changedFiles` (immune by construction) instead of `isClean`.
  it('gate 8: FAILs on an uncommitted file hidden behind an agent-created .gitignore, even though it is in scope', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    // HEAD advances past baseline.measureCommit first, exactly as in the
    // test above, so only the clean-tree check (not "HEAD has not moved")
    // can be what rejects this experiment.
    await trivialCommit(root)

    await mkdir(path.join(root, 'src', 'lib'), { recursive: true })
    await writeFile(path.join(root, 'src', 'lib', '.gitignore'), '*\n', 'utf8')
    await writeFile(path.join(root, 'src', 'lib', 'evil.ts'), 'export const evil = 1\n', 'utf8')

    // A one-sided stand-in (candidate always faster), not an empty `vi.fn()`:
    // with the check reverted to `isClean`, this reaches a real, full KEEP
    // (verified by hand -- see the mutation evidence in final-fix-report.md)
    // rather than merely avoiding a crash.
    const worktreeDir2 = path.join(runDir(root, TAG), 'baseline-worktree')
    const spy = vi.fn(async (dir: string): Promise<number> => (dir === worktreeDir2 ? 1000 : 10))

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('worktree-integrity')
    expect(outcome.message).toMatch(/not clean/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('gate 8: FAILs when HEAD has not moved past the already-recorded measureCommit', async () => {
    const { ctx } = await setup(FAST_MEASURE_PATCHES)
    // No commit made since baseline: candidateCommit === baseline.measureCommit.
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('worktree-integrity')
    expect(outcome.message).toMatch(/nothing new to evaluate/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('gate 8: the normal committed path still KEEPs a real, committed optimization', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    await applyRealFix(root)

    const outcome = await runEval({ ctx, tag: TAG, description: 'push instead of concat' })

    expect(outcome.verdict.status).toBe('keep')
  })

  // A wrong implementation that maps a measurement-child failure to
  // noVerdict('fail') instead of noVerdict('crash') would pass every other
  // test in this file -- this is the only one that actually drives a
  // measurement failure and checks which status it produces.
  it('gate 9: any ok:false from a measurement child is CRASH, not FAIL', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    await trivialCommit(root)

    const outcome = await runEval({
      ctx,
      tag: TAG,
      description: '',
      measureOne: async () => {
        throw new Error('boom: forced measurement failure')
      },
    })

    expect(outcome.verdict.status).toBe('crash')
    expect(outcome.failedGate).toBe('measure')
    const rows = await loadRows(ctx.resultsPath)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('crash')
  })
})

describe('runEval: harness failures are CRASH, not FAIL', () => {
  // "No baseline exists for this tag" is not a verdict about a change --
  // there is no change to have a verdict about. Reporting FAIL here would
  // tell an unattended agent "try another change," which is actively false
  // and would loop it forever discarding otherwise-good work.
  it('reports CRASH, not FAIL, when no baseline exists for the tag', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    await initWithConfig(root, ctx, FAST_MEASURE_PATCHES)
    // Deliberately no cmdBaseline call.

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: vi.fn() })

    expect(outcome.verdict.status).toBe('crash')
    expect(outcome.failedGate).toBe('setup')
  })

  // The frozen snapshot going missing is a harness/environment problem
  // (corrupted run state), not something the agent's own change did.
  it('reports CRASH, not FAIL, when the frozen snapshot is missing a file restore needs', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    const dir = runDir(root, TAG)
    await rm(path.join(dir, 'frozen', 'src', 'wordcount.test.ts'))

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: vi.fn() })

    expect(outcome.verdict.status).toBe('crash')
    expect(outcome.failedGate).toBe('restore')
  })
})

describe('runEval: locking', () => {
  it('releases the eval lock even when something inside the chain throws unexpectedly', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    const badCtx: RunCtx = { ...ctx, resultsPath: path.join(root, 'does-not-exist', 'results.tsv') }

    await expect(
      runEval({ ctx: badCtx, tag: TAG, description: '', measureOne: constMeasureOne }),
    ).rejects.toThrow()

    // If the lock were not released in a `finally`, this second, otherwise
    // ordinary eval would reject with "eval lock is already held."
    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: constMeasureOne })
    expect(outcome.verdict.status).toBeDefined()
  })
})

describe('runEval: stop', () => {
  it('reports stop_requested in the verdict when a stop is pending', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    await requestStop(runDir(root, TAG), false)

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: constMeasureOne })

    expect(outcome.stopRequested).toBe(true)
    // A pending, non-forced stop must not change how this experiment is judged.
    expect(outcome.verdict.status).not.toBe('crash')
  })

  it('does not report a pending stop when none was requested', async () => {
    const { ctx } = await setup(FAST_MEASURE_PATCHES)

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: constMeasureOne })

    expect(outcome.stopRequested).toBe(false)
  })
})

describe('runEval: unfreeze exemption', () => {
  // Priority 3 from the final whole-branch review: `baseline` used to
  // snapshot `freezableFiles` with no reference to `config.unfreeze` at
  // all, so a file the config declares exempt was still hashed into the
  // manifest and still silently reverted by gate 3 on every eval --
  // directly contradicting both `init`'s own generated comment on the key
  // and spec section 6.
  it('a file listed in unfreeze is absent from the manifest and survives an eval unmodified', async () => {
    const { root, ctx } = await setup({
      ...FAST_MEASURE_PATCHES,
      unfreeze: JSON.stringify(['src/wordcount.test.ts']),
    })
    const dir = runDir(root, TAG)
    const baseline = await readBaseline(dir)
    expect(Object.keys(baseline.manifest.files)).not.toContain('src/wordcount.test.ts')

    const weakened =
      "import { describe, it } from 'node:test'\ndescribe('countWords', () => { it('does nothing', () => {}) })\n"
    await addAndCommit(root, 'src/wordcount.test.ts', weakened, 'edit the unfrozen test file')

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: constMeasureOne })

    expect(outcome.restoredFiles).not.toContain('src/wordcount.test.ts')
    expect(outcome.failedGate).not.toBe('unmanifested')
    expect(outcome.failedGate).not.toBe('restore')
    const onDisk = await readFile(path.join(root, 'src', 'wordcount.test.ts'), 'utf8')
    expect(onDisk).toBe(weakened)
  })
})

describe('runEval: results.tsv', () => {
  it('appends exactly one results.tsv row per experiment', async () => {
    const { ctx } = await setup(FAST_MEASURE_PATCHES)

    await runEval({ ctx, tag: TAG, description: 'first', measureOne: constMeasureOne })
    const afterFirst = await loadRows(ctx.resultsPath)
    expect(afterFirst).toHaveLength(1)

    await runEval({ ctx, tag: TAG, description: 'second', measureOne: constMeasureOne })
    const afterSecond = await loadRows(ctx.resultsPath)
    expect(afterSecond).toHaveLength(2)
  })

  it('appends a row even when a gate rejects the experiment', async () => {
    const { root, ctx } = await setup()
    await addAndCommit(root, 'notes.txt', 'x', 'out of scope')

    await runEval({ ctx, tag: TAG, description: '', measureOne: vi.fn() })

    const rows = await loadRows(ctx.resultsPath)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('fail')
  })
})

describe('runEval: end to end against the real demo fixture', () => {
  it('KEEPs a genuine optimization of the demo and advances the measurement commit', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    const dir = runDir(root, TAG)
    const before = await readBaseline(dir)
    await applyRealFix(root)
    const newHead = await headCommit(root)

    const outcome = await runEval({ ctx, tag: TAG, description: 'push instead of concat' })

    expect(outcome.verdict.status).toBe('keep')
    expect(outcome.measureCommit).toBe(newHead)
    expect(before.measureCommit).not.toBe(newHead)
    const after = await readBaseline(dir)
    expect(after.measureCommit).toBe(newHead)
  })

  it('leaves frozenCommit UNCHANGED after a KEEP', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    const dir = runDir(root, TAG)
    const before = await readBaseline(dir)
    await applyRealFix(root)

    const outcome = await runEval({ ctx, tag: TAG, description: 'push instead of concat' })

    expect(outcome.verdict.status).toBe('keep')
    expect(outcome.frozenCommit).toBe(before.frozenCommit)
    const after = await readBaseline(dir)
    expect(after.frozenCommit).toBe(before.frozenCommit)
    expect(after.manifest).toEqual(before.manifest)
  })

  // This is the regression the harness exists to prevent: with a
  // measurement baseline that never advances, one real improvement makes
  // every later change -- including one that changes nothing at all --
  // coast to KEEP on the strength of that earlier win. See the mutation
  // evidence recorded in task-19-report.md: with `measureCommit`'s advance
  // (and `repointWorktree`) removed from the KEEP path, this exact test
  // fails, because the no-op is then compared against the original, slow
  // baseline instead of the just-kept fast one.
  it('DISCARDs a comment-only no-op commit', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    await applyRealFix(root)

    const keepOutcome = await runEval({ ctx, tag: TAG, description: 'push instead of concat' })
    expect(keepOutcome.verdict.status).toBe('keep') // precondition for the real test below

    const file = path.join(root, 'src', 'wordcount.ts')
    const text = await readFile(file, 'utf8')
    await writeFile(file, `${text}\n// no functional change, comment only\n`, 'utf8')
    await git(root, ['add', 'src/wordcount.ts'])
    await git(root, ['commit', '-q', '-m', 'chore: add a comment'])

    const noopOutcome = await runEval({ ctx, tag: TAG, description: 'comment only, no-op' })

    expect(noopOutcome.verdict.status).toBe('discard')
    expect(noopOutcome.verdict.reason).toBe('no_significant_improvement')
  })

  // The attack this closes: gate 3 restores the FROZEN FILES ON DISK for
  // this experiment's own measurement, but never touches the candidate
  // COMMIT itself. A commit that both fixes real source AND slows the
  // benchmark body earns a legitimate KEEP (measured against the
  // gate-3-restored, real benchmark) -- but `repointWorktree` alone would
  // then check that same commit's tampered bench body into the BASE
  // worktree, permanently inflating every future baseline measurement.
  // Gate 4 does not catch this: the file is already in the manifest, only
  // its content differs commit-to-commit. This is "add an easier
  // benchmark," routed around the one gate built to stop it.
  it('a bench file tampered in the same commit as a real fix does NOT survive into the base worktree after KEEP', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    const dir = runDir(root, TAG)
    const benchFile = path.join(root, 'src', 'wordcount.bench.ts')
    const originalBenchText = await readFile(benchFile, 'utf8')

    const wcFile = path.join(root, 'src', 'wordcount.ts')
    const wcText = await readFile(wcFile, 'utf8')
    const fixed = wcText.replace('chars = chars.concat([c])', 'chars.push(c)')
    expect(fixed).not.toBe(wcText)
    await writeFile(wcFile, fixed, 'utf8')
    // Tamper the benchmark body in the SAME commit: gate 3 restores this on
    // disk before THIS experiment measures, so the real speedup is what
    // gets scored -- the attack is what happens to the committed content
    // afterward, not to this experiment's own verdict.
    const tamperedBench = originalBenchText.replace(
      'export function benchCountWords(): Map<string, number> {',
      'export function benchCountWords(): Map<string, number> {\n  for (let i = 0; i < 5_000_000; i++) { /* slow the benchmark body down */ }',
    )
    expect(tamperedBench).not.toBe(originalBenchText)
    await writeFile(benchFile, tamperedBench, 'utf8')
    await git(root, ['add', 'src/wordcount.ts', 'src/wordcount.bench.ts'])
    await git(root, ['commit', '-q', '-m', 'fix wordcount AND slow the benchmark body'])

    // A deterministic stand-in that reports a real, large, one-sided
    // improvement without spawning anything -- what matters for this test
    // is what happens to the WORKTREE's bench file content after KEEP, not
    // re-proving the real fix's magnitude (already covered by the
    // real-fixture KEEP test above).
    const worktreeDir = path.join(dir, 'baseline-worktree')
    const sidedMeasureOne = async (measureDir: string): Promise<number> => (measureDir === worktreeDir ? 1000 : 10)

    const outcome = await runEval({ ctx, tag: TAG, description: 'fix + tamper bench', measureOne: sidedMeasureOne })

    expect(outcome.verdict.status).toBe('keep')
    const worktreeBenchText = await readFile(
      path.join(dir, 'baseline-worktree', 'src', 'wordcount.bench.ts'),
      'utf8',
    )
    expect(worktreeBenchText).toBe(originalBenchText)
  })
})

// Scoped re-review finding (I6): the advance sequence used to be
// repointWorktree -> restore -> writeBaseline, all-or-nothing in appearance
// but not in fact -- a crash between the first two steps and the third left
// `measureCommit` unmoved while the worktree had already moved, and a crash
// between `repointWorktree` and `restore` left the worktree's frozen files
// stale. Recovery advice in both cases pointed at "baseline -force," which
// re-derives the freeze manifest from whatever is at HEAD -- silently
// adopting the agent's own commits as the new correctness contract.
//
// The fix writes `measureCommit` FIRST, so a worktree merely left behind
// (at the OLD commit, while the baseline record already names the NEW one)
// is a recoverable, well-defined state: gate 8 repairs it itself.
describe('runEval: worktree self-heal (I6)', () => {
  it('gate 8 repoints and restores a worktree left behind by an interrupted advance, instead of demanding -force', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    const dir = runDir(root, TAG)
    const worktreeDir = path.join(dir, 'baseline-worktree')
    const beforeFix = await readBaseline(dir)

    await applyRealFix(root)
    const fixedHead = await headCommit(root)
    const keepOutcome = await runEval({ ctx, tag: TAG, description: 'push instead of concat' })
    expect(keepOutcome.verdict.status).toBe('keep') // precondition
    expect((await readBaseline(dir)).measureCommit).toBe(fixedHead)

    // Simulate exactly the crash window this fix targets: measureCommit is
    // already durably advanced to fixedHead (proven above), but the
    // worktree itself never got repointed -- reverted here by hand, back to
    // the ORIGINAL frozen commit, standing in for "the repoint/restore step
    // never ran."
    await git(worktreeDir, ['checkout', '-q', '--detach', '--force', beforeFix.measureCommit])
    expect(await headCommit(worktreeDir)).toBe(beforeFix.measureCommit)
    expect(await headCommit(worktreeDir)).not.toBe(fixedHead)

    // A further trivial commit, so this second eval has something new to
    // evaluate (gate 8's other check).
    await trivialCommit(root)

    const secondOutcome = await runEval({ ctx, tag: TAG, description: 'after simulated crash' })

    // No FAIL demanding -force: the mismatch was repaired automatically.
    expect(secondOutcome.failedGate).not.toBe('worktree-integrity')
    expect(secondOutcome.warnings.join(' ')).toMatch(/repointed and restored automatically/)
    // The repair actually happened: the worktree is now at the commit
    // baseline.measureCommit already named, not the stale one.
    expect(await headCommit(worktreeDir)).toBe(fixedHead)
  })

  // Mutation-adjacent control: BEFORE the fix, `checkWorktreeIntegrity`
  // returned a bare FAIL ("run baseline -force to recreate it") for this
  // exact state, with measureOne never called. Pinning `not.toHaveBeenCalled`
  // being FALSE here (i.e. measurement genuinely proceeds) is what would
  // have failed against the old behaviour.
  it('measures normally after the self-heal, rather than stopping at gate 8', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    const dir = runDir(root, TAG)
    const worktreeDir = path.join(dir, 'baseline-worktree')
    const beforeFix = await readBaseline(dir)

    await applyRealFix(root)
    const keepOutcome = await runEval({ ctx, tag: TAG, description: 'push instead of concat' })
    expect(keepOutcome.verdict.status).toBe('keep')

    await git(worktreeDir, ['checkout', '-q', '--detach', '--force', beforeFix.measureCommit])
    await trivialCommit(root)

    const spy = vi.fn(constMeasureOne)
    await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(spy).toHaveBeenCalled()
  })
})

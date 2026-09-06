import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
 * `.autoresearch/config.yaml`. `value` must already be YAML-ready (a quoted
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
  await git(root, ['add', 'program.md', '.gitignore'])
  await git(root, ['commit', '-q', '-m', 'init: config + program.md'])
}

async function addAndCommit(root: string, rel: string, body: string, message: string): Promise<void> {
  await writeFile(path.join(root, rel), body, 'utf8')
  await git(root, ['add', rel])
  await git(root, ['commit', '-q', '-m', message])
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

/** Rounds/benchtime/warmup small enough that a real `runChild` spawn stays fast. */
const FAST_MEASURE_PATCHES: Record<string, string> = {
  count: '4',
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

  it('gate 2: fails when .autoresearch/config.yaml changed since baseline', async () => {
    const { ctx } = await setup()
    // .autoresearch/ is gitignored -- this is deliberately an uncommitted,
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
    const { ctx } = await setup(FAST_MEASURE_PATCHES)

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
    const { ctx } = await setup(FAST_MEASURE_PATCHES)

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
    const dir = runDir(root, TAG)
    const worktreeLockfile = path.join(dir, 'baseline-worktree', 'package-lock.json')
    await writeFile(worktreeLockfile, '{"tampered": true}\n', 'utf8')
    const spy = vi.fn()

    const outcome = await runEval({ ctx, tag: TAG, description: '', measureOne: spy })

    expect(outcome.verdict.status).toBe('fail')
    expect(outcome.failedGate).toBe('worktree-integrity')
    expect(spy).not.toHaveBeenCalled()
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
})

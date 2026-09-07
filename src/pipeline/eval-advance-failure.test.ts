import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cmdBaseline } from '../cli/cmd-baseline.js'
import { cmdInit } from '../cli/cmd-init.js'
import type { RunCtx } from '../cli/runctx.js'
import { CONFIG_PATH } from '../config/schema.js'
import { RESULTS_PATH, loadRows } from '../results/results.js'
import { headCommit, repointWorktree } from '../gitx/git.js'
import { ok, run } from '../runner/exec.js'
import { readBaseline } from '../state/baseline.js'
import { runDir, STATE_HOME_ENV } from '../state/home.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { runEval } from './eval.js'

/**
 * Deferred item 2: the post-KEEP advance's failure path was never tested.
 * The Task 19 implementer reported no injection seam existed; the reviewer
 * showed that was inaccurate -- a PARTIAL module mock isolates exactly this
 * one call with no production-code change.
 *
 * It lives in its own file because `vi.mock` is hoisted and file-scoped: a
 * `git.js` mock inside `eval.test.ts` would apply to all 35 of its tests,
 * every one of which needs the real git.
 */
vi.mock('../gitx/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gitx/git.js')>()),
  repointWorktree: vi.fn(),
}))

const TAG = 'sep6'

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

let stateHomeDir: string
let originalStateHomeEnv: string | undefined
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  originalStateHomeEnv = process.env[STATE_HOME_ENV]
  stateHomeDir = await mkdtemp(path.join(tmpdir(), 'ars-advfail-state-'))
  process.env[STATE_HOME_ENV] = stateHomeDir
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.mocked(repointWorktree).mockReset()
})

afterEach(async () => {
  if (originalStateHomeEnv === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHomeEnv
  await rm(stateHomeDir, { recursive: true, force: true })
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
})

describe('runEval: the post-KEEP advance fails (deferred item 2)', () => {
  it('reports CRASH, not FAIL, and still records a row -- with measureCommit already advanced', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    expect(await cmdInit(ctx, [])).toBe(0)
    await git(root, ['add', '.autor3search/config.yaml', 'program.md', '.gitignore'])
    await git(root, ['commit', '-q', '-m', 'init'])
    expect(await cmdBaseline(ctx, ['-tag', TAG])).toBe(0)
    const dir = runDir(root, TAG)
    const before = await readBaseline(dir)

    // A commit to evaluate. The verdict is forced to KEEP by measurement,
    // not by the fixture, so this test does not depend on the demo's real
    // timings: the candidate side is 100x faster than the baseline side.
    const file = path.join(root, 'src', 'wordcount.ts')
    await writeFile(file, `${await readFile(file, 'utf8')}\n// candidate\n`, 'utf8')
    await git(root, ['add', 'src/wordcount.ts'])
    await git(root, ['commit', '-q', '-m', 'candidate'])
    const candidate = await headCommit(root)

    const worktreeDir = path.join(dir, 'baseline-worktree')
    const sidedMeasure = async (measureDir: string): Promise<number> =>
      measureDir === worktreeDir ? 1000 : 10

    vi.mocked(repointWorktree).mockRejectedValue(new Error('boom'))

    const outcome = await runEval({ ctx, tag: TAG, description: 'advance blows up', measureOne: sidedMeasure })

    // A genuine KEEP was already decided; this is a harness failure moving
    // the measurement point, not a verdict about the change. FAIL would
    // read as "your change was rejected", which is a lie about the science.
    expect(outcome.verdict.status).toBe('crash')
    expect(vi.mocked(repointWorktree)).toHaveBeenCalledTimes(1)

    // CRASH here still writes a row -- the alternative is an exception
    // escaping with the experiment recorded nowhere at all.
    const rows = await loadRows(ctx.resultsPath)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('crash')

    // writeBaseline runs BEFORE the two worktree calls precisely so this
    // holds: the KEEP is durably recorded even though the advance failed,
    // which is what makes the next eval's gate 8 able to self-heal instead
    // of demanding `baseline -force`.
    const after = await readBaseline(dir)
    expect(after.measureCommit).toBe(candidate)
    expect(after.frozenCommit).toBe(before.frozenCommit)
  }, 300_000)
})

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cmdBaseline } from '../cli/cmd-baseline.js'
import { cmdEval } from '../cli/cmd-eval.js'
import { cmdInit } from '../cli/cmd-init.js'
import type { RunCtx } from '../cli/runctx.js'
import { CONFIG_PATH } from '../config/schema.js'
import { headCommit } from '../gitx/git.js'
import { RESULTS_PATH, loadRows } from '../results/results.js'
import { ok, run } from '../runner/exec.js'
import { type BaselineRecord, readBaseline } from '../state/baseline.js'
import { runDir, STATE_HOME_ENV } from '../state/home.js'
import { makeDemoRepo } from '../testutil/demo.js'

/**
 * This is the project's own proof-of-life: it drives the real CLI dispatch
 * functions (`cmdInit`, `cmdBaseline`, `cmdEval`) -- not `runEval` directly,
 * and not a mock of any of the three -- against the shipped demo fixture,
 * with a real `git`, a real `npm ci` inside a real worktree, and real
 * measurement children. Every other suite either drives `runEval` straight
 * (`pipeline/eval.test.ts`) or drives one command in isolation
 * (`cli/cmd-*.test.ts`); this is the only place all three commands run back
 * to back, in the order a human or an agent actually issues them.
 */

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
 * Substitutes top-level `key: value` lines in the generated config, mirroring
 * exactly what `cmd-init`'s own renderer writes -- the same helper every
 * other CLI-level suite in this project uses to speed up measurement without
 * touching anything `loadConfig` would reject.
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

const TAG = 'e2e'

/**
 * Rounds/benchtime/warmup small enough that ten real measured rounds per
 * side stay fast, while `count: 10` (not the minimum 4) keeps the exact
 * two-sided p-value floor (~1.08e-5) comfortably below ALPHA, so a loaded
 * machine's timing noise cannot flip a real, large effect below
 * significance -- see the identical note in `pipeline/eval.test.ts`.
 */
const FAST_MEASURE_PATCHES: Record<string, string> = {
  count: '10',
  benchtime: JSON.stringify('5ms'),
  warmup: JSON.stringify('0ms'),
}

interface KeepResult {
  root: string
  ctx: RunCtx
  dir: string
  beforeFix: BaselineRecord
  fixedHead: string
  keepCode: number
  keepJson: Record<string, unknown>
}

/**
 * The real sequence: `init` -> commit -> `baseline` -> apply the demo
 * fixture's real fix -> commit -> `eval`. The slow path in
 * `testdata/demo/src/wordcount.ts` is `chars = chars.concat([c])`, which
 * allocates and copies a brand-new array on every character (O(n^2) per
 * word); the fix is `chars.push(c)`. This is NOT a string-builder or
 * array-join change -- the code already joins with `.join('')` -- and plain
 * `+=` on a JS string would not exercise this bug at all, since V8
 * represents concatenated strings as ropes rather than copying on every
 * append.
 */
async function driveToKeep(): Promise<KeepResult> {
  const root = await makeDemoRepo()
  const ctx = ctxFor(root)

  expect(await cmdInit(ctx, [])).toBe(0)
  await patchConfig(ctx, FAST_MEASURE_PATCHES)
  await git(root, ['add', '.autoresearch/config.yaml', 'program.md', '.gitignore'])
  await git(root, ['commit', '-q', '-m', 'init: config + program.md'])

  expect(await cmdBaseline(ctx, ['-tag', TAG])).toBe(0)
  const dir = runDir(root, TAG)
  const beforeFix = await readBaseline(dir)
  expect(beforeFix.frozenCommit).toBe(beforeFix.measureCommit)

  const file = path.join(root, 'src', 'wordcount.ts')
  const text = await readFile(file, 'utf8')
  const fixed = text.replace('chars = chars.concat([c])', 'chars.push(c)')
  expect(fixed).not.toBe(text) // sanity: the replacement actually matched something
  await writeFile(file, fixed, 'utf8')
  await git(root, ['add', 'src/wordcount.ts'])
  await git(root, ['commit', '-q', '-m', 'fix: push instead of concat in the hot loop'])
  const fixedHead = await headCommit(root)

  const keepCode = await cmdEval(ctx, ['-tag', TAG, '--json', '-desc', 'push instead of concat'])
  const keepJson = JSON.parse(lastStdout()) as Record<string, unknown>

  return { root, ctx, dir, beforeFix, fixedHead, keepCode, keepJson }
}

let stdout: string[]
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

function lastStdout(): string {
  return (stdout[stdout.length - 1] ?? '').trim()
}

let stateHomeDir: string
let originalStateHomeEnv: string | undefined

beforeEach(async () => {
  originalStateHomeEnv = process.env[STATE_HOME_ENV]
  stateHomeDir = await mkdtemp(path.join(tmpdir(), 'ars-e2e-state-'))
  process.env[STATE_HOME_ENV] = stateHomeDir
  stdout = []
  // init/baseline print real progress to stdout/stderr; captured (not
  // silently dropped) so the suite could inspect it, but every assertion
  // below reads the state written to disk (results.tsv, baseline.json) or
  // eval's own --json object, which is stronger evidence than a string
  // match against human-readable prose.
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  if (originalStateHomeEnv === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHomeEnv
  await rm(stateHomeDir, { recursive: true, force: true })
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
})

// Skippable on a constrained CI runner with no npm registry access at all --
// though since the demo fixture has zero dependencies, `npm ci` inside
// `baseline`'s worktree here never actually reaches the network. It must
// still run locally before every release: this is the test that proves the
// whole tool, not any one gate of it, actually works end to end.
describe.skipIf(process.env['CI_SKIP_INSTALL'] === '1')(
  'end-to-end: init -> baseline -> eval against the real demo fixture',
  () => {
    it(
      'runs init -> baseline -> eval end to end and KEEPs a real optimization',
      async () => {
        const { ctx, dir, beforeFix, fixedHead, keepCode, keepJson } = await driveToKeep()

        expect(keepCode).toBe(0)
        expect(keepJson['status']).toBe('keep')
        expect(keepJson['score']).toBeLessThan(1)

        const rows = await loadRows(ctx.resultsPath)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.status).toBe('keep')
        expect(rows[0]?.score).toBeLessThan(1)

        const after = await readBaseline(dir)
        expect(after.measureCommit).toBe(fixedHead)
        expect(after.measureCommit).not.toBe(beforeFix.measureCommit)
        expect(after.frozenCommit).toBe(beforeFix.frozenCommit)
      },
      600_000,
    )

    it(
      'runs the same flow and DISCARDs a no-op comment commit measured against the advanced baseline',
      async () => {
        const { root, ctx, dir, beforeFix, fixedHead, keepCode } = await driveToKeep()
        expect(keepCode).toBe(0) // precondition for the real test below

        const file = path.join(root, 'src', 'wordcount.ts')
        const text = await readFile(file, 'utf8')
        await writeFile(file, `${text}\n// no functional change, comment only\n`, 'utf8')
        await git(root, ['add', 'src/wordcount.ts'])
        await git(root, ['commit', '-q', '-m', 'chore: add a comment'])
        const noopHead = await headCommit(root)

        const discardCode = await cmdEval(ctx, ['-tag', TAG, '--json', '-desc', 'comment only, no-op'])
        const discardJson = JSON.parse(lastStdout()) as Record<string, unknown>

        // "DISCARD" is the overwhelmingly likely outcome for a genuine no-op,
        // but it is a STATISTICAL claim -- at the documented false-positive
        // rate (ALPHA/k), a real run can spuriously clear significance and
        // KEEP even a true no-op. Asserting DISCARD as the pass/fail
        // condition here would make this test itself flaky at exactly that
        // rate. Never FAIL/CRASH either way: only a real gate problem
        // produces those, and none is expected on this path.
        expect(discardCode === 0 || discardCode === 1).toBe(true)
        const status = discardJson['status']
        expect(status === 'keep' || status === 'discard').toBe(true)

        const rows = await loadRows(ctx.resultsPath)
        expect(rows).toHaveLength(2)
        expect(rows[0]?.status).toBe('keep')
        expect(rows[1]?.status).toBe(status)

        // The DETERMINISTIC regression this test actually exists to prove:
        // with a measurement baseline that never advances, this no-op would
        // be compared against the original, slow baseline and coast to a
        // spurious KEEP on the strength of the earlier real win. That is
        // true regardless of which way the statistical result above landed
        // -- either this experiment measured against the ALREADY-ADVANCED
        // baseline (fixedHead), in which case its own commit is the only
        // one that can newly become measureCommit, never one from a stale
        // comparison.
        const after = await readBaseline(dir)
        if (status === 'keep') {
          expect(after.measureCommit).toBe(noopHead)
        } else {
          expect(discardJson['reason']).toBe('no_significant_improvement')
          expect(rows[1]?.reason).toBe('no_significant_improvement')
          expect(after.measureCommit).toBe(fixedHead) // did NOT advance again
          expect(after.measureCommit).not.toBe(noopHead)
        }
        expect(after.frozenCommit).toBe(beforeFix.frozenCommit) // never moves
      },
      600_000,
    )
  },
)

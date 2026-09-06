import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH } from '../config/schema.js'
import { RESULTS_PATH, loadRows } from '../results/results.js'
import { ok, run } from '../runner/exec.js'
import { STATE_HOME_ENV } from '../state/home.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { cmdBaseline } from './cmd-baseline.js'
import { cmdEval } from './cmd-eval.js'
import { cmdInit } from './cmd-init.js'
import type { RunCtx } from './runctx.js'

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

async function patchConfig(ctx: RunCtx, patches: Record<string, string>): Promise<void> {
  let text = await readFile(ctx.configPath, 'utf8')
  for (const [key, value] of Object.entries(patches)) {
    const re = new RegExp(`^${key}:.*$`, 'm')
    if (!re.test(text)) throw new Error(`patchConfig: key not found in config: ${key}`)
    text = text.replace(re, `${key}: ${value}`)
  }
  await writeFile(ctx.configPath, text, 'utf8')
}

const TAG = 'sep6'
// count: 10, not the minimum 4 -- see the identical note in pipeline/eval.test.ts:
// at 4 the exact two-sided p-value floor (2/C(8,4) ~= 0.0286) is only ~1.75x
// below ALPHA (0.05), thin enough for a loaded CI box's timing noise to flip.
const FAST_MEASURE_PATCHES: Record<string, string> = {
  count: '10',
  benchtime: JSON.stringify('5ms'),
  warmup: JSON.stringify('0ms'),
}

async function setup(patches: Record<string, string> = {}): Promise<{ root: string; ctx: RunCtx }> {
  const root = await makeDemoRepo()
  const ctx = ctxFor(root)
  // cmdInit/cmdBaseline write real progress to stdout/stderr; silenced
  // during setup so this suite's own captured output stays exactly what
  // the eval-under-test itself wrote.
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(await cmdInit(ctx, [])).toBe(0)
    if (Object.keys(patches).length > 0) await patchConfig(ctx, patches)
    await git(root, ['add', 'program.md', '.gitignore'])
    await git(root, ['commit', '-q', '-m', 'init'])
    expect(await cmdBaseline(ctx, ['-tag', TAG])).toBe(0)
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
  return { root, ctx }
}

let stdout: string[]
let stderr: string[]
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

function captureOutput(): void {
  stdout = []
  stderr = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
}

let stateHomeDir: string
let originalStateHomeEnv: string | undefined

beforeEach(async () => {
  originalStateHomeEnv = process.env[STATE_HOME_ENV]
  stateHomeDir = await mkdtemp(path.join(tmpdir(), 'ars-cmdeval-state-'))
  process.env[STATE_HOME_ENV] = stateHomeDir
})

afterEach(async () => {
  if (originalStateHomeEnv === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHomeEnv
  await rm(stateHomeDir, { recursive: true, force: true })
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
})

describe('cmdEval', () => {
  it('defaults -tag to the tag inferred from the current run branch', async () => {
    const { ctx } = await setup(FAST_MEASURE_PATCHES)
    captureOutput()

    // No -tag given at all -- the current branch, checked out by baseline
    // itself, is "autoresearch-typescript/sep6".
    const code = await cmdEval(ctx, ['--json'])

    expect([0, 1]).toContain(code) // a real, unmodified experiment: keep or discard, never fail/crash
    const parsed = JSON.parse(stdout.join('').trim()) as { experiment: number }
    expect(parsed.experiment).toBe(1)
  })

  it('refuses when -tag is not given and the current branch is not a run branch', async () => {
    const { root, ctx } = await setup()
    await git(root, ['checkout', '-q', 'main'])
    captureOutput()

    const code = await cmdEval(ctx, [])

    expect(code).toBe(2)
    expect(stderr.join('')).toMatch(/-tag/)
  })

  it('--json prints exactly one JSON object and nothing else on stdout', async () => {
    const { ctx } = await setup(FAST_MEASURE_PATCHES)
    captureOutput()

    await cmdEval(ctx, ['-tag', TAG, '--json'])

    const text = stdout.join('')
    // Parsing the ENTIRE stdout, not merely checking it contains JSON: a
    // stray log line before or after the object would make this throw.
    const parsed: unknown = JSON.parse(text)
    expect(typeof parsed).toBe('object')
    // Exactly one line of output (plus the trailing newline the writer adds).
    expect(text.endsWith('\n')).toBe(true)
    expect(text.slice(0, -1).includes('\n')).toBe(false)
  })

  it('the JSON object carries all the documented fields with the right shapes', async () => {
    const { ctx } = await setup(FAST_MEASURE_PATCHES)
    captureOutput()

    const code = await cmdEval(ctx, ['-tag', TAG, '--json', '-desc', 'a test experiment'])

    const parsed = JSON.parse(stdout.join('')) as Record<string, unknown>
    expect(typeof parsed['status']).toBe('string')
    expect(parsed['exit_code']).toBe(code)
    expect(typeof parsed['score']).toBe('number')
    expect(typeof parsed['reason']).toBe('string')
    expect(typeof parsed['corrected_alpha']).toBe('number')
    expect(Array.isArray(parsed['warnings'])).toBe(true)
    expect(typeof parsed['stop_requested']).toBe('boolean')
    expect(Array.isArray(parsed['benchmarks'])).toBe(true)
    const bench = (parsed['benchmarks'] as unknown[])[0] as Record<string, unknown>
    expect(typeof bench['name']).toBe('string')
    expect(typeof bench['base_ns']).toBe('number')
    expect(typeof bench['cand_ns']).toBe('number')
    expect(typeof bench['pct_change']).toBe('number')
    expect(typeof bench['p']).toBe('number')
    expect(typeof bench['significant']).toBe('boolean')
    expect(typeof parsed['measure_commit']).toBe('string')
    expect(typeof parsed['frozen_commit']).toBe('string')
    expect(typeof parsed['experiment']).toBe('number')
    expect(typeof parsed['failed_gate']).toBe('string')
    expect(typeof parsed['message']).toBe('string')
  })

  it('a FAIL is diagnostically informative, not empty: failed_gate and message name the actual problem', async () => {
    const { root, ctx } = await setup()
    await writeFile(path.join(root, 'notes.txt'), 'agent notes\n', 'utf8')
    await git(root, ['add', 'notes.txt'])
    await git(root, ['commit', '-q', '-m', 'add a file outside scope'])
    captureOutput()

    const code = await cmdEval(ctx, ['-tag', TAG, '--json'])

    expect(code).toBe(2)
    const parsed = JSON.parse(stdout.join('')) as { status: string; failed_gate: string; message: string; reason: string }
    expect(parsed.status).toBe('fail')
    expect(parsed.failed_gate).toBe('scope')
    expect(parsed.message).toMatch(/notes\.txt/)
    // results.tsv's reason column can only ever hold a DiscardReason or ''
    // (never a FAIL's free-text message) -- the diagnosis instead lands in
    // description, which must not be left empty just because -desc was not passed.
    const rows = await loadRows(ctx.resultsPath)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reason).toBe('')
    expect(rows[0]?.description).toMatch(/notes\.txt/)
  })

  // A genuine measurement-child crash, driven through the real CLI end to
  // end (not an injected test double): a benchmark that throws only when a
  // marker file exists in its OWN process's cwd. The marker is absent
  // during baseline's smoke run (which executes in the separate worktree)
  // and is created only in repoRoot, gitignored so the scope gate never
  // sees it, right before this eval -- so only the candidate side crashes.
  it('a real measurement-child crash exits 3 (CRASH), not 2 (FAIL)', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await writeFile(
        path.join(root, 'src', 'crash.bench.ts'),
        [
          "import { existsSync } from 'node:fs'",
          "import path from 'node:path'",
          '',
          'export function benchCrash(): number {',
          "  if (existsSync(path.join(process.cwd(), 'CRASH_NOW'))) {",
          "    throw new Error('boom: forced crash for testing')",
          '  }',
          '  return 1',
          '}',
          '',
        ].join('\n'),
        'utf8',
      )
      await writeFile(path.join(root, '.gitignore'), 'CRASH_NOW\n', 'utf8')
      await git(root, ['add', '-A'])
      await git(root, ['commit', '-q', '-m', 'add a crash-aware benchmark'])

      expect(await cmdInit(ctx, [])).toBe(0)
      await patchConfig(ctx, FAST_MEASURE_PATCHES)
      await git(root, ['add', 'program.md', '.gitignore'])
      await git(root, ['commit', '-q', '-m', 'init'])
      expect(await cmdBaseline(ctx, ['-tag', TAG])).toBe(0)
    } finally {
      outSpy.mockRestore()
      errSpy.mockRestore()
    }

    await writeFile(path.join(root, 'CRASH_NOW'), '', 'utf8')

    captureOutput()
    const code = await cmdEval(ctx, ['-tag', TAG, '--json'])

    expect(code).toBe(3)
    const parsed = JSON.parse(stdout.join('')) as { status: string; failed_gate: string }
    expect(parsed.status).toBe('crash')
    expect(parsed.failed_gate).toBe('measure')
  })

  it('records -desc on the results.tsv row', async () => {
    const { ctx } = await setup(FAST_MEASURE_PATCHES)
    captureOutput()

    await cmdEval(ctx, ['-tag', TAG, '-desc', 'a memorable description'])

    const rows = await loadRows(ctx.resultsPath)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.description).toBe('a memorable description')
  })

  it('human output prints WARNING: lines above the verdict', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    // Weaken a frozen test file so gate 3 has something to restore and
    // report as a warning.
    await writeFile(
      path.join(root, 'src', 'wordcount.test.ts'),
      "import { describe, it } from 'node:test'\ndescribe('countWords', () => { it('does nothing', () => {}) })\n",
      'utf8',
    )
    await git(root, ['add', 'src/wordcount.test.ts'])
    await git(root, ['commit', '-q', '-m', 'weaken the test'])
    captureOutput()

    await cmdEval(ctx, ['-tag', TAG])

    const text = stdout.join('')
    const warningLines = text.split('\n').filter((l) => l.startsWith('WARNING:'))
    expect(warningLines.length).toBeGreaterThan(0)
    expect(warningLines.join('\n')).toMatch(/restored/)
    // Every WARNING: line must precede the verdict line -- compare actual
    // positions, not merely that both substrings occur somewhere: an
    // implementation that printed warnings AFTER the verdict would still
    // pass a check that only asks "does some verdict word appear."
    const lastWarningPos = text.lastIndexOf(warningLines[warningLines.length - 1] as string)
    const verdictPos = text.search(/: (KEEP|DISCARD|FAIL|CRASH) \(exit/)
    expect(verdictPos).toBeGreaterThan(-1)
    expect(verdictPos).toBeGreaterThan(lastWarningPos)
  })

  it('subprocess transcripts go to run.log, not stdout', async () => {
    const marker = 'RUN_LOG_MARKER_9f3a1c'
    const { ctx } = await setup({
      ...FAST_MEASURE_PATCHES,
      test_command: JSON.stringify(`node -e "console.log('${marker}')"`),
    })
    captureOutput()

    await cmdEval(ctx, ['-tag', TAG, '--json'])

    const log = await readFile(ctx.logPath, 'utf8')
    expect(log).toContain(marker)
    // stdout is exactly the one JSON object -- nothing from the test command leaked into it.
    expect(stdout.join('')).not.toContain(marker)
  })

  it('a usage error (bad flag) exits 2 and never attempts an experiment', async () => {
    const { ctx } = await setup()
    captureOutput()

    const code = await cmdEval(ctx, ['-bogus-flag'])

    expect(code).toBe(2)
    expect(stderr.join('')).toMatch(/error:/)
    const rows = await loadRows(ctx.resultsPath)
    expect(rows).toHaveLength(0)
  })
})

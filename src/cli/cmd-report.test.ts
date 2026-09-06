import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESULTS_PATH, appendRow, type Row } from '../results/results.js'
import { cmdReport } from './cmd-report.js'
import type { RunCtx } from './runctx.js'

function ctxFor(root: string): RunCtx {
  return {
    repoRoot: root,
    configPath: path.join(root, '.autor3search/config.yaml'),
    resultsPath: path.join(root, RESULTS_PATH),
    logPath: path.join(root, 'run.log'),
  }
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

afterEach(() => {
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ars-report-'))
})

describe('cmdReport', () => {
  it('reports "no experiments recorded yet" when results.tsv does not exist, rather than erroring', async () => {
    const ctx = ctxFor(root)
    captureOutput()

    const code = await cmdReport(ctx, [])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/no experiments recorded yet/)
    expect(stderr.join('')).toBe('')
  })

  it('reports "no experiments recorded yet" for a results.tsv that exists but has only a header', async () => {
    const ctx = ctxFor(root)
    await writeFile(ctx.resultsPath, 'commit\tscore\tbest_bench_delta\tp_min\tstatus\treason\tdescription\n', 'utf8')
    captureOutput()

    const code = await cmdReport(ctx, [])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/no experiments recorded yet/)
  })

  it('reports counts by status', async () => {
    const ctx = ctxFor(root)
    const rows: Row[] = [
      { commit: 'aaa1111', score: 0.8, bestBenchDelta: -20, pMin: 0.001, status: 'keep', reason: '', description: 'win 1' },
      {
        commit: 'bbb2222',
        score: 1.0,
        bestBenchDelta: 0.1,
        pMin: 0.9,
        status: 'discard',
        reason: 'no_significant_improvement',
        description: '',
      },
      { commit: 'ccc3333', score: 1, bestBenchDelta: 0, pMin: 1, status: 'fail', reason: '', description: 'scope violation' },
      { commit: 'ddd4444', score: 1, bestBenchDelta: 0, pMin: 1, status: 'crash', reason: '', description: 'setup: no baseline' },
    ]
    for (const r of rows) await appendRow(ctx.resultsPath, r)
    captureOutput()

    const code = await cmdReport(ctx, [])

    expect(code).toBe(0)
    const text = stdout.join('')
    expect(text).toMatch(/experiments:\s+4 total/)
    expect(text).toMatch(/keep: 1/)
    expect(text).toMatch(/discard: 1/)
    expect(text).toMatch(/fail: 1/)
    expect(text).toMatch(/crash: 1/)
  })

  // Ruling / guidance point 1: this is the test that would fail against the
  // plausible-but-wrong implementation that prints the LATEST kept score
  // (or a mean) instead of the product of every kept score.
  it('reports cumulative speedup as the PRODUCT of every kept score, not the latest one', async () => {
    const ctx = ctxFor(root)
    const rows: Row[] = [
      { commit: 'aaa1111', score: 0.9, bestBenchDelta: -10, pMin: 0.001, status: 'keep', reason: '', description: 'win 1' },
      { commit: 'bbb2222', score: 0.8, bestBenchDelta: -20, pMin: 0.001, status: 'keep', reason: '', description: 'win 2' },
    ]
    for (const r of rows) await appendRow(ctx.resultsPath, r)
    captureOutput()

    const code = await cmdReport(ctx, [])

    expect(code).toBe(0)
    const text = stdout.join('')
    // 0.9 * 0.8 = 0.72 (the raw candidate/baseline time ratio), not 0.8
    // (the latest) and not 0.85 (the mean) -- printed as "1.39x faster",
    // the inverse of the ratio, with the ratio itself named alongside it.
    expect(text).toMatch(/1\.39x faster/)
    expect(text).toMatch(/cumulative time ratio 0\.7200/)
    expect(text).not.toMatch(/cumulative time ratio 0\.8000/)
    expect(text).not.toMatch(/cumulative time ratio 0\.8500/)
  })

  // The headline number must read as a speedup, not as its own inverse: a
  // large win (a small ratio) must print as a LARGE "x faster" figure, not
  // as a small number suffixed "x" that reads like a slowdown.
  it('prints the cumulative speedup as "N faster", the inverse of the raw ratio, not the raw ratio itself', async () => {
    const ctx = ctxFor(root)
    const rows: Row[] = [
      { commit: 'aaa1111', score: 0.08, bestBenchDelta: -92, pMin: 0.001, status: 'keep', reason: '', description: '12x win' },
    ]
    for (const r of rows) await appendRow(ctx.resultsPath, r)
    captureOutput()

    const code = await cmdReport(ctx, [])

    expect(code).toBe(0)
    const text = stdout.join('')
    // 1 / 0.08 = 12.5 -- a big, obviously-a-win number, not "0.08x" which
    // reads as roughly thirteen times SLOWER.
    expect(text).toMatch(/12\.50x faster/)
    expect(text).not.toMatch(/0\.0800x faster/)
  })

  // The wording itself must make clear this is a compounded, end-to-end
  // number, not "the current speedup versus the start" -- a reader who
  // only glances at the number should not be able to mistake it for the
  // most recent experiment's own score.
  it('describes the cumulative speedup as a compounded product across every KEEP, not "the current speedup"', async () => {
    const ctx = ctxFor(root)
    const rows: Row[] = [
      { commit: 'aaa1111', score: 0.9, bestBenchDelta: -10, pMin: 0.001, status: 'keep', reason: '', description: 'win 1' },
    ]
    for (const r of rows) await appendRow(ctx.resultsPath, r)
    captureOutput()

    const code = await cmdReport(ctx, [])

    expect(code).toBe(0)
    const text = stdout.join('').toLowerCase()
    expect(text).toMatch(/product/)
    expect(text).not.toMatch(/current speedup/)
  })

  it('lists the largest individual wins, best (lowest score) first', async () => {
    const ctx = ctxFor(root)
    const rows: Row[] = [
      { commit: 'aaa1111', score: 0.95, bestBenchDelta: -5, pMin: 0.001, status: 'keep', reason: '', description: 'small win' },
      { commit: 'bbb2222', score: 0.5, bestBenchDelta: -50, pMin: 0.001, status: 'keep', reason: '', description: 'big win' },
    ]
    for (const r of rows) await appendRow(ctx.resultsPath, r)
    captureOutput()

    const code = await cmdReport(ctx, [])

    expect(code).toBe(0)
    const text = stdout.join('')
    const bigIdx = text.indexOf('big win')
    const smallIdx = text.indexOf('small win')
    expect(bigIdx).toBeGreaterThan(-1)
    expect(smallIdx).toBeGreaterThan(-1)
    expect(bigIdx).toBeLessThan(smallIdx)
  })

  it('says so when there are experiments but none were kept', async () => {
    const ctx = ctxFor(root)
    const rows: Row[] = [
      {
        commit: 'aaa1111',
        score: 1,
        bestBenchDelta: 0,
        pMin: 1,
        status: 'discard',
        reason: 'no_significant_improvement',
        description: '',
      },
    ]
    for (const r of rows) await appendRow(ctx.resultsPath, r)
    captureOutput()

    const code = await cmdReport(ctx, [])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/no kept experiments/)
  })

  it('fails cleanly, without a stack trace, on a corrupted results.tsv', async () => {
    const ctx = ctxFor(root)
    // Malformed: only 3 fields instead of 7.
    await writeFile(ctx.resultsPath, 'commit\tscore\tbest_bench_delta\tp_min\tstatus\treason\tdescription\naaa\t0.9\tbad\n', 'utf8')
    captureOutput()

    const code = await cmdReport(ctx, [])

    expect(code).toBe(2)
    const message = stderr.join('')
    expect(message).toMatch(/^error: /)
    expect(message).not.toMatch(/at file:|\.ts:\d+:\d+|node:internal/)
  })
})

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBenchResult, type BenchResult } from '../benchproto/types.js'
import { run } from '../runner/exec.js'

// Task 13 adds runChild(), which will resolve child.js vs child.ts and hide
// this plumbing. Until then we drive the child directly, exactly as it will
// be driven in production: a fresh node process, the tsx ESM loader
// resolved from our own dependencies (not the global install), and a real
// --out file on disk.
const require = createRequire(import.meta.url)
const TSX_LOADER_URL = pathToFileURL(require.resolve('tsx/esm')).href
const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url))

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ars-benchrun-'))
}

let counter = 0

/** Writes a fixture benchmark module to disk and returns its absolute path. */
async function fixture(dir: string, body: string): Promise<string> {
  const file = path.join(dir, `fixture-${counter++}.ts`)
  await writeFile(file, body)
  return file
}

interface RunChildOptions {
  benchtimeMs?: number
  warmupMs?: number
}

/**
 * Spawns the child exactly as production will: the tsx loader registered
 * via --import, the result read back from --out (never from stdout). The
 * raw stdout/stderr are still returned so tests can assert on them
 * (e.g. the stdout-noise test).
 */
async function runChild(
  dir: string,
  file: string,
  fn: string,
  opts: RunChildOptions = {},
): Promise<{ result: BenchResult; stdout: string; stderr: string; exitCode: number }> {
  const outFile = path.join(dir, `out-${counter++}.json`)
  const id = `${fn}-${counter}`
  const r = await run(
    process.execPath,
    [
      '--import',
      TSX_LOADER_URL,
      CHILD,
      '--file',
      file,
      '--fn',
      fn,
      '--id',
      id,
      '--benchtime-ms',
      String(opts.benchtimeMs ?? 200),
      '--warmup-ms',
      String(opts.warmupMs ?? 50),
      '--out',
      outFile,
    ],
    { cwd: dir, timeoutMs: 60_000 },
  )
  if (r.exitCode !== 0) {
    throw new Error(
      `child exited ${r.exitCode} (signal ${r.signal}, timedOut ${r.timedOut})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    )
  }
  const text = await readFile(outFile, 'utf8')
  return { result: parseBenchResult(text), stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
}

describe('bench child', () => {
  it('measures a synchronous benchmark and reports positive nsPerOp', async () => {
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      function heavyish(): number {
        let acc = 0
        for (let i = 0; i < 10_000; i++) acc += Math.sqrt(i)
        return acc
      }
      export function benchX(): number {
        return heavyish()
      }
      `,
    )
    const { result } = await runChild(dir, file, 'benchX')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.nsPerOp).toBeGreaterThan(0)
    expect(result.iterations).toBeGreaterThan(0)
    expect(result.batches).toBeGreaterThanOrEqual(1)
  })

  it('measures an async benchmark without counting await overhead as the work', async () => {
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      export async function benchFast(): Promise<number> {
        return 42
      }
      export async function benchSlow(): Promise<number> {
        return new Promise((resolve) => setTimeout(() => resolve(42), 1))
      }
      `,
    )
    const { result: fast } = await runChild(dir, file, 'benchFast')
    const { result: slow } = await runChild(dir, file, 'benchSlow', { benchtimeMs: 150, warmupMs: 30 })
    expect(fast.ok).toBe(true)
    expect(slow.ok).toBe(true)
    if (!fast.ok || !slow.ok) return
    // A resolved-promise benchmark should be orders of magnitude cheaper
    // than one that waits on a real 1ms timer -- if the child folded
    // microtask overhead into every op, or mis-measured the timer op, the
    // two would land close together instead of being far apart.
    expect(fast.nsPerOp).toBeLessThan(slow.nsPerOp / 10)
  })

  it('reports a benchmark that throws as ok:false with the message, and does not crash', async () => {
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      export function benchThrows(): number {
        throw new Error('boom')
      }
      `,
    )
    const { result, exitCode } = await runChild(dir, file, 'benchThrows')
    expect(exitCode).toBe(0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/boom/)
  })

  it('reports a missing export as ok:false naming the function', async () => {
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      export function somethingElse(): number {
        return 1
      }
      `,
    )
    const { result } = await runChild(dir, file, 'benchMissing')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/benchMissing/)
  })

  it('reports a module that throws at import time as ok:false', async () => {
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      throw new Error('boom at import')
      export function benchY(): number {
        return 1
      }
      `,
    )
    const { result } = await runChild(dir, file, 'benchY')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/import|boom/)
  })

  it('consumes the return value so a returning benchmark is not optimized away', async () => {
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      export function benchMap(): Map<string, number> {
        const m = new Map<string, number>()
        m.set('a', 1)
        return m
      }
      `,
    )
    const { result } = await runChild(dir, file, 'benchMap')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sinkType).toBe('object')
  })

  it('writes ONLY to --out, tolerating a benchmark module that logs to stdout', async () => {
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      console.log('noise from the module under measurement')
      export function benchZ(): number {
        return 1 + 1
      }
      `,
    )
    const { result, stdout } = await runChild(dir, file, 'benchZ')
    // The module's own logging still reaches stdout unmodified...
    expect(stdout).toContain('noise from the module under measurement')
    // ...but the protocol result parses cleanly from --out regardless, and
    // is not the JSON blob some naive implementation might have printed to
    // stdout instead.
    expect(result.ok).toBe(true)
    expect(() => JSON.parse(stdout)).toThrow()
  })

  it('scales iterations so a fast benchmark runs many more of them than a slow one', async () => {
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      export function benchTiny(): number {
        return 1 + 1
      }
      function spinMs(ms: number): number {
        const end = process.hrtime.bigint() + BigInt(ms) * 1_000_000n
        let x = 0
        while (process.hrtime.bigint() < end) x++
        return x
      }
      export function benchSpin(): number {
        return spinMs(1)
      }
      `,
    )
    const { result: tiny } = await runChild(dir, file, 'benchTiny', { benchtimeMs: 200, warmupMs: 50 })
    const { result: spin } = await runChild(dir, file, 'benchSpin', { benchtimeMs: 200, warmupMs: 50 })
    expect(tiny.ok).toBe(true)
    expect(spin.ok).toBe(true)
    if (!tiny.ok || !spin.ok) return
    // Same wall-clock benchtime; the ~1us benchmark must have run far more
    // iterations than the ~1ms one, or calibration is not scaling batch
    // size to the actual cost of the function.
    expect(tiny.iterations).toBeGreaterThan(spin.iterations * 100)
  })

  it('reports roughly the known cost of a benchmark that spins for a fixed duration', async () => {
    // This is the calibration sanity check called for by the task: a
    // benchmark of *known* per-call cost should come back close to that
    // cost. A calibration bug (wrong batch math, counting warmup, etc.)
    // produces a passing-looking but meaningless number; this test would
    // catch that even though nothing here "throws".
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      export function benchSpin2ms(): number {
        const end = process.hrtime.bigint() + 2_000_000n
        let x = 0
        while (process.hrtime.bigint() < end) x++
        return x
      }
      `,
    )
    const { result } = await runChild(dir, file, 'benchSpin2ms', { benchtimeMs: 300, warmupMs: 50 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 2ms of busy-spin, +/- generous slack for OS scheduling jitter and
    // hrtime granularity -- but nowhere near an order of magnitude off,
    // which is what a broken totalNs/iterations calculation would produce.
    expect(result.nsPerOp).toBeGreaterThan(1_500_000)
    expect(result.nsPerOp).toBeLessThan(4_000_000)
  })

  it('does not fold sync execution through the async loop (no await overhead on sync ops)', async () => {
    // Same trivial body, expressed once synchronously and once behind
    // `async`. If the probe-and-branch in the child were broken -- e.g.
    // always awaiting -- the sync benchmark would show overhead consistent
    // with a microtask tick on every op instead of being a fully optimized
    // no-op call. (A larger shared workload, e.g. a 1000-iteration loop in
    // both variants, measures far noisier at this timescale and does not
    // reliably separate the two -- the trivial body isolates the await
    // cost itself instead of drowning it in loop-timing jitter.)
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      export function benchSyncTrivial(): number {
        return 1
      }
      export async function benchAsyncTrivial(): Promise<number> {
        return 1
      }
      `,
    )
    const { result: sync } = await runChild(dir, file, 'benchSyncTrivial')
    const { result: asyncR } = await runChild(dir, file, 'benchAsyncTrivial')
    expect(sync.ok).toBe(true)
    expect(asyncR.ok).toBe(true)
    if (!sync.ok || !asyncR.ok) return
    // Measured: sync ~0.3ns/op, async ~25ns/op (~80x apart) -- assert a
    // wide margin below that so the test isn't flaky, while still failing
    // hard if sync execution ever picks up microtask-scale overhead.
    expect(asyncR.nsPerOp).toBeGreaterThan(sync.nsPerOp * 5)
  })

  it('does not eliminate a pure computation whose result is only sink-consumed', async () => {
    // The whole benchmark body is arithmetic with no side effects; nothing
    // but the child's `sink = fn()` / `typeof sink` at the end keeps V8
    // from proving the loop dead and deleting it. If the sink were
    // decorative, this would measure near-zero instead of a real loop cost.
    const dir = await tmp()
    const file = await fixture(
      dir,
      `
      export function benchPureLoop(): number {
        let acc = 0
        for (let i = 0; i < 200_000; i++) {
          acc += (i * 2654435761) % 97
        }
        return acc
      }
      `,
    )
    const { result } = await runChild(dir, file, 'benchPureLoop')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A 200k-iteration loop with real multiply/mod work costs at least
    // tens of microseconds on any real CPU; a fully-eliminated call would
    // cost single-digit nanoseconds (just the function-call overhead).
    expect(result.nsPerOp).toBeGreaterThan(10_000)
  })
})

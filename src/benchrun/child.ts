/**
 * The measurement child.
 *
 * Runs exactly one benchmark function in a fresh process and writes one JSON
 * result to --out. Never writes its result to stdout: the module under
 * measurement is arbitrary repository code and is free to print (a stray
 * console.log during import, module init, or the benchmark body itself), so
 * a protocol that parsed stdout would be broken by one such line. --out is
 * a file this process alone controls the contents of.
 */
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import type { BenchResult } from '../benchproto/types.js'

/** Batches shorter than this are dominated by timer resolution. */
const MIN_BATCH_NS = 10_000_000n // 10ms

/**
 * Written on every call, read once at the end. This is what keeps V8 from
 * proving a benchmark's return value is unused and deleting the work that
 * produced it -- a benchmark that computes something and returns it must
 * have that return value actually consumed somewhere, or the "measurement"
 * degenerates into timing an empty loop.
 */
let sink: unknown

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    fn: { type: 'string' },
    id: { type: 'string' },
    'benchtime-ms': { type: 'string' },
    'warmup-ms': { type: 'string' },
    out: { type: 'string' },
  },
})

const file = values.file!
const fnName = values.fn!
const id = values.id!
const benchtimeMs = Number(values['benchtime-ms'])
const warmupMs = Number(values['warmup-ms'])
const out = values.out!

async function emit(r: BenchResult): Promise<void> {
  await writeFile(out, JSON.stringify(r))
}

type Bench = () => unknown

function runBatchSync(fn: Bench, n: number): bigint {
  const start = process.hrtime.bigint()
  for (let i = 0; i < n; i++) sink = fn()
  return process.hrtime.bigint() - start
}

async function runBatchAsync(fn: Bench, n: number): Promise<bigint> {
  const start = process.hrtime.bigint()
  for (let i = 0; i < n; i++) sink = await fn()
  return process.hrtime.bigint() - start
}

async function main(): Promise<void> {
  let fn: Bench
  try {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    const candidate = mod[fnName]
    if (typeof candidate !== 'function') {
      await emit({ ok: false, id, error: `${file} does not export a function named ${fnName}` })
      return
    }
    fn = candidate as Bench
  } catch (e) {
    await emit({ ok: false, id, error: `import ${file}: ${(e as Error).message}` })
    return
  }

  try {
    // Probe once to learn whether the benchmark is async. Awaiting a
    // synchronous function would fold microtask-queue overhead into every
    // measurement, so the two cases get separate loops: runBatchSync never
    // awaits, runBatchAsync always does.
    const probe = fn()
    const isAsync =
      probe !== null && typeof probe === 'object' && typeof (probe as PromiseLike<unknown>).then === 'function'
    if (isAsync) await probe
    sink = probe

    const batch = isAsync
      ? (n: number): Promise<bigint> => runBatchAsync(fn, n)
      : (n: number): Promise<bigint> => Promise.resolve(runBatchSync(fn, n))

    // Warm up first: JIT tiering changes the speed we are about to
    // calibrate to, so calibrating against a cold function would pick a
    // batch size for code that no longer exists by the time we measure.
    const warmDeadline = process.hrtime.bigint() + BigInt(warmupMs) * 1_000_000n
    while (process.hrtime.bigint() < warmDeadline) await batch(16)

    // Calibrate a batch size whose duration is well above timer resolution.
    let n = 1
    for (;;) {
      const took = await batch(n)
      if (took >= MIN_BATCH_NS || n >= 1_000_000_000) break
      n *= 2
    }

    let totalNs = 0n
    let iterations = 0
    let batches = 0
    const deadline = process.hrtime.bigint() + BigInt(benchtimeMs) * 1_000_000n
    while (process.hrtime.bigint() < deadline) {
      totalNs += await batch(n)
      iterations += n
      batches++
    }
    if (iterations === 0) {
      // benchtime shorter than a single batch: still report one honest batch.
      totalNs = await batch(n)
      iterations = n
      batches = 1
    }

    await emit({
      ok: true,
      id,
      nsPerOp: Number(totalNs) / iterations,
      iterations,
      batches,
      elapsedMs: Number(totalNs) / 1_000_000,
      // Reading the sink is what makes every write to it observable, which
      // is what makes those writes something V8 cannot optimize away.
      sinkType: typeof sink,
    })
  } catch (e) {
    await emit({ ok: false, id, error: `${fnName}: ${(e as Error).message}` })
  }
}

await main()

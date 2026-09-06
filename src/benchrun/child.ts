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
 * Written on every call, read once at the end via `sinkType`. Consuming the
 * return value this way is cheap insurance against an optimizer deciding an
 * unread result is dead and eliding the work that produced it. Measured
 * directly (see task-12-report.md): the specific V8 build and benchmark
 * shapes tested so far did NOT eliminate the loop even with the sink
 * removed, so this is not known to be load-bearing today -- it is kept
 * because that is a fact about one V8 version and a handful of shapes, not
 * a guarantee, and the cost of keeping it is one assignment and one read.
 */
let sink: unknown

type Bench = () => unknown

/** True for a promise or any other thenable a benchmark might return. */
function isThenable(v: unknown): v is PromiseLike<unknown> {
  return v !== null && typeof v === 'object' && typeof (v as PromiseLike<unknown>).then === 'function'
}

/**
 * Arbitrary repository code can `throw` anything, not just an `Error` --
 * `throw null` or `throw 'boom'` are both legal JS. `(e as Error).message`
 * on a non-Error throws its own TypeError, which would crash this process
 * with no --out file written at all: exactly the crash this module exists
 * to avoid.
 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

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

interface Args {
  file: string
  fnName: string
  id: string
  benchtimeMs: number
  warmupMs: number
  out: string
}

function isNonNegativeInteger(n: number): boolean {
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0
}

type ParseResult =
  | { ok: true; args: Args }
  | { ok: false; attributable: true; id: string; out: string; message: string }
  | { ok: false; attributable: false; message: string }

/**
 * Parses and validates argv. --out and --id are checked first because they
 * are what let any OTHER failure be reported at all -- without an output
 * path or an id to put in it, an invalid-invocation result cannot be
 * attributed to any benchmark, so their absence is fatal (caller exits
 * non-zero) rather than reported as a benchmark result the way every other
 * validation failure is.
 */
function parseArgv(): ParseResult {
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

  const out = values.out
  const id = values.id
  if (typeof out !== 'string' || out === '' || typeof id !== 'string' || id === '') {
    return { ok: false, attributable: false, message: 'missing --out or --id' }
  }

  const file = values.file
  if (typeof file !== 'string' || file === '') {
    return { ok: false, attributable: true, id, out, message: 'missing --file' }
  }
  const fnName = values.fn
  if (typeof fnName !== 'string' || fnName === '') {
    return { ok: false, attributable: true, id, out, message: 'missing --fn' }
  }
  const benchtimeMs = Number(values['benchtime-ms'])
  if (!isNonNegativeInteger(benchtimeMs)) {
    return {
      ok: false,
      attributable: true,
      id,
      out,
      message: `--benchtime-ms must be a non-negative integer, got ${JSON.stringify(values['benchtime-ms'])}`,
    }
  }
  const warmupMs = Number(values['warmup-ms'])
  if (!isNonNegativeInteger(warmupMs)) {
    return {
      ok: false,
      attributable: true,
      id,
      out,
      message: `--warmup-ms must be a non-negative integer, got ${JSON.stringify(values['warmup-ms'])}`,
    }
  }
  return { ok: true, args: { file, fnName, id, benchtimeMs, warmupMs, out } }
}

async function measure(args: Args): Promise<BenchResult> {
  let fn: Bench
  try {
    const mod = (await import(pathToFileURL(args.file).href)) as Record<string, unknown>
    const candidate = mod[args.fnName]
    if (typeof candidate !== 'function') {
      return { ok: false, id: args.id, error: `${args.file} does not export a function named ${args.fnName}` }
    }
    fn = candidate as Bench
  } catch (e) {
    return { ok: false, id: args.id, error: `import ${args.file}: ${messageOf(e)}` }
  }

  try {
    // Probe once to learn whether the benchmark is async. Awaiting a
    // synchronous function would fold microtask-queue overhead into every
    // measurement, so the two cases get separate loops: runBatchSync never
    // awaits, runBatchAsync always does.
    const probe = fn()
    const isAsync = isThenable(probe)
    if (isAsync) await probe
    sink = probe

    const batch = isAsync
      ? (n: number): Promise<bigint> => runBatchAsync(fn, n)
      : (n: number): Promise<bigint> => Promise.resolve(runBatchSync(fn, n))

    // Warm up first: JIT tiering changes the speed we are about to
    // calibrate to, so calibrating against a cold function would pick a
    // batch size for code that no longer exists by the time we measure.
    const warmDeadline = process.hrtime.bigint() + BigInt(args.warmupMs) * 1_000_000n
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
    const deadline = process.hrtime.bigint() + BigInt(args.benchtimeMs) * 1_000_000n
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

    // The initial probe is a single, un-timed call: it decides which loop
    // measures every batch for the rest of the run. A benchmark that took
    // a synchronous fast path on that one call (a cache hit, an early
    // return) but later starts returning promises (a cache miss, a lazily
    // opened connection) would stay on runBatchSync, which never awaits --
    // silently timing promise *construction* instead of the awaited work,
    // and reporting a real-looking nsPerOp that is orders of magnitude too
    // small. One check here, after the loop, is enough to catch it without
    // adding a per-iteration cost to every measurement.
    if (!isAsync && isThenable(sink)) {
      return {
        ok: false,
        id: args.id,
        error: `${args.fnName}: benchmark is conditionally async -- the initial probe call returned a plain value so it was measured synchronously, but a later call returned a promise; measured timings would reflect promise construction, not the awaited work`,
      }
    }

    return {
      ok: true,
      id: args.id,
      nsPerOp: Number(totalNs) / iterations,
      iterations,
      batches,
      elapsedMs: Number(totalNs) / 1_000_000,
      // typeof the value consumed above -- see the `sink` declaration for
      // why it is read at all.
      sinkType: typeof sink,
    }
  } catch (e) {
    return { ok: false, id: args.id, error: `${args.fnName}: ${messageOf(e)}` }
  }
}

async function main(): Promise<void> {
  const parsed = parseArgv()
  if (!parsed.ok && !parsed.attributable) {
    // No --out and/or --id: there is nowhere to write a result and nothing
    // to attribute it to, so this is the one failure mode that is not
    // reported as a benchmark result.
    process.stderr.write(`benchrun child: invalid invocation: ${parsed.message}\n`)
    process.exit(1)
  }
  if (parsed.ok) {
    const result = await measure(parsed.args)
    await writeFile(parsed.args.out, JSON.stringify(result))
    return
  }
  await writeFile(
    parsed.out,
    JSON.stringify({ ok: false, id: parsed.id, error: `invalid invocation: ${parsed.message}` }),
  )
}

await main()
// A benchmark module can leave the event loop non-empty on its way out (an
// open timer, a socket, a lingering connection pool) even though the result
// is already written. Without an explicit exit, node would wait for that
// handle and the parent would eventually kill this process on timeout,
// discarding a result that was complete on disk the whole time -- the same
// "arbitrary repository code" reasoning that justified --out in the first
// place.
process.exit(0)

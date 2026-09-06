/** One benchmark measured once, as written by the child process. */
export type BenchResult =
  | {
      ok: true
      id: string
      /** Mean nanoseconds per operation across the measured window. */
      nsPerOp: number
      iterations: number
      batches: number
      elapsedMs: number
      /** typeof the sink value, proving the return value was consumed. */
      sinkType: string
    }
  | { ok: false; id: string; error: string }

/**
 * Parses one child result, validating just enough that a caller never
 * silently treats corrupt data as a real measurement.
 *
 * Only `ok` and `id` were checked before this fix -- documented as an
 * accepted limitation for a self-produced protocol, until the final
 * whole-branch review reclassified it as a defect: a SIGKILL mid-`writeFile`
 * (the timeout path, or an OS-level kill) can land after the JSON document
 * is syntactically complete but before every field inside it was written --
 * e.g. an atomic-rename race that leaves `"nsPerOp":` followed by a
 * half-written number, or a field simply absent from an otherwise
 * well-formed object. `JSON.parse` succeeds either way, so only an explicit
 * check here stops `nsPerOp: undefined` (or `NaN`, or `-1`) from reaching
 * the statistics layer looking like a legitimate zero-cost measurement.
 */
export function parseBenchResult(text: string): BenchResult {
  const v: unknown = JSON.parse(text)
  if (typeof v !== 'object' || v === null || !('ok' in v) || !('id' in v)) {
    throw new Error(`malformed benchmark result: ${text.slice(0, 200)}`)
  }
  const r = v as BenchResult
  if (r.ok === true && !(typeof r.nsPerOp === 'number' && Number.isFinite(r.nsPerOp) && r.nsPerOp > 0)) {
    throw new Error(
      `malformed benchmark result: ok:true but nsPerOp is not a finite positive number ` +
        `(got ${JSON.stringify((v as { nsPerOp?: unknown }).nsPerOp)}): ${text.slice(0, 200)}`,
    )
  }
  return r
}

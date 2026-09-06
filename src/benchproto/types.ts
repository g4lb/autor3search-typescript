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

export function parseBenchResult(text: string): BenchResult {
  const v: unknown = JSON.parse(text)
  if (typeof v !== 'object' || v === null || !('ok' in v) || !('id' in v)) {
    throw new Error(`malformed benchmark result: ${text.slice(0, 200)}`)
  }
  return v as BenchResult
}

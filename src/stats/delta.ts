import { median } from './geomean.js'
import { mannWhitneyU } from './mannwhitney.js'

/**
 * The significance threshold. Deliberately a constant and not a config key:
 * it is the one number the optimizing agent must not be able to argue with.
 */
export const ALPHA = 0.05

/** One benchmark compared across the two sides. */
export interface Delta {
  name: string
  /** Median nanoseconds per operation on the baseline. */
  baseNs: number
  /** Median nanoseconds per operation on the candidate. */
  candNs: number
  /** Percent change; negative is faster. */
  pctChange: number
  /** Two-sided p-value. */
  p: number
  /** p < ALPHA, uncorrected. The honest statistic, not the KEEP threshold. */
  significant: boolean
  /** Whether the exact test was used. */
  exact: boolean
}

export function compare(
  name: string,
  base: readonly number[],
  cand: readonly number[],
): Delta {
  const baseNs = median(base)
  const candNs = median(cand)
  const { p, exact } = mannWhitneyU(base, cand)
  return {
    name,
    baseNs,
    candNs,
    pctChange: ((candNs - baseNs) / baseNs) * 100,
    p,
    significant: p < ALPHA,
    exact,
  }
}

/**
 * Compares every benchmark, requiring both sides to declare exactly the same
 * set. A mismatch is an error rather than an intersection: silently comparing
 * only the overlap would let a candidate drop a benchmark it regressed and
 * still be scored.
 */
export function compareAll(
  base: ReadonlyMap<string, number[]>,
  cand: ReadonlyMap<string, number[]>,
): Delta[] {
  const missing = [...base.keys()].filter((k) => !cand.has(k)).sort()
  if (missing.length > 0) {
    throw new Error(
      `candidate is missing benchmarks present in the baseline: ${missing.join(', ')}`,
    )
  }
  const extra = [...cand.keys()].filter((k) => !base.has(k)).sort()
  if (extra.length > 0) {
    throw new Error(
      `candidate declares unexpected benchmarks absent from the baseline: ${extra.join(', ')}`,
    )
  }
  return [...base.keys()]
    .sort()
    .map((name) => compare(name, base.get(name)!, cand.get(name)!))
}

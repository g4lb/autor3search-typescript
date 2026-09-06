import { geoMean } from '../stats/geomean.js'
import { ALPHA, type Delta } from '../stats/delta.js'
import { minAchievableP } from '../stats/mannwhitney.js'

export type Status = 'keep' | 'discard' | 'fail' | 'crash'

export const EXIT_CODES: Record<Status, number> = {
  keep: 0,
  discard: 1,
  fail: 2,
  crash: 3,
}

export type DiscardReason =
  /** Nothing measurably moved. */
  | 'no_significant_improvement'
  /** It really did speed things up, by less than min_effect_pct. */
  | 'improvement_below_min_effect'
  /** At least one benchmark got significantly and materially worse. */
  | 'significant_regression'

export interface Verdict {
  status: Status
  /** geomean of candidate/baseline time ratios. Below 1 is faster. */
  score: number
  reason?: DiscardReason
  /** Names of benchmarks that triggered the regression guard. */
  regressions: string[]
  correctedAlpha: number
  /** Never changes the decision; explains when it cannot be read at face value. */
  warnings: string[]
}

export interface VerdictInput {
  deltas: Delta[]
  minEffectPct: number
  maxRegressPct: number
  /** Measured rounds per side, for the sample-size warnings. */
  rounds: number
}

/** At 95% confidence the median's interval needs at least this many samples. */
const MIN_ROUNDS_FOR_CI = 6

export function decide(input: VerdictInput): Verdict {
  const { deltas, minEffectPct, maxRegressPct, rounds } = input
  if (deltas.length === 0) {
    throw new Error('cannot decide with no benchmarks compared')
  }

  // decide() must be total: its Delta[] input comes from the statistics
  // layer, which this module does not control. Left unchecked, a zero or
  // negative baseNs/candNs (division, or a 0/0 ratio) or an out-of-range p
  // would either throw geoMean's generic "must be positive" error with no
  // benchmark attached, or -- for a positive/zero ratio, which geoMean's
  // check happily lets through -- silently produce an infinite score. Reject
  // it explicitly here instead, naming the benchmark, so a corrupt upstream
  // Delta is diagnosable at the boundary rather than three frames deep or
  // not diagnosed at all.
  for (const delta of deltas) {
    if (!(delta.baseNs > 0) || !Number.isFinite(delta.baseNs)) {
      throw new Error(
        `invalid delta for "${delta.name}": baseNs must be a positive finite number, got ${delta.baseNs}`,
      )
    }
    if (!(delta.candNs > 0) || !Number.isFinite(delta.candNs)) {
      throw new Error(
        `invalid delta for "${delta.name}": candNs must be a positive finite number, got ${delta.candNs}`,
      )
    }
    if (!(delta.p >= 0 && delta.p <= 1)) {
      throw new Error(`invalid delta for "${delta.name}": p must be a number in [0, 1], got ${delta.p}`)
    }
  }

  const score = geoMean(deltas.map((d) => d.candNs / d.baseNs))
  const k = deltas.length
  const correctedAlpha = ALPHA / k

  const warnings: string[] = []
  if (rounds < MIN_ROUNDS_FOR_CI) {
    warnings.push(
      `only ${rounds} rounds per side: a 95% confidence interval for the median needs at least ` +
        `${MIN_ROUNDS_FOR_CI} observations, so below that it is unbounded`,
    )
  }
  const floor = minAchievableP(rounds, rounds)
  if (floor > correctedAlpha) {
    const suggestion = requiredCount(k)
    const advice =
      suggestion === undefined
        ? `No per-side round count up to ${MAX_REQUIRED_COUNT} would clear it either — reduce the ` +
          `number of benchmarks compared instead.`
        : `Raise count to at least ${suggestion}.`
    warnings.push(
      `no KEEP was reachable: with ${rounds} rounds per side the smallest attainable two-sided ` +
        `p-value is ${floor.toExponential(2)}, above the Bonferroni-corrected threshold of ` +
        `${correctedAlpha.toExponential(2)} for ${k} benchmarks — every experiment would discard ` +
        `regardless of what changed. ${advice}`,
    )
  }

  // Harm first, and deliberately at the UNCORRECTED alpha. The Bonferroni
  // correction only ever makes significance harder to declare; applying it
  // here would make real regressions easier to miss. Conservative about
  // accepting a win, liberal about catching damage.
  const regressions = deltas
    .filter((d) => d.significant && d.pctChange > maxRegressPct)
    .map((d) => d.name)
  if (regressions.length > 0) {
    return { status: 'discard', score, reason: 'significant_regression', regressions, correctedAlpha, warnings }
  }

  const anyCorrectedSignificantWin = deltas.some((d) => d.p < correctedAlpha && d.pctChange < 0)
  if (!anyCorrectedSignificantWin) {
    return { status: 'discard', score, reason: 'no_significant_improvement', regressions, correctedAlpha, warnings }
  }

  const threshold = 1 - minEffectPct / 100
  if (!(score < threshold)) {
    return { status: 'discard', score, reason: 'improvement_below_min_effect', regressions, correctedAlpha, warnings }
  }

  return { status: 'keep', score, regressions, correctedAlpha, warnings }
}

/** Largest per-side round count `requiredCount` will search up to. */
const MAX_REQUIRED_COUNT = 64

/**
 * The smallest per-side round count whose exact p-floor clears ALPHA/k, or
 * `undefined` if no count up to `MAX_REQUIRED_COUNT` does.
 *
 * The brief's version returned the cap itself in that case, which reads as
 * "raising count to 64 fixes it" when 64 in fact still cannot clear the
 * bar — misleading advice for a caller that acts on it and then watches
 * every experiment keep discarding anyway. Reporting "unreachable"
 * explicitly instead lets the caller be told to reduce benchmark count
 * instead of chasing a round count that was never going to help.
 *
 * Exported for testing: the case this guards against needs k on the order
 * of 1e36 (floor(64, 64) is about 8.35e-38) to reach the cap for real,
 * which is unreachable through `decide`'s own Delta[] input without
 * constructing an array of that size.
 */
export function requiredCount(k: number): number | undefined {
  for (let n = 4; n <= MAX_REQUIRED_COUNT; n++) {
    if (minAchievableP(n, n) < ALPHA / k) return n
  }
  return undefined
}

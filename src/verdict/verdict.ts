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
    warnings.push(
      `no KEEP was reachable: with ${rounds} rounds per side the smallest attainable two-sided ` +
        `p-value is ${floor.toExponential(2)}, above the Bonferroni-corrected threshold of ` +
        `${correctedAlpha.toExponential(2)} for ${k} benchmarks — every experiment would discard ` +
        `regardless of what changed. Raise count to at least ${requiredCount(k)}.`,
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

/** The smallest per-side round count whose exact p-floor clears ALPHA/k. */
function requiredCount(k: number): number {
  for (let n = 4; n <= 64; n++) {
    if (minAchievableP(n, n) < ALPHA / k) return n
  }
  return 64
}

/**
 * Exact and approximate Mann-Whitney U test.
 *
 * Benchmark rounds give us small samples (default 10 per side), where the
 * normal approximation is poor. For small n with no ties we enumerate the
 * exact null distribution instead; that is also what makes the p-value floor
 * in `minAchievableP` a real, reportable property rather than an estimate.
 */

export interface MannWhitneyResult {
  /** The U statistic for the smaller of the two rank sums. */
  u: number
  /** Two-sided p-value, in [0, 1]. */
  p: number
  /** True when the exact null distribution was used. */
  exact: boolean
}

/**
 * Largest n1*n2 for which we build the exact distribution.
 *
 * The DP table's total footprint grows much faster than n1*n2 itself: at
 * n1=n2=50 (2_500) it holds 1,628,226 Float64 entries, about 12 MB; at
 * n1=n2=100 (10_000) — a value `count` can reach with no upper bound in
 * config, and one the README will tell users to raise on a noisy machine —
 * it holds 25,512,701 entries, about 195 MB, once per benchmark per
 * experiment. That is a plausible way to OOM a memory-constrained CI runner,
 * not a theoretical edge case. Above this bound we fall back to the normal
 * approximation, which is essentially exact once each sample exceeds ~50
 * observations.
 */
const MAX_EXACT_CELLS = 2_500

/**
 * Counts of the U statistic under the null hypothesis.
 *
 * table[u] is the number of arrangements of n1 and n2 observations giving
 * statistic u, via c(i, j, u) = c(i-1, j, u-j) + c(i, j-1, u).
 */
function uCounts(n1: number, n2: number): Float64Array {
  const table: Float64Array[][] = []
  for (let i = 0; i <= n1; i++) {
    const row: Float64Array[] = []
    for (let j = 0; j <= n2; j++) row.push(new Float64Array(i * j + 1))
    table.push(row)
  }
  table[0]![0]![0] = 1
  for (let i = 0; i <= n1; i++) {
    for (let j = 0; j <= n2; j++) {
      if (i === 0 && j === 0) continue
      const cur = table[i]![j]!
      for (let u = 0; u <= i * j; u++) {
        let v = 0
        if (i > 0 && u - j >= 0 && u - j <= (i - 1) * j) v += table[i - 1]![j]![u - j]!
        if (j > 0 && u <= i * (j - 1)) v += table[i]![j - 1]![u]!
        cur[u] = v
      }
    }
  }
  return table[n1]![n2]!
}

/** Binomial coefficient, exact for the sizes we use. */
function binomial(n: number, k: number): number {
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return Math.round(r)
}

/**
 * The smallest two-sided p-value the exact test can ever produce at these
 * sample sizes: 2 / C(n1+n2, n1). No degree of separation between the samples
 * can go below it. For equal sizes this is the 2/C(2n,n) floor that makes a
 * Bonferroni-corrected KEEP unreachable once there are enough benchmarks.
 */
export function minAchievableP(n1: number, n2: number): number {
  return Math.min(1, 2 / binomial(n1 + n2, n1))
}

/** Tie-averaged ranks of `values`, in the original element order. */
function rank(values: readonly number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }))
  idx.sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(values.length)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++
    // Ranks are 1-based; tied entries share their average rank.
    const avg = (i + j + 2) / 2
    for (let k = i; k <= j; k++) ranks[idx[k]!.i] = avg
    i = j + 1
  }
  return ranks
}

function hasTies(values: readonly number[]): boolean {
  return new Set(values).size !== values.length
}

/** Normal CDF via the complementary error function. */
function normalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26 applied to erf.
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x)
  return 0.5 * (1 + sign * y)
}

/**
 * Two-sided Mann-Whitney U test. Neither input is modified.
 */
export function mannWhitneyU(
  a: readonly number[],
  b: readonly number[],
): MannWhitneyResult {
  if (a.length === 0 || b.length === 0) {
    throw new Error('mannWhitneyU: each sample needs at least one observation')
  }
  // These slices are not what stops caller mutation today: rank() sorts a
  // derived array of {v, i} pairs rather than `combined`, and `combined`
  // (built with concat() below) is already a fresh array regardless of
  // whether xa/xb are copies. The "does not mutate its inputs" guarantee
  // currently comes entirely from rank()'s design. We keep these copies
  // anyway — they are cheap, and they keep that guarantee true even if
  // rank() is later changed to sort its argument in place.
  const xa = a.slice()
  const xb = b.slice()
  const n1 = xa.length
  const n2 = xb.length

  const combined = xa.concat(xb)
  const ranks = rank(combined)
  let rankSumA = 0
  for (let i = 0; i < n1; i++) rankSumA += ranks[i]!

  const uA = rankSumA - (n1 * (n1 + 1)) / 2
  const uB = n1 * n2 - uA
  const u = Math.min(uA, uB)

  const ties = hasTies(combined)
  if (!ties && n1 * n2 <= MAX_EXACT_CELLS) {
    const counts = uCounts(n1, n2)
    let atOrBelow = 0
    for (let k = 0; k <= u; k++) atOrBelow += counts[k]!
    const total = binomial(n1 + n2, n1)
    const p = Math.min(1, (2 * atOrBelow) / total)
    return { u, p, exact: true }
  }

  // Normal approximation with a tie correction on the variance.
  const mean = (n1 * n2) / 2
  const n = n1 + n2
  const counts = new Map<number, number>()
  for (const v of combined) counts.set(v, (counts.get(v) ?? 0) + 1)
  let tieTerm = 0
  for (const c of counts.values()) tieTerm += c * c * c - c
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)))
  if (variance <= 0) return { u, p: 1, exact: false }
  // Continuity correction.
  const z = (Math.abs(u - mean) - 0.5) / Math.sqrt(variance)
  const p = Math.min(1, 2 * (1 - normalCdf(z)))
  return { u, p, exact: false }
}

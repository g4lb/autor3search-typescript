/**
 * `summarize()`'s `cumulativeSpeedup` is a product of candidate/baseline
 * TIME RATIOS -- below 1 is faster -- not a speedup factor itself. Printing
 * it directly, suffixed `x`, reads as its own inverse: a genuine 12x win
 * (a ratio of ~0.0833) prints as "0.0833x," which a human reads as "twelve
 * times slower." This is the one number most likely to be read without the
 * surrounding context of `summarize`'s own doc comment, so it must read
 * correctly on its own.
 *
 * `1 / cumulativeSpeedup` is the actual "N times faster" figure a human
 * expects; the raw ratio is kept alongside it, labeled explicitly, for
 * anyone who wants the underlying number `summarize` actually computed.
 */
export function formatCumulativeSpeedup(cumulativeSpeedup: number): string {
  if (!(cumulativeSpeedup > 0) || !Number.isFinite(cumulativeSpeedup)) {
    // Never reachable through `summarize`'s own product-of-scores (score is
    // validated positive and finite before it ever reaches decide(), let
    // alone this), but this function must still be total for whatever
    // corrupted or synthetic input it is ever handed.
    return `${cumulativeSpeedup.toFixed(4)}x (cumulative time ratio)`
  }
  const factor = 1 / cumulativeSpeedup
  return `${factor.toFixed(2)}x faster (cumulative time ratio ${cumulativeSpeedup.toFixed(4)})`
}

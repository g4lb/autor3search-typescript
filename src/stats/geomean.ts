/** Geometric mean. Used to combine per-benchmark ratios into one score. */
export function geoMean(values: readonly number[]): number {
  if (values.length === 0) throw new Error('geoMean: empty value set')
  let sumLog = 0
  for (const v of values) {
    if (!(v > 0)) throw new Error(`geoMean: values must be positive, got ${v}`)
    sumLog += Math.log(v)
  }
  return Math.exp(sumLog / values.length)
}

/** Median. Does not modify the caller's array. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median: empty value set')
  const xs = values.slice().sort((a, b) => a - b)
  const mid = xs.length >> 1
  return xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2
}

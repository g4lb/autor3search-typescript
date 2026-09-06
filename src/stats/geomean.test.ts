import { describe, expect, it } from 'vitest'
import { geoMean, median } from './geomean.js'

describe('geoMean', () => {
  it('is the nth root of the product', () => {
    expect(geoMean([1, 4])).toBeCloseTo(2, 12)
    expect(geoMean([0.5, 0.5])).toBeCloseTo(0.5, 12)
  })

  it('returns 1 for a set of no-change ratios', () => {
    expect(geoMean([1, 1, 1])).toBeCloseTo(1, 12)
  })

  it('rejects non-positive values, which have no logarithm', () => {
    expect(() => geoMean([1, 0])).toThrow(/positive/)
    expect(() => geoMean([1, -2])).toThrow(/positive/)
  })

  it('rejects an empty set', () => {
    expect(() => geoMean([])).toThrow(/empty/)
  })
})

describe('median', () => {
  it('takes the middle of an odd-length sample', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middle values of an even-length sample', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('does NOT mutate its input', () => {
    const xs = [9, 1, 5]
    median(xs)
    expect(xs).toEqual([9, 1, 5])
  })
})

import { describe, expect, it } from 'vitest'
import { mannWhitneyU, minAchievableP } from './mannwhitney.js'

describe('mannWhitneyU', () => {
  it('gives U=0 and the exact floor p for fully separated samples of 4', () => {
    const r = mannWhitneyU([1, 2, 3, 4], [5, 6, 7, 8])
    expect(r.u).toBe(0)
    expect(r.exact).toBe(true)
    // 2 / C(8,4) = 2/70
    expect(r.p).toBeCloseTo(2 / 70, 12)
  })

  it('cannot reach alpha at n=3 per side, however separated', () => {
    const r = mannWhitneyU([1, 2, 3], [100, 200, 300])
    expect(r.p).toBeCloseTo(0.1, 12)
    expect(r.p).toBeGreaterThan(0.05)
  })

  it('cannot reach alpha at n=2 per side', () => {
    const r = mannWhitneyU([1, 2], [100, 200])
    expect(r.p).toBeCloseTo(1 / 3, 12)
  })

  it('returns p=1 for identical samples', () => {
    const r = mannWhitneyU([5, 5, 5, 5], [5, 5, 5, 5])
    expect(r.p).toBe(1)
  })

  it('is symmetric in its arguments', () => {
    const a = [1, 4, 6, 9, 11]
    const b = [2, 3, 7, 8, 15]
    expect(mannWhitneyU(a, b).p).toBeCloseTo(mannWhitneyU(b, a).p, 12)
  })

  it('does NOT mutate its inputs', () => {
    const a = [9, 1, 5, 3]
    const b = [8, 2, 6, 4]
    mannWhitneyU(a, b)
    expect(a).toEqual([9, 1, 5, 3])
    expect(b).toEqual([8, 2, 6, 4])
  })

  it('falls back to the normal approximation when there are ties', () => {
    const r = mannWhitneyU([1, 2, 3, 4], [4, 5, 6, 7])
    expect(r.exact).toBe(false)
    expect(r.p).toBeGreaterThan(0)
    expect(r.p).toBeLessThanOrEqual(1)
  })

  it('rejects empty samples', () => {
    expect(() => mannWhitneyU([], [1, 2])).toThrow(/at least one observation/)
  })

  it('falls back to the normal approximation once n1*n2 exceeds the exact-DP cell budget', () => {
    // 51*51 = 2601 cells, just over the 2_500 budget, with no ties (the
    // interleaved evens/odds keep the combined set tie-free) so this would
    // otherwise qualify for the exact path. Interleaved rather than fully
    // separated, so the resulting p-value is not so extreme it underflows
    // to 0 in the normal approximation.
    const a = Array.from({ length: 51 }, (_, i) => i * 2)
    const b = Array.from({ length: 51 }, (_, i) => i * 2 + 1)
    const r = mannWhitneyU(a, b)
    expect(r.exact).toBe(false)
    expect(r.p).toBeGreaterThan(0)
    expect(r.p).toBeLessThanOrEqual(1)
  })
})

describe('minAchievableP', () => {
  it('is 2/C(2n,n) for equal sample sizes', () => {
    expect(minAchievableP(4, 4)).toBeCloseTo(2 / 70, 12)
    expect(minAchievableP(3, 3)).toBeCloseTo(0.1, 12)
    expect(minAchievableP(10, 10)).toBeCloseTo(2 / 184756, 12)
  })
})

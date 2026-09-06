import { describe, expect, it } from 'vitest'
import type { Delta } from '../stats/delta.js'
import { decide, requiredCount } from './verdict.js'

function d(over: Partial<Delta> & { name: string }): Delta {
  return {
    baseNs: 100, candNs: 100, pctChange: 0, p: 1, significant: false, exact: true, ...over,
  }
}
const BASE = { minEffectPct: 1, maxRegressPct: 5, rounds: 10 }

describe('decide', () => {
  it('KEEPs a large, significant, uniform improvement', () => {
    const v = decide({ ...BASE, deltas: [d({ name: 'a', candNs: 50, pctChange: -50, p: 0.0001, significant: true })] })
    expect(v.status).toBe('keep')
    expect(v.score).toBeCloseTo(0.5, 6)
  })

  it('DISCARDs when nothing moved, with reason no_significant_improvement', () => {
    const v = decide({ ...BASE, deltas: [d({ name: 'a' })] })
    expect(v.status).toBe('discard')
    expect(v.reason).toBe('no_significant_improvement')
  })

  it('DISCARDs a real but tiny win with reason improvement_below_min_effect', () => {
    // 0.5% faster, unambiguously significant: directionally right, too small.
    const v = decide({
      ...BASE,
      deltas: [d({ name: 'a', candNs: 99.5, pctChange: -0.5, p: 0.0001, significant: true })],
    })
    expect(v.status).toBe('discard')
    expect(v.reason).toBe('improvement_below_min_effect')
  })

  it('DISCARDs a win that fails the Bonferroni-corrected bar', () => {
    // p = 0.02: significant at raw alpha, but not at 0.05/4.
    const deltas = [
      d({ name: 'a', candNs: 50, pctChange: -50, p: 0.02, significant: true }),
      d({ name: 'b' }), d({ name: 'c' }), d({ name: 'd' }),
    ]
    const v = decide({ ...BASE, deltas })
    expect(v.status).toBe('discard')
    expect(v.reason).toBe('no_significant_improvement')
    expect(v.correctedAlpha).toBeCloseTo(0.05 / 4, 12)
  })

  it('DISCARDs when one benchmark regresses significantly beyond the cap', () => {
    const deltas = [
      d({ name: 'a', candNs: 40, pctChange: -60, p: 0.0001, significant: true }),
      d({ name: 'b', candNs: 130, pctChange: 30, p: 0.001, significant: true }),
    ]
    const v = decide({ ...BASE, deltas })
    expect(v.status).toBe('discard')
    expect(v.reason).toBe('significant_regression')
    expect(v.regressions).toEqual(['b'])
  })

  it('uses the UNCORRECTED alpha for the regression guard', () => {
    // p = 0.02 is significant at 0.05 but not at 0.05/4. The regression must
    // still be caught: the correction only makes significance harder to
    // declare, so applying it here would make real harm easier to miss.
    const deltas = [
      d({ name: 'a', candNs: 20, pctChange: -80, p: 0.0001, significant: true }),
      d({ name: 'b', candNs: 130, pctChange: 30, p: 0.02, significant: true }),
      d({ name: 'c' }), d({ name: 'd' }),
    ]
    const v = decide({ ...BASE, deltas })
    expect(v.status).toBe('discard')
    expect(v.reason).toBe('significant_regression')
  })

  it('tolerates a small significant regression within max_regress_pct', () => {
    const deltas = [
      d({ name: 'a', candNs: 50, pctChange: -50, p: 0.0001, significant: true }),
      d({ name: 'b', candNs: 103, pctChange: 3, p: 0.001, significant: true }),
    ]
    expect(decide({ ...BASE, deltas }).status).toBe('keep')
  })

  it('ignores a large but NON-significant regression', () => {
    const deltas = [
      d({ name: 'a', candNs: 50, pctChange: -50, p: 0.0001, significant: true }),
      d({ name: 'b', candNs: 140, pctChange: 40, p: 0.7, significant: false }),
    ]
    expect(decide({ ...BASE, deltas }).status).toBe('keep')
  })

  it('warns when no KEEP was reachable at this round count', () => {
    // 7 benchmarks at 5 rounds: corrected alpha 0.00714 is below the exact
    // test's floor of 2/C(10,5) = 0.00794, so nothing could ever KEEP.
    const deltas = Array.from({ length: 7 }, (_, i) => d({ name: `b${i}` }))
    const v = decide({ ...BASE, rounds: 5, deltas })
    expect(v.warnings.join(' ')).toMatch(/no KEEP.*reachable/i)
    expect(v.warnings.join(' ')).toMatch(/count/)
  })

  it('warns when there are too few observations for a median confidence interval', () => {
    const v = decide({ ...BASE, rounds: 5, deltas: [d({ name: 'a' })] })
    expect(v.warnings.join(' ')).toMatch(/confidence interval/i)
  })

  it('never lets a warning change the decision', () => {
    const withWarn = decide({ ...BASE, rounds: 5, deltas: [d({ name: 'a', candNs: 50, pctChange: -50, p: 0.0001, significant: true })] })
    expect(withWarn.status).toBe('keep')
    expect(withWarn.warnings.length).toBeGreaterThan(0)
  })

  it('throws on an empty delta set rather than scoring nothing', () => {
    expect(() => decide({ ...BASE, deltas: [] })).toThrow(/no benchmarks/)
  })

  // decide() takes Delta[] straight from the statistics layer, which this
  // module does not control. A degenerate Delta (zero/negative baseNs, a
  // NaN p-value) must not be allowed to fall through to geoMean and throw
  // its generic, benchmark-less "must be positive" error three frames deep
  // -- decide() rejects it itself, naming the offending benchmark, so the
  // failure is diagnosable at the boundary where the bad data entered.
  it('rejects a delta with baseNs of zero instead of dividing by it silently', () => {
    const deltas = [d({ name: 'a', baseNs: 0, candNs: 10 })]
    expect(() => decide({ ...BASE, deltas })).toThrow(/"a"/)
  })

  it('rejects a delta whose ratio is NaN (both sides zero) instead of throwing from geoMean', () => {
    const deltas = [d({ name: 'a', baseNs: 0, candNs: 0 })]
    expect(() => decide({ ...BASE, deltas })).toThrow(/"a"/)
  })

  it('rejects a delta with a negative baseNs', () => {
    const deltas = [d({ name: 'a', baseNs: -5 })]
    expect(() => decide({ ...BASE, deltas })).toThrow(/"a"/)
  })

  it('rejects a delta with a NaN p-value', () => {
    const deltas = [d({ name: 'a', p: NaN })]
    expect(() => decide({ ...BASE, deltas })).toThrow(/"a"/)
  })

  it('rejects a delta with a p-value outside [0, 1]', () => {
    const deltas = [d({ name: 'a', p: 1.5 })]
    expect(() => decide({ ...BASE, deltas })).toThrow(/"a"/)
  })
})

describe('requiredCount', () => {
  it('finds the smallest per-side count whose floor clears ALPHA/k', () => {
    // floor(5,5) = 0.0079365 > 0.05/7 = 0.0071429; floor(6,6) = 0.0021645 clears it.
    expect(requiredCount(7)).toBe(6)
  })

  it('reports unreachable rather than falsely naming the cap as a fix', () => {
    // No per-side count up to the 64 cap gets the exact floor below this
    // threshold (floor(64, 64) is about 8.35e-38): returning 64 anyway, as
    // if raising count to 64 would fix it, would be misleading advice a
    // caller could act on and still see every experiment discard.
    expect(requiredCount(1e40)).toBeUndefined()
  })
})

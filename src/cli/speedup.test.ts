import { describe, expect, it } from 'vitest'
import { formatCumulativeSpeedup } from './speedup.js'

describe('formatCumulativeSpeedup', () => {
  it('prints the inverse of the ratio as "N faster", not the raw ratio suffixed x', () => {
    // A genuine 12x win is a candidate/baseline ratio of ~0.0833 -- printed
    // directly and suffixed "x" that reads as roughly twelve times SLOWER.
    const text = formatCumulativeSpeedup(1 / 12)
    expect(text).toMatch(/^12\.00x faster/)
    expect(text).not.toMatch(/^0\.0833x/)
  })

  it('still names the underlying raw ratio, for anyone who wants it', () => {
    const text = formatCumulativeSpeedup(0.72)
    expect(text).toMatch(/cumulative time ratio 0\.7200/)
  })

  it('reports "no speedup yet" (ratio 1) as 1.00x faster, not a division artifact', () => {
    expect(formatCumulativeSpeedup(1)).toMatch(/^1\.00x faster/)
  })

  it('is total against a zero ratio rather than dividing by zero', () => {
    expect(() => formatCumulativeSpeedup(0)).not.toThrow()
    expect(formatCumulativeSpeedup(0)).not.toMatch(/Infinity/)
  })
})

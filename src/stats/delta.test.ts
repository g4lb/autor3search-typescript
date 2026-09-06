import { describe, expect, it } from 'vitest'
import { ALPHA, compare, compareAll } from './delta.js'

const SLOW = [100, 101, 99, 102, 98, 100, 101, 99, 100, 102]
const FAST = [50, 51, 49, 52, 48, 50, 51, 49, 50, 52]

describe('ALPHA', () => {
  it('is 0.05 and is not configurable', () => {
    expect(ALPHA).toBe(0.05)
  })
})

describe('compare', () => {
  it('reports a large improvement as a negative pct change and significant', () => {
    const d = compare('bench', SLOW, FAST)
    expect(d.baseNs).toBeCloseTo(100, 6)
    expect(d.candNs).toBeCloseTo(50, 6)
    expect(d.pctChange).toBeCloseTo(-50, 6)
    expect(d.significant).toBe(true)
    expect(d.p).toBeLessThan(ALPHA)
  })

  it('reports a regression as a positive pct change', () => {
    const d = compare('bench', FAST, SLOW)
    expect(d.pctChange).toBeCloseTo(100, 6)
    expect(d.significant).toBe(true)
  })

  it('is not significant when the samples overlap', () => {
    const d = compare('bench', SLOW, [...SLOW])
    expect(d.significant).toBe(false)
    expect(d.pctChange).toBeCloseTo(0, 6)
  })
})

describe('compareAll', () => {
  it('produces one delta per benchmark present on both sides, name-sorted', () => {
    const base = new Map([['b', SLOW], ['a', SLOW]])
    const cand = new Map([['b', FAST], ['a', FAST]])
    const ds = compareAll(base, cand)
    expect(ds.map((d) => d.name)).toEqual(['a', 'b'])
  })

  it('throws when the candidate is missing a benchmark the baseline has', () => {
    const base = new Map([['a', SLOW], ['b', SLOW]])
    const cand = new Map([['a', FAST]])
    // \b...\b pins this to the standalone key "b", not just any message
    // containing the word "benchmarks" — it must fail if the implementation
    // names the wrong key (e.g. "a") or omits the key entirely.
    expect(() => compareAll(base, cand)).toThrow(/missing.*\bb\b/)
  })

  it('throws when the candidate adds a benchmark the baseline lacks', () => {
    const base = new Map([['a', SLOW]])
    const cand = new Map([['a', FAST], ['b', FAST]])
    expect(() => compareAll(base, cand)).toThrow(/unexpected.*\bb\b/)
  })
})

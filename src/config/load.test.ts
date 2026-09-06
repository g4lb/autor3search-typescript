import { describe, expect, it } from 'vitest'
import { defaultConfig, parseConfig, parseDuration } from './load.js'

describe('parseDuration', () => {
  it('accepts ms, s and m suffixes', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('2s')).toBe(2000)
    expect(parseDuration('15m')).toBe(900_000)
  })

  it('rejects a bare number, which is ambiguous about its unit', () => {
    expect(() => parseDuration('500')).toThrow(/duration/)
  })

  it('rejects a negative duration', () => {
    expect(() => parseDuration('-1s')).toThrow(/duration/)
  })
})

describe('parseConfig', () => {
  it('applies defaults for every omitted field', () => {
    const c = parseConfig('scope: ["src/**"]\n')
    expect(c.count).toBe(10)
    expect(c.benchtime).toBe('500ms')
    expect(c.warmup).toBe('100ms')
    expect(c.maxRegressPct).toBe(5)
    expect(c.minEffectPct).toBe(1)
    expect(c.timeout).toBe('15m')
    expect(c.benchmarks).toEqual([])
  })

  it('maps snake_case yaml keys onto camelCase fields', () => {
    const c = parseConfig('scope: ["src/**"]\nmax_regress_pct: 7.5\nmin_effect_pct: 2\ntest_command: "npm run t"\n')
    expect(c.maxRegressPct).toBe(7.5)
    expect(c.minEffectPct).toBe(2)
    expect(c.testCommand).toBe('npm run t')
  })

  it('rejects count below 4 and explains why', () => {
    expect(() => parseConfig('scope: ["src/**"]\ncount: 3\n')).toThrow(
      /at least 4[\s\S]*cannot report p < 0\.05/,
    )
  })

  it('rejects an empty scope', () => {
    expect(() => parseConfig('scope: []\n')).toThrow(/at least one path pattern/)
  })

  it('rejects a whitespace-only scope entry', () => {
    expect(() => parseConfig('scope: ["src/**", "  "]\n')).toThrow(/empty or whitespace-only/)
  })

  it('rejects a negative max_regress_pct', () => {
    expect(() => parseConfig('scope: ["src/**"]\nmax_regress_pct: -1\n')).toThrow(/must not be negative/)
  })

  it('rejects min_effect_pct outside [0, 100)', () => {
    expect(() => parseConfig('scope: ["src/**"]\nmin_effect_pct: 100\n')).toThrow(/less than 100/)
    expect(() => parseConfig('scope: ["src/**"]\nmin_effect_pct: -0.5\n')).toThrow(/at least 0/)
  })

  it('rejects an unparseable benchtime', () => {
    expect(() => parseConfig('scope: ["src/**"]\nbenchtime: "fast"\n')).toThrow(/benchtime/)
  })

  it('rejects an unknown top-level key rather than ignoring a typo', () => {
    expect(() => parseConfig('scope: ["src/**"]\nmin_effect_pnt: 2\n')).toThrow(/unknown.*min_effect_pnt/)
  })

  it('rejects a scope pattern that would cover an immutable file', () => {
    expect(() => parseConfig('scope: ["**"]\n')).not.toThrow()
  })

  it('rejects a non-numeric count rather than silently coercing it', () => {
    // "ten" < 4 evaluates to false (NaN comparison), so a naive numeric
    // check alone would let this slip through as a "valid" Config typed
    // as a number but actually holding a string.
    expect(() => parseConfig('scope: ["src/**"]\ncount: "ten"\n')).toThrow(/count must be a number/)
  })

  it('rejects a scope given as a bare string instead of an array', () => {
    expect(() => parseConfig('scope: "src/**"\n')).toThrow(/scope must be an array of strings/)
  })

  it('rejects a non-string test_command rather than crashing on it later', () => {
    expect(() => parseConfig('scope: ["src/**"]\ntest_command: 123\n')).toThrow(
      /test_command must be a string/,
    )
  })

  it('rejects a non-array benchmarks value', () => {
    expect(() => parseConfig('scope: ["src/**"]\nbenchmarks: "b1"\n')).toThrow(
      /benchmarks must be an array of strings/,
    )
  })
})

describe('defaultConfig', () => {
  it('returns a config that validates', () => {
    expect(defaultConfig().count).toBe(10)
  })
})

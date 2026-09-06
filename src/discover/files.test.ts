import { describe, expect, it } from 'vitest'
import { classify } from './files.js'

describe('classify', () => {
  it('recognises test and spec files in ts and js', () => {
    expect(classify('src/a.test.ts')).toBe('test')
    expect(classify('src/a.spec.ts')).toBe('test')
    expect(classify('src/a.test.js')).toBe('test')
    expect(classify('test/a.spec.mts')).toBe('test')
  })

  it('recognises bench files', () => {
    expect(classify('src/a.bench.ts')).toBe('bench')
    expect(classify('src/a.bench.js')).toBe('bench')
  })

  it('recognises test-runner config, which gates correctness', () => {
    expect(classify('vitest.config.ts')).toBe('runner-config')
    expect(classify('jest.config.js')).toBe('runner-config')
    expect(classify('vitest.config.mts')).toBe('runner-config')
  })

  it('treats everything else as source', () => {
    expect(classify('src/a.ts')).toBe('source')
    expect(classify('src/testing.ts')).toBe('source')
    expect(classify('src/benchmarks.ts')).toBe('source')
  })
})

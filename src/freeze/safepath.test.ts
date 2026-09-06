import { describe, expect, it } from 'vitest'
import { assertSafeRelPath } from './safepath.js'

describe('assertSafeRelPath', () => {
  it('accepts an ordinary relative path', () => {
    expect(() => assertSafeRelPath('src/a.test.ts')).not.toThrow()
  })

  it('rejects an absolute path', () => {
    expect(() => assertSafeRelPath('/etc/passwd')).toThrow(/absolute/)
  })

  it('rejects a parent traversal, including one hidden mid-path', () => {
    expect(() => assertSafeRelPath('../outside.ts')).toThrow(/traversal/)
    expect(() => assertSafeRelPath('src/../../outside.ts')).toThrow(/traversal/)
  })

  it('rejects an empty or dot path', () => {
    expect(() => assertSafeRelPath('')).toThrow(/empty/)
    expect(() => assertSafeRelPath('.')).toThrow(/empty/)
  })

  it('rejects a Windows-style absolute path', () => {
    expect(() => assertSafeRelPath('C:\\Windows\\system32')).toThrow(/absolute|backslash/)
  })
})

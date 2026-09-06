import { describe, expect, it } from 'vitest'
import { checkScope, matchGlob } from './scope.js'

describe('matchGlob', () => {
  it('matches * within one segment only', () => {
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/*.ts', 'src/deep/a.ts')).toBe(false)
  })

  it('matches ** across segments', () => {
    expect(matchGlob('src/**', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/**', 'src/deep/nested/a.ts')).toBe(true)
    expect(matchGlob('**', 'anything/at/all.ts')).toBe(true)
  })

  it('does not let a prefix match escape its directory', () => {
    expect(matchGlob('src/**', 'srcfake/a.ts')).toBe(false)
  })

  it('treats regex metacharacters in the pattern literally', () => {
    expect(matchGlob('src/a.ts', 'src/aXts')).toBe(false)
  })
})

describe('checkScope', () => {
  const SCOPE = ['src/**']

  it('accepts a change inside scope', () => {
    expect(checkScope(['src/a.ts'], SCOPE)).toEqual([])
  })

  it('rejects a change outside scope', () => {
    expect(checkScope(['tools/a.ts'], SCOPE)).toEqual([
      { file: 'tools/a.ts', reason: 'out-of-scope' },
    ])
  })

  it('rejects package.json even when scope would allow it', () => {
    expect(checkScope(['package.json'], ['**'])).toEqual([
      { file: 'package.json', reason: 'immutable' },
    ])
  })

  it('rejects every lockfile and tsconfig.json even under a permissive scope', () => {
    for (const f of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json']) {
      expect(checkScope([f], ['**'])).toEqual([{ file: f, reason: 'immutable' }])
    }
  })

  it('reports immutable before out-of-scope for the same file', () => {
    expect(checkScope(['package.json'], ['src/**'])).toEqual([
      { file: 'package.json', reason: 'immutable' },
    ])
  })

  it('reports every violation, not just the first', () => {
    const v = checkScope(['package.json', 'tools/x.ts'], SCOPE)
    expect(v).toHaveLength(2)
  })
})

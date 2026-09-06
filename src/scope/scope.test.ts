import { describe, expect, it } from 'vitest'
import { CONFIG_PATH } from '../config/schema.js'
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

  // Deferred minor #1 (SECURITY-RELEVANT), promoted to committed coverage:
  // `matchGlob` escapes a pattern character-by-character before compiling it
  // into a `RegExp`. Only `.` had a committed regression test; `+`, `(`,
  // `)`, `|`, `[`, `]`, `^`, `$`, `{`, `}` and `?` were checked by hand
  // during development and never committed. A future regression in
  // escaping any ONE of these would silently WIDEN the scope gate -- the
  // exact failure this gate exists to prevent -- and ship green with no
  // other test catching it. Each row's `pattern` always matches itself
  // literally; `wrongMatch` is a DIFFERENT string that a regex reading of
  // the un-escaped metacharacter would incorrectly also match (or, for `{`,
  // `^` and `$`, one where the un-escaped reading would incorrectly fail to
  // match `pattern` itself), so a regression in escaping is caught either
  // way it could go wrong.
  it.each([
    ['.', 'a.b', 'aXb'], // "." means "any char"
    ['+', 'a+b', 'ab'], // "+" means "one or more of the preceding char"
    ['?', 'a?b', 'b'], // "?" means "zero or one of the preceding char"
    ['|', 'a|b', 'a'], // "|" means alternation
    ['[', 'a[bc]', 'ab'], // "[bc]" means a character class matching "b" or "c"
    [']', 'a[bc]', 'ab'], // (shares a case with "[": a class needs both)
    ['(', '(ab)', 'ab'], // "(...)" means a (non-widening on its own, but
    [')', '(ab)', 'ab'], //  must not throw as unbalanced once escaped)
  ] as const)('treats regex metacharacter %j as literal: matches itself, not %j', (_char, pattern, wrongMatch) => {
    expect(matchGlob(pattern, pattern)).toBe(true)
    expect(matchGlob(pattern, wrongMatch)).toBe(false)
  })

  // "^" and "$" are anchors: unescaped, "a^b" (or "a$b") can never match
  // ANY string, including its own literal text, because the anchor forces a
  // position "a" already consumed past. A regression that stops escaping
  // either would make the pattern match NOTHING -- silently making a scope
  // entry containing "^" or "$" useless (fail-closed, not a widening), but
  // still a real defect this guards against.
  it.each([
    ['^', 'a^b'],
    ['$', 'a$b'],
  ] as const)('treats anchor metacharacter %j as literal: still matches its own literal text', (_char, pattern) => {
    expect(matchGlob(pattern, pattern)).toBe(true)
  })

  // "{2}" is a quantifier (repeat the preceding atom exactly twice):
  // unescaped, "a{2}" as a regex matches "aa", not the literal text "a{2}".
  it('treats { and } as literal, not a quantifier', () => {
    expect(matchGlob('a{2}', 'a{2}')).toBe(true)
    expect(matchGlob('a{2}', 'aa')).toBe(false)
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

  // Priority 5 from the final whole-branch review: .autor3search/config.yaml
  // is now a tracked, committed file, so it is visible to changedFiles like
  // any other -- but it already has its own dedicated, more specific
  // protection (pipeline/eval.ts gate 2, hash-based). It must not ALSO be
  // reported as a generic scope violation, which would race that more
  // useful diagnosis to the same conclusion.
  it('exempts .autor3search/config.yaml from scope -- it has its own dedicated gate', () => {
    expect(checkScope([CONFIG_PATH], SCOPE)).toEqual([])
  })
})

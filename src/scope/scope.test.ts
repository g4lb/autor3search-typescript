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

/**
 * The previous implementation, verbatim, kept as a reference oracle.
 *
 * matchGlob was rewritten from this regexp compilation to a memoized search
 * because the regexp backtracked exponentially (see matchGlob's own comment
 * for the measured numbers). The rewrite had to preserve the semantics of a
 * SECURITY gate exactly -- a subtle difference either widens what the agent
 * may edit or blocks work it should be allowed to do, and neither would be
 * obvious from the 20-odd hand-written cases above. Differential testing
 * against the original is what makes "identical behaviour" a checked claim
 * rather than an assertion.
 */
function oldMatchGlob(pattern: string, p: string): boolean {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`).test(p)
}

describe('matchGlob: rewritten from a backtracking regexp', () => {
  it('agrees with the previous implementation across random patterns and paths', () => {
    const alphabet = ['a', 'b', '/', '.', 'x', 'ts']
    // Deterministic: a fixed-seed LCG, so a failure is reproducible rather
    // than a one-off a rerun makes disappear.
    let seed = 0x2f6e2b1
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }

    let checked = 0
    for (let i = 0; i < 20_000; i++) {
      let pattern = ''
      let globstars = 0
      const plen = 1 + rnd(9)
      for (let k = 0; k < plen; k++) {
        const r = rnd(10)
        // `**` is capped only because the OLD implementation is the oracle
        // and more than a few make IT hang -- which is the whole reason for
        // the rewrite. The performance test below covers the uncapped case.
        if (r < 2 && globstars < 3) {
          pattern += '**'
          globstars++
        } else if (r < 4) pattern += '*'
        else if (r < 5) pattern += '?'
        else pattern += alphabet[rnd(alphabet.length)]
      }
      let subject = ''
      const slen = 1 + rnd(12)
      for (let k = 0; k < slen; k++) subject += alphabet[rnd(alphabet.length)]

      expect(matchGlob(pattern, subject), `pattern=${pattern} subject=${subject}`).toBe(
        oldMatchGlob(pattern, subject),
      )
      checked++
    }
    expect(checked).toBe(20_000)
  })

  // The rewrite's OWN regression: the first version used a recursive
  // helper, whose depth is driven by the pattern's token count. Patterns
  // come from config with no length limit, so it threw RangeError
  // ("Maximum call stack size exceeded") at ~8k tokens -- from inside the
  // gate that decides what the agent may edit, as a crash rather than a
  // clean refusal. The matcher is iterative now and has no such ceiling.
  it('matches very long patterns without exhausting the stack', () => {
    for (const len of [4096, 8192, 20_000]) {
      const same = 'a'.repeat(len)
      expect(() => matchGlob(same, same), `len=${len}`).not.toThrow()
      expect(matchGlob(same, same)).toBe(true)
      expect(matchGlob(same, `${same}b`)).toBe(false)
    }
  })

  // The bug itself. On this machine the old implementation took 18.7s for
  // the first pattern and 88s for the second; a generous ceiling here still
  // fails by three orders of magnitude if the backtracking ever returns.
  it('matches pathological patterns in bounded time instead of backtracking', () => {
    const deepPath = `src/${'a/'.repeat(30)}z.js`
    const cases = [
      `src/${'**/'.repeat(10)}*.ts`,
      `${'**/'.repeat(10)}x`,
      `src/${'**/a/'.repeat(10)}*.ts`,
    ]
    for (const pattern of cases) {
      const started = performance.now()
      matchGlob(pattern, deepPath)
      const elapsed = performance.now() - started
      expect(elapsed, `pattern=${pattern} took ${elapsed.toFixed(1)}ms`).toBeLessThan(1000)
    }
  })
})

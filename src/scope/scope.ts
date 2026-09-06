import { IMMUTABLE_FILES } from '../config/schema.js'

export interface ScopeViolation {
  file: string
  reason: 'immutable' | 'out-of-scope'
}

/**
 * Compiles a glob to an anchored regexp.
 *
 * `**` crosses directory separators, `*` and `?` do not. Everything else is
 * escaped: a pattern is data from a config file, and a stray `.` or `+`
 * silently widening the scope is exactly the failure this gate must not have.
 */
export function matchGlob(pattern: string, p: string): boolean {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` also matches zero directories, so `src/**` matches `src/a.ts`.
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

const IMMUTABLE = new Set(IMMUTABLE_FILES)

/**
 * Every reason the changed set is not allowed.
 *
 * Immutability is checked first and independently of `scope`: a dependency or
 * compiler-configuration change is a human decision, and no scope setting may
 * grant it.
 */
export function checkScope(changed: string[], scope: string[]): ScopeViolation[] {
  const out: ScopeViolation[] = []
  for (const file of changed) {
    if (IMMUTABLE.has(file)) {
      out.push({ file, reason: 'immutable' })
      continue
    }
    if (!scope.some((pat) => matchGlob(pat, file))) {
      out.push({ file, reason: 'out-of-scope' })
    }
  }
  return out
}

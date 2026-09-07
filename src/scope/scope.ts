import { CONFIG_PATH, IMMUTABLE_FILES } from '../config/schema.js'

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
        if (pattern[i + 2] === '/') {
          // `**/` in the MIDDLE of a pattern. `(?:.*/)?` makes the whole
          // group optional so it also matches ZERO directories: `src/**/a.ts`
          // matches `src/a.ts` as well as `src/x/y/a.ts`.
          re += '(?:.*/)?'
          i += 2
        } else {
          // `**` NOT followed by `/` -- trailing (`src/**`) or bare (`**`).
          // `.*` crosses separators, so `src/**` matches `src/a.ts` and
          // `src/x/y/a.ts` alike. Note this branch also absorbs a `**`
          // written mid-pattern without a slash after it (`src/**x`), which
          // degrades to "anything, including separators, then x" rather than
          // being rejected -- deliberately permissive, since the gate's job
          // is to be conservative about what it ADMITS, and a widened
          // pattern here is one the config author wrote explicitly.
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
    // `.autor3search/config.yaml` is now a tracked, committed file (spec
    // section 13), so any edit to it is visible to `changedFiles` like any
    // other file -- but it already has its own dedicated, more specific
    // protection: `pipeline/eval.ts` gate 2 hashes it against what baseline
    // recorded and FAILs with a diagnosis naming the actual problem
    // ("the run configuration is frozen"), not a generic scope violation.
    // Exempting it here just lets that more specific gate be the one that
    // actually reports it, rather than racing scope to the same conclusion
    // with a less useful message.
    if (file === CONFIG_PATH) continue
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

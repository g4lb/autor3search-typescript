import { CONFIG_PATH, IMMUTABLE_FILES } from '../config/schema.js'

export interface ScopeViolation {
  file: string
  reason: 'immutable' | 'out-of-scope'
}

/**
 * One compiled glob element. Kept as an explicit token list rather than a
 * regexp source string so matching can be a bounded search (below) instead
 * of JavaScript's backtracking regexp engine.
 */
type Token =
  /** A literal character, matched exactly. */
  | { kind: 'lit'; ch: string }
  /** `?` -- exactly one character, never a separator. */
  | { kind: 'any1' }
  /** `*` -- zero or more characters within one path segment. */
  | { kind: 'star' }
  /** `**` not followed by `/` -- zero or more of anything, separators included. */
  | { kind: 'globstar' }
  /** `**` followed by `/` -- zero or more WHOLE segments, so it also matches none. */
  | { kind: 'globstarSlash' }

/**
 * Splits a glob into tokens.
 *
 * `**` crosses directory separators, `*` and `?` do not. Every other
 * character is a literal: a pattern is data from a config file, and a stray
 * `.` or `+` acquiring regexp meaning and silently widening the scope is
 * exactly the failure this gate must not have. Tokenizing (rather than
 * building a regexp source and escaping into it) removes that risk by
 * construction -- there is no metacharacter left to escape.
 */
function tokenize(pattern: string): Token[] {
  const out: Token[] = []
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` in the MIDDLE of a pattern: zero or more whole segments,
          // so `src/**/a.ts` matches `src/a.ts` as well as `src/x/y/a.ts`.
          out.push({ kind: 'globstarSlash' })
          i += 2
        } else {
          // `**` NOT followed by `/` -- trailing (`src/**`) or bare (`**`).
          // Crosses separators, so `src/**` matches `src/a.ts` and
          // `src/x/y/a.ts` alike. This branch also absorbs a `**` written
          // mid-pattern without a slash after it (`src/**x`), which degrades
          // to "anything, including separators, then x" rather than being
          // rejected -- deliberately permissive, since the gate's job is to
          // be conservative about what it ADMITS, and a widened pattern here
          // is one the config author wrote explicitly.
          out.push({ kind: 'globstar' })
          i += 1
        }
      } else {
        out.push({ kind: 'star' })
      }
    } else if (c === '?') {
      out.push({ kind: 'any1' })
    } else {
      out.push({ kind: 'lit', ch: c })
    }
  }
  return out
}

/**
 * Whether `p` matches `pattern`, anchored at both ends.
 *
 * This used to compile the pattern to a regexp, which was correct and
 * exponentially slow: several `**` groups can each match the same text, so
 * JavaScript's backtracking engine explores every division of the subject
 * between them. Measured on this machine, `src/` + `**\/` x10 + `*.ts`
 * against a 30-deep path took **18.7 seconds**, and 10 `**\/` groups with
 * no separator between them took **88 seconds** -- a single call, inside the
 * gate that runs on every changed file of every experiment. Config is
 * human-owned and hash-gated, so this was never agent-reachable; it was a
 * silent multi-minute hang waiting for whoever wrote one pattern too many
 * into their scope list, on a run designed to be left unattended.
 *
 * The search below is the same semantics with the backtracking removed:
 * `seen` memoizes each (token, position) pair, so a pair is explored once
 * instead of once per path that reaches it. That bounds the work at
 * O(tokens x length) states rather than exponential, and the pathological
 * patterns above now return in under a millisecond.
 */
export function matchGlob(pattern: string, p: string): boolean {
  const tokens = tokenize(pattern)
  const n = p.length
  const accept = tokens.length * (n + 1) + n

  // Reachability over (token index, subject offset) states, explored with an
  // explicit stack rather than recursion. `seen` is what removes the
  // backtracking: each state is expanded once instead of once per path that
  // reaches it, which is the difference between bounded and exponential.
  //
  // The stack is explicit rather than a recursive helper because recursion
  // depth here is driven by the PATTERN's token count, and patterns come
  // from config with no length limit. A recursive version overflowed the
  // stack (RangeError, not a clean refusal) at around 8k tokens -- above any
  // real path, but reachable by a config nobody would notice was hostile,
  // and thrown from the middle of the gate that decides what the agent may
  // edit. An explicit stack has no such ceiling.
  const seen = new Uint8Array((tokens.length + 1) * (n + 1))
  const stack: number[] = [0]
  seen[0] = 1

  const push = (t: number, j: number): void => {
    const key = t * (n + 1) + j
    if (seen[key] === 0) {
      seen[key] = 1
      stack.push(key)
    }
  }

  while (stack.length > 0) {
    const key = stack.pop()!
    if (key === accept) return true
    const t = (key / (n + 1)) | 0
    const j = key % (n + 1)
    if (t === tokens.length) continue // a full pattern that did not consume all of `p`

    const tok = tokens[t]!
    switch (tok.kind) {
      case 'lit':
        if (j < n && p[j] === tok.ch) push(t + 1, j + 1)
        break
      case 'any1':
        if (j < n && p[j] !== '/') push(t + 1, j + 1)
        break
      case 'star':
        // Stops at a separator: `*` never leaves its segment.
        for (let k = j; k <= n; k++) {
          push(t + 1, k)
          if (k < n && p[k] === '/') break
        }
        break
      case 'globstar':
        for (let k = j; k <= n; k++) push(t + 1, k)
        break
      case 'globstarSlash':
        // Zero segments...
        push(t + 1, j)
        // ...or any number of whole ones, each ending at a separator.
        for (let k = j; k < n; k++) if (p[k] === '/') push(t + 1, k + 1)
        break
    }
  }

  return false
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

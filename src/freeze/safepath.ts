import path from 'node:path'

/**
 * Refuses any path that could escape the repository root.
 *
 * The agent controls the repository, so a manifest entry or a discovered path
 * is untrusted input. Normalising first defeats `src/../../x`, which looks
 * innocent until it is resolved.
 */
export function assertSafeRelPath(p: string): void {
  if (p === '' || p === '.') throw new Error('unsafe path: empty')
  if (p.includes('\\')) throw new Error(`unsafe path: backslash in ${JSON.stringify(p)}`)
  if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) {
    throw new Error(`unsafe path: absolute ${JSON.stringify(p)}`)
  }
  const normalized = path.posix.normalize(p)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`unsafe path: parent traversal in ${JSON.stringify(p)}`)
  }
}

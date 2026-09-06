import { readdir } from 'node:fs/promises'
import path from 'node:path'

export type FileKind = 'test' | 'bench' | 'runner-config' | 'source'

/** Directories never walked: build output, dependencies, VCS and tool caches. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'out'])

const SCRIPT_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/
const RUNNER_CONFIG = /^(?:vitest|jest|vite)\.config\.(?:[cm]?[jt]s)$/

/**
 * Classifies a repo-relative path.
 *
 * Matching is on dot-delimited segments of the basename, not substrings:
 * `benchmarks.ts` and `testing.ts` are ordinary source, and treating them as
 * frozen would quietly make real source un-editable.
 */
export function classify(rel: string): FileKind {
  const base = path.posix.basename(rel)
  if (RUNNER_CONFIG.test(base)) return 'runner-config'
  if (!SCRIPT_EXT.test(base)) return 'source'
  const parts = base.split('.')
  // parts: name, [qualifier], ext
  const qualifier = parts.length >= 3 ? parts[parts.length - 2] : undefined
  if (qualifier === 'test' || qualifier === 'spec') return 'test'
  if (qualifier === 'bench') return 'bench'
  return 'source'
}

/** Every file in the repository, repo-relative with POSIX separators. */
export async function walkRepo(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(path.join(root, dir), { withFileTypes: true })
    for (const e of entries) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(rel)
      } else if (e.isFile()) {
        out.push(rel)
      }
      // Symlinks are deliberately neither followed nor listed.
    }
  }
  await walk('')
  return out.sort()
}

/** Every file that must be frozen at baseline. */
export async function freezableFiles(root: string): Promise<string[]> {
  const all = await walkRepo(root)
  return all.filter((f) => classify(f) !== 'source')
}

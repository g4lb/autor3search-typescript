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

/**
 * Walks the repository once, collecting regular files and symlinks
 * separately. Shared by `walkRepo` and `listSymlinks` so the two never
 * silently diverge on which directories are skipped.
 */
async function walkAll(root: string): Promise<{ files: string[]; symlinks: string[] }> {
  const files: string[] = []
  const symlinks: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(path.join(root, dir), { withFileTypes: true })
    for (const e of entries) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.isSymbolicLink()) {
        // Recorded, never followed: a symlink is never walked INTO
        // (whether it points to a file or a directory), so its target's
        // contents never appear in `files` regardless of where they live.
        symlinks.push(rel)
        continue
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(rel)
      } else if (e.isFile()) {
        files.push(rel)
      }
    }
  }
  await walk('')
  return { files: files.sort(), symlinks: symlinks.sort() }
}

/** Every regular file in the repository, repo-relative with POSIX separators. */
export async function walkRepo(root: string): Promise<string[]> {
  return (await walkAll(root)).files
}

/**
 * Every symlink in the repository (whatever it points to), repo-relative
 * with POSIX separators, not followed.
 *
 * Exists for `gitx/git.ts`'s `changedFiles`: an untracked symlink is
 * invisible to `walkRepo` by design (see above) but is exactly what Node
 * and `tsc` resolve at measure time, so the scope/clean-tree gates must see
 * it as a change even though the ordinary file walk never will.
 */
export async function listSymlinks(root: string): Promise<string[]> {
  return (await walkAll(root)).symlinks
}

/** Every file that must be frozen at baseline. */
export async function freezableFiles(root: string): Promise<string[]> {
  const all = await walkRepo(root)
  return all.filter((f) => classify(f) !== 'source')
}

import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { hashString, type Manifest } from './manifest.js'
import { assertSafeRelPath } from './safepath.js'

/**
 * Throws if `rel` inside `root` is a symlink.
 *
 * Both directions matter, for different reasons. `buildManifest`/`snapshot`
 * `readFile` the path directly, so an unguarded symlink there would freeze
 * (and copy into the snapshot dir) whatever it points at, leaking content
 * from outside the repository. `restore`'s write path unlinks before
 * writing (see below), which happens to stop a naive "symlink to a
 * differing file" attack — but not the more patient one: point the link at
 * a file whose bytes already match the frozen content, so `restore` sees no
 * difference and leaves the live symlink in place, then edit the link's
 * target *after* restore has already run and "approved" the path. Without
 * this check that swap is invisible: a later test run reads straight
 * through the symlink to whatever the agent put there last. This check
 * refuses the path outright, so no symlink survives a restore regardless of
 * whether its current content happens to match.
 *
 * A missing path is not an error here: `buildManifest` immediately follows
 * this with a `readFile` that throws its own (loud) ENOENT for a baseline
 * file that vanished, and `restore` legitimately expects the agent to have
 * deleted a frozen file — that is one of the two things it must repair.
 */
async function assertNotSymlink(root: string, rel: string): Promise<void> {
  const abs = path.join(root, rel)
  try {
    const st = await lstat(abs)
    if (st.isSymbolicLink()) {
      throw new Error(
        `refusing to touch ${rel}: it is a symlink, and following it would read or write outside the repository`,
      )
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
}

export async function buildManifest(root: string, rels: string[]): Promise<Manifest> {
  const files: Record<string, string> = {}
  for (const rel of rels.slice().sort()) {
    assertSafeRelPath(rel)
    await assertNotSymlink(root, rel)
    files[rel] = hashString(await readFile(path.join(root, rel), 'utf8'))
  }
  return { files }
}

/** Copies every listed file into destDir, preserving relative layout. */
export async function snapshot(
  root: string,
  rels: string[],
  destDir: string,
): Promise<Manifest> {
  const manifest = await buildManifest(root, rels)
  for (const rel of Object.keys(manifest.files)) {
    const dest = path.join(destDir, rel)
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(path.join(root, rel), dest)
  }
  return manifest
}

/**
 * Restores every manifest entry into the repository, returning the paths that
 * actually differed. Edits are erased rather than argued about.
 */
export async function restore(
  root: string,
  srcDir: string,
  manifest: Manifest,
): Promise<string[]> {
  const changed: string[] = []
  for (const rel of Object.keys(manifest.files).sort()) {
    assertSafeRelPath(rel)
    await assertNotSymlink(root, rel)
    const abs = path.join(root, rel)
    const want = await readFile(path.join(srcDir, rel), 'utf8')
    let have: string | null = null
    try {
      have = await readFile(abs, 'utf8')
    } catch {
      have = null
    }
    if (have === want) continue
    await mkdir(path.dirname(abs), { recursive: true })
    // rm first so a read-only leftover cannot deflect the write, and so a
    // symlink that slipped past assertNotSymlink's lstat by a race is
    // unlinked (not followed) rather than written through.
    await rm(abs, { force: true })
    await writeFile(abs, want)
    changed.push(rel)
  }
  return changed
}

/**
 * Candidate test or bench files absent from the manifest.
 *
 * This is what closes "add an easier benchmark": a file that looks like a
 * benchmark but was not frozen at baseline is rejected, not measured.
 *
 * `root` is part of the public signature (see task brief) but unused by this
 * implementation: every comparison here is against manifest keys and
 * `unfreeze` entries, which are already repo-relative, so no filesystem
 * lookup against `root` is needed. Kept rather than dropped, since later
 * tasks may call this positionally and dropping a parameter would be a
 * breaking, unreviewed change to a documented interface.
 */
export function findUnmanifested(
  root: string,
  candidates: string[],
  manifest: Manifest,
  unfreeze: string[],
): string[] {
  const allowed = new Set([...Object.keys(manifest.files), ...unfreeze])
  return candidates.filter((c) => !allowed.has(c)).sort()
}

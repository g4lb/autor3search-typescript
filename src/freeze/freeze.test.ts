import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildManifest, findUnmanifested, restore, snapshot } from './freeze.js'

const made: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ars-freeze-'))
  made.push(d)
  return d
}
afterEach(() => {
  made.length = 0
})

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await tmp()
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, body)
  }
  return root
}

describe('snapshot and restore', () => {
  it('restores a modified frozen file back to its snapshotted content', async () => {
    const root = await repoWith({ 'src/a.test.ts': 'ORIGINAL' })
    const dest = await tmp()
    const m = await snapshot(root, ['src/a.test.ts'], dest)
    expect(Object.keys(m.files)).toEqual(['src/a.test.ts'])

    await writeFile(path.join(root, 'src/a.test.ts'), 'WEAKENED BY THE AGENT')
    const restored = await restore(root, dest, m)

    expect(restored).toEqual(['src/a.test.ts'])
    expect(await readFile(path.join(root, 'src/a.test.ts'), 'utf8')).toBe('ORIGINAL')
  })

  it('recreates a frozen file the agent deleted', async () => {
    const root = await repoWith({ 'src/a.test.ts': 'ORIGINAL' })
    const dest = await tmp()
    const m = await snapshot(root, ['src/a.test.ts'], dest)
    const { rm } = await import('node:fs/promises')
    await rm(path.join(root, 'src/a.test.ts'))
    await restore(root, dest, m)
    expect(await readFile(path.join(root, 'src/a.test.ts'), 'utf8')).toBe('ORIGINAL')
  })

  it('REFUSES to snapshot a symlinked test file', async () => {
    const root = await repoWith({ 'secret.txt': 'outside data' })
    await mkdir(path.join(root, 'src'), { recursive: true })
    await symlink(path.join(root, 'secret.txt'), path.join(root, 'src/a.test.ts'))
    const dest = await tmp()
    await expect(snapshot(root, ['src/a.test.ts'], dest)).rejects.toThrow(/symlink/)
  })

  it('REFUSES to restore through a symlink planted after the snapshot', async () => {
    const root = await repoWith({ 'src/a.test.ts': 'ORIGINAL' })
    const dest = await tmp()
    const m = await snapshot(root, ['src/a.test.ts'], dest)

    // The agent replaces the frozen test with a link pointing outside the repo.
    const outside = path.join(await tmp(), 'victim.txt')
    await writeFile(outside, 'DO NOT OVERWRITE')
    const { rm } = await import('node:fs/promises')
    await rm(path.join(root, 'src/a.test.ts'))
    await symlink(outside, path.join(root, 'src/a.test.ts'))

    await expect(restore(root, dest, m)).rejects.toThrow(/symlink/)
    // NOTE: this assertion holds regardless of the symlink guard above — it
    // passes even with assertNotSymlink's throw disabled, because restore's
    // `rm(abs, { force: true })` unlinks a symlink rather than following it,
    // so the write that follows never touches `outside`. It is kept because
    // it pins that defence-in-depth property of `rm` (it would regress if
    // the write path were ever changed to open-and-truncate instead), NOT
    // because it demonstrates the symlink guard is doing anything here. The
    // guard's actual load-bearing case is the content-matching bypass below.
    expect(await readFile(outside, 'utf8')).toBe('DO NOT OVERWRITE')
  })

  it('REFUSES a symlink whose content matches the frozen bytes, which would otherwise survive restore\'s early exit', async () => {
    const root = await repoWith({ 'src/a.test.ts': 'ORIGINAL' })
    const dest = await tmp()
    const m = await snapshot(root, ['src/a.test.ts'], dest)

    // The agent points the frozen path at a file whose CURRENT content is
    // byte-identical to the frozen bytes. Without the guard, restore's
    // `readFile(abs)` follows the link, sees have === want, and takes the
    // early `continue` — leaving the symlink in place, untouched, and
    // absent from `changed`. The agent can then edit the link's target
    // after restore has already run and "approved" the path.
    const outsideDir = await tmp()
    const shadow = path.join(outsideDir, 'shadow.ts')
    await writeFile(shadow, 'ORIGINAL')
    const { rm } = await import('node:fs/promises')
    await rm(path.join(root, 'src/a.test.ts'))
    await symlink(shadow, path.join(root, 'src/a.test.ts'))

    await expect(restore(root, dest, m)).rejects.toThrow(/symlink/)
    // Pin that we refused outright rather than silently accepting the link
    // because its content happened to match.
    expect((await lstat(path.join(root, 'src/a.test.ts'))).isSymbolicLink()).toBe(true)
  })

  it('refuses a manifest entry that escapes the repository', async () => {
    const root = await repoWith({ 'src/a.test.ts': 'ORIGINAL' })
    const dest = await tmp()
    await expect(
      restore(root, dest, { files: { '../escape.ts': 'deadbeef' } }),
    ).rejects.toThrow(/traversal|unsafe/)
  })
})

describe('buildManifest', () => {
  it('hashes content, so identical bytes hash identically', async () => {
    const root = await repoWith({ 'a.test.ts': 'same', 'b.test.ts': 'same' })
    const m = await buildManifest(root, ['a.test.ts', 'b.test.ts'])
    expect(m.files['a.test.ts']).toBe(m.files['b.test.ts'])
    expect(m.files['a.test.ts']).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('findUnmanifested', () => {
  it('flags a test file the agent added after baseline', () => {
    const m = { files: { 'src/a.test.ts': 'x' } }
    const found = findUnmanifested(['src/a.test.ts', 'src/easy.bench.ts'], m, [])
    expect(found).toEqual(['src/easy.bench.ts'])
  })

  it('allows a file listed in unfreeze', () => {
    const m = { files: { 'src/a.test.ts': 'x' } }
    const found = findUnmanifested(['src/a.test.ts', 'src/new.test.ts'], m, ['src/new.test.ts'])
    expect(found).toEqual([])
  })
})

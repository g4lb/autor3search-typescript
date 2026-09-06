import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSinglePackage, detect } from './detect.js'

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ars-pm-'))
  for (const [rel, body] of Object.entries(files)) {
    await writeFile(path.join(root, rel), body)
  }
  return root
}

const PKG = JSON.stringify({ name: 'demo', version: '1.0.0' })

describe('detect', () => {
  it('detects npm from package-lock.json', async () => {
    const root = await repo({ 'package.json': PKG, 'package-lock.json': '{}' })
    const d = await detect(root)
    expect(d.pm).toBe('npm')
    expect(d.installCommand).toBe('npm ci')
  })

  it('detects pnpm and uses a frozen lockfile install', async () => {
    const root = await repo({ 'package.json': PKG, 'pnpm-lock.yaml': '' })
    const d = await detect(root)
    expect(d.pm).toBe('pnpm')
    expect(d.installCommand).toBe('pnpm install --frozen-lockfile')
  })

  it('detects yarn', async () => {
    const root = await repo({ 'package.json': PKG, 'yarn.lock': '' })
    expect((await detect(root)).installCommand).toBe('yarn install --immutable')
  })

  it('detects bun', async () => {
    const root = await repo({ 'package.json': PKG, 'bun.lock': '' })
    expect((await detect(root)).installCommand).toBe('bun install --frozen-lockfile')
  })

  it('detects bun from bun.lockb alone', async () => {
    const root = await repo({ 'package.json': PKG, 'bun.lockb': '' })
    const d = await detect(root)
    expect(d.pm).toBe('bun')
    expect(d.installCommand).toBe('bun install --frozen-lockfile')
  })

  it('refuses a repo with no lockfile, since the baseline could not be reproduced', async () => {
    const root = await repo({ 'package.json': PKG })
    await expect(detect(root)).rejects.toThrow(/no lockfile/)
  })

  it('refuses several lockfiles rather than guessing', async () => {
    const root = await repo({ 'package.json': PKG, 'package-lock.json': '{}', 'yarn.lock': '' })
    await expect(detect(root)).rejects.toThrow(/more than one lockfile/)
  })

  it('refuses a workspace/monorepo with a message naming the limitation', async () => {
    const root = await repo({
      'package.json': JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }),
      'package-lock.json': '{}',
    })
    await expect(detect(root)).rejects.toThrow(/workspace|monorepo/i)
  })

  it('refuses a pnpm workspace declared in its own file', async () => {
    const root = await repo({
      'package.json': PKG,
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    })
    await expect(detect(root)).rejects.toThrow(/workspace|monorepo/i)
  })

  it('refuses a repo with no package.json', async () => {
    const root = await repo({ 'package-lock.json': '{}' })
    await expect(detect(root)).rejects.toThrow(/package\.json/)
  })

  it('distinguishes an unreadable package.json (e.g. a directory) from a missing one', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ars-pm-'))
    await mkdir(path.join(root, 'package.json'))
    try {
      await detect(root)
      expect.fail('expected detect() to throw')
    } catch (e) {
      expect((e as Error).message).toMatch(/could not read package\.json/)
      expect((e as Error).message).not.toMatch(/does not look like a Node package/)
    }
  })

  // --- Judgment-point coverage beyond the brief's verbatim cases ---

  it('does not treat both bun lockfile names present at once as ambiguous', async () => {
    // bun.lockb and bun.lock are two on-disk names for the same manager. A repo
    // that (e.g. mid-migration) has both is still unambiguously bun, not "several
    // lockfiles" — the count that matters is distinct *managers*, not filenames.
    const root = await repo({ 'package.json': PKG, 'bun.lockb': '', 'bun.lock': '' })
    const d = await detect(root)
    expect(d.pm).toBe('bun')
  })

  it('refuses an empty workspaces array, since declaring the key signals intent', async () => {
    const root = await repo({
      'package.json': JSON.stringify({ name: 'demo', workspaces: [] }),
      'package-lock.json': '{}',
    })
    await expect(detect(root)).rejects.toThrow(/workspace|monorepo/i)
  })

  it('refuses an empty workspaces object for the same reason', async () => {
    const root = await repo({
      'package.json': JSON.stringify({ name: 'demo', workspaces: {} }),
      'package-lock.json': '{}',
    })
    await expect(detect(root)).rejects.toThrow(/workspace|monorepo/i)
  })

  it('refuses a package.json that is not valid JSON, with an actionable message', async () => {
    const root = await repo({ 'package.json': '{ not json', 'package-lock.json': '{}' })
    await expect(detect(root)).rejects.toThrow(/not valid JSON/)
    await expect(detect(root)).rejects.toThrow(/Fix the JSON syntax/)
  })

  it('does not treat workspaces: null as a workspace declaration', async () => {
    // null is not a shape npm/yarn's own schema accepts for "workspaces", and is
    // the idiomatic JSON spelling of "not set" -- unlike `[]`/`{}`, it does not
    // signal workspace intent.
    const root = await repo({
      'package.json': JSON.stringify({ name: 'demo', workspaces: null }),
      'package-lock.json': '{}',
    })
    const d = await detect(root)
    expect(d.pm).toBe('npm')
  })
})

describe('assertSinglePackage', () => {
  it('resolves for a plain single-package package.json', async () => {
    const root = await repo({ 'package.json': PKG })
    await expect(assertSinglePackage(PKG, root)).resolves.toBeUndefined()
  })

  it('rejects package.json that is not valid JSON', async () => {
    const root = await repo({})
    await expect(assertSinglePackage('{ not json', root)).rejects.toThrow(/not valid JSON/)
  })
})

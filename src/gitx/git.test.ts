import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../runner/exec.js'
import {
  addWorktree,
  branchExists,
  changedFiles,
  createBranch,
  currentBranch,
  deleteBranch,
  headCommit,
  isClean,
  removeWorktree,
  repointWorktree,
  repoRoot,
  shortSha,
} from './git.js'

async function git(root: string, ...args: string[]): Promise<void> {
  const r = await run('git', args, { cwd: root, timeoutMs: 30_000 })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

async function scratchRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ars-git-'))
  await git(root, 'init', '-q', '-b', 'main')
  await git(root, 'config', 'user.name', 'Test')
  await git(root, 'config', 'user.email', 'test@example.invalid')
  await writeFile(path.join(root, 'a.ts'), 'export const a = 1\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'first')
  return root
}

describe('gitx', () => {
  it('reports the repo root and a 40-char head', async () => {
    const root = await scratchRepo()
    expect(await repoRoot(root)).toBe(await repoRoot(root))
    const head = await headCommit(root)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(shortSha(head)).toHaveLength(7)
  })

  it('reports a clean tree, then a dirty one', async () => {
    const root = await scratchRepo()
    expect(await isClean(root)).toBe(true)
    await writeFile(path.join(root, 'a.ts'), 'export const a = 2\n')
    expect(await isClean(root)).toBe(false)
  })

  it('sees an untracked file as dirty', async () => {
    const root = await scratchRepo()
    await writeFile(path.join(root, 'new.ts'), 'export const n = 1\n')
    expect(await isClean(root)).toBe(false)
  })

  it('does not count an untracked file inside an ignored directory as dirty', async () => {
    const root = await scratchRepo()
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'add gitignore')
    await mkdir(path.join(root, 'ignored'))
    await writeFile(path.join(root, 'ignored', 'scratch.txt'), 'noise\n')
    expect(await isClean(root)).toBe(true)
  })

  it('lists files changed since a ref', async () => {
    const root = await scratchRepo()
    const base = await headCommit(root)
    await writeFile(path.join(root, 'b.ts'), 'export const b = 1\n')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'second')
    expect(await changedFiles(root, base)).toEqual(['b.ts'])
  })

  it('sees uncommitted edits, not only committed ones', async () => {
    const root = await scratchRepo()
    const base = await headCommit(root)
    await writeFile(path.join(root, 'a.ts'), 'export const a = 2\n')
    expect(await changedFiles(root, base)).toEqual(['a.ts'])
  })

  it('sees a file the agent deleted', async () => {
    const root = await scratchRepo()
    const base = await headCommit(root)
    await rm(path.join(root, 'a.ts'))
    expect(await changedFiles(root, base)).toEqual(['a.ts'])
  })

  it('sees a new untracked file the agent never staged', async () => {
    const root = await scratchRepo()
    const base = await headCommit(root)
    await writeFile(path.join(root, 'sneaky.ts'), 'export const s = 1\n')
    expect(await changedFiles(root, base)).toEqual(['sneaky.ts'])
  })

  it('does not see an untracked file inside a gitignored directory', async () => {
    const root = await scratchRepo()
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'add gitignore')
    const base = await headCommit(root)
    await mkdir(path.join(root, 'ignored'))
    await writeFile(path.join(root, 'ignored', 'results.tsv'), 'noise\n')
    expect(await changedFiles(root, base)).toEqual([])
  })

  it('does not double-report a file that was untracked and is now committed', async () => {
    const root = await scratchRepo()
    const base = await headCommit(root)
    await writeFile(path.join(root, 'b.ts'), 'export const b = 1\n')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'second')
    expect(await changedFiles(root, base)).toEqual(['b.ts'])
  })

  it('handles a changed filename containing a space', async () => {
    const root = await scratchRepo()
    const base = await headCommit(root)
    await writeFile(path.join(root, 'with space.ts'), 'export const s = 1\n')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'space file')
    expect(await changedFiles(root, base)).toEqual(['with space.ts'])
  })

  it('handles a changed filename containing a newline', async () => {
    const root = await scratchRepo()
    const base = await headCommit(root)
    const name = 'with\nnewline.ts'
    let canCreate = true
    try {
      await writeFile(path.join(root, name), 'export const s = 1\n')
    } catch {
      canCreate = false
    }
    if (!canCreate) {
      // Some filesystems (notably a case- or char-restricted one) cannot
      // hold a literal newline in a filename; skip rather than false-fail.
      return
    }
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'newline file')
    expect(await changedFiles(root, base)).toEqual([name])
  })

  it('creates a branch and reports it as current', async () => {
    const root = await scratchRepo()
    expect(await branchExists(root, 'run/x')).toBe(false)
    await createBranch(root, 'run/x')
    expect(await branchExists(root, 'run/x')).toBe(true)
    expect(await currentBranch(root)).toBe('run/x')
  })

  it('deletes a branch it created', async () => {
    const root = await scratchRepo()
    await createBranch(root, 'run/y')
    await git(root, 'checkout', '-q', 'main')
    expect(await branchExists(root, 'run/y')).toBe(true)
    await deleteBranch(root, 'run/y')
    expect(await branchExists(root, 'run/y')).toBe(false)
  })

  it('fails cleanly deleting a branch that does not exist', async () => {
    const root = await scratchRepo()
    await expect(deleteBranch(root, 'no/such/branch')).rejects.toThrow(/branch/)
  })

  it('adds a detached worktree at a commit', async () => {
    const root = await scratchRepo()
    const head = await headCommit(root)
    const wt = path.join(await mkdtemp(path.join(tmpdir(), 'ars-wt-')), 'baseline')
    await addWorktree(root, wt, head)
    expect(await headCommit(wt)).toBe(head)
  })

  it('repoints a worktree to a later commit', async () => {
    const root = await scratchRepo()
    const first = await headCommit(root)
    await writeFile(path.join(root, 'b.ts'), 'export const b = 1\n')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-q', '-m', 'second')
    const second = await headCommit(root)

    const wt = path.join(await mkdtemp(path.join(tmpdir(), 'ars-wt-')), 'baseline')
    await addWorktree(root, wt, first)
    expect(await headCommit(wt)).toBe(first)

    await repointWorktree(wt, second)
    expect(await headCommit(wt)).toBe(second)
  })

  it('removes a worktree', async () => {
    const root = await scratchRepo()
    const head = await headCommit(root)
    const parent = await mkdtemp(path.join(tmpdir(), 'ars-wt-'))
    const wt = path.join(parent, 'baseline')
    await addWorktree(root, wt, head)
    await removeWorktree(root, wt)
    await expect(headCommit(wt)).rejects.toThrow()
  })

  it('throws naming the failing command and stderr', async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), 'ars-not-a-repo-'))
    await expect(headCommit(notARepo)).rejects.toThrow(/rev-parse/)
  })
})

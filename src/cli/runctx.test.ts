import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../runner/exec.js'
import { repoRoot } from '../gitx/git.js'
import { LOG_PATH, resolveCtx, splitDashC } from './runctx.js'

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await run('git', args, { cwd, timeoutMs: 30_000 })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

async function scratchRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ars-runctx-'))
  await git(root, 'init', '-q', '-b', 'main')
  await git(root, 'config', 'user.name', 'Test')
  await git(root, 'config', 'user.email', 'test@example.invalid')
  await writeFile(path.join(root, 'a.ts'), 'export const a = 1\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'first')
  return root
}

describe('splitDashC', () => {
  it('returns the given cwd and untouched argv when there is no -C', () => {
    const { dir, rest } = splitDashC(['init', '-force'], '/somewhere')
    expect(dir).toBe('/somewhere')
    expect(rest).toEqual(['init', '-force'])
  })

  it('extracts the directory and strips both tokens when -C leads', () => {
    const { dir, rest } = splitDashC(['-C', '/repo', 'init'], '/somewhere')
    expect(dir).toBe('/repo')
    expect(rest).toEqual(['init'])
  })

  it('does not recognize -C anywhere but the first position', () => {
    const { dir, rest } = splitDashC(['init', '-C', '/repo'], '/somewhere')
    expect(dir).toBe('/somewhere')
    expect(rest).toEqual(['init', '-C', '/repo'])
  })

  it('throws a clear error when -C has no following directory', () => {
    expect(() => splitDashC(['-C'])).toThrow(/-C requires a directory/)
  })
})

describe('resolveCtx', () => {
  it('resolves the repository root of a -C directory without calling process.chdir', async () => {
    const root = await scratchRepo()
    const sub = path.join(root, 'nested', 'dir')
    await mkdir(sub, { recursive: true })
    const cwdBefore = process.cwd()

    const ctx = await resolveCtx(['-C', sub])

    expect(process.cwd()).toBe(cwdBefore)
    // Compare against gitx's own resolution rather than the raw mkdtemp
    // path: both go through `git rev-parse --show-toplevel`, so symlink
    // normalization (e.g. macOS /tmp -> /private/tmp) affects both sides
    // identically.
    expect(ctx.repoRoot).toBe(await repoRoot(root))
  })

  it('defaults to the current working directory when -C is absent, still without chdir', async () => {
    const root = await scratchRepo()
    const cwdBefore = process.cwd()
    process.chdir(root)
    try {
      const ctx = await resolveCtx([])
      expect(ctx.repoRoot).toBe(await repoRoot(root))
    } finally {
      process.chdir(cwdBefore)
    }
    expect(process.cwd()).toBe(cwdBefore)
  })

  it('produces a clear error when -C points outside any git repository', async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), 'ars-not-a-repo-'))
    await expect(resolveCtx(['-C', notARepo])).rejects.toThrow(/not inside a git repository/)
  })

  it('anchors configPath, resultsPath and logPath to the repo root', async () => {
    const root = await scratchRepo()
    const ctx = await resolveCtx(['-C', root])
    const want = await repoRoot(root)
    expect(ctx.configPath).toBe(path.join(want, '.autoresearch', 'config.yaml'))
    expect(ctx.resultsPath).toBe(path.join(want, 'results.tsv'))
    expect(ctx.logPath).toBe(path.join(want, LOG_PATH))
    expect(LOG_PATH).toBe('run.log')
  })
})

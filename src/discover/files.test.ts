import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classify, listSymlinks, walkRepo } from './files.js'

describe('classify', () => {
  it('recognises test and spec files in ts and js', () => {
    expect(classify('src/a.test.ts')).toBe('test')
    expect(classify('src/a.spec.ts')).toBe('test')
    expect(classify('src/a.test.js')).toBe('test')
    expect(classify('test/a.spec.mts')).toBe('test')
  })

  it('recognises bench files', () => {
    expect(classify('src/a.bench.ts')).toBe('bench')
    expect(classify('src/a.bench.js')).toBe('bench')
  })

  it('recognises test-runner config, which gates correctness', () => {
    expect(classify('vitest.config.ts')).toBe('runner-config')
    expect(classify('jest.config.js')).toBe('runner-config')
    expect(classify('vitest.config.mts')).toBe('runner-config')
  })

  it('treats everything else as source', () => {
    expect(classify('src/a.ts')).toBe('source')
    expect(classify('src/testing.ts')).toBe('source')
    expect(classify('src/benchmarks.ts')).toBe('source')
  })
})

describe('walkRepo / listSymlinks', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('walkRepo lists regular files but not symlinks', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ars-walk-'))
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'a.ts'), 'export const a = 1\n')
    await symlink(path.join(dir, 'src', 'a.ts'), path.join(dir, 'src', 'link.ts'))

    const files = await walkRepo(dir)

    expect(files).toContain('src/a.ts')
    expect(files).not.toContain('src/link.ts')
  })

  it('listSymlinks lists exactly the symlinks, not regular files', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ars-walk-'))
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'a.ts'), 'export const a = 1\n')
    await symlink(path.join(dir, 'src', 'a.ts'), path.join(dir, 'src', 'link.ts'))

    const symlinks = await listSymlinks(dir)

    expect(symlinks).toEqual(['src/link.ts'])
  })

  it('never walks into a symlinked directory to list its contents', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ars-walk-'))
    const real = path.join(dir, 'real')
    await mkdir(real, { recursive: true })
    await writeFile(path.join(real, 'secret.ts'), 'export const s = 1\n')
    await symlink(real, path.join(dir, 'linked'), 'dir')

    const files = await walkRepo(dir)
    const symlinks = await listSymlinks(dir)

    expect(files).not.toContain('linked/secret.ts')
    expect(symlinks).toEqual(['linked'])
  })

  it('does not walk into node_modules, dist, build, coverage, .git, out or dot-directories', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ars-walk-'))
    for (const skipped of ['node_modules', 'dist', 'build', 'coverage', '.git', 'out', '.hidden']) {
      await mkdir(path.join(dir, skipped), { recursive: true })
      await writeFile(path.join(dir, skipped, 'x.ts'), 'export const x = 1\n')
    }
    await writeFile(path.join(dir, 'kept.ts'), 'export const k = 1\n')

    const files = await walkRepo(dir)

    expect(files).toEqual(['kept.ts'])
  })
})

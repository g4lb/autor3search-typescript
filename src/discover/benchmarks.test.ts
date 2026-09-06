import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverBenchmarks } from './benchmarks.js'

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ars-disc-'))
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, body)
  }
  return root
}

describe('discoverBenchmarks', () => {
  it('finds exported functions named bench*', async () => {
    const root = await repoWith({
      'src/p.bench.ts': `
        export function benchParse() { return 1 }
        export const benchArrow = () => 2
        export async function benchAsync() { return 3 }
      `,
    })
    const found = await discoverBenchmarks(root)
    expect(found.map((b) => b.fn).sort()).toEqual(['benchArrow', 'benchAsync', 'benchParse'])
    expect(found[0]!.id).toMatch(/^src\/p\.bench\.ts:bench/)
  })

  it('ignores non-exported and non-bench-prefixed functions', async () => {
    const root = await repoWith({
      'src/p.bench.ts': `
        function benchHidden() {}
        export function helper() {}
        export function benchReal() {}
      `,
    })
    const found = await discoverBenchmarks(root)
    expect(found.map((b) => b.fn)).toEqual(['benchReal'])
  })

  it('does not execute the module, so a throwing top level is still scanned', async () => {
    const root = await repoWith({
      'src/p.bench.ts': `throw new Error('boom')\nexport function benchX() {}`,
    })
    const found = await discoverBenchmarks(root)
    expect(found.map((b) => b.fn)).toEqual(['benchX'])
  })

  it('scans a file that does not typecheck', async () => {
    const root = await repoWith({
      'src/p.bench.ts': `export function benchX(): number { return "not a number" }`,
    })
    const found = await discoverBenchmarks(root)
    expect(found.map((b) => b.fn)).toEqual(['benchX'])
  })

  it('qualifies ids by file so same-named exports do not collide', async () => {
    const root = await repoWith({
      'src/a.bench.ts': 'export function benchX() {}',
      'src/b.bench.ts': 'export function benchX() {}',
    })
    const found = await discoverBenchmarks(root)
    expect(found.map((b) => b.id).sort()).toEqual([
      'src/a.bench.ts:benchX',
      'src/b.bench.ts:benchX',
    ])
  })

  it('returns an empty list when there are no bench files', async () => {
    const root = await repoWith({ 'src/a.ts': 'export const x = 1' })
    expect(await discoverBenchmarks(root)).toEqual([])
  })

  it('skips node_modules', async () => {
    const root = await repoWith({
      'node_modules/dep/x.bench.ts': 'export function benchDep() {}',
      'src/a.bench.ts': 'export function benchMine() {}',
    })
    const found = await discoverBenchmarks(root)
    expect(found.map((b) => b.fn)).toEqual(['benchMine'])
  })
})

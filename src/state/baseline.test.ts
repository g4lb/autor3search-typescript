import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readBaseline, writeBaseline, type BaselineRecord } from './baseline.js'

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ars-baseline-'))
}

function record(overrides: Partial<BaselineRecord> = {}): BaselineRecord {
  return {
    tag: 'sep6',
    frozenCommit: 'aaaaaaa',
    measureCommit: 'aaaaaaa',
    configHash: 'cfg-hash',
    lockfileHash: 'lock-hash',
    lockfileName: 'package-lock.json',
    benchmarks: ['bench/one.bench.ts'],
    manifest: { files: { 'src/a.test.ts': 'deadbeef' } },
    createdAt: '2026-09-06T00:00:00.000Z',
    ...overrides,
  }
}

describe('writeBaseline / readBaseline', () => {
  it('round-trips a record', async () => {
    const dir = await tmp()
    const rec = record()
    await writeBaseline(dir, rec)
    expect(await readBaseline(dir)).toEqual(rec)
  })

  it('lets frozenCommit and measureCommit legally differ', async () => {
    const dir = await tmp()
    const rec = record({ frozenCommit: 'aaaaaaa', measureCommit: 'bbbbbbb' })
    await writeBaseline(dir, rec)
    const read = await readBaseline(dir)
    expect(read.frozenCommit).toBe('aaaaaaa')
    expect(read.measureCommit).toBe('bbbbbbb')
    expect(read.frozenCommit).not.toBe(read.measureCommit)
  })

  it('produces a clear, actionable error when no baseline exists for the tag', async () => {
    const dir = await tmp()
    await expect(readBaseline(dir)).rejects.toThrow(
      /no baseline.*autoresearch-typescript baseline -tag/,
    )
  })

  it('does not clobber a previous baseline with a half-written file on repeated writes', async () => {
    const dir = await tmp()
    await writeBaseline(dir, record({ measureCommit: 'aaaaaaa' }))
    await writeBaseline(dir, record({ measureCommit: 'ccccccc' }))
    const read = await readBaseline(dir)
    expect(read.measureCommit).toBe('ccccccc')
  })
})

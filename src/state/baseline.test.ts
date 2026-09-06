import { mkdtemp, readdir } from 'node:fs/promises'
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
      /no baseline.*autor3search-typescript baseline -tag/,
    )
  })

  it('a second write overwrites the first, and leaves no temp file behind', async () => {
    // This does NOT prove crash-atomicity -- a unit test cannot kill the
    // process mid-write to observe that. Atomicity itself rests on `rename`
    // being atomic within a filesystem, which is a property of the OS, not
    // something exercisable here. What this test pins down is the two things
    // that ARE observable: a later write wins over an earlier one, and the
    // write-to-temp-then-rename mechanism doesn't litter the directory with
    // its intermediate file once it succeeds.
    const dir = await tmp()
    await writeBaseline(dir, record({ measureCommit: 'aaaaaaa' }))
    await writeBaseline(dir, record({ measureCommit: 'ccccccc' }))
    const read = await readBaseline(dir)
    expect(read.measureCommit).toBe('ccccccc')
    const entries = await readdir(dir)
    expect(entries).toEqual(['baseline.json'])
  })
})

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearStop, readStop, requestStop, stopPath } from './stop.js'

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ars-stop-'))
}

describe('requestStop / readStop / clearStop', () => {
  it('request then read round-trips force and a timestamp', async () => {
    const dir = await tmp()
    await requestStop(dir, true)
    const req = await readStop(dir)
    expect(req?.force).toBe(true)
    expect(typeof req?.requestedAt).toBe('string')
  })

  it('reading with no request returns null', async () => {
    const dir = await tmp()
    expect(await readStop(dir)).toBeNull()
  })

  it('clearStop removes the request', async () => {
    const dir = await tmp()
    await requestStop(dir, false)
    await clearStop(dir)
    expect(await readStop(dir)).toBeNull()
  })

  it('clearStop on a directory with no request does not throw', async () => {
    const dir = await tmp()
    await expect(clearStop(dir)).resolves.toBeUndefined()
  })

  it('readStop tolerates a partially-written stop.json instead of crashing the eval', async () => {
    const dir = await tmp()
    await mkdir(dir, { recursive: true })
    // Simulates a human's `stop` process being killed mid-write, or a reader
    // racing a writer that has not finished flushing yet.
    await writeFile(stopPath(dir), '{"requestedAt": "2026-09-06T00:00', 'utf8')
    await expect(readStop(dir)).resolves.toBeNull()
  })
})

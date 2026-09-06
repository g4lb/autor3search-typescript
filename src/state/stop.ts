import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface StopRequest {
  requestedAt: string
  /** True when the user also wants the in-flight eval abandoned. */
  force: boolean
}

export function stopPath(dir: string): string {
  return path.join(dir, 'stop.json')
}

/**
 * A human runs `stop` in another terminal while an eval may be mid-read of
 * this exact file. Write via a temp file plus rename (atomic within a
 * directory) so a reader never observes a half-written stop.json.
 */
export async function requestStop(dir: string, force: boolean): Promise<void> {
  await mkdir(dir, { recursive: true })
  const rec: StopRequest = { requestedAt: new Date().toISOString(), force }
  const tmpPath = path.join(dir, `.stop.json.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tmpPath, JSON.stringify(rec))
  try {
    await rename(tmpPath, stopPath(dir))
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}

/**
 * Returns null both when no stop has been requested and when stop.json can't
 * be parsed. The eval polls this file while running; a reader racing a
 * writer that has not finished flushing (or a `stop` process killed
 * mid-write despite the rename above) must never crash the eval on account
 * of it. Worst case a genuine request is missed for one more poll.
 */
export async function readStop(dir: string): Promise<StopRequest | null> {
  let text: string
  try {
    text = await readFile(stopPath(dir), 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(text) as StopRequest
  } catch {
    return null
  }
}

export async function clearStop(dir: string): Promise<void> {
  await rm(stopPath(dir), { force: true })
}

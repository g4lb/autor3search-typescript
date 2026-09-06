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
 * Returns null when no stop has been requested (ENOENT) or when stop.json
 * can't be parsed. The parse case is genuinely expected here -- a human's
 * `stop` process could be killed mid-write despite the rename above, or a
 * reader could race a writer that has not finished flushing yet -- so it must
 * never crash the eval.
 *
 * Any other read failure (EACCES, a different uid, a transient I/O error,
 * ...) is a different fact entirely: the request may well exist and simply
 * be unreadable. Silently reporting that as "no request" would mean a user
 * runs `stop`, it succeeds, and the eval side never observes it -- no error,
 * no log, nothing. So only ENOENT (plus a genuine parse failure) collapses
 * to null; everything else propagates.
 */
export async function readStop(dir: string): Promise<StopRequest | null> {
  let text: string
  try {
    text = await readFile(stopPath(dir), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
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

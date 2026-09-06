import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Manifest } from '../freeze/manifest.js'

export interface BaselineRecord {
  tag: string
  /**
   * The commit the frozen tests and the scope gate always compare against.
   * NEVER advances once the baseline is created. Moving it would move the
   * success criteria mid-run — this is the field that, in the Go predecessor,
   * got collapsed into a single "commit" and let a tampered experiment KEEP.
   */
  frozenCommit: string
  /**
   * The commit base timings are measured against. Advances to the candidate
   * commit after every KEEP, so each subsequent score reflects that
   * experiment's own contribution rather than re-measuring an earlier win.
   * Advancing this field must never change frozenCommit.
   */
  measureCommit: string
  configHash: string
  lockfileHash: string
  lockfileName: string
  benchmarks: string[]
  manifest: Manifest
  createdAt: string
}

export function baselinePath(dir: string): string {
  return path.join(dir, 'baseline.json')
}

/**
 * Writes via a temp file plus rename rather than truncating in place.
 * baseline.json is read by every subsequent eval; a crash mid-truncate would
 * leave a half-written (or empty) file that every future eval trips over. A
 * rename within the same directory is atomic on the filesystems this tool
 * targets, so a reader always sees either the old complete record or the new
 * one, never a partial write.
 */
export async function writeBaseline(dir: string, rec: BaselineRecord): Promise<void> {
  await mkdir(dir, { recursive: true })
  const dest = baselinePath(dir)
  const tmpPath = path.join(dir, `.baseline.json.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tmpPath, `${JSON.stringify(rec, null, 2)}\n`)
  try {
    await rename(tmpPath, dest)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}

export async function readBaseline(dir: string): Promise<BaselineRecord> {
  let text: string
  try {
    text = await readFile(baselinePath(dir), 'utf8')
  } catch {
    throw new Error(
      `no baseline found at ${baselinePath(dir)}. Run "autoresearch-typescript baseline -tag <tag>" first.`,
    )
  }
  return JSON.parse(text) as BaselineRecord
}

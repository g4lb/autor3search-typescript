import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** Repo-relative path -> SHA-256 hex of its content at baseline. */
export interface Manifest {
  files: Record<string, string>
}

export function hashString(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export async function hashFile(abs: string): Promise<string> {
  return hashString(await readFile(abs, 'utf8'))
}

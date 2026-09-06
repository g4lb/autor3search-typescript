import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface EvalLockFile {
  pid: number
  startedAt: string
}

export function lockPath(dir: string): string {
  return path.join(dir, 'eval.lock')
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only probes whether the pid is signalable.
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it --
    // that is still "alive" and definitely not ours to reclaim. Any other
    // error (ESRCH: no such process) means it is dead.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function readEvalLock(dir: string): Promise<{ pid: number } | null> {
  let text: string
  try {
    text = await readFile(lockPath(dir), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as EvalLockFile
    return { pid: parsed.pid }
  } catch {
    // A corrupt or half-written lock file is treated the same as absent so
    // that it can be reclaimed rather than wedging every future eval.
    return null
  }
}

/**
 * Acquires the per-run eval lock, refusing a concurrent eval for the same
 * repo and tag. A crashed eval leaves its lock file behind with no process
 * to clean it up; if the recorded pid is no longer alive the lock is stale
 * and is reclaimed, so a crash never permanently blocks future evals.
 */
export async function acquireEvalLock(dir: string): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true })
  const file = lockPath(dir)
  const record: EvalLockFile = { pid: process.pid, startedAt: new Date().toISOString() }

  for (;;) {
    try {
      await writeFile(file, JSON.stringify(record), { flag: 'wx' })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const existing = await readEvalLock(dir)
      if (existing !== null && isAlive(existing.pid)) {
        throw new Error(
          `eval lock is already held by pid ${existing.pid}; wait for it to finish, or run ` +
            '"stop" to request it stop',
        )
      }
      // Stale (dead pid) or unreadable: reclaim and retry the exclusive create.
      await rm(file, { force: true })
    }
  }

  let released = false
  return async () => {
    if (released) return
    released = true
    await rm(file, { force: true })
  }
}

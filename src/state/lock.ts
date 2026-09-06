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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    // Any other read failure (EACCES, a different uid owns the file, a
    // transient I/O error, ...) does NOT mean the lock is absent -- it means
    // we could not check. Collapsing that into "absent" is how a genuinely
    // held, live lock gets stolen out from under its owner. Propagate it so
    // the caller never treats "couldn't read" as "safe to reclaim".
    throw err
  }
  try {
    const parsed = JSON.parse(text) as EvalLockFile
    return { pid: parsed.pid }
  } catch {
    // The read itself succeeded; the content is corrupt or half-written
    // (e.g. a crash mid-write). That is genuinely indistinguishable from
    // absent, so it is treated as reclaimable rather than wedging every
    // future eval.
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
      // readEvalLock throws on anything other than "confirmed absent" or
      // "confirmed corrupt" (see its doc comment); that throw propagates out
      // of this function untouched, so a lock we failed to read is never
      // reclaimed here.
      const existing = await readEvalLock(dir)
      if (existing !== null && isAlive(existing.pid)) {
        throw new Error(
          `eval lock is already held by pid ${existing.pid}; wait for it to finish, or run ` +
            '"stop" to request it stop',
        )
      }
      // existing is null here only because the file was confirmed absent (a
      // race: it existed for writeFile's wx check but was gone by the time we
      // read it) or its content was corrupt/half-written. Either way it is
      // safe to reclaim. A dead-pid lock falls through the isAlive check
      // above instead.
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

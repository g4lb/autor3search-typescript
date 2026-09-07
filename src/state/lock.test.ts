import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireEvalLock, lockPath, readEvalLock } from './lock.js'

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ars-lock-'))
}

describe('acquireEvalLock', () => {
  it('a second acquire fails while genuinely held', async () => {
    const dir = await tmp()
    const release = await acquireEvalLock(dir)
    await expect(acquireEvalLock(dir)).rejects.toThrow(/lock/i)
    await release()
  })

  it('release removes the lock so a later acquire succeeds', async () => {
    const dir = await tmp()
    const release = await acquireEvalLock(dir)
    await release()
    const release2 = await acquireEvalLock(dir)
    await release2()
  })

  it('reclaims a stale lock whose pid is no longer alive', async () => {
    const dir = await tmp()
    // PID 1 is unreachable to an unprivileged process on macOS/Linux (EPERM,
    // not ESRCH) which would look "alive" to a naive kill(pid, 0) probe, so we
    // instead use a pid far outside any plausible live range: guaranteed dead.
    const deadPid = 99_999_999
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(
      lockPath(dir),
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }),
      { flag: 'wx' },
    )
    const release = await acquireEvalLock(dir)
    const held = await readEvalLock(dir)
    expect(held?.pid).toBe(process.pid)
    await release()
  })

  it('readEvalLock returns null when nothing holds the lock', async () => {
    const dir = await tmp()
    expect(await readEvalLock(dir)).toBeNull()
  })

  // POSIX-only: this simulates the failure with chmod 000, and Windows has no
  // equivalent -- Node's chmod there sets only the read-only bit, which does
  // not deny reads, so the call under test succeeds and the assertion that it
  // REFUSES to fall back cannot be made. Skipped rather than weakened: the
  // behaviour still matters, and still has to hold, on the platforms where the
  // condition can occur at all.
  it.skipIf(process.platform === 'win32')('does NOT reclaim a present lock it fails to read (e.g. permission denied)', async () => {
    const dir = await tmp()
    const { writeFile, mkdir, chmod } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const file = lockPath(dir)
    await writeFile(
      file,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: 'wx' },
    )
    await chmod(file, 0o000)
    try {
      // "Could not read" must never be treated as "safe to steal" -- unlike
      // the stale-pid case, this must reject rather than silently taking the
      // lock over, and readEvalLock itself must surface the failure rather
      // than reporting null (which would look identical to "no lock").
      await expect(readEvalLock(dir)).rejects.toThrow()
      await expect(acquireEvalLock(dir)).rejects.toThrow()
    } finally {
      await chmod(file, 0o600)
    }
    // The lock file must still be exactly as it was: never deleted, and
    // still naming the original (live, this-process) holder.
    const held = JSON.parse(await readFile(file, 'utf8')) as { pid: number }
    expect(held.pid).toBe(process.pid)
  })

  it('release makes the lock file disappear on disk', async () => {
    const dir = await tmp()
    const release = await acquireEvalLock(dir)
    await release()
    await expect(readFile(lockPath(dir), 'utf8')).rejects.toThrow()
  })
})

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

  it('release makes the lock file disappear on disk', async () => {
    const dir = await tmp()
    const release = await acquireEvalLock(dir)
    await release()
    await expect(readFile(lockPath(dir), 'utf8')).rejects.toThrow()
  })
})

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from '../runner/exec.js'
import { lockPath } from '../state/lock.js'
import { installSigtermHandler } from './cmd-eval.js'

/**
 * Priority 5 from the final whole-branch review: `stop -force` sends
 * SIGTERM to the recorded eval pid, whose default disposition kills node
 * immediately -- before `runEval`'s own `finally` ever releases the lock,
 * and with any detached measurement child (its own process-group leader,
 * per `runner/exec.ts`) left running as an orphan. `installSigtermHandler`
 * is what closes both gaps; this proves it does, against a REAL spawned
 * child and a real lock file on disk, not mocks of either.
 */
describe('installSigtermHandler', () => {
  let stateDir: string
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'ars-sigterm-'))
    // process.exit would tear down the whole test worker -- stubbed to throw
    // instead, so the handler's post-exit code never runs and the test can
    // observe everything the handler did up to that call.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit called')
    }) as never)
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    await rm(stateDir, { recursive: true, force: true })
  })

  it('kills a live, detached child group and removes the eval lock file, then exits', async () => {
    await mkdir(stateDir, { recursive: true })
    await writeLock(stateDir)

    // A real, still-running child registered through runner/exec.ts's own
    // spawn path -- not a mock of the registry -- standing in for a
    // measurement child `eval` is still waiting on when SIGTERM arrives.
    // Fired and forgotten (not awaited) so it is genuinely in flight.
    const longRunning = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    })

    // Give the spawn a moment to actually register itself before signalling.
    await new Promise((resolve) => setTimeout(resolve, 200))

    const removeHandler = installSigtermHandler(stateDir)
    try {
      expect(() => process.emit('SIGTERM')).toThrow('process.exit called')
    } finally {
      removeHandler()
    }

    expect(exitSpy).toHaveBeenCalledWith(143)
    await expect(readFile(lockPath(stateDir), 'utf8')).rejects.toThrow()

    const result = await longRunning
    // Killed rather than left running to hit its own 30s timeout. Windows
    // has no POSIX signals, so `killGroup` there uses `taskkill /T /F`,
    // which tears down the tree but reports no signal -- the child exits
    // non-zero with `signal: null`. The claim under test is that the child
    // was killed, not which mechanism killed it.
    if (process.platform === 'win32') {
      expect(result.signal).toBeNull()
      expect(result.exitCode).not.toBe(0)
    } else {
      expect(result.signal).toBe('SIGTERM')
    }
    expect(result.timedOut).toBe(false)
  }, 10_000)
})

async function writeLock(dir: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(lockPath(dir), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
}

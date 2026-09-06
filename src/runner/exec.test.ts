import { describe, expect, it } from 'vitest'
import { MAX_CAPTURED_BYTES, ok, run, runShell, tail } from './exec.js'

const NODE = process.execPath

describe('run', () => {
  it('captures stdout and a zero exit', async () => {
    const r = await run(NODE, ['-e', 'process.stdout.write("hi")'], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    })
    expect(r.stdout).toBe('hi')
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(ok(r)).toBe(true)
  })

  it('treats a non-zero exit as data, not as a thrown error', async () => {
    const r = await run(NODE, ['-e', 'process.exit(7)'], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    })
    expect(r.exitCode).toBe(7)
    expect(ok(r)).toBe(false)
  })

  it('times out and reports it rather than hanging', async () => {
    const r = await run(NODE, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: process.cwd(),
      timeoutMs: 500,
    })
    expect(r.timedOut).toBe(true)
    expect(ok(r)).toBe(false)
  })

  it('kills the whole process group, leaving no orphaned grandchild', async () => {
    // The child spawns a detached grandchild that would outlive a naive kill
    // and go on burning CPU, corrupting every later measurement. The grandchild
    // writes its pid where the test can find it.
    const script = `
      const { spawn } = require('node:child_process')
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      process.stdout.write(String(g.pid))
      setInterval(() => {}, 1000)
    `
    const r = await run(NODE, ['-e', script], { cwd: process.cwd(), timeoutMs: 1000 })
    expect(r.timedOut).toBe(true)
    const grandchild = Number(r.stdout.trim())
    expect(Number.isInteger(grandchild)).toBe(true)
    await new Promise((res) => setTimeout(res, 300))
    // process.kill(pid, 0) throws ESRCH when the process is gone.
    let alive = true
    try {
      process.kill(grandchild, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })

  it('caps captured output and flags it', async () => {
    const r = await run(
      NODE,
      ['-e', `process.stdout.write("x".repeat(${MAX_CAPTURED_BYTES + 1024}))`],
      { cwd: process.cwd(), timeoutMs: 60_000 },
    )
    expect(r.truncated).toBe(true)
    expect(r.stdout.length).toBeLessThanOrEqual(MAX_CAPTURED_BYTES + 200)
  })

  it('reports a missing binary as a result, not an unhandled rejection', async () => {
    const r = await run('definitely-not-a-real-binary-xyz', [], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    })
    expect(ok(r)).toBe(false)
    expect(r.stderr).toMatch(/ENOENT|not found/i)
  })
})

describe('runShell', () => {
  it('runs a command line through a shell', async () => {
    const r = await runShell('echo shell-ok', { cwd: process.cwd(), timeoutMs: 30_000 })
    expect(r.stdout.trim()).toBe('shell-ok')
  })
})

describe('tail', () => {
  it('returns the last n lines', () => {
    expect(tail('a\nb\nc\nd', 2)).toBe('c\nd')
  })
})

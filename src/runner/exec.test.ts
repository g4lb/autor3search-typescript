import { describe, expect, it } from 'vitest'
import { Capture, MAX_CAPTURED_CHARS, ok, run, runShell, tail } from './exec.js'

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
      ['-e', `process.stdout.write("x".repeat(${MAX_CAPTURED_CHARS + 1024}))`],
      { cwd: process.cwd(), timeoutMs: 60_000 },
    )
    expect(r.truncated).toBe(true)
    expect(r.stdout.length).toBeLessThanOrEqual(MAX_CAPTURED_CHARS + 200)
  })

  it('reports a missing binary as a result, not an unhandled rejection', async () => {
    const r = await run('definitely-not-a-real-binary-xyz', [], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    })
    expect(ok(r)).toBe(false)
    expect(r.stderr).toMatch(/ENOENT|not found/i)
  })

  it('does not let a throwing log callback prevent run from resolving', async () => {
    const r = await run(NODE, ['-e', 'process.stdout.write("hi")'], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      log: () => {
        throw new Error('log sink is broken')
      },
    })
    expect(r.stdout).toBe('hi')
    expect(r.exitCode).toBe(0)
    expect(ok(r)).toBe(true)
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

describe('Capture', () => {
  // These drive `push` directly rather than through a spawned process:
  // a real OS pipe fragments large writes (observed ~64 KiB chunks for a
  // 4 MiB+ write on this machine), so a spawned-process test can never be
  // trusted to exercise the single-oversized-chunk path.

  it('trims a single chunk larger than the cap on its own, keeping the tail, and flags it', () => {
    const c = new Capture()
    const marker = 'END-OF-CHUNK'
    const big = 'x'.repeat(MAX_CAPTURED_CHARS + 100 - marker.length) + marker
    c.push(big)
    expect(c.truncated).toBe(true)
    const result = c.toString()
    expect(result.length).toBe(MAX_CAPTURED_CHARS)
    expect(result.endsWith(marker)).toBe(true)
  })

  it('evicts from the head across many small chunks, keeping the tail', () => {
    const c = new Capture()
    const chunkSize = 1024
    const chunkCount = Math.ceil((MAX_CAPTURED_CHARS * 2) / chunkSize)
    for (let i = 0; i < chunkCount; i++) {
      c.push(String(i).padStart(chunkSize, '0'))
    }
    expect(c.truncated).toBe(true)
    const result = c.toString()
    expect(result.length).toBeLessThanOrEqual(MAX_CAPTURED_CHARS)
    expect(result.endsWith(String(chunkCount - 1).padStart(chunkSize, '0'))).toBe(true)
  })

  it('does not flag a chunk that lands exactly on the boundary', () => {
    const c = new Capture()
    c.push('y'.repeat(MAX_CAPTURED_CHARS))
    expect(c.truncated).toBe(false)
    expect(c.toString().length).toBe(MAX_CAPTURED_CHARS)
  })
})

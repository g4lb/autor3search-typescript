import { access } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH } from '../config/schema.js'
import { RESULTS_PATH } from '../results/results.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { cmdProfile } from './cmd-profile.js'
import { cmdInit } from './cmd-init.js'
import type { RunCtx } from './runctx.js'

function ctxFor(root: string): RunCtx {
  return {
    repoRoot: root,
    configPath: path.join(root, CONFIG_PATH),
    resultsPath: path.join(root, RESULTS_PATH),
    logPath: path.join(root, 'run.log'),
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

let stdout: string[]
let stderr: string[]
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

function captureOutput(): void {
  stdout = []
  stderr = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
}

afterEach(() => {
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
})

describe('cmdProfile', () => {
  it('fails cleanly, without a stack trace, when there is no config yet', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()

    const code = await cmdProfile(ctx, [])

    expect(code).toBe(2)
    const message = stderr.join('')
    expect(message).toMatch(/^error: /)
    expect(message).not.toMatch(/at file:|\.ts:\d+:\d+|node:internal/)
  })

  // Point 3 from the task guidance: `profile` is reconnaissance run BEFORE
  // the loop starts -- it must never require `baseline` to have run.
  it('does not require a baseline: init alone is enough to profile', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    const initOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await cmdInit(ctx, [])).toBe(0)
    initOut.mockRestore()
    // No cmdBaseline call at all -- no .autoresearch state, no run branch.

    captureOutput()
    const code = await cmdProfile(ctx, [])

    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
  }, 30_000)

  it('names countWords among the top hot functions for the demo benchmark', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    const initOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await cmdInit(ctx, [])).toBe(0)
    initOut.mockRestore()

    captureOutput()
    const code = await cmdProfile(ctx, [])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/countWords/)
  }, 30_000)

  it('writes a .cpuprofile under .autoresearch/profiles and prints its path', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    const initOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await cmdInit(ctx, [])).toBe(0)
    initOut.mockRestore()

    captureOutput()
    const code = await cmdProfile(ctx, [])

    expect(code).toBe(0)
    const text = stdout.join('')
    const match = text.match(/profile written to (\S+\.cpuprofile)/)
    expect(match).not.toBeNull()
    const profilePath = match![1]!
    expect(profilePath.startsWith(path.join(root, '.autoresearch', 'profiles'))).toBe(true)
    expect(await exists(profilePath)).toBe(true)
  }, 30_000)

  it('tells the human where the file opens', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    const initOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await cmdInit(ctx, [])).toBe(0)
    initOut.mockRestore()

    captureOutput()
    const code = await cmdProfile(ctx, [])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/DevTools|speedscope/i)
  }, 30_000)

  it('fails cleanly when config declares a benchmark that no longer exists', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    const initOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await cmdInit(ctx, [])).toBe(0)
    initOut.mockRestore()
    const fs = await import('node:fs/promises')
    const configText = await fs.readFile(ctx.configPath, 'utf8')
    const edited = configText.replace(/^benchmarks: \[\]$/m, 'benchmarks: ["nope.bench.ts:benchNope"]')
    expect(edited).not.toBe(configText)
    await fs.writeFile(ctx.configPath, edited, 'utf8')

    captureOutput()
    const code = await cmdProfile(ctx, [])

    expect(code).toBe(2)
    expect(stderr.join('')).toMatch(/nope\.bench\.ts:benchNope/)
  })
})

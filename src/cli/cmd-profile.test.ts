import { access, writeFile } from 'node:fs/promises'
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
    // No cmdBaseline call at all -- no .autor3search state, no run branch.

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

  it('writes a .cpuprofile under .autor3search/profiles and prints its path', async () => {
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
    expect(profilePath.startsWith(path.join(root, '.autor3search', 'profiles'))).toBe(true)
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

  // Deferred item 13: the per-benchmark try/catch has no early return, so a
  // failing benchmark must not stop the ones after it -- confirmed by code
  // inspection only, which is exactly the control-flow detail a refactor
  // breaks silently. The demo fixture ships one benchmark, so this adds a
  // second, named to sort FIRST so the surviving one is genuinely profiled
  // after a failure rather than before it.
  it('keeps profiling the remaining benchmarks after one fails, and exits non-zero', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    await writeFile(
      path.join(root, 'src', 'aaa-broken.bench.ts'),
      'export function benchBroken(): void {\n  throw new Error("this benchmark is broken")\n}\n',
      'utf8',
    )
    const initOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await cmdInit(ctx, [])).toBe(0)
    initOut.mockRestore()

    captureOutput()
    const code = await cmdProfile(ctx, ['-benchtime', '20ms'])

    const out = stdout.join('')
    const err = stderr.join('')

    // Both were attempted, in an order that puts the failure first.
    expect(out).toMatch(/aaa-broken\.bench\.ts:benchBroken/)
    expect(out).toMatch(/wordcount\.bench\.ts:benchCountWords/)
    expect(out.indexOf('aaa-broken')).toBeLessThan(out.indexOf('wordcount.bench.ts:benchCountWords'))

    // The failure was reported...
    expect(err).toMatch(/error:/)
    expect(err).toMatch(/1 of 2 benchmark\(s\) could not be profiled/)
    expect(code).toBe(2)

    // ...and the one after it still produced a real profile. This is the
    // no-early-return claim: without it, the surviving benchmark would
    // never be reached and none of this would be printed.
    expect(out).toMatch(/profile written to .*benchCountWords\.cpuprofile/)
    expect(await exists(path.join(root, '.autor3search', 'profiles'))).toBe(true)
  }, 300_000)

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

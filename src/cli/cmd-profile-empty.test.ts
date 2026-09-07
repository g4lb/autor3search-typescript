import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH } from '../config/schema.js'
import { profileBenchmark } from '../profile/profile.js'
import { RESULTS_PATH } from '../results/results.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { cmdInit } from './cmd-init.js'
import { cmdProfile } from './cmd-profile.js'
import type { RunCtx } from './runctx.js'

/**
 * Deferred item 12: the "no user-code samples" guard was unit-tested only at
 * the `parseCpuProfile -> []` level, never through the command that prints
 * the advice.
 *
 * A real benchmark cannot be made to produce zero user frames on demand --
 * whether V8's sampler catches user code in a 20ms window is a race, and a
 * test built on that would be flaky by construction. Mocking the one call
 * that returns the frames makes the empty case exact. In its own file
 * because `vi.mock` is hoisted and file-scoped: `cmd-profile.test.ts` needs
 * the real profiler for every one of its tests.
 */
vi.mock('../profile/profile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../profile/profile.js')>()),
  profileBenchmark: vi.fn(),
}))

function ctxFor(root: string): RunCtx {
  return {
    repoRoot: root,
    configPath: path.join(root, CONFIG_PATH),
    resultsPath: path.join(root, RESULTS_PATH),
    logPath: path.join(root, 'run.log'),
  }
}

let stdoutSpy: ReturnType<typeof vi.spyOn>

afterEach(() => {
  stdoutSpy?.mockRestore()
  vi.mocked(profileBenchmark).mockReset()
})

describe('cmdProfile with no user-code samples (deferred item 12)', () => {
  it('says the benchmark may be too fast to profile, and still succeeds', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    const initOut = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await cmdInit(ctx, [])).toBe(0)
    initOut.mockRestore()

    vi.mocked(profileBenchmark).mockResolvedValue({
      id: 'src/wordcount.bench.ts:benchCountWords',
      profilePath: path.join(root, '.autor3search', 'profiles', 'x.cpuprofile'),
      hotFrames: [],
      totalSelfUs: 0,
    })

    const out: string[] = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      out.push(String(c))
      return true
    })
    const code = await cmdProfile(ctx, [])
    const text = out.join('')

    // Empty frames are not an error: the run worked, there was simply
    // nothing of the user's in it. Exiting non-zero here would make a
    // too-short benchtime look like a broken benchmark.
    expect(code).toBe(0)
    expect(text).toMatch(/no user-code samples were captured/)
    expect(text).toMatch(/too fast to profile meaningfully/)
    expect(text).toMatch(/try a longer -benchtime/)

    // The advice REPLACES the frame table rather than appearing beside an
    // empty one: no percentage rows should be printed.
    expect(text).not.toMatch(/^\s+\d+\.\d%/m)
  }, 120_000)
})

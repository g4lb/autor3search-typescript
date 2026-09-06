import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverBenchmarks } from '../discover/benchmarks.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { parseCpuProfile, profileBenchmark } from './profile.js'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function tmp(prefix = 'ars-profile-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

/** A minimal, hand-built .cpuprofile document with known, verifiable self times. */
function fakeCpuProfile(): string {
  return JSON.stringify({
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 } },
      { id: 2, callFrame: { functionName: 'countWords', url: 'file:///abs/wordcount.ts', lineNumber: 2 } },
      { id: 3, callFrame: { functionName: 'helper', url: 'file:///abs/helper.ts', lineNumber: 5 } },
      { id: 4, callFrame: { functionName: 'idle', url: 'node:internal/idle', lineNumber: 0 } },
    ],
    // node ids, index-parallel to timeDeltas below.
    samples: [1, 2, 3, 2, 3, 3, 4],
    // Self time (microseconds) attributed to samples[i] is timeDeltas[i].
    timeDeltas: [10, 100, 50, 120, 60, 70, 999],
  })
}

describe('parseCpuProfile', () => {
  it('sums timeDeltas at the indices where each node id appears in samples', () => {
    const frames = parseCpuProfile(fakeCpuProfile())
    const countWords = frames.find((f) => f.functionName === 'countWords')
    expect(countWords).toBeDefined()
    // samples[1]=2 (delta 100) and samples[3]=2 (delta 120) -> 220
    expect(countWords?.selfTimeUs).toBe(220)
  })

  it('drops frames whose url is empty', () => {
    const frames = parseCpuProfile(fakeCpuProfile())
    expect(frames.some((f) => f.functionName === '(root)')).toBe(false)
  })

  it('drops frames whose url starts with node:', () => {
    const frames = parseCpuProfile(fakeCpuProfile())
    expect(frames.some((f) => f.functionName === 'idle')).toBe(false)
  })

  it('sorts by self time, descending', () => {
    const frames = parseCpuProfile(fakeCpuProfile())
    expect(frames.map((f) => f.functionName)).toEqual(['countWords', 'helper'])
    // helper: samples[2]=3 (delta 50) + samples[4]=3 (delta 60) + samples[5]=3 (delta 70) = 180
    expect(frames.find((f) => f.functionName === 'helper')?.selfTimeUs).toBe(180)
  })

  it('never drops every frame just because node internals were sampled too', () => {
    // A profile that is ENTIRELY node internals (a benchmark too fast to
    // sample any user code) is a real possible input -- this must not throw,
    // and callers must be able to tell "genuinely nothing" from a bug.
    const allInternal = JSON.stringify({
      nodes: [{ id: 1, callFrame: { functionName: 'idle', url: 'node:internal/idle', lineNumber: 0 } }],
      samples: [1, 1],
      timeDeltas: [10, 10],
    })
    expect(parseCpuProfile(allInternal)).toEqual([])
  })
})

describe('profileBenchmark', () => {
  it('writes a .cpuprofile file under the given profile directory', async () => {
    const root = await makeDemoRepo()
    const profileDir = path.join(await tmp(), 'profiles')
    const benchmarks = await discoverBenchmarks(root)
    const b = benchmarks[0]!

    const result = await profileBenchmark({
      cwd: root,
      benchFileAbs: path.join(root, b.file),
      fn: b.fn,
      id: b.id,
      benchtimeMs: 300,
      warmupMs: 50,
      timeoutMs: 15_000,
      nodeArgs: [],
      profileDir,
    })

    expect(result.profilePath.startsWith(profileDir)).toBe(true)
    expect(await exists(result.profilePath)).toBe(true)
    const raw = await readFile(result.profilePath, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('names countWords among the top hot functions for the demo benchmark', async () => {
    // The whole point of `profile`: a profiler that only ever reports node
    // internals gives the optimizing agent nothing to act on. The demo
    // fixture's hot function is `countWords` (an intentional O(n^2) bug --
    // see wordcount.ts), so it must show up, and near the top.
    const root = await makeDemoRepo()
    const profileDir = path.join(await tmp(), 'profiles')
    const benchmarks = await discoverBenchmarks(root)
    const b = benchmarks[0]!

    const result = await profileBenchmark({
      cwd: root,
      benchFileAbs: path.join(root, b.file),
      fn: b.fn,
      id: b.id,
      benchtimeMs: 400,
      warmupMs: 100,
      timeoutMs: 15_000,
      nodeArgs: [],
      profileDir,
    })

    const top5 = result.hotFrames.slice(0, 5).map((f) => f.functionName)
    expect(top5).toContain('countWords')

    // Deferred minor #14 (Task 21, "self-disclosed by the implementer"):
    // this only proved countWords APPEARS in the top 5, not that it ranks
    // #1 -- the actual empirical claim (README: ~94% of self time). A
    // regression pushing it from #1 to #4, with self time misattributed
    // elsewhere, would still have passed. hotFrames is sorted descending by
    // selfTimeUs (see parseCpuProfile), so [0] is the rank-#1 frame; the
    // percentage threshold is generous (>50%, not ~94%) to stay robust
    // against real-machine profiling noise while still being a real pin,
    // not merely "appears somewhere."
    expect(result.hotFrames[0]?.functionName).toBe('countWords')
    const countWordsFrame = result.hotFrames[0]!
    expect(countWordsFrame.selfTimeUs / result.totalSelfUs).toBeGreaterThan(0.5)
  }, 30_000)

  it('drops node: and empty-url frames from the demo benchmark profile', async () => {
    const root = await makeDemoRepo()
    const profileDir = path.join(await tmp(), 'profiles')
    const benchmarks = await discoverBenchmarks(root)
    const b = benchmarks[0]!

    const result = await profileBenchmark({
      cwd: root,
      benchFileAbs: path.join(root, b.file),
      fn: b.fn,
      id: b.id,
      benchtimeMs: 300,
      warmupMs: 50,
      timeoutMs: 15_000,
      nodeArgs: [],
      profileDir,
    })

    for (const f of result.hotFrames) {
      expect(f.url).not.toBe('')
      expect(f.url.startsWith('node:')).toBe(false)
    }
  }, 30_000)

  it('throws a diagnosable error when the benchmark itself crashes, instead of writing a bogus profile', async () => {
    const dir = await tmp('ars-profile-crash-')
    const file = path.join(dir, 'boom.bench.ts')
    await rm(file, { force: true })
    const fs = await import('node:fs/promises')
    await fs.writeFile(file, "export function benchBoom(): number {\n  throw new Error('boom')\n}\n")
    const profileDir = path.join(dir, 'profiles')

    await expect(
      profileBenchmark({
        cwd: dir,
        benchFileAbs: file,
        fn: 'benchBoom',
        id: 'boom.bench.ts:benchBoom',
        benchtimeMs: 50,
        warmupMs: 10,
        timeoutMs: 10_000,
        nodeArgs: [],
        profileDir,
      }),
    ).rejects.toThrow(/boom/)
  })
})

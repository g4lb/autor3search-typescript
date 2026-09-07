import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverBenchmarks } from '../discover/benchmarks.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { CHILD, pickChildPath, readChildResult, runChild } from './invoke.js'

async function tmp(prefix = 'ars-invoke-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

/** Any leftover directories this module's own mkdtemp prefix would create. */
async function leftoverOutDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir())
  return entries.filter((e) => e.startsWith('ars-out-'))
}

/**
 * Runs `fn` with `os.tmpdir()` pointed at a fresh, private root for the
 * duration of the call, restoring the previous value (or its absence)
 * afterward.
 *
 * `runChild`'s own `mkdtemp(path.join(tmpdir(), 'ars-out-'))` reads
 * `tmpdir()` at call time, so overriding `TMPDIR` here is enough to make
 * its temp directory land inside our private root instead of the shared OS
 * temp directory. That matters because the shared temp directory is not
 * private to this test: sibling tests -- in this file and, under a full
 * suite run, in other files running concurrently -- create their own
 * `ars-out-*` directories via the very same `runChild`. A "before vs.
 * after" count taken against the shared directory measures *"how many
 * ars-out-* directories exist anywhere right now"*, which a concurrent
 * sibling's in-flight directory can inflate between the two snapshots --
 * a false failure with nothing wrong in the code under test. Measuring
 * against a private root makes the count mean what the assertion claims:
 * "this invocation's own directory was cleaned up."
 */
async function withPrivateTmpdir<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ars-invoke-root-'))
  // `os.tmpdir()` reads DIFFERENT variables per platform: TMPDIR on POSIX,
  // but TEMP then TMP on Windows. Setting only TMPDIR made this helper a
  // no-op on Windows -- the child and the scan both fell back to the SHARED
  // OS temp directory, where sibling test files running concurrently create
  // their own ars-out-* directories through this very same runChild. The
  // isolation this function exists to provide simply was not there, and the
  // resulting cross-test contamination read as a leak
  // ("expected [ 'ars-out-BwAMTK' ] to deeply equal []") in a test that had
  // leaked nothing.
  const vars = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR']
  const previous = new Map(vars.map((v) => [v, process.env[v]]))
  for (const v of vars) process.env[v] = root
  try {
    return await fn()
  } finally {
    for (const [v, was] of previous) {
      if (was === undefined) delete process.env[v]
      else process.env[v] = was
    }
    await rm(root, { recursive: true, force: true })
  }
}

describe('runChild', () => {
  // This is the load-bearing test: tsx must resolve from OUR dependencies,
  // not the measured repository's. A temp dir with only a .bench.ts file
  // and no node_modules at all proves that -- if resolution were relative
  // to the measured directory, this would fail on every real user's repo
  // even though it happens to pass against our own fixtures.
  it('loads a TypeScript benchmark from a repo that has no tsx of its own', async () => {
    const dir = await tmp('ars-no-deps-')
    const file = path.join(dir, 'x.bench.ts')
    await writeFile(
      file,
      `export function benchAdd(): number {\n  return 1 + 1\n}\n`,
    )

    const r = await runChild({
      cwd: dir,
      benchFileAbs: file,
      fn: 'benchAdd',
      id: 'x.bench.ts:benchAdd',
      benchtimeMs: 50,
      warmupMs: 20,
      timeoutMs: 30_000,
      nodeArgs: [],
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.nsPerOp).toBeGreaterThan(0)
  })

  it('resolves CHILD to a file that actually exists on disk', () => {
    expect(existsSync(CHILD)).toBe(true)
  })

  it('reports a timed-out child as ok:false with a diagnosis, and does not throw', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'hang.bench.ts')
    // Hangs forever on its very first call -- the warmup loop calls fn()
    // once before ever checking the deadline again, so this never returns
    // control to the child at all. The external timeout is what ends it.
    await writeFile(
      file,
      `export function benchHang(): number {\n  while (true) {\n    // spin forever\n  }\n}\n`,
    )

    await withPrivateTmpdir(async () => {
      const before = new Set(await leftoverOutDirs())
      const r = await runChild({
        cwd: dir,
        benchFileAbs: file,
        fn: 'benchHang',
        id: 'hang.bench.ts:benchHang',
        benchtimeMs: 50,
        warmupMs: 20,
        timeoutMs: 500,
        nodeArgs: [],
      })
      const after = await leftoverOutDirs()

      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toMatch(/timed out/i)
      // The temp --out directory must be cleaned up even though the child
      // never wrote to it. Compared as a SET DIFFERENCE, not as counts:
      // counts also move when a directory DISAPPEARS, and on Windows a
      // prior test's directory can still be finishing its (deferred)
      // deletion while this one samples -- which failed here as
      // "expected 0 to be 1", a leak assertion tripped by the absence of a
      // leak. The difference names what actually leaked, and only that.
      expect(after.filter((d) => !before.has(d))).toEqual([])
    })
  }, 15_000)

  it('reports a child that dies without writing --out as ok:false, and cleans up its temp dir', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'a.bench.ts')
    await writeFile(file, `export function benchA(): number {\n  return 1\n}\n`)

    await withPrivateTmpdir(async () => {
      const before = new Set(await leftoverOutDirs())
      // An unrecognized node flag makes node exit immediately with its own
      // "bad option" error, before our script (and therefore --out) is ever
      // reached -- a real "the child died before writing" case that is not a
      // timeout.
      const r = await runChild({
        cwd: dir,
        benchFileAbs: file,
        fn: 'benchA',
        id: 'a.bench.ts:benchA',
        benchtimeMs: 50,
        warmupMs: 20,
        timeoutMs: 10_000,
        nodeArgs: ['--not-a-real-node-flag'],
      })
      const after = await leftoverOutDirs()

      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toMatch(/exit/i)
      // Measured against a private root (see withPrivateTmpdir) so a
      // concurrent sibling test's own in-flight ars-out-* directory can
      // never inflate this count.
      expect(after.filter((d) => !before.has(d))).toEqual([])
    })
  })

  it('passes nodeArgs to node directly, not through a wrapper that swallows them', async () => {
    // Varies the thing under test: the ONLY difference between the two
    // calls below is nodeArgs. The benchmark throws unless global.gc is
    // present, which is only true when --expose-gc actually reached node.
    const dir = await tmp()
    const file = path.join(dir, 'b.bench.ts')
    await writeFile(
      file,
      [
        'export function benchGc(): number {',
        "  if (typeof globalThis.gc !== 'function') throw new Error('gc not exposed')",
        '  globalThis.gc()',
        '  return 1',
        '}',
        '',
      ].join('\n'),
    )
    const opts = {
      cwd: dir,
      benchFileAbs: file,
      fn: 'benchGc',
      id: 'b.bench.ts:benchGc',
      benchtimeMs: 30,
      warmupMs: 10,
      timeoutMs: 30_000,
    }

    const withoutFlag = await runChild({ ...opts, nodeArgs: [] })
    const withFlag = await runChild({ ...opts, nodeArgs: ['--expose-gc'] })

    expect(withoutFlag.ok).toBe(false)
    if (!withoutFlag.ok) expect(withoutFlag.error).toMatch(/gc not exposed/)
    expect(withFlag.ok).toBe(true)
  })

  it('measures the real demo fixture (~3.1ms/op) within a timeout sized for the fixed 16-op warmup batch', async () => {
    // The child warms up with a FIXED batch of 16 ops regardless of
    // warmupMs (see child.ts / task-12 notes): a benchmark costing C
    // always warms for at least 16*C before warmupMs is even checked
    // again. At ~3.1ms/op that floor is ~50ms. Sizing timeoutMs generously
    // above (warmup floor + benchtimeMs + node/tsx startup) is what avoids
    // the failure mode where a slow-per-op benchmark burns its whole
    // timeout budget in warmup alone.
    const root = await makeDemoRepo()
    const benchmarks = await discoverBenchmarks(root)
    expect(benchmarks).toHaveLength(1)
    const b = benchmarks[0]!

    const warmupMs = 100
    const benchtimeMs = 300
    // Generous slack for node startup + tsx transpilation + the ~50ms
    // 16-op warmup floor, well beyond what should ever be needed here.
    const timeoutMs = 15_000

    const r = await runChild({
      cwd: root,
      benchFileAbs: path.join(root, b.file),
      fn: b.fn,
      id: b.id,
      benchtimeMs,
      warmupMs,
      timeoutMs,
      nodeArgs: [],
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.nsPerOp).toBeGreaterThan(0)
  })
})

describe('pickChildPath', () => {
  it('chooses child.js when it exists', () => {
    const chosen = pickChildPath('/some/dir', (p) => p === path.join('/some/dir', 'child.js'))
    expect(chosen).toBe(path.join('/some/dir', 'child.js'))
  })

  it('falls back to child.ts when child.js does not exist', () => {
    const chosen = pickChildPath('/some/dir', () => false)
    expect(chosen).toBe(path.join('/some/dir', 'child.ts'))
  })
})

describe('readChildResult', () => {
  const fakeExec = { timedOut: false, exitCode: 0, stderr: '' }

  it('parses a well-formed result file', async () => {
    const dir = await tmp()
    const outFile = path.join(dir, 'result.json')
    await writeFile(outFile, JSON.stringify({ ok: true, id: 'x', nsPerOp: 1, iterations: 1, batches: 1, elapsedMs: 1, sinkType: 'number' }))

    const r = await readChildResult(outFile, 'x', fakeExec, 30_000)
    expect(r.ok).toBe(true)
  })

  it('reports ok:false instead of rejecting when --out contains truncated JSON', async () => {
    // Reproduces the real failure mode described in review: our own
    // timeout path SIGKILLs the child's process group, which can land
    // mid-writeFile and leave a truncated-but-readable JSON document on
    // disk. readFile succeeds; only JSON.parse/parseBenchResult would
    // catch this, and if that throw were left uncaught it would reject
    // the returned promise instead of yielding a CRASH-able ok:false.
    const dir = await tmp()
    const outFile = path.join(dir, 'result.json')
    // A SIGKILL mid-write would truncate at an arbitrary byte offset; this
    // slices a valid document well before its closing brace to reproduce
    // exactly that shape without depending on real subprocess timing.
    const full = JSON.stringify({ ok: true, id: 'x', nsPerOp: 1, iterations: 1, batches: 1, elapsedMs: 1, sinkType: 'number' })
    await writeFile(outFile, full.slice(0, full.length - 10))

    // Asserted via .resolves rather than a bare await: if the underlying
    // implementation reverts to letting the parse error propagate, this
    // promise REJECTS, and .resolves is what turns that into a normal
    // failing assertion instead of an unhandled-rejection test crash.
    await expect(readChildResult(outFile, 'x', fakeExec, 30_000)).resolves.toMatchObject({
      ok: false,
      id: 'x',
      error: expect.stringMatching(/malformed/i),
    })
  })

  it('reports ok:false when --out contains valid JSON with the wrong shape', async () => {
    const dir = await tmp()
    const outFile = path.join(dir, 'result.json')
    await writeFile(outFile, JSON.stringify({ notARealResult: true }))

    const r = await readChildResult(outFile, 'x', fakeExec, 30_000)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/malformed/i)
  })

  // Deferred item, reclassified from "documented limitation" to defect by
  // the final whole-branch review: parseBenchResult previously validated
  // only `ok` and `id` before casting the rest of the object straight to
  // BenchResult. A SIGKILL mid-writeFile can, unlike the truncated-JSON case
  // above, leave a document that is SYNTACTICALLY COMPLETE (e.g. an
  // atomic-rename race landing between two writes) but missing or garbling
  // a field inside it -- `ok:true` with `nsPerOp` absent parses to
  // `undefined`, which previously reached the statistics layer looking like
  // a legitimate measurement rather than a visible failure.
  it('reports ok:false when ok:true is missing its nsPerOp field entirely', async () => {
    const dir = await tmp()
    const outFile = path.join(dir, 'result.json')
    await writeFile(outFile, JSON.stringify({ ok: true, id: 'x', iterations: 1, batches: 1, elapsedMs: 1, sinkType: 'number' }))

    const r = await readChildResult(outFile, 'x', fakeExec, 30_000)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/malformed/i)
    expect(r.error).toMatch(/nsPerOp/)
  })

  it.each([
    ['NaN written as null', null],
    ['a negative number', -1],
    ['zero', 0],
    ['a string', '1.5'],
  ])('reports ok:false when ok:true carries an invalid nsPerOp (%s)', async (_label, badValue) => {
    const dir = await tmp()
    const outFile = path.join(dir, 'result.json')
    await writeFile(
      outFile,
      JSON.stringify({ ok: true, id: 'x', nsPerOp: badValue, iterations: 1, batches: 1, elapsedMs: 1, sinkType: 'number' }),
    )

    const r = await readChildResult(outFile, 'x', fakeExec, 30_000)
    expect(r.ok).toBe(false)
  })

  it('reports ok:false naming the timeout when --out is missing because the child never wrote it', async () => {
    const dir = await tmp()
    const outFile = path.join(dir, 'result.json') // never written
    const r = await readChildResult(outFile, 'x', { timedOut: true, exitCode: 137, stderr: 'stuck' }, 1234)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/timed out after 1234ms/)
  })
})

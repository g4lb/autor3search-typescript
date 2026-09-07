import { describe, expect, it } from 'vitest'
import { discoverBenchmarks } from '../discover/benchmarks.js'
import { detect } from '../pm/detect.js'
import { ok, run } from '../runner/exec.js'
import { makeDemoRepo } from './demo.js'

describe('makeDemoRepo', () => {
  it('produces a clean tree with a HEAD commit', async () => {
    const root = await makeDemoRepo()
    const status = await run('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 30_000 })
    expect(ok(status)).toBe(true)
    expect(status.stdout.trim()).toBe('')

    const head = await run('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 30_000 })
    expect(ok(head)).toBe(true)
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('discoverBenchmarks finds exactly the one real benchmark in it', async () => {
    const root = await makeDemoRepo()
    const found = await discoverBenchmarks(root)
    expect(found.map((b) => b.id)).toEqual(['src/wordcount.bench.ts:benchCountWords'])
  })

  it('is detected as an npm package', async () => {
    const root = await makeDemoRepo()
    const d = await detect(root)
    expect(d.pm).toBe('npm')
    expect(d.lockfile).toBe('package-lock.json')
    expect(d.installCommand).toBe('npm ci')
  })

  // Real npm install and a real test run: this is what proves the fixture is
  // genuinely usable, not merely well-formed. Skippable on a constrained CI
  // runner that has no npm registry access at all -- though since the fixture
  // has zero dependencies, `npm ci` here never actually reaches the network.
  it.skipIf(process.env['CI_SKIP_INSTALL'] !== undefined)(
    "the demo's own test suite passes for real, after a real npm ci",
    async () => {
      const root = await makeDemoRepo()
      const install = await run('npm', ['ci'], { cwd: root, timeoutMs: 120_000 })
      expect(ok(install)).toBe(true)

      const test = await run('npm', ['test'], { cwd: root, timeoutMs: 60_000 })
      expect(ok(test)).toBe(true)
      // `node --test`'s DEFAULT REPORTER changed between Node 22 and 24:
      // 22 emits TAP (`# pass 3`), 24 emits the spec reporter (`ℹ pass 3`).
      // Pinning one spelling made this a Node-version test rather than a
      // demo-fixture test, and it failed on every platform under Node 24 --
      // caught the day the CI matrix started covering 24 at all. Accept
      // either marker; the COUNTS are what this test is about.
      expect(test.stdout).toMatch(/[#ℹ]\s*pass 3/)
      expect(test.stdout).toMatch(/[#ℹ]\s*fail 0/)
    },
    120_000,
  )
})

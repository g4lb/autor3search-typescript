import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH } from '../config/schema.js'
import { RESULTS_PATH } from '../results/results.js'
import type { Check } from '../doctor/doctor.js'
import type { RunCtx } from './runctx.js'

// Mocked so the "returns 0 even when checks fail" behavior is deterministic
// -- this dev machine may legitimately pass every real check, and the whole
// point of this suite is to prove cmdDoctor's exit code does not depend on
// check outcomes at all.
vi.mock('../doctor/doctor.js', () => ({
  runChecks: vi.fn(),
}))

const { runChecks } = await import('../doctor/doctor.js')
const { cmdDoctor } = await import('./cmd-doctor.js')

function ctxFor(root: string): RunCtx {
  return {
    repoRoot: root,
    configPath: path.join(root, CONFIG_PATH),
    resultsPath: path.join(root, RESULTS_PATH),
    logPath: path.join(root, 'run.log'),
  }
}

const CTX = ctxFor('/irrelevant-for-doctor')

let stdout: string[]
let stdoutSpy: ReturnType<typeof vi.spyOn>

function captureStdout(): void {
  stdout = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
}

afterEach(() => {
  stdoutSpy?.mockRestore()
  vi.mocked(runChecks).mockReset()
})

describe('cmdDoctor', () => {
  it('returns 0 even when every check fails -- doctor is informational only', async () => {
    const failing: Check[] = [
      { name: 'node-version', ok: false, detail: 'too old, upgrade' },
      { name: 'disk-space', ok: false, detail: 'too little, free some up' },
    ]
    vi.mocked(runChecks).mockResolvedValue(failing)
    captureStdout()

    const code = await cmdDoctor(CTX, [])

    expect(code).toBe(0)
  })

  it('returns 0 when every check passes', async () => {
    vi.mocked(runChecks).mockResolvedValue([{ name: 'node-version', ok: true, detail: 'fine' }])
    captureStdout()

    const code = await cmdDoctor(CTX, [])

    expect(code).toBe(0)
  })

  it('prints each check name and detail, marking failures distinctly from passes', async () => {
    vi.mocked(runChecks).mockResolvedValue([
      { name: 'node-version', ok: true, detail: 'Node v22.0.0 meets the minimum.' },
      { name: 'disk-space', ok: false, detail: 'only 0.5 GB free, below the floor' },
    ])
    captureStdout()

    await cmdDoctor(CTX, [])
    const out = stdout.join('')

    expect(out).toMatch(/node-version/)
    expect(out).toMatch(/Node v22\.0\.0 meets the minimum\./)
    expect(out).toMatch(/disk-space/)
    expect(out).toMatch(/only 0\.5 GB free, below the floor/)
    // A passing and a failing check must render with visibly different markers.
    const nodeLine = out.split('\n').find((l) => l.includes('node-version'))
    const diskLine = out.split('\n').find((l) => l.includes('disk-space'))
    expect(nodeLine).toBeDefined()
    expect(diskLine).toBeDefined()
    expect(nodeLine).not.toBe(diskLine)
    expect(nodeLine?.match(/OK|WARN/)?.[0]).not.toBe(diskLine?.match(/OK|WARN/)?.[0])
  })

  it('never writes to stderr -- this command has nothing to fail loudly about', async () => {
    vi.mocked(runChecks).mockResolvedValue([{ name: 'x', ok: false, detail: 'y' }])
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    captureStdout()

    await cmdDoctor(CTX, [])

    expect(stderrSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })
})

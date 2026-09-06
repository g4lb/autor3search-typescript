import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH } from '../config/schema.js'
import { headCommit } from '../gitx/git.js'
import { RESULTS_PATH } from '../results/results.js'
import { ok, run } from '../runner/exec.js'
import { STATE_HOME_ENV, runDir } from '../state/home.js'
import { lockPath } from '../state/lock.js'
import { readStop } from '../state/stop.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { cmdBaseline } from './cmd-baseline.js'
import { cmdEval } from './cmd-eval.js'
import { cmdInit } from './cmd-init.js'
import { cmdStop } from './cmd-stop.js'
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

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await run('git', args, { cwd, timeoutMs: 60_000 })
  if (!ok(r)) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

async function patchConfig(ctx: RunCtx, patches: Record<string, string>): Promise<void> {
  let text = await readFile(ctx.configPath, 'utf8')
  for (const [key, value] of Object.entries(patches)) {
    const re = new RegExp(`^${key}:.*$`, 'm')
    if (!re.test(text)) throw new Error(`patchConfig: key not found in config: ${key}`)
    text = text.replace(re, `${key}: ${value}`)
  }
  await writeFile(ctx.configPath, text, 'utf8')
}

const TAG = 'sep6'
// Same reasoning as the identical constant in cmd-eval.test.ts: count 10,
// not the minimum 4, so a real experiment's p-value floor isn't thin enough
// for timing noise to flip it.
const FAST_MEASURE_PATCHES: Record<string, string> = {
  count: '10',
  benchtime: JSON.stringify('5ms'),
  warmup: JSON.stringify('0ms'),
}

/**
 * Advances HEAD past `baseline.measureCommit` with a trivial, in-scope,
 * non-frozen edit -- gate 8 refuses to evaluate a commit that is still the
 * one already recorded as measured, so any test driving a real measurement
 * needs one real commit past baseline first.
 */
async function trivialCommit(root: string): Promise<void> {
  const file = path.join(root, 'src', 'wordcount.ts')
  const text = await readFile(file, 'utf8')
  await writeFile(file, `${text}\n// trivial, in-scope, non-functional edit\n`, 'utf8')
  await git(root, ['add', 'src/wordcount.ts'])
  await git(root, ['commit', '-q', '-m', 'chore: trivial commit to advance HEAD past measureCommit'])
}

async function setup(patches: Record<string, string> = {}): Promise<{ root: string; ctx: RunCtx }> {
  const root = await makeDemoRepo()
  const ctx = ctxFor(root)
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(await cmdInit(ctx, [])).toBe(0)
    if (Object.keys(patches).length > 0) await patchConfig(ctx, patches)
    await git(root, ['add', '.autor3search/config.yaml', 'program.md', '.gitignore'])
    await git(root, ['commit', '-q', '-m', 'init'])
    expect(await cmdBaseline(ctx, ['-tag', TAG])).toBe(0)
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
  return { root, ctx }
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

let stateHomeDir: string
let originalStateHomeEnv: string | undefined

beforeEach(async () => {
  originalStateHomeEnv = process.env[STATE_HOME_ENV]
  stateHomeDir = await mkdtemp(path.join(tmpdir(), 'ars-cmdstop-state-'))
  process.env[STATE_HOME_ENV] = stateHomeDir
})

afterEach(async () => {
  if (originalStateHomeEnv === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHomeEnv
  await rm(stateHomeDir, { recursive: true, force: true })
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
})

describe('cmdStop', () => {
  it('writes a request that eval reports as stop_requested', async () => {
    const { root, ctx } = await setup(FAST_MEASURE_PATCHES)
    await trivialCommit(root)
    captureOutput()
    expect(await cmdStop(ctx, ['-tag', TAG])).toBe(0)
    expect(stdout.join('')).toMatch(/stop requested for tag "sep6"/)

    captureOutput()
    const code = await cmdEval(ctx, ['-tag', TAG, '--json'])
    expect([0, 1]).toContain(code)
    const parsed = JSON.parse(stdout.join('')) as { stop_requested: boolean }
    expect(parsed.stop_requested).toBe(true)
  })

  it('-clear cancels a pending request', async () => {
    const { root, ctx } = await setup()
    const dir = runDir(root, TAG)
    captureOutput()
    expect(await cmdStop(ctx, ['-tag', TAG])).toBe(0)
    expect(await readStop(dir)).not.toBeNull()

    captureOutput()
    const code = await cmdStop(ctx, ['-tag', TAG, '-clear'])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/cleared/)
    expect(await readStop(dir)).toBeNull()
  })

  it('refuses -clear and -force together as a usage error', async () => {
    const { root, ctx } = await setup()
    const dir = runDir(root, TAG)
    captureOutput()

    const code = await cmdStop(ctx, ['-tag', TAG, '-clear', '-force'])

    expect(code).toBe(2)
    expect(stderr.join('')).toMatch(/-clear and -force are mutually exclusive/)
    // A rejected usage combination must not write anything -- neither
    // request nor clear.
    expect(await readStop(dir)).toBeNull()
  })

  it('infers -tag from the current run branch when -tag is omitted', async () => {
    const { ctx } = await setup()
    // baseline leaves the repo checked out on "autor3search-typescript/sep6";
    // every other test in this file passes -tag explicitly, so this is the
    // only coverage of inferTagFromBranch actually running end to end.
    captureOutput()

    const code = await cmdStop(ctx, [])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/stop requested for tag "sep6"/)
  })

  it('-force records force and reports what state the repo is in', async () => {
    const { root, ctx } = await setup()
    const dir = runDir(root, TAG)
    const head = await headCommit(root)
    const branch = 'autor3search-typescript/sep6'
    captureOutput()

    const code = await cmdStop(ctx, ['-tag', TAG, '-force'])

    expect(code).toBe(0)
    const stop = await readStop(dir)
    expect(stop?.force).toBe(true)
    const text = stdout.join('')
    expect(text).toMatch(new RegExp(branch))
    expect(text).toMatch(new RegExp(head.slice(0, 7)))
    expect(text).toMatch(/git reset --hard HEAD~1/)
    // Dropping work is the human's decision -- the command only ever
    // PRINTS the reset command, it must never itself run git reset.
    expect(text).not.toMatch(/HEAD~1\n\$/)
  })

  it('-force does NOT itself reset any commit', async () => {
    const { root, ctx } = await setup()
    const before = await headCommit(root)
    captureOutput()

    expect(await cmdStop(ctx, ['-tag', TAG, '-force'])).toBe(0)

    const after = await headCommit(root)
    expect(after).toBe(before)
  })

  it('on a tag with no run, explains that rather than creating state', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    const dir = runDir(root, 'nope')
    captureOutput()

    const code = await cmdStop(ctx, ['-tag', 'nope'])

    expect(code).toBe(2)
    expect(stderr.join('')).toMatch(/no baseline found/)
    expect(await exists(dir)).toBe(false)
  })

  it('-force refuses to signal pid 1 group, exactly as runner/exec.ts does', async () => {
    const { root, ctx } = await setup()
    const dir = runDir(root, TAG)
    await mkdir(dir, { recursive: true })
    // A lock recording pid 1 -- e.g. a process whose group leader has
    // already exited and now reports ppid 1 on Linux. Signalling this
    // group would mean signalling everything the user can reach.
    await writeFile(lockPath(dir), JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }), {
      flag: 'wx',
    })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    captureOutput()

    const code = await cmdStop(ctx, ['-tag', TAG, '-force'])

    expect(code).toBe(0)
    // A signal-0 liveness probe (process.kill(pid, 0)) sends nothing and is
    // harmless even for pid 1 -- it's how this command decides whether to
    // report the lock as "running" at all. What must never happen is an
    // ACTUAL signal (SIGTERM here) reaching pid 1 or its process group.
    for (const call of killSpy.mock.calls) {
      const [pidArg, sigArg] = call
      if (sigArg === 0) continue
      expect(pidArg, `unexpected real signal ${String(sigArg)} to pid ${String(pidArg)}`).not.toBe(1)
      expect(pidArg, `unexpected real signal ${String(sigArg)} to pid ${String(pidArg)}`).not.toBe(-1)
    }
    killSpy.mockRestore()
  })

  it('-force actually signals a real running process recorded in eval.lock', async () => {
    const { root, ctx } = await setup()
    const dir = runDir(root, TAG)
    await mkdir(dir, { recursive: true })
    // A real, detached child (its own process group) standing in for a
    // running `eval` -- proof this sends a real, effective signal, not
    // merely a call that a mock swallows.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const childPid = child.pid
    expect(childPid).toBeDefined()
    await writeFile(
      lockPath(dir),
      JSON.stringify({ pid: childPid, startedAt: new Date().toISOString() }),
      { flag: 'wx' },
    )

    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    captureOutput()
    const code = await cmdStop(ctx, ['-tag', TAG, '-force'])
    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(new RegExp(`signalled pid ${childPid}`))

    await Promise.race([
      exited,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('child did not exit')), 5_000)),
    ])
  })
})

import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH } from '../config/schema.js'
import { headCommit } from '../gitx/git.js'
import { RESULTS_PATH, appendRow, type Row } from '../results/results.js'
import { ok, run } from '../runner/exec.js'
import { STATE_HOME_ENV, runDir } from '../state/home.js'
import { acquireEvalLock } from '../state/lock.js'
import { requestStop } from '../state/stop.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { cmdBaseline } from './cmd-baseline.js'
import { cmdInit } from './cmd-init.js'
import { cmdStatus } from './cmd-status.js'
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

const TAG = 'sep6'

async function setup(): Promise<{ root: string; ctx: RunCtx }> {
  const root = await makeDemoRepo()
  const ctx = ctxFor(root)
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(await cmdInit(ctx, [])).toBe(0)
    await git(root, ['add', 'program.md', '.gitignore'])
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
  stateHomeDir = await mkdtemp(path.join(tmpdir(), 'ars-cmdstatus-state-'))
  process.env[STATE_HOME_ENV] = stateHomeDir
})

afterEach(async () => {
  if (originalStateHomeEnv === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHomeEnv
  await rm(stateHomeDir, { recursive: true, force: true })
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
})

/**
 * A flat map of every regular file under `root` to its size and mtime.
 * Used to PROVE `status` writes nothing, not merely assert it returns 0 --
 * a command can exit successfully while still touching disk incidentally
 * (a log line, a cache refresh, ...), and only a full before/after
 * filesystem comparison rules that out.
 */
async function snapshotTree(root: string): Promise<Record<string, { size: number; mtimeMs: number }>> {
  const out: Record<string, { size: number; mtimeMs: number }> = {}
  let names: string[]
  try {
    names = await readdir(root, { recursive: true })
  } catch {
    return out
  }
  for (const rel of names) {
    const full = path.join(root, rel)
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(full)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    out[rel] = { size: st.size, mtimeMs: st.mtimeMs }
  }
  return out
}

function assertTreeUnchanged(
  before: Record<string, { size: number; mtimeMs: number }>,
  after: Record<string, { size: number; mtimeMs: number }>,
  label: string,
): void {
  expect(Object.keys(after).sort(), `${label}: file set changed`).toEqual(Object.keys(before).sort())
  for (const key of Object.keys(before)) {
    expect(after[key], `${label}: ${key} changed`).toEqual(before[key])
  }
}

describe('cmdStatus', () => {
  it('writes nothing: checking on a run cannot change it', async () => {
    const { root, ctx } = await setup()
    const dir = runDir(root, TAG)
    // A row already on disk, plus a pending stop and an in-flight eval lock,
    // so status has plenty of real state to read while proving it writes
    // none of it back out.
    const row: Row = {
      commit: await headCommit(root),
      score: 0.9,
      bestBenchDelta: -10,
      pMin: 0.001,
      status: 'keep',
      reason: '',
      description: 'a synthetic experiment',
    }
    await appendRow(ctx.resultsPath, row)
    await requestStop(dir, false)
    const release = await acquireEvalLock(dir)

    const dirBefore = await snapshotTree(dir)
    const repoBefore = await snapshotTree(root)

    captureOutput()
    const code = await cmdStatus(ctx, ['-tag', TAG])
    expect(code).toBe(0)

    const dirAfter = await snapshotTree(dir)
    const repoAfter = await snapshotTree(root)
    assertTreeUnchanged(dirBefore, dirAfter, 'run dir')
    assertTreeUnchanged(repoBefore, repoAfter, 'repo')

    await release()
  })

  it('works from any branch via -tag', async () => {
    const { root, ctx } = await setup()
    // baseline leaves the repo checked out on the run branch; wander off it.
    await git(root, ['checkout', '-q', 'main'])
    captureOutput()

    const code = await cmdStatus(ctx, ['-tag', TAG])

    expect(code).toBe(0)
    const text = stdout.join('')
    expect(text).toMatch(/tag "sep6"/)
    expect(text).toMatch(/run branch:\s+autoresearch-typescript\/sep6/)
    expect(text).toMatch(/current branch:\s+main.*not on the run branch/)
  })

  it('infers -tag from the current run branch when -tag is omitted', async () => {
    const { ctx } = await setup()
    // baseline leaves the repo checked out on "autoresearch-typescript/sep6";
    // every other test in this file passes -tag explicitly, so this is the
    // only coverage of inferTagFromBranch actually running end to end.
    captureOutput()

    const code = await cmdStatus(ctx, [])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/tag "sep6"/)
  })

  it('reports the run branch, frozen and measurement commits, and counts by verdict', async () => {
    const { root, ctx } = await setup()
    const head = await headCommit(root)
    const rows: Row[] = [
      { commit: head, score: 0.8, bestBenchDelta: -20, pMin: 0.001, status: 'keep', reason: '', description: 'win 1' },
      {
        commit: head,
        score: 1.0,
        bestBenchDelta: 0.1,
        pMin: 0.9,
        status: 'discard',
        reason: 'no_significant_improvement',
        description: '',
      },
      { commit: head, score: 1, bestBenchDelta: 0, pMin: 1, status: 'fail', reason: '', description: 'scope violation' },
    ]
    for (const r of rows) await appendRow(ctx.resultsPath, r)
    captureOutput()

    const code = await cmdStatus(ctx, ['-tag', TAG])

    expect(code).toBe(0)
    const text = stdout.join('')
    expect(text).toMatch(/run branch:\s+autoresearch-typescript\/sep6/)
    expect(text).toMatch(new RegExp(`frozen commit:\\s+${head.slice(0, 7)}`))
    expect(text).toMatch(new RegExp(`measure commit:\\s+${head.slice(0, 7)}`))
    expect(text).toMatch(/experiments:\s+3 total/)
    expect(text).toMatch(/keep: 1/)
    expect(text).toMatch(/discard: 1/)
    expect(text).toMatch(/fail: 1/)
    expect(text).toMatch(/crash: 0/)
  })

  it('reports whether an eval is in flight', async () => {
    const { root, ctx } = await setup()
    const dir = runDir(root, TAG)
    captureOutput()
    expect(await cmdStatus(ctx, ['-tag', TAG])).toBe(0)
    expect(stdout.join('')).toMatch(/eval:\s+idle/)

    const release = await acquireEvalLock(dir)
    captureOutput()
    expect(await cmdStatus(ctx, ['-tag', TAG])).toBe(0)
    expect(stdout.join('')).toMatch(new RegExp(`eval:\\s+running \\(pid ${process.pid}\\)`))
    await release()

    captureOutput()
    expect(await cmdStatus(ctx, ['-tag', TAG])).toBe(0)
    expect(stdout.join('')).toMatch(/eval:\s+idle/)
  })

  it('reports a pending stop', async () => {
    const { root, ctx } = await setup()
    const dir = runDir(root, TAG)
    captureOutput()
    expect(await cmdStatus(ctx, ['-tag', TAG])).toBe(0)
    expect(stdout.join('')).toMatch(/stop:\s+none pending/)

    await requestStop(dir, true)
    captureOutput()
    expect(await cmdStatus(ctx, ['-tag', TAG])).toBe(0)
    const text = stdout.join('')
    expect(text).toMatch(/stop:\s+requested at .+\(force: yes\)/)
  })

  it('on a tag with no run, explains that rather than creating state', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    const dir = runDir(root, 'nope')
    captureOutput()

    const code = await cmdStatus(ctx, ['-tag', 'nope'])

    expect(code).toBe(2)
    expect(stderr.join('')).toMatch(/no baseline found/)
    expect(await exists(dir)).toBe(false)
  })
})

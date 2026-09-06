import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH } from '../config/schema.js'
import { run, ok } from '../runner/exec.js'
import { STATE_HOME_ENV } from '../state/home.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { COMMANDS, main } from './main.js'

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

let stateHomeDir: string
let originalStateHomeEnv: string | undefined

beforeEach(async () => {
  originalStateHomeEnv = process.env[STATE_HOME_ENV]
  // Redirected to a scratch directory so the "baseline" dispatch test below
  // never touches the real user cache.
  stateHomeDir = await mkdtemp(path.join(tmpdir(), 'ars-main-state-'))
  process.env[STATE_HOME_ENV] = stateHomeDir
})

afterEach(async () => {
  if (originalStateHomeEnv === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHomeEnv
  await rm(stateHomeDir, { recursive: true, force: true })
})

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await run('git', args, { cwd, timeoutMs: 60_000 })
  if (!ok(r)) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

describe('main', () => {
  it('prints the command table and exits 2 with no arguments', async () => {
    captureOutput()
    const code = await main([])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/Commands:/)
    expect(stdout.join('')).toMatch(/init/)
  })

  it('prints the command table and exits 2 for --help', async () => {
    captureOutput()
    const code = await main(['--help'])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/Usage:/)
  })

  it('exits 2 for an unknown subcommand, naming it', async () => {
    captureOutput()
    const code = await main(['bogus'])
    expect(code).toBe(2)
    expect(stderr.join('')).toMatch(/unknown command "bogus"/)
  })

  it('exits 2 with a usage error when -C has no directory', async () => {
    captureOutput()
    const code = await main(['-C'])
    expect(code).toBe(2)
    expect(stderr.join('')).toMatch(/-C requires a directory/)
  })

  it('never prints a raw stack trace when -C points outside any git repository', async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), 'ars-main-norepo-'))
    captureOutput()

    const code = await main(['-C', notARepo, 'init'])

    expect(code).toBe(2)
    const message = stderr.join('')
    expect(message).toMatch(/^error: /)
    expect(message).not.toMatch(/at file:|\.ts:\d+:\d+|node:internal/)
  })

  it('dispatches "init" against -C <dir>, actually writing the config', async () => {
    const root = await makeDemoRepo()
    captureOutput()

    const code = await main(['-C', root, 'init'])

    expect(code).toBe(0)
    expect(await exists(path.join(root, CONFIG_PATH))).toBe(true)
  })

  it('does not touch process.cwd() while dispatching', async () => {
    const root = await makeDemoRepo()
    const cwdBefore = process.cwd()
    captureOutput()
    await main(['-C', root, 'init'])
    expect(process.cwd()).toBe(cwdBefore)
  })

  // Ruling 34: a command that only calls its own `cmd*` function directly
  // (never through `main`) would still pass even if it were never added to
  // `COMMANDS` -- that is exactly the bug this test exists to catch, so it
  // must dispatch through `main` itself.
  it('dispatches "doctor" through main -- registered, not merely implemented', async () => {
    const root = await makeDemoRepo()
    captureOutput()

    const code = await main(['-C', root, 'doctor'])

    expect(code).toBe(0)
    // Something recognisable from doctor's own output, not just a zero exit
    // code (which an unknown-command path could also produce by accident).
    expect(stdout.join('')).toMatch(/can this machine measure reliably/)
    expect(stderr.join('')).toBe('')
  })

  it('lists "doctor" in --help output', async () => {
    captureOutput()
    const code = await main(['--help'])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/doctor/)
  })

  // Ruling 34: same reasoning as the doctor test above -- a command that is
  // implemented and even fully tested in its own file is not proven
  // reachable until something dispatches it through `main` itself.
  it('dispatches "baseline" through main -- registered, not merely implemented', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await main(['-C', root, 'init'])).toBe(0)
    await git(root, ['add', '.autor3search/config.yaml', 'program.md', '.gitignore'])
    await git(root, ['commit', '-q', '-m', 'init'])

    captureOutput()
    const code = await main(['-C', root, 'baseline', '-tag', 'sep6'])

    expect(code).toBe(0)
    // Something recognisable from baseline's own success output, not just a
    // zero exit code.
    expect(stdout.join('')).toMatch(/baseline "sep6" created at/)
    expect(stderr.join('')).toBe('')
  })

  it('lists "baseline" in --help output', async () => {
    captureOutput()
    const code = await main(['--help'])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/baseline/)
  })

  // Ruling 34, same reasoning as doctor/baseline above: eval must be proven
  // reachable through main's own dispatch table, not merely implemented and
  // tested in its own file.
  it('dispatches "eval" through main -- registered, not merely implemented', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await main(['-C', root, 'init'])).toBe(0)
    await git(root, ['add', '.autor3search/config.yaml', 'program.md', '.gitignore'])
    await git(root, ['commit', '-q', '-m', 'init'])
    captureOutput()
    expect(await main(['-C', root, 'baseline', '-tag', 'sep6'])).toBe(0)

    captureOutput()
    // No code change since baseline: whatever the statistical outcome (this
    // does not inject a fake measurer, so it runs the real, tiny demo
    // benchmark), the point here is only that dispatch reaches cmdEval and
    // produces a well-formed, single-JSON-object result -- not any
    // particular verdict.
    const code = await main(['-C', root, 'eval', '-tag', 'sep6', '--json'])

    expect([0, 1, 2, 3]).toContain(code)
    const lines = stdout.join('').split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0] as string) as { status: string; exit_code: number }
    expect(['keep', 'discard', 'fail', 'crash']).toContain(parsed.status)
    expect(parsed.exit_code).toBe(code)
  })

  it('lists "eval" in --help output', async () => {
    captureOutput()
    const code = await main(['--help'])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/eval/)
  })

  // Ruling 34, same reasoning as doctor/baseline/eval above: status must be
  // proven reachable through main's own dispatch table, not merely
  // implemented and tested in its own file. `doctor` was implemented,
  // tested, and unreachable for exactly this reason.
  it('dispatches "status" through main -- registered, not merely implemented', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await main(['-C', root, 'init'])).toBe(0)
    await git(root, ['add', '.autor3search/config.yaml', 'program.md', '.gitignore'])
    await git(root, ['commit', '-q', '-m', 'init'])
    captureOutput()
    expect(await main(['-C', root, 'baseline', '-tag', 'sep6'])).toBe(0)

    captureOutput()
    const code = await main(['-C', root, 'status', '-tag', 'sep6'])

    expect(code).toBe(0)
    // Something recognisable from status's own output, not just a zero exit
    // code (which an unknown-command path could also produce by accident).
    expect(stdout.join('')).toMatch(/tag "sep6"/)
    expect(stderr.join('')).toBe('')
  })

  it('lists "status" in --help output', async () => {
    captureOutput()
    const code = await main(['--help'])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/status/)
  })

  // Ruling 34, same reasoning as above.
  it('dispatches "stop" through main -- registered, not merely implemented', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await main(['-C', root, 'init'])).toBe(0)
    await git(root, ['add', '.autor3search/config.yaml', 'program.md', '.gitignore'])
    await git(root, ['commit', '-q', '-m', 'init'])
    captureOutput()
    expect(await main(['-C', root, 'baseline', '-tag', 'sep6'])).toBe(0)

    captureOutput()
    const code = await main(['-C', root, 'stop', '-tag', 'sep6'])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/stop requested for tag "sep6"/)
    expect(stderr.join('')).toBe('')
  })

  it('lists "stop" in --help output', async () => {
    captureOutput()
    const code = await main(['--help'])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/stop/)
  })

  // Ruling 34, same reasoning as above: report must be proven reachable
  // through main's own dispatch table, not merely implemented and tested in
  // its own file.
  it('dispatches "report" through main -- registered, not merely implemented', async () => {
    const root = await makeDemoRepo()
    captureOutput()

    // No init/baseline/eval at all -- report on a virgin repo must still
    // work, with a helpful "nothing recorded yet" message rather than an
    // error, and it must be reachable through main to prove it.
    const code = await main(['-C', root, 'report'])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/no experiments recorded yet/)
    expect(stderr.join('')).toBe('')
  })

  it('lists "report" in --help output', async () => {
    captureOutput()
    const code = await main(['--help'])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/report/)
  })

  // Ruling 34, same reasoning as above: profile must be proven reachable
  // through main's own dispatch table, not merely implemented and tested in
  // its own file. It also must not require a baseline (point 3 of the task
  // guidance), so this dispatches it straight after "init" with no
  // "baseline" call at all.
  it('dispatches "profile" through main -- registered, not merely implemented, and needs no baseline', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await main(['-C', root, 'init'])).toBe(0)

    captureOutput()
    const code = await main(['-C', root, 'profile'])

    expect(code).toBe(0)
    // The demo fixture's own hot function -- proof this is real profiler
    // attribution, not a stub that only lists Node internals.
    expect(stdout.join('')).toMatch(/countWords/)
    expect(stderr.join('')).toBe('')
  }, 30_000)

  it('lists "profile" in --help output', async () => {
    captureOutput()
    const code = await main(['--help'])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/profile/)
  })

  it('exposes exactly eight commands', () => {
    expect(Object.keys(COMMANDS)).toHaveLength(8)
  })

  // Ruling 34, extended: the mutation evidence for the doctor reachability
  // test also showed that HELP and COMMANDS are two independent strings
  // that can silently disagree -- removing a COMMANDS entry broke dispatch
  // while the --help assertion still passed. This closes that gap once,
  // for every command, rather than costing a per-command test forever.
  it('every command in COMMANDS is listed in --help, and vice versa', async () => {
    captureOutput()
    await main(['--help'])
    const help = stdout.join('')
    const commandsSection = help.split('Commands:')[1]?.split('Global flags:')[0] ?? ''
    const listed = new Set([...commandsSection.matchAll(/^\s{2}(\S+)/gm)].map((m) => m[1]))
    expect(listed.size).toBeGreaterThan(0)
    expect(listed).toEqual(new Set(Object.keys(COMMANDS)))
  })
})

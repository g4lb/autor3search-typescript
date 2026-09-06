import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config/load.js'
import { CONFIG_PATH } from '../config/schema.js'
import { RESULTS_PATH } from '../results/results.js'
import { headCommit, isClean } from '../gitx/git.js'
import { run } from '../runner/exec.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { cmdInit, templatesDir } from './cmd-init.js'
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

/** A plain (non-git) directory with the given files, for pm-detection tests. */
async function plainRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ars-init-'))
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), body)
  }
  return root
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

describe('cmdInit', () => {
  it('refuses a repository with no benchmarks and writes no config', async () => {
    const root = await makeDemoRepo()
    await rm(path.join(root, 'src', 'wordcount.bench.ts'))
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/no benchmarks/)
    expect(await exists(path.join(root, CONFIG_PATH))).toBe(false)
    expect(await exists(path.join(root, '.autoresearch'))).toBe(false)
    expect(await exists(path.join(root, 'program.md'))).toBe(false)
    expect(await exists(path.join(root, '.gitignore'))).toBe(false)
  })

  it('writes config, program.md and .gitignore entries', async () => {
    const root = await makeDemoRepo()
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])
    expect(code).toBe(0)

    expect(await exists(path.join(root, CONFIG_PATH))).toBe(true)
    expect(await exists(path.join(root, 'program.md'))).toBe(true)

    const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8')
    expect(gitignore).toMatch(/\.autoresearch\//)
    expect(gitignore).toMatch(/^results\.tsv$/m)
    expect(gitignore).toMatch(/^run\.log$/m)
    expect(gitignore).toMatch(/\*\.cpuprofile/)
  })

  it('discovers the demo benchmark and lists it to the user', async () => {
    const root = await makeDemoRepo()
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])

    expect(code).toBe(0)
    expect(stdout.join('')).toMatch(/src\/wordcount\.bench\.ts:benchCountWords/)
    const programMd = await readFile(path.join(root, 'program.md'), 'utf8')
    expect(programMd).toMatch(/src\/wordcount\.bench\.ts:benchCountWords/)
  })

  it('derives test_command from the detected package manager, not a hardcoded npm', async () => {
    const root = await makeDemoRepo()
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])
    expect(code).toBe(0)

    const cfg = await loadConfig(path.join(root, CONFIG_PATH))
    // The demo fixture is detected as npm (package-lock.json), so "npm test"
    // is correct here -- but it is *derived* from the detected pm, not
    // hardcoded: see the pnpm test below for the case where that matters.
    expect(cfg.testCommand).toBe('npm test')
  })

  it('derives test_command from pnpm, not npm, when pnpm is the detected package manager', async () => {
    // Ruling 4: every command must be derived from the DETECTED package
    // manager. A repo pinned to pnpm given "npm test" either fails outright
    // or resolves dependencies differently than its own lockfile promises.
    const root = await plainRepo({
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 't', build: 'b' } }),
      'pnpm-lock.yaml': '',
      'src/foo.bench.ts': 'export function benchFoo() { return 1 }\n',
    })
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])
    expect(code).toBe(0)

    const cfg = await loadConfig(path.join(root, CONFIG_PATH))
    expect(cfg.testCommand).toBe('pnpm test')
    expect(cfg.buildCommand).toBe('pnpm run build')
  })

  it('leaves typecheck_command empty and warns when there is no tsconfig.json', async () => {
    // Ruling 25: the demo fixture deliberately has no tsconfig.json, so this
    // is the expected branch against it, not a bug.
    const root = await makeDemoRepo()
    expect(await exists(path.join(root, 'tsconfig.json'))).toBe(false)
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])
    expect(code).toBe(0)

    expect(stderr.join('')).toMatch(/typecheck gate is disabled/)
    const cfg = await loadConfig(path.join(root, CONFIG_PATH))
    expect(cfg.typecheckCommand).toBe('')
  })

  it('derives a non-empty typecheck_command through the detected pm when tsconfig.json exists', async () => {
    const root = await plainRepo({
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 't' } }),
      'package-lock.json': '{}',
      'tsconfig.json': '{}',
      'src/foo.bench.ts': 'export function benchFoo() { return 1 }\n',
    })
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])
    expect(code).toBe(0)

    const cfg = await loadConfig(path.join(root, CONFIG_PATH))
    expect(cfg.typecheckCommand).toBe('npx tsc --noEmit')
  })

  it('derives the typecheck runner through pnpm exec, not npx, on a pnpm repo', async () => {
    // Ruling 4 again, specifically for the typecheck runner: `npx` on a pnpm
    // repo either fails (no npx-visible install) or resolves a different
    // typescript than the one the pnpm lockfile actually pins.
    const root = await plainRepo({
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 't' } }),
      'pnpm-lock.yaml': '',
      'tsconfig.json': '{}',
      'src/foo.bench.ts': 'export function benchFoo() { return 1 }\n',
    })
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])
    expect(code).toBe(0)

    const cfg = await loadConfig(path.join(root, CONFIG_PATH))
    expect(cfg.typecheckCommand).toBe('pnpm exec tsc --noEmit')
  })

  it('refuses to overwrite an existing config without -force', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await cmdInit(ctxFor(root), [])).toBe(0)
    const before = await readFile(path.join(root, CONFIG_PATH), 'utf8')

    captureOutput()
    const code = await cmdInit(ctxFor(root), [])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/-force/)
    const after = await readFile(path.join(root, CONFIG_PATH), 'utf8')
    expect(after).toBe(before)
  })

  it('overwrites with -force', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await cmdInit(ctxFor(root), [])).toBe(0)

    captureOutput()
    const code = await cmdInit(ctxFor(root), ['-force'])
    expect(code).toBe(0)
  })

  it('does NOT commit anything', async () => {
    const root = await makeDemoRepo()
    const headBefore = await headCommit(root)
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])
    expect(code).toBe(0)

    expect(await headCommit(root)).toBe(headBefore)
    // init wrote real files, so the tree must now be dirty -- a human has to
    // review and commit them; init does not do that on their behalf.
    expect(await isClean(root)).toBe(false)
  })

  it('writes a config that loadConfig accepts', async () => {
    const root = await makeDemoRepo()
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])
    expect(code).toBe(0)

    await expect(loadConfig(path.join(root, CONFIG_PATH))).resolves.toBeDefined()
  })

  it('refuses a workspace repository, surfacing the pm error', async () => {
    const root = await plainRepo({
      'package.json': JSON.stringify({ name: 'x', workspaces: ['packages/*'] }),
      'package-lock.json': '{}',
    })
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/workspace/i)
    expect(await exists(path.join(root, CONFIG_PATH))).toBe(false)
  })

  it('refuses a repository with no test script', async () => {
    const root = await plainRepo({
      'package.json': JSON.stringify({ name: 'x', scripts: {} }),
      'package-lock.json': '{}',
      'src/foo.bench.ts': 'export function benchFoo() { return 1 }\n',
    })
    captureOutput()

    const code = await cmdInit(ctxFor(root), [])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/test.*script/i)
    expect(await exists(path.join(root, CONFIG_PATH))).toBe(false)
  })

  it('leaves build_command empty when there is no build script', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await cmdInit(ctxFor(root), [])).toBe(0)
    const cfg = await loadConfig(path.join(root, CONFIG_PATH))
    expect(cfg.buildCommand).toBe('')
  })

  it('derives scope as src/** when src/ exists', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await cmdInit(ctxFor(root), [])).toBe(0)
    const cfg = await loadConfig(path.join(root, CONFIG_PATH))
    expect(cfg.scope).toEqual(['src/**'])
  })

  it('derives scope from the top-level directory holding source when there is no src/', async () => {
    const root = await plainRepo({
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 't' } }),
      'package-lock.json': '{}',
      'lib/foo.ts': 'export const x = 1\n',
      'lib/foo.bench.ts': 'export function benchFoo() { return 1 }\n',
    })
    captureOutput()
    expect(await cmdInit(ctxFor(root), [])).toBe(0)
    const cfg = await loadConfig(path.join(root, CONFIG_PATH))
    expect(cfg.scope).toEqual(['lib/**'])
  })

  it('substitutes the discovered benchmark list and a run tag into program.md', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await cmdInit(ctxFor(root), [])).toBe(0)
    const programMd = await readFile(path.join(root, 'program.md'), 'utf8')
    expect(programMd).not.toMatch(/\{\{BENCHMARKS\}\}/)
    expect(programMd).not.toMatch(/\{\{RUN_TAG\}\}/)
    expect(programMd).toMatch(/main/) // makeDemoRepo commits on branch "main"
  })

  it('also accepts the flag as --force (double dash)', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await cmdInit(ctxFor(root), [])).toBe(0)

    captureOutput()
    const code = await cmdInit(ctxFor(root), ['--force'])
    expect(code).toBe(0)
  })

  it('rejects an unknown flag without writing anything', async () => {
    const root = await makeDemoRepo()
    captureOutput()

    const code = await cmdInit(ctxFor(root), ['-bogus'])

    expect(code).not.toBe(0)
    expect(await exists(path.join(root, CONFIG_PATH))).toBe(false)
  })

  it('does not touch process.cwd() while running', async () => {
    const root = await makeDemoRepo()
    const cwdBefore = process.cwd()
    captureOutput()
    await cmdInit(ctxFor(root), [])
    expect(process.cwd()).toBe(cwdBefore)
  })
})

describe('templatesDir', () => {
  it('points at a directory containing program.md', async () => {
    const dir = templatesDir()
    await expect(readFile(path.join(dir, 'program.md'), 'utf8')).resolves.toMatch(/Idea bank/)
  })
})

// A light end-to-end smoke test: what init produces should actually install
// and test cleanly through the derived commands, not merely parse.
describe('cmdInit end-to-end against the demo fixture', () => {
  it('the derived test_command actually runs the demo test suite', async () => {
    const root = await makeDemoRepo()
    captureOutput()
    expect(await cmdInit(ctxFor(root), [])).toBe(0)
    const cfg = await loadConfig(path.join(root, CONFIG_PATH))
    expect(cfg.testCommand).toBe('npm test')

    if (process.env['CI_SKIP_INSTALL'] === '1') return
    const install = await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, timeoutMs: 120_000 })
    expect(install.exitCode).toBe(0)
    const [cmd, ...args] = cfg.testCommand.split(' ')
    const test = await run(cmd!, args, { cwd: root, timeoutMs: 60_000 })
    expect(test.exitCode).toBe(0)
  })
})

import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH } from '../config/schema.js'
import { RESULTS_PATH } from '../results/results.js'
import { hashString } from '../freeze/manifest.js'
import { branchExists, currentBranch, headCommit, isClean } from '../gitx/git.js'
import { ok, run } from '../runner/exec.js'
import { readBaseline } from '../state/baseline.js'
import { runDir, STATE_HOME_ENV } from '../state/home.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { cmdBaseline } from './cmd-baseline.js'
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

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await run('git', args, { cwd, timeoutMs: 60_000 })
  if (!ok(r)) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

/** Runs `init`, commits everything init produced that is meant to be committed. */
async function initAndCommit(root: string, ctx: RunCtx): Promise<void> {
  expect(await cmdInit(ctx, [])).toBe(0)
  await git(root, ['add', '.autoresearch/config.yaml', 'program.md', '.gitignore'])
  await git(root, ['commit', '-q', '-m', 'init: config + program.md'])
}

/**
 * Substitutes one or more top-level `key: value` lines in the generated
 * config, mirroring exactly what `cmd-init`'s own renderer writes -- the
 * same helper other CLI-level suites in this project use.
 */
async function patchConfig(ctx: RunCtx, patches: Record<string, string>): Promise<void> {
  let text = await readFile(ctx.configPath, 'utf8')
  for (const [key, value] of Object.entries(patches)) {
    const re = new RegExp(`^${key}:.*$`, 'm')
    if (!re.test(text)) throw new Error(`patchConfig: key not found in config: ${key}`)
    text = text.replace(re, `${key}: ${value}`)
  }
  await writeFile(ctx.configPath, text, 'utf8')
}

/** Like `initAndCommit`, but patches the generated config before committing it. */
async function initWithConfigAndCommit(root: string, ctx: RunCtx, patches: Record<string, string>): Promise<void> {
  expect(await cmdInit(ctx, [])).toBe(0)
  await patchConfig(ctx, patches)
  await git(root, ['add', '.autoresearch/config.yaml', 'program.md', '.gitignore'])
  await git(root, ['commit', '-q', '-m', 'init: config + program.md'])
}

/** Adds a file and commits it, so the working tree stays clean for `baseline`. */
async function addAndCommit(root: string, rel: string, body: string, message: string): Promise<void> {
  await writeFile(path.join(root, rel), body, 'utf8')
  await git(root, ['add', rel])
  await git(root, ['commit', '-q', '-m', message])
}

async function removeAndCommit(root: string, rel: string, message: string): Promise<void> {
  await rm(path.join(root, rel))
  await git(root, ['add', rel])
  await git(root, ['commit', '-q', '-m', message])
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
  // Every test in this file is redirected to a scratch state home, so
  // nothing here can ever touch the real user cache -- the same convention
  // the brief requires.
  stateHomeDir = await mkdtemp(path.join(tmpdir(), 'ars-state-'))
  process.env[STATE_HOME_ENV] = stateHomeDir
})

afterEach(async () => {
  if (originalStateHomeEnv === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHomeEnv
  await rm(stateHomeDir, { recursive: true, force: true })
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
})

describe('cmdBaseline', () => {
  it('refuses a dirty tree, because a baseline pinned to disk is not reproducible', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)
    // An untracked file, never committed -- makes the tree dirty.
    await writeFile(path.join(root, 'src', 'stray.ts'), 'export const x = 1\n', 'utf8')
    expect(await isClean(root)).toBe(false)

    captureOutput()
    const code = await cmdBaseline(ctx, ['-tag', 'sep6'])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/not clean|dirty|uncommitted/i)
    const dir = runDir(root, 'sep6')
    expect(await exists(dir)).toBe(false)
    expect(await branchExists(root, 'autoresearch-typescript/sep6')).toBe(false)
  })

  // Scoped re-review finding: the dirty-tree check must not trust
  // `.gitignore` either, for the identical reason `pipeline/eval.ts` gate 8
  // must not (see its test of the same name). `isClean` (`git status
  // --porcelain`) would report this tree as clean; a baseline pinned while
  // this file sits on disk uncommitted would be exactly as unreproducible
  // as one pinned with any other uncommitted change.
  it('refuses a tree with an uncommitted file hidden behind an agent-created .gitignore', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)
    await mkdir(path.join(root, 'src', 'lib'), { recursive: true })
    await writeFile(path.join(root, 'src', 'lib', '.gitignore'), '*\n', 'utf8')
    await writeFile(path.join(root, 'src', 'lib', 'evil.ts'), 'export const evil = 1\n', 'utf8')
    expect(await isClean(root)).toBe(true) // isClean is blind to it -- the whole point

    captureOutput()
    const code = await cmdBaseline(ctx, ['-tag', 'sep6'])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/not clean|dirty|uncommitted/i)
    const dir = runDir(root, 'sep6')
    expect(await exists(dir)).toBe(false)
    expect(await branchExists(root, 'autoresearch-typescript/sep6')).toBe(false)
  })

  it('refuses when no config exists, and leaves no run directory or branch', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()

    const code = await cmdBaseline(ctx, ['-tag', 'sep6'])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/config/i)
    const dir = runDir(root, 'sep6')
    expect(await exists(dir)).toBe(false)
    expect(await branchExists(root, 'autoresearch-typescript/sep6')).toBe(false)
  })

  it('refuses to reuse an existing tag without -force', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)

    captureOutput()
    expect(await cmdBaseline(ctx, ['-tag', 'sep6'])).toBe(0)
    const dir = runDir(root, 'sep6')
    const before = await readBaseline(dir)

    captureOutput()
    const code = await cmdBaseline(ctx, ['-tag', 'sep6'])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/-force/)
    // The refusal must not have touched anything the first run created.
    const after = await readBaseline(dir)
    expect(after).toEqual(before)
    expect(await branchExists(root, 'autoresearch-typescript/sep6')).toBe(true)
  })

  it('recreates a baseline for an existing tag with -force', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)

    captureOutput()
    expect(await cmdBaseline(ctx, ['-tag', 'sep6'])).toBe(0)

    captureOutput()
    const code = await cmdBaseline(ctx, ['-tag', 'sep6', '-force'])

    expect(code).toBe(0)
    expect(await branchExists(root, 'autoresearch-typescript/sep6')).toBe(true)
    expect(await currentBranch(root)).toBe('autoresearch-typescript/sep6')
  })

  it('creates the run branch autoresearch-typescript/<tag> and checks it out', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)

    captureOutput()
    const code = await cmdBaseline(ctx, ['-tag', 'sep6'])

    expect(code).toBe(0)
    expect(await branchExists(root, 'autoresearch-typescript/sep6')).toBe(true)
    expect(await currentBranch(root)).toBe('autoresearch-typescript/sep6')
  })

  it('records frozenCommit and measureCommit as equal at the start', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)
    const head = await headCommit(root)

    captureOutput()
    expect(await cmdBaseline(ctx, ['-tag', 'sep6'])).toBe(0)

    const dir = runDir(root, 'sep6')
    const rec = await readBaseline(dir)
    expect(rec.frozenCommit).toBe(head)
    expect(rec.measureCommit).toBe(head)
    expect(rec.frozenCommit).toBe(rec.measureCommit)
  })

  it('freezes every test, spec, bench and runner-config file', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)

    captureOutput()
    expect(await cmdBaseline(ctx, ['-tag', 'sep6'])).toBe(0)

    const dir = runDir(root, 'sep6')
    const rec = await readBaseline(dir)
    expect(Object.keys(rec.manifest.files)).toContain('src/wordcount.test.ts')
    expect(Object.keys(rec.manifest.files)).toContain('src/wordcount.bench.ts')
    // The actual bytes were copied into the frozen snapshot, not just listed.
    expect(await exists(path.join(dir, 'frozen', 'src', 'wordcount.bench.ts'))).toBe(true)
  })

  // Priority 3 from the final whole-branch review: a file the config
  // declares in `unfreeze` must never be snapshotted or hashed into the
  // manifest -- otherwise gate 3's restore would silently revert the
  // agent's edits to a file the config explicitly exempted, contradicting
  // both `init`'s own generated comment and spec section 6.
  it('excludes a file listed in unfreeze from the manifest and the frozen snapshot', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initWithConfigAndCommit(root, ctx, { unfreeze: JSON.stringify(['src/wordcount.test.ts']) })

    captureOutput()
    expect(await cmdBaseline(ctx, ['-tag', 'sep6'])).toBe(0)

    const dir = runDir(root, 'sep6')
    const rec = await readBaseline(dir)
    expect(Object.keys(rec.manifest.files)).not.toContain('src/wordcount.test.ts')
    expect(Object.keys(rec.manifest.files)).toContain('src/wordcount.bench.ts')
    expect(await exists(path.join(dir, 'frozen', 'src', 'wordcount.test.ts'))).toBe(false)
  })

  it('records the config hash and the lockfile hash', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)

    captureOutput()
    expect(await cmdBaseline(ctx, ['-tag', 'sep6'])).toBe(0)

    const dir = runDir(root, 'sep6')
    const rec = await readBaseline(dir)
    const expectedConfigHash = hashString(await readFile(ctx.configPath, 'utf8'))
    const expectedLockfileHash = hashString(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
    expect(rec.configHash).toBe(expectedConfigHash)
    expect(rec.lockfileHash).toBe(expectedLockfileHash)
    expect(rec.lockfileName).toBe('package-lock.json')
  })

  // The shared demo fixture is deliberately zero-dependency (so `npm ci`
  // against it is instant and never touches the network) -- which also
  // means npm never creates a `node_modules` directory for it at all,
  // leaving nothing here to assert against. This dedicated fixture adds
  // exactly one dependency, resolved via npm's `file:` protocol against a
  // sibling directory it ships alongside itself, so the install stays
  // fully offline (no registry contact) while still producing a real,
  // observable `node_modules`.
  async function makeFileDepRepo(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'ars-filedep-'))
    await mkdir(path.join(root, 'vendor', 'tinylib'), { recursive: true })
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: 'filedep-demo',
          version: '0.0.0',
          private: true,
          type: 'module',
          scripts: { test: 'node --eval "process.exit(0)"' },
          dependencies: { tinylib: 'file:./vendor/tinylib' },
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(
      path.join(root, 'vendor', 'tinylib', 'package.json'),
      JSON.stringify({ name: 'tinylib', version: '1.0.0', main: 'index.js' }, null, 2),
      'utf8',
    )
    await writeFile(
      path.join(root, 'vendor', 'tinylib', 'index.js'),
      'module.exports = { add: (a, b) => a + b }\n',
      'utf8',
    )
    await writeFile(
      path.join(root, 'src', 'thing.bench.ts'),
      "import tinylib from 'tinylib'\n\nexport function benchAdd(): number {\n  return tinylib.add(1, 2)\n}\n",
      'utf8',
    )
    // Generates a real, npm-produced lockfile for the `file:` dependency --
    // this still never contacts the network, since the dependency resolves
    // to a local path.
    const lockGen = await run('npm', ['install', '--package-lock-only'], { cwd: root, timeoutMs: 60_000 })
    if (!ok(lockGen)) throw new Error(`npm install --package-lock-only: ${lockGen.stderr}`)

    await git(root, ['init', '-q', '-b', 'main'])
    await git(root, ['config', 'user.name', 'Test'])
    await git(root, ['config', 'user.email', 'test@example.invalid'])
    const ctx = ctxFor(root)
    expect(await cmdInit(ctx, [])).toBe(0)
    await git(root, ['add', '-A'])
    await git(root, ['commit', '-q', '-m', 'filedep fixture'])
    return root
  }

  it('installs dependencies inside the worktree, not a symlink to the main repo', async () => {
    captureOutput()
    const root = await makeFileDepRepo()
    const ctx = ctxFor(root)

    captureOutput()
    const code = await cmdBaseline(ctx, ['-tag', 'sep6'])
    expect(code).toBe(0)

    const dir = runDir(root, 'sep6')
    const nodeModules = path.join(dir, 'baseline-worktree', 'node_modules')
    const st = await lstat(nodeModules)
    expect(st.isSymbolicLink()).toBe(false)
    expect(st.isDirectory()).toBe(true)
    // The dependency itself really got linked in -- proving a real install
    // ran in the worktree, not merely that an empty directory exists.
    expect(await exists(path.join(nodeModules, 'tinylib', 'index.js'))).toBe(true)
  })

  it('smoke-runs the benchmarks in the worktree and FAILS if they do not run', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)
    await addAndCommit(
      root,
      'src/broken.bench.ts',
      'export function benchBroken(): number {\n  throw new Error("boom: this benchmark cannot run")\n}\n',
      'add a benchmark that throws',
    )

    captureOutput()
    const code = await cmdBaseline(ctx, ['-tag', 'sep6'])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/boom: this benchmark cannot run/)
  })

  it('leaves no state behind when it fails partway, and a retry without -force then succeeds', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)
    const originalBranch = await currentBranch(root)
    await addAndCommit(
      root,
      'src/broken.bench.ts',
      'export function benchBroken(): number {\n  throw new Error("boom")\n}\n',
      'add a benchmark that throws',
    )

    captureOutput()
    const failCode = await cmdBaseline(ctx, ['-tag', 'sep6'])
    expect(failCode).not.toBe(0)

    // Nothing survives the failed attempt: no run directory, no branch, and
    // the main repo is back on the branch it started from.
    const dir = runDir(root, 'sep6')
    expect(await exists(dir)).toBe(false)
    expect(await branchExists(root, 'autoresearch-typescript/sep6')).toBe(false)
    expect(await currentBranch(root)).toBe(originalBranch)

    // Fix the repository (remove the broken benchmark) and retry with the
    // SAME tag and NO -force: this is what proves Ruling 3 -- a failed
    // baseline must not require -force to retry.
    await removeAndCommit(root, 'src/broken.bench.ts', 'remove the broken benchmark')

    captureOutput()
    const retryCode = await cmdBaseline(ctx, ['-tag', 'sep6'])
    expect(retryCode).toBe(0)
    expect(await branchExists(root, 'autoresearch-typescript/sep6')).toBe(true)
  })

  it('refuses a declared benchmark id that no longer exists', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)
    const cfgText = await readFile(ctx.configPath, 'utf8')
    expect(cfgText).toMatch(/^benchmarks: \[\]$/m)
    await writeFile(
      ctx.configPath,
      cfgText.replace(/^benchmarks: \[\]$/m, 'benchmarks: ["src/nope.bench.ts:benchNope"]'),
      'utf8',
    )
    // .autoresearch/config.yaml is a tracked, committed file (spec section
    // 13): baseline refuses an unclean tree before it ever reaches the
    // "declared benchmark exists" check below, so this edit must be
    // committed like any other for that check to be what this test proves.
    await git(root, ['add', CONFIG_PATH])
    await git(root, ['commit', '-q', '-m', 'declare a benchmark that does not exist'])

    captureOutput()
    const code = await cmdBaseline(ctx, ['-tag', 'sep6'])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/src\/nope\.bench\.ts:benchNope/)
    const dir = runDir(root, 'sep6')
    expect(await exists(dir)).toBe(false)
    expect(await branchExists(root, 'autoresearch-typescript/sep6')).toBe(false)
  })

  it('refuses a missing -tag', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)

    captureOutput()
    const code = await cmdBaseline(ctx, [])

    expect(code).not.toBe(0)
    expect(stderr.join('')).toMatch(/-tag/)
  })

  it('does not touch process.cwd() while running', async () => {
    const root = await makeDemoRepo()
    const ctx = ctxFor(root)
    captureOutput()
    await initAndCommit(root, ctx)
    const cwdBefore = process.cwd()

    captureOutput()
    await cmdBaseline(ctx, ['-tag', 'sep6'])

    expect(process.cwd()).toBe(cwdBefore)
  })
})

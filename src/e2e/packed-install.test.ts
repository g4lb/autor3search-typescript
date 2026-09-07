import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COMMANDS } from '../cli/main.js'
import { run, type ExecResult } from '../runner/exec.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * What this covers, and why it is worth being the suite's slowest test.
 *
 * Three separate shipped bugs shared one signature: invisible to every other
 * test, and found only by packing the tarball and installing it by hand.
 *
 *  1. The entry-point guard compared raw `process.argv[1]` to
 *     `import.meta.url`. npm installs `bin` as a SYMLINK, so the two never
 *     matched, `main()` never ran, and the binary exited 0 -- the KEEP code
 *     -- for every command including `--help`.
 *  2. `version` resolved a RunCtx before dispatching, so an installed copy
 *     answered "not inside a git repository" and exit 2.
 *  3. `bin` carried a leading "./", which npm stripped with a warning on
 *     every publish.
 *
 * None is reachable by importing source modules: each lives in the gap
 * between the repository and the installed artifact. So this test crosses
 * that gap for real -- `npm pack`, `npm install <tarball>`, then run the
 * installed binary as a subprocess and read its exit codes.
 */

let projectDir: string
let workDir: string
let bin: string
// Retained only for the failure messages below: if pack or install fails,
// the reason has to reach the reader.
let packOutput: string
let installOutput: string

/** Runs the INSTALLED binary, never a source module. */
async function runBin(args: string[], cwd: string): Promise<ExecResult> {
  return run(bin, args, { cwd, timeoutMs: 60_000 })
}

describe('the packed, installed artifact', () => {
  beforeAll(async () => {
    if (process.env['CI_SKIP_INSTALL'] === '1') return

    workDir = await mkdtemp(path.join(tmpdir(), 'ars-packed-'))
    const packDir = path.join(workDir, 'tarball')
    projectDir = path.join(workDir, 'consumer')
    await writeFile(path.join(workDir, '.keep'), '')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(packDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })

    // `--pack-destination` keeps the tarball out of the repository: packing
    // into the repo root would leave a stray .tgz that the scope gate and
    // `changedFiles` would then see as an untracked file.
    const packed = await run('npm', ['pack', '--pack-destination', packDir], {
      cwd: repoRoot,
      timeoutMs: 600_000,
    })
    packOutput = packed.stdout + packed.stderr
    if (packed.exitCode !== 0) throw new Error(`npm pack failed:\n${packOutput}`)

    const entries = await readdir(packDir)
    const tgz = entries.find((e) => e.endsWith('.tgz'))
    if (tgz === undefined) throw new Error(`npm pack produced no tarball: ${entries.join(', ')}`)

    // A consumer project that depends on nothing else, so anything the
    // install pulls in came from this package's own dependencies.
    await writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }, null, 2),
    )

    const installed = await run(
      'npm',
      ['install', '--no-audit', '--no-fund', path.join(packDir, tgz)],
      { cwd: projectDir, timeoutMs: 600_000 },
    )
    installOutput = installed.stdout + installed.stderr
    if (installed.exitCode !== 0) throw new Error(`npm install failed:\n${installOutput}`)

    bin = path.join(projectDir, 'node_modules', '.bin', 'autor3search-typescript')
  }, 900_000)

  afterAll(async () => {
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true })
  })

  // REMOVED: two tests that asserted on npm's warning TEXT.
  //
  // They broke CI three times in a row, never once because of this package:
  // npm renamed the prefix (`allow-scripts` -> `install-scripts`), started
  // tagging the unauthenticated-login warning with `publish` so a
  // /npm warn publish/ filter caught it, and changed `publish --dry-run`'s
  // exit code between the npm in Node 22 and the one in Node 24. Each fix
  // was a narrower grep of a string npm is free to change again.
  //
  // The invariant they were guarding -- that npm has no manifest correction
  // to make -- is a property of package.json, not of npm's messaging, and
  // `src/packaging.test.ts` asserts it directly and version-independently
  // (bin paths already in npm's normalized form, every bin covered by
  // `files`, no duplicate publish hook), mutation-verified. Testing it a
  // second time through npm's stderr added no coverage and a standing
  // maintenance cost.
  //
  // What stays below is everything about the ARTIFACT rather than about
  // npm's prose -- and that is the part which caught three real shipped
  // bugs.

  it('runs from the installed symlink instead of silently exiting 0', async () => {
    if (process.env['CI_SKIP_INSTALL'] === '1') return
    // THE regression that shipped: with a broken entry-point guard the
    // binary did nothing and exited 0 for every input. An unknown command
    // must be a usage error (2), so a 0 here means main() never ran --
    // which is exactly what a naive `import.meta.url === argv[1]` check
    // produced through npm's bin symlink.
    const r = await runBin(['no-such-command'], projectDir)
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/unknown command "no-such-command"/)
  })

  it('answers `version` from outside any git repository', async () => {
    if (process.env['CI_SKIP_INSTALL'] === '1') return
    // projectDir is a bare directory, not a git repo -- the condition that
    // made the first `version` fail with "not inside a git repository".
    const r = await runBin(['version'], projectDir)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/^autor3search-typescript \d+\.\d+\.\d+\n/)
    expect(r.stderr).toBe('')
  })

  it('exposes every command the source registers', async () => {
    if (process.env['CI_SKIP_INSTALL'] === '1') return
    // Ties the artifact to the source's own table: a command added to
    // COMMANDS but lost on the way into the tarball fails here.
    const r = await runBin(['--help'], projectDir)
    expect(r.exitCode).toBe(2)
    const section = r.stdout.split('Commands:')[1]?.split('Global flags:')[0] ?? ''
    const listed = new Set([...section.matchAll(/^\s{2}(\S+)/gm)].map((m) => m[1]))
    expect(listed).toEqual(new Set(Object.keys(COMMANDS)))
  })

  it('reports the version the tarball actually declares', async () => {
    if (process.env['CI_SKIP_INSTALL'] === '1') return
    const { readFile } = await import('node:fs/promises')
    const installedPkg = JSON.parse(
      await readFile(
        path.join(projectDir, 'node_modules', 'autor3search-typescript', 'package.json'),
        'utf8',
      ),
    ) as { version: string }
    const r = await runBin(['version'], projectDir)
    expect(r.stdout).toContain(`autor3search-typescript ${installedPkg.version}`)
  })
})

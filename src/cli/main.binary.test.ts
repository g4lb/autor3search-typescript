import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ok, run } from '../runner/exec.js'

/**
 * The bug this whole file exists to catch: every test elsewhere in this
 * suite imports `main` (or a command function) and calls it directly inside
 * the SAME process -- which never touches Node's own module-resolution
 * machinery at all. `main.ts`'s guard that decides "am I the entry point,
 * or merely imported" is exactly the code path those tests can never
 * exercise, because importing a function is not the same operation as
 * spawning a process and letting Node itself decide the entry point.
 *
 * The real defect: npm installs a package's `bin` as a SYMLINK under
 * `node_modules/.bin/<name>`. When Node loads a symlinked file as the
 * program's entry point, `import.meta.url` is the symlink-RESOLVED real
 * path, but `process.argv[1]` stays the symlink path exactly as invoked.
 * A guard that compares those two strings directly therefore never matches
 * for an installed package -- `main()` is never called, nothing is ever
 * printed, and the process exits 0 (the KEEP exit code) having done
 * nothing at all, for every command including `--help`. This is invisible
 * to every other test in this project, all 429 of which passed against
 * exactly this defect before it was fixed.
 *
 * These tests spawn the REAL BUILT `dist/cli/main.js` as a real OS
 * subprocess -- once invoked directly, and once through a symlink that
 * reproduces the exact shape of an npm-installed `bin` -- and assert on
 * its actual exit code and actual stdout, the only two things a real user
 * (or a real agent driving `eval`) ever sees.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const DIST_MAIN = path.join(REPO_ROOT, 'dist', 'cli', 'main.js')
const BUILD_TIMEOUT_MS = 120_000
const RUN_TIMEOUT_MS = 30_000

const ALL_COMMANDS = ['init', 'doctor', 'baseline', 'eval', 'status', 'stop', 'report', 'profile']

let symlinkDir: string
let symlinkPath: string

beforeAll(async () => {
  // Rebuilds dist/ fresh rather than trusting whatever is already there --
  // a stale dist/ from before this fix would make these tests pass for the
  // wrong reason (an old, already-correct build) or fail for the wrong
  // reason (a dist/ that predates any build at all).
  const build = await run('npm', ['run', 'build'], { cwd: REPO_ROOT, timeoutMs: BUILD_TIMEOUT_MS })
  if (!ok(build)) {
    throw new Error(`npm run build failed (exit ${build.exitCode}): ${build.stderr || build.stdout}`)
  }

  symlinkDir = await mkdtemp(path.join(tmpdir(), 'ars-bin-symlink-'))
  // No file extension, matching the shape of a real npm-installed
  // `node_modules/.bin/<name>` entry -- npm's own bin symlinks are never
  // named `*.js` on POSIX.
  symlinkPath = path.join(symlinkDir, 'autoresearch-typescript')
  await symlink(DIST_MAIN, symlinkPath)
}, BUILD_TIMEOUT_MS)

afterAll(async () => {
  if (symlinkDir) await rm(symlinkDir, { recursive: true, force: true })
})

describe('the built CLI binary, run as a real subprocess', () => {
  it('invoked directly, --help exits 2 and lists all eight commands', async () => {
    const r = await run('node', [DIST_MAIN, '--help'], { cwd: REPO_ROOT, timeoutMs: RUN_TIMEOUT_MS })

    expect(r.exitCode).toBe(2)
    for (const cmd of ALL_COMMANDS) {
      expect(r.stdout).toMatch(new RegExp(`^  ${cmd}\\b`, 'm'))
    }
  })

  // The regression test: before the fix, this exits 0 with EMPTY stdout,
  // because main()'s entry-point guard never fires through a symlink and
  // the process falls straight through having done nothing. Reverting the
  // guard to the raw `import.meta.url === \`file://${process.argv[1]}\``
  // comparison makes this test fail again -- see task-22-report.md for the
  // mutation-testing transcript.
  it('invoked through a symlink (mirroring an npm-installed bin), --help STILL exits 2 and lists all eight commands', async () => {
    const r = await run('node', [symlinkPath, '--help'], { cwd: REPO_ROOT, timeoutMs: RUN_TIMEOUT_MS })

    expect(r.exitCode).toBe(2)
    expect(r.stdout).not.toBe('')
    for (const cmd of ALL_COMMANDS) {
      expect(r.stdout).toMatch(new RegExp(`^  ${cmd}\\b`, 'm'))
    }
  })

  // The case that matters most: an invocation that cannot possibly succeed
  // must report ITS OWN real, non-zero exit code -- never exit 0, which a
  // program.md-following agent reads as KEEP. This mirrors the coordinator's
  // own repro exactly: `eval` run through the installed bin with no baseline
  // (here: no git repository at all) and no `-tag` to infer. Before the fix,
  // this silently exits 0 with nothing on either stream -- the single worst
  // possible failure mode for a harness whose entire job is refusing to
  // rubber-stamp a change.
  it('invoked through a symlink, a command that cannot succeed reports its real non-zero exit code and a real error, never a silent 0', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'ars-bin-notrepo-'))
    try {
      const r = await run('node', [symlinkPath, 'eval'], { cwd: scratch, timeoutMs: RUN_TIMEOUT_MS })

      expect(r.exitCode).not.toBe(0)
      expect(r.stderr).toMatch(/error:/)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

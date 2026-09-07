/**
 * Spawns the measurement child (child.ts / child.js) for one benchmark in
 * one directory, and turns its outcome into a `BenchResult` that never
 * throws for a benchmark-level failure -- a timeout, a crash, or a child
 * that writes nothing is reported as `ok: false` with a diagnosis, because
 * the pipeline treats that as a CRASH verdict for the benchmark rather than
 * a harness bug.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseBenchResult, type BenchResult } from '../benchproto/types.js'
import { run, tail, type ExecResult } from '../runner/exec.js'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Picks the measurement child from a directory, preferring the built
 * `child.js` and falling back to the source `child.ts`.
 *
 * Under a real install (`dist/`), only `child.js` exists next to this
 * module -- that is the branch that actually runs for an installed user.
 * Under Vitest, `import.meta.url` resolves to `src/benchrun/invoke.ts`,
 * where only `child.ts` exists -- there is no build step before the test
 * run. Either way the spawn below runs through the tsx loader, so a `.ts`
 * path works identically to a `.js` one; this just picks whichever file is
 * actually on disk.
 *
 * Pulled apart from `resolveChild` (a thin wrapper below) so both branches
 * can be exercised directly with an injected existence check, since only
 * one of the two ever exists in any single checkout.
 */
export function pickChildPath(dir: string, exists: (p: string) => boolean): string {
  const asJs = path.join(dir, 'child.js')
  if (exists(asJs)) return asJs
  return path.join(dir, 'child.ts')
}

function resolveChild(): string {
  return pickChildPath(HERE, existsSync)
}

export const CHILD = resolveChild()

/**
 * The tsx ESM loader, resolved from OUR dependencies.
 *
 * The measured repository does not depend on us, so resolving this relative
 * to the measured directory would work in our own fixtures and fail on
 * every real user's repository. Resolving it here, from this module's own
 * `import.meta.url`, always finds it in *our* node_modules regardless of
 * what (if anything) the measured directory contains.
 */
function tsxLoaderUrl(): string {
  return pathToFileURL(require.resolve('tsx/esm')).href
}

/**
 * Arbitrary throw values (a non-`Error`, or a `JSON.parse` `SyntaxError`)
 * both need a printable message; this mirrors the same helper in child.ts.
 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Reads and parses the child's `--out` file, turning every failure mode
 * into `{ ok: false }` instead of a rejection: a missing file (the child
 * died before writing at all) and a present-but-malformed one (the file
 * exists but doesn't parse, or doesn't have the right shape).
 *
 * The malformed case is not exotic: our own timeout path kills the child's
 * process group with SIGKILL, which can land mid-`writeFile`, leaving a
 * truncated-but-readable JSON document on disk. `readFile` succeeds on
 * that; only `JSON.parse`/`parseBenchResult` would have caught it, and
 * uncaught, that throw would have propagated out of `runChild` as a
 * rejected promise -- exactly the "harness bug" failure mode `runChild`
 * exists to avoid for a benchmark-level failure.
 *
 * Exported for testing: it lets a test write deliberately truncated JSON
 * to a real, controlled `--out` path and assert `ok: false` directly,
 * without needing to race a real subprocess's SIGKILL against its own
 * `writeFile` to reproduce the truncation.
 */
export async function readChildResult(
  outFile: string,
  id: string,
  r: Pick<ExecResult, 'timedOut' | 'exitCode' | 'stderr'>,
  timeoutMs: number,
): Promise<BenchResult> {
  let text: string
  try {
    text = await readFile(outFile, 'utf8')
  } catch {
    // The child died before writing. Its own stderr is the useful diagnosis.
    const why = r.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${r.exitCode}`
    return { ok: false, id, error: `benchmark child ${why}: ${tail(r.stderr, 20)}` }
  }
  try {
    return parseBenchResult(text)
  } catch (e) {
    return { ok: false, id, error: `malformed benchmark result: ${messageOf(e)}` }
  }
}

export interface RunChildOptions {
  /** The worktree to measure in. Sets module resolution and tsconfig context. */
  cwd: string
  benchFileAbs: string
  fn: string
  id: string
  benchtimeMs: number
  warmupMs: number
  timeoutMs: number
  nodeArgs: string[]
  log?: ((s: string) => void) | undefined
}

/**
 * Runs one benchmark, once, in a fresh child process.
 *
 * Never rejects for a benchmark-level failure: a timeout, a crash, or a
 * child that exits without writing --out all come back as `{ ok: false }`
 * with a diagnosis built from the child's own stderr, so a caller can
 * record a CRASH verdict instead of aborting the whole run.
 */
export async function runChild(o: RunChildOptions): Promise<BenchResult> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ars-out-'))
  const outFile = path.join(dir, 'result.json')
  try {
    const args = [
      ...o.nodeArgs,
      '--import',
      tsxLoaderUrl(),
      CHILD,
      '--file',
      o.benchFileAbs,
      '--fn',
      o.fn,
      '--id',
      o.id,
      '--benchtime-ms',
      String(o.benchtimeMs),
      '--warmup-ms',
      String(o.warmupMs),
      '--out',
      outFile,
    ]
    const r = await run(process.execPath, args, {
      cwd: o.cwd,
      timeoutMs: o.timeoutMs,
      ...(o.log ? { log: o.log } : {}),
    })
    return await readChildResult(outFile, o.id, r, o.timeoutMs)
  } finally {
    // A failure here (permissions, an EBUSY-like transient on some
    // platform) must never replace a result the try block already
    // produced -- losing a computed measurement is strictly worse than
    // leaking a temp directory, so the cleanup failure is swallowed rather
    // than left to propagate out of `finally` and clobber the return value
    // (or the rejection) above.
    try {
      // maxRetries/retryDelay are insurance for Windows, where killing a
      // timed-out child means `taskkill /T /F` and the OS can briefly hold
      // the dead process's handles on this directory -- long enough for an
      // immediate rm to fail with EBUSY/EPERM and, because the failure is
      // (correctly) swallowed below, leak it silently.
      //
      // Kept as defence, NOT as a fix for anything observed: the leak this
      // was first added for turned out not to be a leak at all, but a test
      // helper that failed to isolate on Windows (it set TMPDIR, which
      // `os.tmpdir()` ignores there). Node retries these errno values when
      // asked, and the cost when there is nothing to retry is zero.
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      /* leak the directory rather than discard the result */
    }
  }
}

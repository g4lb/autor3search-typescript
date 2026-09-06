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
import { run, tail } from '../runner/exec.js'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Resolves the measurement child, preferring the built `child.js` and
 * falling back to the source `child.ts`.
 *
 * Under a real install (`dist/`), only `child.js` exists next to this
 * module. Under Vitest, `import.meta.url` resolves to
 * `src/benchrun/invoke.ts`, where only `child.ts` exists -- there is no
 * build step before the test run. Either way the spawn below runs through
 * the tsx loader, so a `.ts` path works identically to a `.js` one; this
 * just picks whichever file is actually on disk.
 */
function resolveChild(): string {
  const asJs = path.join(HERE, 'child.js')
  if (existsSync(asJs)) return asJs
  return path.join(HERE, 'child.ts')
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
    let text: string
    try {
      text = await readFile(outFile, 'utf8')
    } catch {
      // The child died before writing. Its own stderr is the useful diagnosis.
      const why = r.timedOut ? `timed out after ${o.timeoutMs}ms` : `exit ${r.exitCode}`
      return { ok: false, id: o.id, error: `benchmark child ${why}: ${tail(r.stderr, 20)}` }
    }
    return parseBenchResult(text)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

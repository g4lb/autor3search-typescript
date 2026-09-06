import path from 'node:path'
import { CONFIG_PATH } from '../config/schema.js'
import { repoRoot as gitRepoRoot } from '../gitx/git.js'
import { RESULTS_PATH } from '../results/results.js'

/** Repo-root-relative default location of the unattended run's transcript. */
export const LOG_PATH = 'run.log'

export interface RunCtx {
  repoRoot: string
  configPath: string
  resultsPath: string
  logPath: string
}

/**
 * Splits a leading `-C <dir>` off argv, recognized only as the very first
 * token (the same convention `git -C` uses). Never touches `process.cwd()`
 * or `process.chdir` -- the directory is only ever handed to a spawned
 * `git` as its `cwd` option, so this is safe to call concurrently from
 * multiple invocations and to unit test without disturbing the test
 * process's own working directory.
 */
export function splitDashC(argv: readonly string[], cwd: string = process.cwd()): { dir: string; rest: string[] } {
  if (argv[0] !== '-C') {
    return { dir: cwd, rest: [...argv] }
  }
  const dir = argv[1]
  if (dir === undefined) {
    throw new Error('-C requires a directory argument')
  }
  return { dir, rest: argv.slice(2) }
}

/**
 * Resolves the run context for one invocation: the `-C <dir>` (or the
 * current working directory) is walked up to its git repository root via a
 * spawned `git rev-parse --show-toplevel`, and every path the harness
 * writes -- the config, `results.tsv`, `run.log` -- is anchored to that
 * root. Since resolution goes through a subprocess `cwd`, not
 * `process.chdir`, `process.cwd()` in this process is never touched.
 */
export async function resolveCtx(argv: readonly string[]): Promise<RunCtx> {
  const { dir } = splitDashC(argv)
  let root: string
  try {
    root = await gitRepoRoot(dir)
  } catch (e) {
    throw new Error(
      `${dir} is not inside a git repository (or a subdirectory of one): ${(e as Error).message}`,
    )
  }
  return {
    repoRoot: root,
    configPath: path.join(root, CONFIG_PATH),
    resultsPath: path.join(root, RESULTS_PATH),
    logPath: path.join(root, LOG_PATH),
  }
}

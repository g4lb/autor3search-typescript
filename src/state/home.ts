import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { hashString } from '../freeze/manifest.js'

export const STATE_HOME_ENV = 'AUTORESEARCH_TYPESCRIPT_STATE_HOME'

const APP = 'autoresearch-typescript'

/** Tags become directory names, so they must be a single safe segment. */
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * The root directory everything the metric depends on lives under, deliberately
 * outside the repository the agent controls: baselines, eval locks and stop
 * requests. If the agent could write any of this, it could grade its own work.
 */
export function stateHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STATE_HOME_ENV]
  if (override !== undefined && override !== '') {
    if (!path.isAbsolute(override)) {
      // A relative value resolves against whatever directory the current command
      // happens to run from. `eval` invoked from a subdirectory and `stop` invoked
      // from the repo root would then address different state for the same run,
      // and the stop would silently appear to do nothing.
      throw new Error(
        `${STATE_HOME_ENV} must be an absolute path, got ${JSON.stringify(override)}: a relative ` +
          "value resolves against each command's working directory, so eval and stop could " +
          'address different state for the same run',
      )
    }
    return override
  }
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches')
  if (process.platform === 'win32') {
    return env['LOCALAPPDATA'] ?? path.join(homedir(), 'AppData', 'Local')
  }
  return env['XDG_CACHE_HOME'] ?? path.join(homedir(), '.cache')
}

/**
 * Canonicalizes a repo path so the same repository keys identically no matter
 * how it was reached: a trailing slash, a relative path, or a symlinked parent
 * directory. `realpath` requires the path to exist; when it doesn't (as in
 * tests that key against a repo root that was never created on disk) we fall
 * back to the syntactic resolution rather than failing.
 */
function canonicalRepoPath(repoRoot: string): string {
  const abs = path.resolve(repoRoot)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** The per-repository, per-tag state directory. */
export function runDir(
  repoRoot: string,
  tag: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!TAG_RE.test(tag)) {
    throw new Error(
      `invalid tag ${JSON.stringify(tag)}: use letters, digits, dot, dash or underscore only ` +
        '(a tag becomes a directory name)',
    )
  }
  const key = hashString(canonicalRepoPath(repoRoot)).slice(0, 16)
  return path.join(stateHome(env), APP, key, tag)
}

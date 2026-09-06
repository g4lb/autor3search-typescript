import path from 'node:path'
import { walkRepo } from '../discover/files.js'
import { RESULTS_PATH } from '../results/results.js'
import { ok, run } from '../runner/exec.js'

const TIMEOUT_MS = 60_000

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await run('git', args, { cwd, timeoutMs: TIMEOUT_MS })
  if (!ok(r)) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd} (exit ${r.exitCode}): ${r.stderr.trim()}`)
  }
  return r.stdout.trim()
}

/**
 * Like `git`, but returns stdout untrimmed.
 *
 * `.trim()` is safe for the scalar callers (`repoRoot`, `headCommit`,
 * `currentBranch`, ...), which only ever get one shell-wrapped value back.
 * It is NOT safe for a `-z` NUL-separated list: `String.prototype.trim`
 * strips leading ASCII whitespace, and a leading space (0x20) sorts before
 * any letter in git's output — so a repo-relative path that legitimately
 * starts with a space (e.g. a directory named `" src"`) would have that
 * space clipped from the *first* entry every time, silently turning
 * `" src/evil.ts"` into `"src/evil.ts"`. Under a scope gate that allowlists
 * `src/**`, that reported path is in scope while the real file is not —
 * the same "name a file to bypass the gate" class `-z` itself exists to
 * prevent, reintroduced one layer up by an over-eager trim. `-z` and NUL
 * splitting still take care of the trailing edge: `trim()` does not treat
 * `\0` as whitespace, so it never eats the sentinel a caller's split relies
 * on.
 */
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const r = await run('git', args, { cwd, timeoutMs: TIMEOUT_MS })
  if (!ok(r)) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd} (exit ${r.exitCode}): ${r.stderr.trim()}`)
  }
  return r.stdout
}

export async function repoRoot(dir: string): Promise<string> {
  return git(dir, ['rev-parse', '--show-toplevel'])
}

export async function headCommit(root: string): Promise<string> {
  return git(root, ['rev-parse', 'HEAD'])
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/**
 * A tree is clean only if it has no modifications AND no untracked files.
 * `--porcelain` lists untracked entries too (respecting .gitignore, so an
 * untracked file inside an ignored directory does not count): a baseline
 * pinned against what is on disk rather than what is in git is not
 * reproducible, so a stray untracked file must make the tree dirty.
 */
export async function isClean(root: string): Promise<boolean> {
  return (await git(root, ['status', '--porcelain'])) === ''
}

/**
 * Splits a NUL-separated `-z` git listing into repo-relative POSIX paths.
 * `out` must come from `gitRaw`, not `git` — see `gitRaw`'s doc comment for
 * why trimming first would silently corrupt a path with a leading space.
 */
function parseNulList(out: string): string[] {
  return out
    .split('\0')
    .filter((s) => s !== '')
    .map((s) => s.split(path.sep).join('/'))
}

/**
 * Files the harness itself owns and writes into the repository, gitignored
 * on purpose by `init` -- never something the scope gate should ever see as
 * "changed," but also never something that may be trusted to stay
 * gitignored (see below). `.autoresearch/`, `dist/`, `build/`, `coverage/`,
 * `out/` and `node_modules/` need no entry here: `walkRepo`'s own
 * `SKIP_DIRS` (and its dot-directory skip) already excludes them
 * unconditionally, by name, independent of any `.gitignore`.
 *
 * `run.log` is duplicated from `cli/runctx.ts`'s `LOG_PATH` rather than
 * imported -- importing it here would cycle (`runctx.ts` imports this
 * module for `repoRoot`). Must be kept in sync with it.
 */
const HARNESS_OWNED_FILES = new Set<string>([RESULTS_PATH, 'run.log'])

function isHarnessOwned(rel: string): boolean {
  return HARNESS_OWNED_FILES.has(rel) || rel.endsWith('.cpuprofile')
}

/**
 * Repo-relative POSIX paths touched since `sinceRef`: everything the scope
 * gate must treat as "changed by the agent," whether or not it was ever
 * `git add`-ed.
 *
 * This is the union of two views, because neither alone answers the
 * question:
 *
 * - `diff --name-only <ref>` (ref vs. the *working tree*, not `HEAD`) — this
 *   catches committed changes, uncommitted edits to tracked files, and
 *   files the agent deleted. It does NOT catch a brand-new file the agent
 *   creates and never stages: `git diff` only ever compares paths git
 *   already knows about, so a new file outside `scope` that is never
 *   `git add`-ed would silently evade a gate built on `diff` alone — a real
 *   scope-gate bypass, not a hypothetical one.
 * - a filesystem walk (`walkRepo`) minus git's own tracked set (`ls-files`,
 *   with NO `--exclude-standard`) minus the harness-owned files above —
 *   this is what closes the untracked-file gap `diff` leaves, and it is
 *   deliberately NOT `ls-files --others --exclude-standard`: that flag
 *   honors whatever `.gitignore` is on disk right now, including one the
 *   AGENT just created. `printf '*\n' > lib/.gitignore` would hide `lib/`
 *   entirely from `ls-files --others` and from `git status`, letting
 *   arbitrary untracked source outside `scope` go completely unseen — the
 *   exact bypass this function exists to prevent. Enumerating the
 *   filesystem directly and subtracting git's tracked set (not git's
 *   *ignored* set) is immune to any `.gitignore` content, agent-authored or
 *   not. Once a new file is committed, `diff` picks it up as an addition
 *   and it drops out of "untracked" (it is now tracked), so the union never
 *   double-reports a file across a commit boundary.
 *
 * `diff` and `ls-files` both use `-z`: a path with a space or embedded
 * newline would otherwise be able to split into extra entries under the
 * default newline-separated, C-quoted output, and a scope gate that
 * mis-parses a filename is one an agent can bypass by naming a file
 * carefully. This is a security property, not formatting.
 */
export async function changedFiles(root: string, sinceRef: string): Promise<string[]> {
  const [diffOut, allFiles, trackedOut] = await Promise.all([
    gitRaw(root, ['diff', '--name-only', '-z', sinceRef]),
    walkRepo(root),
    gitRaw(root, ['ls-files', '-z']),
  ])
  const tracked = new Set(parseNulList(trackedOut))
  const untracked = allFiles.filter((f) => !tracked.has(f) && !isHarnessOwned(f))
  return [...new Set([...parseNulList(diffOut), ...untracked])].sort()
}

export async function currentBranch(root: string): Promise<string> {
  return git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

export async function branchExists(root: string, name: string): Promise<boolean> {
  const r = await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], {
    cwd: root,
    timeoutMs: TIMEOUT_MS,
  })
  return r.exitCode === 0
}

export async function createBranch(root: string, name: string): Promise<void> {
  await git(root, ['checkout', '-q', '-b', name])
}

/**
 * Deletes a local branch, force (`-D`) rather than `-d`: this exists for the
 * `baseline` unwind path, where a run that fails partway must delete the run
 * branch it just created so a retry does not die on "branch already
 * exists." A branch created moments ago for a fresh run is never something
 * the merge-safety check behind `-d` needs to protect. Fails (does not
 * silently succeed) if the branch does not exist, since a caller unwinding
 * a partial failure needs to know its assumption about what it created was
 * wrong.
 */
export async function deleteBranch(root: string, name: string): Promise<void> {
  await git(root, ['branch', '-D', name])
}

export async function addWorktree(root: string, dir: string, commit: string): Promise<void> {
  await git(root, ['worktree', 'add', '--detach', '-q', dir, commit])
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  await git(root, ['worktree', 'remove', '--force', dir])
}

/**
 * Moves an existing detached worktree to another commit.
 *
 * This is how the MEASUREMENT commit advances after a KEEP. It must never be
 * used on the frozen-test snapshot: moving the measurement point must not move
 * the success criteria.
 */
export async function repointWorktree(worktreeDir: string, commit: string): Promise<void> {
  await git(worktreeDir, ['checkout', '-q', '--detach', commit])
}

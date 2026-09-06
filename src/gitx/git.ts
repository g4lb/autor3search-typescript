import path from 'node:path'
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
 * Repo-relative POSIX paths touched since `sinceRef`: everything the scope
 * gate must treat as "changed by the agent," whether or not it was ever
 * `git add`-ed.
 *
 * This is the union of two git views, because neither alone answers the
 * question:
 *
 * - `diff --name-only <ref>` (ref vs. the *working tree*, not `HEAD`) — this
 *   catches committed changes, uncommitted edits to tracked files, and
 *   files the agent deleted. It does NOT catch a brand-new file the agent
 *   creates and never stages: `git diff` only ever compares paths git
 *   already knows about, so a new file outside `scope` that is never
 *   `git add`-ed would silently evade a gate built on `diff` alone — a real
 *   scope-gate bypass, not a hypothetical one.
 * - `ls-files --others --exclude-standard` — lists untracked files, closing
 *   that gap. `--exclude-standard` is load-bearing, not decoration: without
 *   it, the harness's own gitignored outputs (`results.tsv`, `run.log`,
 *   `.autoresearch/`, `node_modules/`) would appear as changes outside
 *   `scope` and fail every eval. Once a new file is committed, `diff` picks
 *   it up as an addition and `ls-files --others` naturally stops listing it
 *   (it is no longer "other"), so the union never double-reports a file
 *   across a commit boundary.
 *
 * Both commands use `-z`: a path with a space or embedded newline would
 * otherwise be able to split into extra entries under the default
 * newline-separated, C-quoted output, and a scope gate that mis-parses a
 * filename is one an agent can bypass by naming a file carefully. This is a
 * security property, not formatting.
 */
export async function changedFiles(root: string, sinceRef: string): Promise<string[]> {
  const [diffOut, untrackedOut] = await Promise.all([
    gitRaw(root, ['diff', '--name-only', '-z', sinceRef]),
    gitRaw(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  return [...new Set([...parseNulList(diffOut), ...parseNulList(untrackedOut)])].sort()
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

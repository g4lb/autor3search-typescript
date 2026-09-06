import path from 'node:path'
import { listSymlinks, walkRepo } from '../discover/files.js'
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
 * Repo-relative POSIX paths of every tracked file whose git-index "assume
 * unchanged" or "skip-worktree" bit is set.
 *
 * Either bit tells git to stop comparing that path against the working
 * tree at all -- `git diff <ref>` (which `changedFiles` otherwise relies on
 * to see committed-vs-disk differences) reports NO difference for such a
 * file even after its on-disk content is completely rewritten, because git
 * trusts the index entry without ever re-reading the file. That is a
 * complete, one-command bypass of both the scope gate and gate 8's
 * clean-tree check (`git update-index --assume-unchanged <path>`, or
 * `--skip-worktree`) -- strictly easier than the `.gitignore`-hiding attack
 * this function otherwise closes -- so it is detected directly rather than
 * trusted through a diff mechanism that cannot see it.
 *
 * `git ls-files -v` tags every tracked path with one status letter; the
 * letter is lowercased when the assume-unchanged bit is set, and a
 * skip-worktree path is tagged `S` regardless. Either is reported here.
 */
async function tamperedIndexEntries(root: string): Promise<string[]> {
  const out = await gitRaw(root, ['ls-files', '-v', '-z'])
  const flagged: string[] = []
  for (const entry of out.split('\0')) {
    if (entry === '') continue
    const tag = entry.charAt(0)
    const rel = entry.slice(2) // "<tag><SP><path>"
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) {
      flagged.push(rel.split(path.sep).join('/'))
    }
  }
  return flagged
}

/**
 * Repo-relative POSIX paths of every `.gitignore` (a plain file -- a
 * SYMLINKED `.gitignore` is caught separately, as an untracked symlink)
 * that is either untracked or differs from `sinceRef`: one whose rules
 * cannot be trusted for this comparison.
 *
 * `--exclude-standard` (used below to list ordinary untracked files) is
 * only safe to rely on once this comes back empty. An agent-authored
 * `.gitignore` an agent just wrote to hide a directory of untracked source
 * (`printf '*\n' > lib/.gitignore`) is exactly what this catches: rather
 * than distrust `--exclude-standard`'s output in general (which would also
 * make it blind to the REPOSITORY's own, entirely legitimate ignore rules
 * -- `dist/`, `.env`, `.DS_Store`, `*.log`, ...), an untracked or modified
 * `.gitignore` is treated as a violation in its own right and refused
 * before `--exclude-standard`'s output is ever trusted.
 */
function untrustedGitignores(allFiles: string[], tracked: Set<string>, diffed: Set<string>): string[] {
  return allFiles.filter(
    (f) => path.posix.basename(f) === '.gitignore' && (!tracked.has(f) || diffed.has(f)),
  )
}

/**
 * Repo-relative POSIX paths touched since `sinceRef`: everything the scope
 * gate (and gate 8's clean-tree check) must treat as "changed," whether or
 * not it was ever `git add`-ed, committed, or hidden from git's own normal
 * views.
 *
 * This is the union of several views, because no one of them alone answers
 * the question:
 *
 * - `diff --name-only <ref>` (ref vs. the *working tree*, not `HEAD`) --
 *   catches committed changes, uncommitted edits to tracked files, and
 *   files the agent deleted. Blind to a brand-new file never `git add`-ed,
 *   and to a tracked file flagged assume-unchanged/skip-worktree (below).
 * - `ls-files --others --exclude-standard` -- untracked files, respecting
 *   `.gitignore`. Safe to trust here ONLY because `untrustedGitignores`
 *   (above) is checked first and separately: this function does NOT
 *   re-derive an ignore-immune untracked-file list of its own (an earlier
 *   version did, and it made the tool refuse on a repository's own
 *   ordinary `dist/`, `.env` or `*.log` entries -- the opposite failure).
 * - `untrustedGitignores` -- an untracked or modified `.gitignore` is
 *   itself reported as a change, so `--exclude-standard`'s output for
 *   THIS invocation is never trusted while the rules it depends on are in
 *   an unverified state.
 * - `listSymlinks` minus git's tracked set -- an untracked symlink is
 *   invisible to the ordinary file walk `walkRepo` uses (by design; see
 *   its own doc comment) and to `--exclude-standard` only if it happens to
 *   be gitignored, but it is exactly what Node and `tsc` resolve at
 *   measure time. Reported unconditionally, gitignored or not: a symlink
 *   is content indirection, and hiding a NEW one behind an ignore rule is
 *   not a legitimate use this gate needs to accommodate the way `dist/`
 *   or `.env` are.
 * - `tamperedIndexEntries` -- see its own doc comment: a complete bypass
 *   of `diff` for a tracked file, detected directly.
 *
 * `diff` and every `ls-files` call use `-z`: a path with a space or
 * embedded newline would otherwise be able to split into extra entries
 * under the default newline-separated, C-quoted output, and a scope gate
 * that mis-parses a filename is one an agent can bypass by naming a file
 * carefully. This is a security property, not formatting.
 */
export async function changedFiles(root: string, sinceRef: string): Promise<string[]> {
  const [diffOut, trackedOut, untrackedOut, allFiles, symlinks, tamperedTags] = await Promise.all([
    gitRaw(root, ['diff', '--name-only', '-z', sinceRef]),
    gitRaw(root, ['ls-files', '-z']),
    gitRaw(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    walkRepo(root),
    listSymlinks(root),
    tamperedIndexEntries(root),
  ])
  const tracked = new Set(parseNulList(trackedOut))
  const diffed = new Set(parseNulList(diffOut))
  const gitignoreViolations = untrustedGitignores(allFiles, tracked, diffed)
  const untrackedSymlinks = symlinks.filter((f) => !tracked.has(f))

  return [
    ...new Set([
      ...diffed,
      ...parseNulList(untrackedOut),
      ...gitignoreViolations,
      ...untrackedSymlinks,
      ...tamperedTags,
    ]),
  ].sort()
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

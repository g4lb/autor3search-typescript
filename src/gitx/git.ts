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
 * Repo-relative POSIX paths changed between `sinceRef` and the working tree.
 *
 * Deliberately `diff <ref>` (ref vs. working tree), not `diff <ref> HEAD`
 * (ref vs. last commit): the scope gate must see uncommitted edits too, and
 * this form also reports files the agent deleted. It does NOT report a new
 * untracked file the agent added — `git diff` only ever compares against
 * what git already knows about, so a file added outside `scope` and never
 * `git add`-ed would evade a gate built only on this function. Callers that
 * need to catch new files must combine this with an untracked-files check.
 */
export async function changedFiles(root: string, sinceRef: string): Promise<string[]> {
  // -z guards against paths containing spaces or newlines: with the default
  // newline-separated, C-quoted output, a filename that itself contains a
  // newline (or a space, under certain diff options) can be misparsed into
  // extra entries. A scope gate that mis-parses a filename is a scope gate
  // that can be bypassed by naming a file carefully, so this is a security
  // property, not formatting.
  const out = await git(root, ['diff', '--name-only', '-z', sinceRef])
  return out
    .split('\0')
    .filter((s) => s !== '')
    .map((s) => s.split(path.sep).join('/'))
    .sort()
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

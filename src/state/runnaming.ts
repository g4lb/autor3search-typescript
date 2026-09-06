import { currentBranch } from '../gitx/git.js'

/**
 * Shared naming constants and the `-tag`-inference helper, previously
 * copied (with an identical comment explaining why) across `cmd-baseline.ts`,
 * `cmd-eval.ts`, `cmd-stop.ts`, `cmd-status.ts` and `pipeline/eval.ts`.
 *
 * The duplication was a deliberate, documented choice during earlier tasks
 * (a scheduling constraint: `cmd-baseline.ts` was already-shipped code a
 * later task was not to modify) rather than an oversight. That constraint
 * no longer applies -- per Ruling 44 ("eliminate duplication when you can,
 * guard it only when you cannot"), these five copies are consolidated here.
 * A future change to the branch-naming scheme or the worktree/frozen layout
 * now cannot silently diverge between call sites by being made in one copy
 * and forgotten in the others.
 */

/** Prefix `baseline` uses for the run branch it creates: `<prefix><tag>`. */
export const BRANCH_PREFIX = 'autoresearch-typescript/'

/** Directory name, under the per-run state dir, of the pinned baseline worktree. */
export const WORKTREE_DIRNAME = 'baseline-worktree'

/** Directory name, under the per-run state dir, of the frozen test/bench snapshot. */
export const FROZEN_DIRNAME = 'frozen'

/**
 * `-tag`'s default: the tag encoded in the current run branch's name.
 * Every command that accepts `-tag` falls back to this when it is omitted,
 * so a human or agent already checked out on a run branch never has to
 * repeat the tag on every invocation.
 */
export async function inferTagFromBranch(repoRoot: string): Promise<string> {
  let branch: string
  try {
    branch = await currentBranch(repoRoot)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new Error(`-tag was not given, and the current branch could not be determined: ${message}`)
  }
  if (!branch.startsWith(BRANCH_PREFIX)) {
    throw new Error(
      `-tag was not given, and the current branch (${JSON.stringify(branch)}) is not a run branch ` +
        `(expected "${BRANCH_PREFIX}<tag>"). Pass -tag <tag> explicitly.`,
    )
  }
  const tag = branch.slice(BRANCH_PREFIX.length)
  if (tag === '') {
    throw new Error(`-tag was not given, and the current branch (${JSON.stringify(branch)}) names no tag`)
  }
  return tag
}

import { access } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { currentBranch, headCommit, shortSha } from '../gitx/git.js'
import { loadRows, summarize } from '../results/results.js'
import { readBaseline } from '../state/baseline.js'
import { runDir } from '../state/home.js'
import { readEvalLock } from '../state/lock.js'
import { BRANCH_PREFIX, WORKTREE_DIRNAME, inferTagFromBranch } from '../state/runnaming.js'
import { readStop } from '../state/stop.js'
import type { RunCtx } from './runctx.js'
import { formatCumulativeSpeedup } from './speedup.js'

const STATUSES = ['keep', 'discard', 'fail', 'crash'] as const

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`)
  return 2
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Mirrors lock.ts's private `isAlive` (not exported): EPERM means the
 * process exists but we lack permission to signal it, which is still
 * "alive." `status` only ever uses this to word its report ("running" vs.
 * "a crashed eval's stale lock") -- it never reclaims anything, which stays
 * `acquireEvalLock`'s job alone, so a merely-informational check here can
 * never race a real acquire.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function tryGit<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f()
  } catch {
    return null
  }
}

/**
 * `status`: reports where a run is, without changing it. It reads only the
 * baseline record, `results.tsv`, the eval lock and the stop file (plus two
 * read-only `git` queries for the human's own current branch/HEAD) --
 * nothing here is ever written. `-tag` resolves the run directory from the
 * repo root and the tag alone (see `state/home.ts`'s `runDir`), independent
 * of whatever branch the repository happens to be on right now, so a human
 * who has wandered off the run branch can still check on it.
 */
export async function cmdStatus(ctx: RunCtx, argv: readonly string[]): Promise<number> {
  let tag: string | undefined
  try {
    const normalized = argv.map((a) => (/^-[A-Za-z][A-Za-z-]+$/.test(a) ? `-${a}` : a))
    const { values } = parseArgs({
      args: normalized,
      options: { tag: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    })
    tag = values.tag
  } catch (e) {
    return fail(messageOf(e))
  }

  let resolvedTag: string
  try {
    resolvedTag = tag ?? (await inferTagFromBranch(ctx.repoRoot))
  } catch (e) {
    return fail(messageOf(e))
  }

  const dir = runDir(ctx.repoRoot, resolvedTag)

  let baseline: Awaited<ReturnType<typeof readBaseline>>
  try {
    baseline = await readBaseline(dir)
  } catch (e) {
    return fail(messageOf(e))
  }

  const [branch, head, lock, stop, rows] = await Promise.all([
    tryGit(() => currentBranch(ctx.repoRoot)),
    tryGit(() => headCommit(ctx.repoRoot)),
    readEvalLock(dir),
    readStop(dir),
    loadRows(ctx.resultsPath),
  ])

  const runBranch = `${BRANCH_PREFIX}${resolvedTag}`
  const worktreeDir = path.join(dir, WORKTREE_DIRNAME)
  const worktreePresent = await exists(worktreeDir)
  const summary = summarize(rows)

  const lines: string[] = []
  lines.push(`autor3search-typescript status -- tag ${JSON.stringify(resolvedTag)}`)
  lines.push(`  run branch:      ${runBranch}`)
  lines.push(
    `  current branch:  ${branch ?? 'unknown'}` + (branch === runBranch ? '' : '  (not on the run branch)'),
  )
  lines.push(`  frozen commit:   ${shortSha(baseline.frozenCommit)} (${baseline.frozenCommit})`)
  lines.push(`  measure commit:  ${shortSha(baseline.measureCommit)} (${baseline.measureCommit})`)
  lines.push(`  HEAD:            ${head === null ? 'unknown' : `${shortSha(head)} (${head})`}`)
  lines.push(`  worktree:        ${worktreeDir} (${worktreePresent ? 'present' : 'MISSING'})`)

  if (lock === null) {
    lines.push('  eval:            idle')
  } else if (isPidAlive(lock.pid)) {
    lines.push(`  eval:            running (pid ${lock.pid})`)
  } else {
    lines.push(
      `  eval:            not running (stale lock left by pid ${lock.pid} -- a previous eval likely crashed)`,
    )
  }

  if (stop === null) {
    lines.push('  stop:            none pending')
  } else {
    const detail = stop.force
      ? 'the running eval was asked to abandon its current experiment immediately'
      : 'the agent will stop after its current experiment reports a verdict'
    lines.push(`  stop:            requested at ${stop.requestedAt} (force: ${stop.force ? 'yes' : 'no'}) -- ${detail}`)
  }

  lines.push(`  experiments:     ${rows.length} total`)
  lines.push(`    ${STATUSES.map((s) => `${s}: ${summary.counts[s] ?? 0}`).join('  ')}`)
  lines.push(`  cumulative speedup: ${formatCumulativeSpeedup(summary.cumulativeSpeedup)}`)
  if (summary.topWins.length > 0) {
    lines.push('  top wins:')
    for (const w of summary.topWins) {
      const desc = w.description.length > 0 ? ` -- ${w.description}` : ''
      lines.push(`    ${shortSha(w.commit)}  score=${w.score.toFixed(4)}${desc}`)
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

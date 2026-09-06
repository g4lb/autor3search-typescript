import { shortSha } from '../gitx/git.js'
import { RESULTS_PATH, loadRows, summarize } from '../results/results.js'
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

/**
 * `report`: what a human reads in the morning after an unattended run --
 * a summary of `results.tsv`, and nothing else. Read-only: it never writes
 * anything, and it never spawns anything (no git, no subprocess), so it is
 * always safe to run alongside a live loop.
 *
 * A missing (or header-only) `results.tsv` is a real, valid state -- a
 * repository that has never run an experiment -- so it is reported as "no
 * experiments recorded yet," not as an error. `loadRows` already treats a
 * missing file as an empty log; this only needs to word the empty case
 * helpfully instead of printing zeroed-out counts a human could misread as
 * "something ran and did nothing."
 */
export async function cmdReport(ctx: RunCtx, _argv: readonly string[]): Promise<number> {
  let rows: Awaited<ReturnType<typeof loadRows>>
  try {
    rows = await loadRows(ctx.resultsPath)
  } catch (e) {
    return fail(messageOf(e))
  }

  const lines: string[] = ['autor3search-typescript report', '']

  if (rows.length === 0) {
    lines.push(
      `no experiments recorded yet (${RESULTS_PATH} does not exist, or has no rows). Run "eval" ` +
        'at least once to populate it.',
    )
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  }

  const summary = summarize(rows)

  lines.push(`experiments: ${rows.length} total`)
  lines.push(`  ${STATUSES.map((s) => `${s}: ${summary.counts[s] ?? 0}`).join('  ')}`)
  lines.push('')
  // Deliberately spelled out rather than left implicit: each KEEP advances
  // the measurement baseline to the just-kept commit, so every kept row's
  // own `score` is only that experiment's incremental contribution on top
  // of the last win -- never a re-measurement against the run's original
  // starting point. Only the PRODUCT of every kept score is the true
  // end-to-end speedup since the run began; printing (or reading) the
  // latest row's score alone would silently understate or overstate that,
  // depending on how many wins came before it.
  lines.push(
    `cumulative speedup: ${formatCumulativeSpeedup(summary.cumulativeSpeedup)} ` +
      "(the product of every KEPT experiment's own score, compounded across the whole run -- " +
      "not the most recent experiment's score by itself)",
  )

  if (summary.topWins.length > 0) {
    lines.push('')
    lines.push('largest individual wins (own score, biggest improvement first):')
    for (const w of summary.topWins) {
      const desc = w.description.length > 0 ? ` -- ${w.description}` : ''
      lines.push(
        `  ${shortSha(w.commit)}  score=${w.score.toFixed(4)}  best_bench_delta=${w.bestBenchDelta.toFixed(2)}%${desc}`,
      )
    }
  } else {
    lines.push('')
    lines.push('no kept experiments yet.')
  }

  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

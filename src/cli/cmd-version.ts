import { parseArgs } from 'node:util'
import { formatVersion } from '../version.js'
import type { RunCtx } from './runctx.js'

/**
 * Reports which build of the harness is running.
 *
 * Worth having for the same reason the Go sibling has it: a `results.tsv`
 * row is only as reproducible as the harness that produced it, and "which
 * version measured this" is otherwise unanswerable from an installed copy.
 *
 * Takes no flags, and says so rather than ignoring them -- a silently
 * accepted typo here would be reported as a version by whatever script
 * called it.
 */
export async function cmdVersion(_ctx: RunCtx, argv: readonly string[]): Promise<number> {
  try {
    parseArgs({ args: [...argv], options: {}, strict: true, allowPositionals: false })
  } catch {
    process.stderr.write('error: version takes no arguments\n')
    return 2
  }

  process.stdout.write(formatVersion())
  return 0
}

import { runChecks } from '../doctor/doctor.js'
import type { RunCtx } from './runctx.js'

/**
 * Reports whether this machine can measure reliably: informational only.
 *
 * `doctor` deliberately always returns 0, regardless of how many checks
 * fail. Every other command's exit code carries a verdict the harness or
 * a script may act on; this one does not -- it exists to be run before
 * trusting an overnight run's numbers, and a diagnostic that blocks the
 * next step is a diagnostic people stop running.
 */
export async function cmdDoctor(_ctx: RunCtx, _argv: string[]): Promise<number> {
  const checks = await runChecks()

  process.stdout.write('autor3search-typescript doctor -- can this machine measure reliably?\n\n')
  for (const c of checks) {
    const mark = c.ok ? 'OK  ' : 'WARN'
    process.stdout.write(`[${mark}] ${c.name}: ${c.detail}\n`)
  }

  const warnings = checks.filter((c) => !c.ok).length
  process.stdout.write('\n')
  process.stdout.write(
    warnings === 0
      ? 'No issues found.\n'
      : `${warnings} check(s) flagged above -- address what you can before an overnight run.\n`,
  )
  process.stdout.write('This command is informational only and always exits 0.\n')

  return 0
}

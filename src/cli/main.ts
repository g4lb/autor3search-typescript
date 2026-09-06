#!/usr/bin/env node
import { cmdBaseline } from './cmd-baseline.js'
import { cmdDoctor } from './cmd-doctor.js'
import { cmdEval } from './cmd-eval.js'
import { cmdInit } from './cmd-init.js'
import { cmdProfile } from './cmd-profile.js'
import { cmdReport } from './cmd-report.js'
import { cmdStatus } from './cmd-status.js'
import { cmdStop } from './cmd-stop.js'
import { resolveCtx, splitDashC, type RunCtx } from './runctx.js'

type Command = (ctx: RunCtx, argv: string[]) => Promise<number>

/**
 * The command table.
 *
 * Ruling 34: a command implemented and tested but never added here is
 * unreachable, yet looks completely healthy from inside its own task's
 * suite -- the missing piece lives in a file that task never touches, and
 * `--help` would still print successfully, just without it. Every command
 * task must register itself here, and prove it with a test that dispatches
 * through `main`, not one that only calls the command function directly.
 * Exported (only) so the COMMANDS/HELP invariant test below can compare
 * this table's keys against what `--help` actually lists.
 */
export const COMMANDS: Record<string, Command> = {
  init: cmdInit,
  doctor: cmdDoctor,
  baseline: cmdBaseline,
  eval: cmdEval,
  status: cmdStatus,
  stop: cmdStop,
  report: cmdReport,
  profile: cmdProfile,
}

const HELP = `autoresearch-typescript -- autonomous performance optimization for a TypeScript repository

Usage: autoresearch-typescript [-C <dir>] <command> [flags]

Commands:
  init      Discover benchmarks and write .autoresearch/config.yaml and program.md
  doctor    Report whether this machine can measure reliably (informational, always exits 0)
  baseline  Freeze tests/benchmarks, pin a worktree at HEAD, install and prove it can measure
  eval      Run one experiment through the gate chain and report a verdict (0 KEEP, 1 DISCARD, 2 FAIL, 3 CRASH)
  status    Report where a run is: branch, commits, worktree, experiment counts, in-flight eval, pending stop (read-only)
  stop      Ask the agent to stop after its current experiment; -clear cancels, -force also signals the running eval
  report    Summarize results.tsv: counts by status, cumulative speedup, largest individual wins
  profile   Run the declared benchmarks under Node's CPU profiler and print the hottest functions

Global flags:
  -C <dir>  Run as if invoked from <dir> (resolves that directory's git repository root)
  --help    Print this message
`

function printHelp(): void {
  process.stdout.write(HELP)
}

/**
 * Dispatch only: parse the leading `-C <dir>`, take the subcommand, and
 * delegate. Every command is `(ctx, argv) => Promise<number>`, and its
 * return value becomes the process exit code directly -- exit codes are
 * reserved project-wide (0 KEEP, 1 DISCARD, 2 FAIL, 3 CRASH), and a usage
 * error or an `init` failure is a FAIL (2).
 *
 * This function never rejects: everything below -- including `resolveCtx`
 * failing on a `-C` outside any git repository -- is caught here and
 * turned into `error: <message>` on stderr plus a `2` return, never a raw
 * stack trace. That makes it directly testable (call it, read the
 * returned number) without a test having to unwrap a promise rejection.
 */
export async function main(argv: string[]): Promise<number> {
  try {
    // The same `splitDashC` that `resolveCtx` uses below: one implementation
    // of "-C is only recognized as the leading token," so this and
    // `resolveCtx` cannot silently drift apart into two different parsings
    // of the same flag.
    const { rest } = splitDashC(argv)
    const [name, ...commandArgv] = rest
    if (name === undefined || name === '--help' || name === '-h') {
      printHelp()
      return 2
    }

    const command = COMMANDS[name]
    if (!command) {
      process.stderr.write(`error: unknown command "${name}"\n\n`)
      printHelp()
      return 2
    }

    const ctx = await resolveCtx(argv)
    return await command(ctx, commandArgv)
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`)
    return 2
  }
}

// Only run when this module is the entry point -- not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}

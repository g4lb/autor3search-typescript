#!/usr/bin/env node
import { cmdInit } from './cmd-init.js'
import { resolveCtx, type RunCtx } from './runctx.js'

type Command = (ctx: RunCtx, argv: string[]) => Promise<number>

/**
 * The command table. Only `init` exists so far -- `baseline`, `eval`,
 * `stop` and `report` are later tasks, and until they land an attempt to
 * run them is correctly an "unknown subcommand," not a stub that pretends
 * to work.
 */
const COMMANDS: Record<string, Command> = {
  init: cmdInit,
}

const HELP = `autoresearch-typescript -- autonomous performance optimization for a TypeScript repository

Usage: autoresearch-typescript [-C <dir>] <command> [flags]

Commands:
  init      Discover benchmarks and write .autoresearch/config.yaml and program.md

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
    let rest = argv
    if (rest[0] === '-C') {
      if (rest[1] === undefined) {
        process.stderr.write('error: -C requires a directory argument\n')
        return 2
      }
      rest = rest.slice(2)
    }

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

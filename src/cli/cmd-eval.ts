import { appendFileSync, rmSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { currentBranch } from '../gitx/git.js'
import { runEval, type EvalOutcome } from '../pipeline/eval.js'
import { killActiveChildren } from '../runner/exec.js'
import { runDir } from '../state/home.js'
import { lockPath } from '../state/lock.js'
import { EXIT_CODES } from '../verdict/verdict.js'
import type { RunCtx } from './runctx.js'

/**
 * SIGTERM's default disposition kills node immediately -- once ANY listener
 * is added, Node stops doing that for us, so this handler must actually
 * terminate the process itself once it's done cleaning up.
 *
 * Both steps below are what `stop -force` (spec section 2 item 4) needs and
 * does not otherwise get for free: `eval.ts` spawns every measurement child
 * `detached: true` (its own process-group leader), so it is not reaped
 * merely by `eval` itself dying; and the eval lock is a file this process
 * would otherwise never release, since `acquireEvalLock`'s `finally` in
 * `runEval` never runs if the process exits out from under it instead.
 */
/** Exported for testing: see `cmd-eval.sigterm.test.ts`. */
export function installSigtermHandler(dir: string): () => void {
  const onSigterm = (): void => {
    killActiveChildren('SIGTERM')
    try {
      rmSync(lockPath(dir), { force: true })
    } catch {
      /* best effort -- exiting either way */
    }
    // 128 + 15 (SIGTERM), the conventional shell exit code for "killed by
    // this signal" -- distinct from every real verdict's exit code (0-3),
    // so a caller can tell "abandoned by -force" from any real outcome.
    process.exit(143)
  }
  process.once('SIGTERM', onSigterm)
  return () => process.off('SIGTERM', onSigterm)
}

/**
 * Duplicated from `cmd-baseline.ts` rather than imported -- see the same
 * note in `pipeline/eval.ts`. Load-bearing: this must match the prefix
 * `cmd-baseline.ts` uses when it creates the run branch, or `-tag`
 * inference from the current branch silently stops working.
 */
const BRANCH_PREFIX = 'autoresearch-typescript/'

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`)
  return 2
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** `-tag`'s default: the tag encoded in the current run branch's name. */
async function inferTagFromBranch(repoRoot: string): Promise<string> {
  let branch: string
  try {
    branch = await currentBranch(repoRoot)
  } catch (e) {
    throw new Error(`-tag was not given, and the current branch could not be determined: ${messageOf(e)}`)
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

interface JsonBenchmark {
  name: string
  base_ns: number
  cand_ns: number
  pct_change: number
  p: number
  significant: boolean
}

interface JsonOutcome {
  status: string
  exit_code: number
  score: number
  reason: string
  corrected_alpha: number
  warnings: string[]
  stop_requested: boolean
  benchmarks: JsonBenchmark[]
  measure_commit: string
  frozen_commit: string
  experiment: number
  /** Which gate rejected the experiment, empty for KEEP/DISCARD/CRASH-in-measurement. */
  failed_gate: string
  /** Human-readable explanation -- for FAIL/CRASH this is the only place the actual diagnosis lives. */
  message: string
}

function toJson(outcome: EvalOutcome, exitCode: number): JsonOutcome {
  return {
    status: outcome.verdict.status,
    exit_code: exitCode,
    score: outcome.verdict.score,
    reason: outcome.verdict.reason ?? '',
    corrected_alpha: outcome.verdict.correctedAlpha,
    warnings: outcome.warnings,
    stop_requested: outcome.stopRequested,
    benchmarks: outcome.deltas.map((d) => ({
      name: d.name,
      base_ns: d.baseNs,
      cand_ns: d.candNs,
      pct_change: d.pctChange,
      p: d.p,
      significant: d.significant,
    })),
    measure_commit: outcome.measureCommit,
    frozen_commit: outcome.frozenCommit,
    experiment: outcome.experiment,
    failed_gate: outcome.failedGate ?? '',
    message: outcome.message,
  }
}

function printHuman(outcome: EvalOutcome, exitCode: number): void {
  for (const w of outcome.warnings) process.stdout.write(`WARNING: ${w}\n`)
  const status = outcome.verdict.status.toUpperCase()
  process.stdout.write(`experiment ${outcome.experiment}: ${status} (exit ${exitCode})\n`)
  if (outcome.failedGate) process.stdout.write(`  failed_gate: ${outcome.failedGate}\n`)
  process.stdout.write(`  ${outcome.message}\n`)
  if (outcome.deltas.length > 0) {
    process.stdout.write('  benchmarks:\n')
    for (const d of outcome.deltas) {
      const sig = d.significant ? 'significant' : 'not significant'
      process.stdout.write(
        `    ${d.name}: ${d.baseNs.toFixed(1)}ns -> ${d.candNs.toFixed(1)}ns ` +
          `(${d.pctChange.toFixed(2)}%, p=${d.p.toExponential(2)}, ${sig})\n`,
      )
    }
  }
  process.stdout.write(`  measure_commit: ${outcome.measureCommit}\n`)
  process.stdout.write(`  frozen_commit:  ${outcome.frozenCommit}\n`)
  if (outcome.stopRequested) {
    process.stdout.write('  a stop has been requested: apply this verdict, then stop looping.\n')
  }
}

/**
 * `eval`: runs one experiment through the gate chain (`pipeline/eval.ts`)
 * and reports the verdict. The exit code IS the signal an unattended agent
 * loop acts on -- 0 KEEP, 1 DISCARD, 2 FAIL, 3 CRASH -- so every path here
 * that can be reached after a real attempt returns whatever `EXIT_CODES`
 * says for that outcome; only a usage error (bad flags, no resolvable tag)
 * returns 2 without ever having attempted an experiment.
 *
 * Under `--json`, exactly one JSON object is printed to stdout and nothing
 * else: subprocess transcripts go to `run.log`, and every warning is folded
 * into the object's own `warnings` array rather than printed as a separate
 * line. Human output prints those same warnings as `WARNING:` lines above
 * the verdict instead.
 */
export async function cmdEval(ctx: RunCtx, argv: readonly string[]): Promise<number> {
  let tag: string | undefined
  let json: boolean
  let desc: string
  try {
    const normalized = argv.map((a) => (/^-[A-Za-z][A-Za-z-]+$/.test(a) ? `-${a}` : a))
    const { values } = parseArgs({
      args: normalized,
      options: {
        tag: { type: 'string' },
        json: { type: 'boolean', default: false },
        desc: { type: 'string', default: '' },
      },
      strict: true,
      allowPositionals: false,
    })
    tag = values.tag
    json = values.json === true
    desc = values.desc ?? ''
  } catch (e) {
    return fail(messageOf(e))
  }

  let resolvedTag: string
  try {
    resolvedTag = tag ?? (await inferTagFromBranch(ctx.repoRoot))
  } catch (e) {
    return fail(messageOf(e))
  }

  // A fresh transcript per invocation -- run.log is this run's own record,
  // not a growing history. Best effort: a logging failure must never take
  // down the experiment it is only observing.
  try {
    writeFileSync(ctx.logPath, '')
  } catch {
    /* best effort */
  }
  const log = (chunk: string): void => {
    try {
      appendFileSync(ctx.logPath, chunk)
    } catch {
      /* best effort -- see above */
    }
  }

  const removeSigtermHandler = installSigtermHandler(runDir(ctx.repoRoot, resolvedTag))
  let outcome: EvalOutcome
  try {
    outcome = await runEval({ ctx, tag: resolvedTag, description: desc, log })
  } catch (e) {
    return fail(`eval failed before producing a verdict: ${messageOf(e)}`)
  } finally {
    removeSigtermHandler()
  }

  const exitCode = EXIT_CODES[outcome.verdict.status]

  if (json) {
    process.stdout.write(`${JSON.stringify(toJson(outcome, exitCode))}\n`)
  } else {
    printHuman(outcome, exitCode)
  }

  return exitCode
}

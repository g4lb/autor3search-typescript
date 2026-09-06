/**
 * The gate chain: everything one `eval` invocation does between "the agent
 * made a commit" and "here is a verdict." Gate order is the design, not an
 * implementation detail -- each gate must reject before anything past it
 * runs, and in particular before any benchmark child is ever spawned.
 *
 * The eleven checks, in the order the brief specifies:
 *
 *  1. scope             -- every changed file is in `config.scope` (or immutable
 *                           -> unconditional reject regardless of scope)
 *  2. config integrity   -- `.autoresearch/config.yaml` hashes to what baseline
 *                           recorded; the agent cannot loosen its own rules
 *  3. restore            -- frozen tests/benchmarks are put back exactly as they
 *                           were at baseline, whether or not they were "in scope"
 *  4. unmanifested        -- no new test/bench/runner-config file has appeared
 *                           that baseline never froze ("add an easier benchmark")
 *  5. typecheck          -- `config.typecheckCommand`, skipped when empty
 *  6. build              -- `config.buildCommand`, skipped when empty
 *  7. test               -- `config.testCommand` (never empty)
 *  8. worktree integrity -- the pinned baseline worktree still exists, is at
 *                           `baseline.measureCommit`, and its lockfile is untouched
 *  9. measure            -- interleaved benchmark measurement, base vs. candidate
 * 10. score              -- `compareAll` + `decide`
 * 11. on KEEP             -- advance `measureCommit` (never `frozenCommit`)
 *
 * A `results.tsv` row is appended for every outcome this function actually
 * returns from -- FAIL and CRASH included -- because "an eval ran and was
 * refused" is itself part of the experiment record.
 */
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { runChild } from '../benchrun/invoke.js'
import { loadConfig, parseDuration } from '../config/load.js'
import type { Config } from '../config/schema.js'
import type { Benchmark } from '../discover/benchmarks.js'
import { freezableFiles } from '../discover/files.js'
import { findUnmanifested, restore } from '../freeze/freeze.js'
import { hashString } from '../freeze/manifest.js'
import { changedFiles, headCommit, repointWorktree } from '../gitx/git.js'
import { interleave, type Observations } from '../measure/interleave.js'
import { appendRow, loadRows, type Row } from '../results/results.js'
import { checkScope } from '../scope/scope.js'
import { ALPHA, compareAll, type Delta } from '../stats/delta.js'
import { readBaseline, writeBaseline, type BaselineRecord } from '../state/baseline.js'
import { acquireEvalLock } from '../state/lock.js'
import { runDir } from '../state/home.js'
import { readStop } from '../state/stop.js'
import { ok, runShell, tail } from '../runner/exec.js'
import { decide, type Verdict } from '../verdict/verdict.js'

/**
 * The baseline worktree/frozen-snapshot directory names, duplicated from
 * `cmd-baseline.ts` rather than imported from it. `cmd-baseline.ts` is
 * already-shipped (task 18) code this task must not modify, and it keeps
 * those two names as module-private constants -- so this is the only way
 * for `eval` to agree with `baseline` on where the worktree and frozen
 * snapshot live without editing that file. Both names are load-bearing
 * across the two modules; a change to either must be made in both places.
 */
const WORKTREE_DIRNAME = 'baseline-worktree'
const FROZEN_DIRNAME = 'frozen'

export type GateName =
  /** No baseline for this tag, or the config file itself could not be loaded at all. */
  | 'setup'
  | 'scope'
  | 'config-integrity'
  | 'restore'
  | 'unmanifested'
  | 'typecheck'
  | 'build'
  | 'test'
  | 'worktree-integrity'
  | 'measure'

/**
 * The subset of `RunCtx` (see `cli/runctx.ts`) this pipeline needs. Declared
 * independently rather than importing `RunCtx` itself so the pipeline layer
 * does not depend on the CLI layer -- `cli/cmd-eval.ts` passes its `RunCtx`
 * straight through, which satisfies this structurally.
 */
export interface EvalRepoCtx {
  repoRoot: string
  configPath: string
  resultsPath: string
}

export interface EvalOptions {
  ctx: EvalRepoCtx
  tag: string
  /** Free-text experiment description, recorded on the results.tsv row. */
  description: string
  /** Subprocess transcripts (typecheck/build/test/measurement children). */
  log?: (chunk: string) => void
  /**
   * Testing hook: overrides how one benchmark is measured in one directory.
   * Defaults to a real `runChild` spawn. Exists so gate-order tests can prove
   * a rejected gate never measures anything, by asserting this was never
   * called, without needing to spawn (and then discard) a real subprocess.
   */
  measureOne?: (dir: string, b: Benchmark) => Promise<number>
}

export interface EvalOutcome {
  verdict: Verdict
  deltas: Delta[]
  stopRequested: boolean
  failedGate?: GateName
  message: string
  /**
   * Every non-verdict warning gathered along the way (e.g. "gate 3 restored
   * N frozen file(s)"), followed by the verdict's own warnings when a score
   * was actually computed. Not in the brief's minimal interface, but
   * `cmd-eval`'s `--json` output and its human "WARNING:" lines both need a
   * single combined list, and building it here (once, where the gates run)
   * beats recomputing it at the CLI layer from partial information.
   */
  warnings: string[]
  /** Repo-relative frozen files whose content differed from baseline and were restored. */
  restoredFiles: string[]
  /** HEAD of the repository being evaluated -- the commit this verdict is about. */
  candidateCommit: string
  frozenCommit: string
  measureCommit: string
  /** 1-based count of experiments recorded in results.tsv, this one included. */
  experiment: number
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

/** `<file>:<fn>` -> `{ id, file, fn }`. The inverse of how `discoverBenchmarks` builds an id. */
function parseBenchmarkId(id: string): Benchmark {
  const idx = id.lastIndexOf(':')
  if (idx === -1) {
    throw new Error(`malformed benchmark id in baseline record: ${JSON.stringify(id)}`)
  }
  return { id, file: id.slice(0, idx), fn: id.slice(idx + 1) }
}

function noVerdict(status: 'fail' | 'crash'): Verdict {
  // fail/crash never reach decide() -- nothing was scored, so score,
  // correctedAlpha and regressions are all placeholders, not measurements.
  // ALPHA (uncorrected) is used rather than a computed correction because no
  // benchmark count is known at this point.
  return { status, score: 1, regressions: [], correctedAlpha: ALPHA, warnings: [] }
}

/**
 * Runs one experiment end to end: the full gate chain, and -- for whatever
 * outcome it ends in -- one `results.tsv` row.
 *
 * The eval lock is held for the whole chain and released in a `finally`, so
 * a crash mid-chain (this function throwing something genuinely
 * unanticipated) never leaves a future eval permanently blocked.
 */
export async function runEval(opts: EvalOptions): Promise<EvalOutcome> {
  const dir = runDir(opts.ctx.repoRoot, opts.tag)
  const release = await acquireEvalLock(dir)
  try {
    return await evaluate(opts, dir)
  } finally {
    await release()
  }
}

async function evaluate(opts: EvalOptions, dir: string): Promise<EvalOutcome> {
  const log = opts.log ?? ((): void => {})
  const worktreeDir = path.join(dir, WORKTREE_DIRNAME)
  const frozenDir = path.join(dir, FROZEN_DIRNAME)

  const stopRequested = (await readStop(dir)) !== null

  let candidateCommit = 'unknown'
  try {
    candidateCommit = await headCommit(opts.ctx.repoRoot)
  } catch {
    // Best effort only -- a row still needs *some* commit string, and a
    // git failure this early will also fail loudly below anyway.
  }

  const warnings: string[] = []
  const restoredFiles: string[] = []

  let baseline: BaselineRecord | undefined
  let config: Config | undefined

  /**
   * Builds the final outcome for any terminal state (fail, crash, discard or
   * keep), appends its results.tsv row, and returns. The row is appended
   * for every path through this function -- a rejected or crashed
   * experiment is still part of the record.
   */
  async function finish(
    verdict: Verdict,
    deltas: Delta[],
    failedGate: GateName | undefined,
    message: string,
  ): Promise<EvalOutcome> {
    const frozenCommit = baseline?.frozenCommit ?? 'unknown'
    const measureCommit = baseline?.measureCommit ?? 'unknown'
    const allWarnings = [...warnings, ...verdict.warnings]

    const priorRows = await loadRows(opts.ctx.resultsPath)
    const experiment = priorRows.length + 1

    const bestBenchDelta = deltas.length > 0 ? Math.min(...deltas.map((d) => d.pctChange)) : 0
    const pMin = deltas.length > 0 ? Math.min(...deltas.map((d) => d.p)) : 1
    const row: Row = {
      commit: candidateCommit,
      score: verdict.score,
      bestBenchDelta,
      pMin,
      status: verdict.status,
      reason: verdict.reason ?? '',
      description: opts.description,
    }
    await appendRow(opts.ctx.resultsPath, row)

    return {
      verdict,
      deltas,
      stopRequested,
      ...(failedGate !== undefined ? { failedGate } : {}),
      message,
      warnings: allWarnings,
      restoredFiles,
      candidateCommit,
      frozenCommit,
      measureCommit,
      experiment,
    }
  }

  // --- Load baseline and config. Either failing is a FAIL, not a crash: an
  // eval that cannot even establish what it is measuring against has not
  // measured anything.
  try {
    baseline = await readBaseline(dir)
  } catch (e) {
    return finish(noVerdict('fail'), [], 'setup', messageOf(e))
  }
  try {
    config = await loadConfig(opts.ctx.configPath)
  } catch (e) {
    return finish(noVerdict('fail'), [], 'setup', messageOf(e))
  }

  // --- Gate 1: scope. Immutable files reject unconditionally, regardless of
  // `config.scope` -- see `checkScope`.
  let changed: string[]
  try {
    changed = await changedFiles(opts.ctx.repoRoot, baseline.frozenCommit)
  } catch (e) {
    return finish(noVerdict('fail'), [], 'scope', `could not compute changed files: ${messageOf(e)}`)
  }
  const violations = checkScope(changed, config.scope)
  if (violations.length > 0) {
    const list = violations.map((v) => `${v.file} (${v.reason})`).join(', ')
    return finish(noVerdict('fail'), [], 'scope', `scope violation: ${list}`)
  }

  // --- Gate 2: config integrity. The config that produced `baseline` must
  // still be exactly what is on disk -- this is what stops the agent
  // loosening its own rules mid-run.
  let configText: string
  try {
    configText = await readFile(opts.ctx.configPath, 'utf8')
  } catch (e) {
    return finish(noVerdict('fail'), [], 'config-integrity', `could not read config: ${messageOf(e)}`)
  }
  if (hashString(configText) !== baseline.configHash) {
    return finish(
      noVerdict('fail'),
      [],
      'config-integrity',
      `${path.basename(opts.ctx.configPath)} has changed since baseline: the run configuration is frozen`,
    )
  }

  // --- Gate 3: restore. Frozen files are put back exactly as they were,
  // whether or not the agent's edit to them was "in scope" -- a test file
  // edit is legal to make, but its content is not legal to keep.
  try {
    const changedByRestore = await restore(opts.ctx.repoRoot, frozenDir, baseline.manifest)
    restoredFiles.push(...changedByRestore)
    if (changedByRestore.length > 0) {
      warnings.push(
        `restored ${changedByRestore.length} frozen file(s) modified since baseline: ${changedByRestore.join(', ')}`,
      )
    }
  } catch (e) {
    return finish(noVerdict('fail'), [], 'restore', `could not restore frozen files: ${messageOf(e)}`)
  }

  // --- Gate 4: unmanifested. A new test/bench/runner-config file absent
  // from the frozen manifest is rejected outright -- this is what closes
  // "add an easier benchmark."
  let candidates: string[]
  try {
    candidates = await freezableFiles(opts.ctx.repoRoot)
  } catch (e) {
    return finish(noVerdict('fail'), [], 'unmanifested', `could not list freezable files: ${messageOf(e)}`)
  }
  const extra = findUnmanifested(candidates, baseline.manifest, config.unfreeze)
  if (extra.length > 0) {
    return finish(
      noVerdict('fail'),
      [],
      'unmanifested',
      `new test/bench/runner-config file(s) not present at baseline: ${extra.join(', ')}`,
    )
  }

  const timeoutMs = parseDuration(config.timeout)

  // --- Gate 5: typecheck (skipped when empty).
  if (config.typecheckCommand.trim() !== '') {
    const r = await runShell(config.typecheckCommand, { cwd: opts.ctx.repoRoot, timeoutMs, log })
    if (!ok(r)) {
      return finish(
        noVerdict('fail'),
        [],
        'typecheck',
        `typecheck command failed (${config.typecheckCommand}, exit ${r.exitCode}): ${tail(r.stderr || r.stdout, 40)}`,
      )
    }
  }

  // --- Gate 6: build (skipped when empty).
  if (config.buildCommand.trim() !== '') {
    const r = await runShell(config.buildCommand, { cwd: opts.ctx.repoRoot, timeoutMs, log })
    if (!ok(r)) {
      return finish(
        noVerdict('fail'),
        [],
        'build',
        `build command failed (${config.buildCommand}, exit ${r.exitCode}): ${tail(r.stderr || r.stdout, 40)}`,
      )
    }
  }

  // --- Gate 7: test (never empty -- enforced by config validation).
  {
    const r = await runShell(config.testCommand, { cwd: opts.ctx.repoRoot, timeoutMs, log })
    if (!ok(r)) {
      return finish(
        noVerdict('fail'),
        [],
        'test',
        `test command failed (${config.testCommand}, exit ${r.exitCode}): ${tail(r.stderr || r.stdout, 40)}`,
      )
    }
  }

  // --- Gate 8: worktree integrity.
  const worktreeProblem = await checkWorktreeIntegrity(worktreeDir, baseline)
  if (worktreeProblem !== null) {
    return finish(noVerdict('fail'), [], 'worktree-integrity', worktreeProblem)
  }

  // --- Gate 9: measure.
  const benchmarks = baseline.benchmarks.map(parseBenchmarkId)
  const benchtimeMs = parseDuration(config.benchtime)
  const warmupMs = parseDuration(config.warmup)

  const defaultMeasureOne = async (measureDir: string, b: Benchmark): Promise<number> => {
    const result = await runChild({
      cwd: measureDir,
      benchFileAbs: path.join(measureDir, b.file),
      fn: b.fn,
      id: b.id,
      benchtimeMs,
      warmupMs,
      timeoutMs,
      nodeArgs: config!.nodeArgs,
      log,
    })
    if (!result.ok) {
      throw new Error(`benchmark ${b.id} crashed in ${measureDir}: ${result.error}`)
    }
    return result.nsPerOp
  }
  const measureOne = opts.measureOne ?? defaultMeasureOne

  let base: Observations
  let cand: Observations
  try {
    ;({ base, cand } = await interleave({
      rounds: config.count,
      benchmarks,
      baseDir: worktreeDir,
      candDir: opts.ctx.repoRoot,
      measureOne,
    }))
  } catch (e) {
    return finish(noVerdict('crash'), [], 'measure', messageOf(e))
  }

  // --- Gate 10: score.
  let deltas: Delta[]
  try {
    deltas = compareAll(base, cand)
  } catch (e) {
    return finish(noVerdict('crash'), [], 'measure', messageOf(e))
  }
  const verdict = decide({
    deltas,
    minEffectPct: config.minEffectPct,
    maxRegressPct: config.maxRegressPct,
    rounds: config.count,
  })

  // --- Step 11: on KEEP, advance measureCommit. frozenCommit and the
  // manifest are never touched -- moving the measurement point must never
  // move the success criteria.
  if (verdict.status === 'keep') {
    await repointWorktree(worktreeDir, candidateCommit)
    baseline = { ...baseline, measureCommit: candidateCommit }
    await writeBaseline(dir, baseline)
  }

  return finish(verdict, deltas, undefined, `${verdict.status}${verdict.reason ? `: ${verdict.reason}` : ''}`)
}

async function checkWorktreeIntegrity(worktreeDir: string, baseline: BaselineRecord): Promise<string | null> {
  if (!(await exists(worktreeDir))) {
    return `no worktree at ${worktreeDir}; run "baseline -force" to recreate it`
  }
  let atCommit: string
  try {
    atCommit = await headCommit(worktreeDir)
  } catch (e) {
    return `could not read the worktree's HEAD: ${messageOf(e)}`
  }
  if (atCommit !== baseline.measureCommit) {
    return (
      `the worktree is at ${atCommit} but baseline.measureCommit is ${baseline.measureCommit}; ` +
      'run "baseline -force" to recreate it'
    )
  }
  let lockfileText: string
  try {
    lockfileText = await readFile(path.join(worktreeDir, baseline.lockfileName), 'utf8')
  } catch (e) {
    return `could not read the worktree's lockfile (${baseline.lockfileName}): ${messageOf(e)}`
  }
  if (hashString(lockfileText) !== baseline.lockfileHash) {
    return (
      `the worktree's lockfile (${baseline.lockfileName}) no longer matches baseline.lockfileHash; ` +
      'run "baseline -force" to recreate it'
    )
  }
  return null
}

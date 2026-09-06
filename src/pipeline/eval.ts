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
 *  8. worktree integrity -- the candidate's own working tree is clean and HEAD
 *                           has moved past `baseline.measureCommit` (measuring
 *                           an uncommitted edit and crediting it to a commit
 *                           that never contained it would let one uncommitted
 *                           optimization be scored forever); the pinned
 *                           baseline worktree still exists, is at
 *                           `baseline.measureCommit`, and its lockfile is
 *                           untouched
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
import { FROZEN_DIRNAME, WORKTREE_DIRNAME } from '../state/runnaming.js'
import { ok, runShell, tail } from '../runner/exec.js'
import { decide, type Verdict } from '../verdict/verdict.js'

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
  /** Advancing measureCommit after a KEEP was already decided. */
  | 'advance'

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
    // results.tsv's `reason` column only ever holds a `DiscardReason` or ''
    // (loadRows rejects anything else) -- a FAIL/CRASH's free-text `message`
    // cannot go there. Folding it into `description` instead is the only
    // place in the fixed 7-column row that can carry it, so a FAIL/CRASH row
    // is not left with an empty reason AND an empty description, the way a
    // plain `opts.description` passthrough would leave it whenever the agent
    // did not also pass `-desc`.
    const isFailure = verdict.status === 'fail' || verdict.status === 'crash'
    const description = isFailure
      ? opts.description.length > 0
        ? `${opts.description}: ${message}`
        : message
      : opts.description
    const row: Row = {
      commit: candidateCommit,
      score: verdict.score,
      bestBenchDelta,
      pMin,
      status: verdict.status,
      reason: verdict.reason ?? '',
      description,
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

  // --- Load baseline and config. Either failing is a harness/environment
  // problem, not a policy decision about the agent's change (there is no
  // change to have a policy about yet) -- CRASH, not FAIL. Reporting FAIL
  // here would tell an unattended agent "your change was rejected, try
  // another," which for "no baseline exists yet" is actively false and
  // would loop it forever discarding otherwise-good work.
  try {
    baseline = await readBaseline(dir)
  } catch (e) {
    return finish(noVerdict('crash'), [], 'setup', messageOf(e))
  }
  try {
    config = await loadConfig(opts.ctx.configPath)
  } catch (e) {
    return finish(noVerdict('crash'), [], 'setup', messageOf(e))
  }

  // --- Gate 1: scope. Immutable files reject unconditionally, regardless of
  // `config.scope` -- see `checkScope`. A failure to even COMPUTE the
  // changed-file list (git itself failing) is a harness problem, not a
  // scope verdict about the change -- CRASH.
  let changed: string[]
  try {
    changed = await changedFiles(opts.ctx.repoRoot, baseline.frozenCommit)
  } catch (e) {
    return finish(noVerdict('crash'), [], 'scope', `could not compute changed files: ${messageOf(e)}`)
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
    return finish(noVerdict('crash'), [], 'config-integrity', `could not read config: ${messageOf(e)}`)
  }
  if (hashString(configText) !== baseline.configHash) {
    return finish(
      noVerdict('fail'),
      [],
      'config-integrity',
      `${path.basename(opts.ctx.configPath)} has changed since baseline: the run configuration is frozen`,
    )
  }

  // Captured HERE, before gate 3 ever touches the working tree: gate 3's own
  // restore intentionally leaves tracked frozen files differing from HEAD
  // (that is the whole point -- the measured content must be the frozen
  // bytes, not whatever the agent committed), which makes the tree dirty on
  // its own. Checking cleanliness after that would misreport every
  // legitimate restore as an uncommitted-change violation. What gate 8 must
  // police is whether the AGENT's own commit left the tree clean, which is
  // exactly what this snapshot -- taken before any harness mutation -- answers.
  //
  // Deliberately `changedFiles(repoRoot, candidateCommit)` (HEAD), NOT
  // `isClean` (`git status --porcelain`): `isClean` respects whatever
  // `.gitignore` is on disk, including one the agent just wrote --
  // `printf '*\n' > src/lib/.gitignore` hides an uncommitted, IN-SCOPE file
  // from `git status` entirely, so `isClean` would report a clean tree
  // while the working tree still differs from HEAD. That is the exact C1
  // attack (measure an uncommitted edit, credit it to a commit that never
  // contained it) surviving Priority 2's scope-gate fix by hiding from THIS
  // gate instead: the scope gate happily lets an in-scope file through, and
  // a gitignore-trusting clean check never sees it was never committed.
  // `changedFiles` is already immune to this (see its own doc comment) --
  // reusing it here means gate 8 inherits that immunity by construction,
  // not by remembering to reimplement it a second time.
  let treeWasCleanBeforeRestore = true
  try {
    treeWasCleanBeforeRestore = (await changedFiles(opts.ctx.repoRoot, candidateCommit)).length === 0
  } catch (e) {
    return finish(noVerdict('crash'), [], 'worktree-integrity', `could not check working tree cleanliness: ${messageOf(e)}`)
  }

  // --- Gate 3: restore. Frozen files are put back exactly as they were,
  // whether or not the agent's edit to them was "in scope" -- a test file
  // edit is legal to make, but its content is not legal to keep. A failure
  // here (e.g. the frozen snapshot itself is missing or unreadable) is a
  // harness-state problem, not something the agent's change did -- CRASH.
  try {
    const changedByRestore = await restore(opts.ctx.repoRoot, frozenDir, baseline.manifest)
    restoredFiles.push(...changedByRestore)
    if (changedByRestore.length > 0) {
      warnings.push(
        `restored ${changedByRestore.length} frozen file(s) modified since baseline: ${changedByRestore.join(', ')}`,
      )
    }
  } catch (e) {
    return finish(noVerdict('crash'), [], 'restore', `could not restore frozen files: ${messageOf(e)}`)
  }

  // --- Gate 4: unmanifested. A new test/bench/runner-config file absent
  // from the frozen manifest is rejected outright -- this is what closes
  // "add an easier benchmark." A failure to even list the candidate files
  // (a filesystem walk failing) is a harness problem -- CRASH.
  let candidates: string[]
  try {
    candidates = await freezableFiles(opts.ctx.repoRoot)
  } catch (e) {
    return finish(noVerdict('crash'), [], 'unmanifested', `could not list freezable files: ${messageOf(e)}`)
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
  //
  // The candidate is measured from `opts.ctx.repoRoot` -- the live working
  // tree, not a checkout of `candidateCommit` -- so nothing upstream of this
  // gate stops an agent from applying a real optimization and never
  // committing it: the working tree keeps the win, `candidateCommit` (and
  // `measureCommit` after a KEEP) stays wherever HEAD already was, and the
  // same uncommitted edit can be measured and credited indefinitely. Both
  // checks below are FAIL, not CRASH: they describe the agent's own change
  // (or lack of one), not a harness malfunction.
  if (!treeWasCleanBeforeRestore) {
    return finish(
      noVerdict('fail'),
      [],
      'worktree-integrity',
      'the working tree is not clean (uncommitted changes or untracked files): the candidate is ' +
        'measured from this working tree, and crediting an uncommitted edit to a commit that never ' +
        'contained it would let the same edit be measured and kept forever without ever landing. ' +
        'Commit your change, then run eval.',
    )
  }
  if (candidateCommit === baseline.measureCommit) {
    return finish(
      noVerdict('fail'),
      [],
      'worktree-integrity',
      `HEAD (${candidateCommit}) is the same commit already recorded as measureCommit: there is ` +
        'nothing new to evaluate. Commit your change, then run eval.',
    )
  }
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
  //
  // `repointWorktree` checks out the candidate commit's OWN tree into the
  // base worktree -- tampered bench/test content included, since freezing
  // only pins byte content in the manifest and the frozen snapshot, not
  // what a later commit is allowed to contain. Gate 3 already restored
  // `repoRoot`'s WORKING TREE for this experiment's own measurement, but
  // that restoration never touches the commit itself, so without also
  // restoring the worktree here, a candidate commit that both fixes the
  // source AND slows the benchmark body would earn a legitimate KEEP now
  // and then permanently inflate every future baseline measurement -- "add
  // an easier benchmark," routed around gate 4 (which only checks the
  // manifest, not commit content) via the one place gate 3's fix never
  // reaches. Restoring the worktree's frozen files immediately after the
  // repoint closes that gap: both sides always measure the SAME frozen
  // benchmark bytes, regardless of what any given commit holds.
  if (verdict.status === 'keep') {
    try {
      await repointWorktree(worktreeDir, candidateCommit)
      await restore(worktreeDir, frozenDir, baseline.manifest)
      baseline = { ...baseline, measureCommit: candidateCommit }
      await writeBaseline(dir, baseline)
    } catch (e) {
      // A genuine KEEP was already decided -- this is a harness failure
      // advancing the measurement point, not a verdict about the change,
      // so it must not read as FAIL ("your change was rejected"). CRASH is
      // also why this experiment still gets a results.tsv row here, rather
      // than an exception escaping with nothing recorded at all.
      return finish(noVerdict('crash'), deltas, 'advance', messageOf(e))
    }
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

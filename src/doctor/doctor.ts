import { readFile, readdir, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ok as execOk, run } from '../runner/exec.js'
import { stateHome } from '../state/home.js'

/**
 * One diagnostic result. `doctor` never fails a run on any of these -- it
 * only ever reports, so `ok` is advice, not a gate.
 */
export interface Check {
  name: string
  ok: boolean
  detail: string
}

const MIN_NODE_MAJOR = 22
const GIB = 1024 ** 3
const MIN_FREE_GIB = 2
/** 1-minute load average at or above this fraction of core count counts as "busy". */
const BUSY_LOAD_RATIO = 0.8
const PROBE_TIMEOUT_MS = 5_000

/**
 * The shared shape every probe falls back to when its platform-specific
 * mechanism is missing or unreadable: `ok: true` (this is advice, not a
 * failure of the machine) with a detail that says plainly why no real
 * measurement was possible, so the user can tell "checked and fine" apart
 * from "could not check."
 */
function notAvailable(name: string, reason: string): Check {
  return { name, ok: true, detail: `not available on this platform: ${reason}` }
}

// ---------------------------------------------------------------------------
// Node version
// ---------------------------------------------------------------------------

/** Pure so the boundary (21 vs. 22 vs. 23) is testable without spawning Node. */
export function nodeVersionVerdict(version: string): Check {
  const major = Number(version.replace(/^v/, '').split('.')[0])
  const okVal = Number.isFinite(major) && major >= MIN_NODE_MAJOR
  return {
    name: 'node-version',
    ok: okVal,
    detail: okVal
      ? `Node ${version} meets the minimum (>=${MIN_NODE_MAJOR}).`
      : `Node ${version} is below the minimum (>=${MIN_NODE_MAJOR}); upgrade before trusting timing comparisons -- older runtimes differ in JIT and GC behavior in ways that show up as noise between baseline and candidate.`,
  }
}

function checkNodeVersion(): Check {
  return nodeVersionVerdict(process.version)
}

// ---------------------------------------------------------------------------
// Free disk space
// ---------------------------------------------------------------------------

/** Pure threshold logic, so the 2 GB floor is testable without a real tiny filesystem. */
export function diskSpaceVerdict(freeBytes: number, dir: string): Check {
  const freeGb = freeBytes / GIB
  const okVal = freeGb >= MIN_FREE_GIB
  return {
    name: 'disk-space',
    ok: okVal,
    detail: okVal
      ? `${freeGb.toFixed(1)} GB free at ${dir}.`
      : `${freeGb.toFixed(1)} GB free at ${dir}, below the ${MIN_FREE_GIB} GB floor; a worktree plus its own node_modules will not fit comfortably. Free up space before an unattended run.`,
  }
}

/**
 * Exported (and parameterized on `dir`) so a test can point it at a path
 * that certainly does not exist and assert it degrades instead of
 * throwing, per the brief's own suggested test.
 */
export async function checkDiskSpace(dir: string): Promise<Check> {
  try {
    const stats = await statfs(dir)
    return diskSpaceVerdict(stats.bavail * stats.bsize, dir)
  } catch (e) {
    return notAvailable('disk-space', `could not read free space at ${dir}: ${(e as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// On battery
// ---------------------------------------------------------------------------

/**
 * Parses `pmset -g batt` output. Pure and exported so the parsing logic is
 * testable with fixture strings, independent of this machine's actual
 * power state.
 */
export function pmsetBatteryVerdict(stdout: string): Check {
  const onBattery = /Battery Power/.test(stdout)
  return {
    name: 'on-battery',
    ok: !onBattery,
    detail: onBattery
      ? 'Running on battery power; macOS scales CPU frequency down aggressively off AC. Plug in before an unattended measurement run.'
      : 'Running on AC power.',
  }
}

async function checkOnBatteryMac(): Promise<Check> {
  const r = await run('pmset', ['-g', 'batt'], { cwd: os.tmpdir(), timeoutMs: PROBE_TIMEOUT_MS })
  if (!execOk(r)) return notAvailable('on-battery', 'pmset did not run on this machine')
  return pmsetBatteryVerdict(r.stdout)
}

/**
 * Reads the documented Linux sysfs shape: under `dir`, each `BAT<n>`
 * entry has a `status` file containing `Charging`, `Discharging`,
 * `Full`, etc. Exported and parameterized on `dir` so the shape can be
 * exercised with a fixture directory on any platform -- this project's
 * dev machine is macOS, so this has been verified only against a
 * fabricated fixture, never a real Linux kernel.
 */
export async function checkOnBatteryLinux(dir: string): Promise<Check> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (e) {
    return notAvailable('on-battery', `${dir} unreadable: ${(e as Error).message}`)
  }
  const batteries = entries.filter((e) => e.startsWith('BAT'))
  if (batteries.length === 0) {
    return { name: 'on-battery', ok: true, detail: 'No battery present (desktop or VM); nothing to check.' }
  }
  const statuses = await Promise.all(
    batteries.map(async (b) => {
      try {
        return (await readFile(path.join(dir, b, 'status'), 'utf8')).trim()
      } catch {
        return 'unknown'
      }
    }),
  )
  const discharging = statuses.some((s) => s.toLowerCase() === 'discharging')
  return {
    name: 'on-battery',
    ok: !discharging,
    detail: discharging
      ? `On battery (${statuses.join(', ')}); frequency scaling on battery invites noise. Plug in before an unattended measurement run.`
      : `On AC power (${statuses.join(', ')}).`,
  }
}

async function checkOnBattery(): Promise<Check> {
  if (process.platform === 'darwin') return checkOnBatteryMac()
  if (process.platform === 'linux') return checkOnBatteryLinux('/sys/class/power_supply')
  return notAvailable('on-battery', `no battery probe for platform "${process.platform}"`)
}

// ---------------------------------------------------------------------------
// CPU frequency scaling governor (Linux)
// ---------------------------------------------------------------------------

/** Pure so "performance" vs. anything else is testable without a real sysfs file. */
export function cpuGovernorVerdict(governor: string): Check {
  const okVal = governor === 'performance'
  return {
    name: 'cpu-governor',
    ok: okVal,
    detail: okVal
      ? 'cpu0 scaling governor is "performance".'
      : `cpu0 scaling governor is "${governor}", not "performance"; frequency ramps mid-benchmark add noise between rounds. Consider "cpupower frequency-set -g performance" before measuring.`,
  }
}

/**
 * Reads one sysfs file at a caller-supplied path, so both the "missing
 * file" fallback and the parsing of a real value can be tested with a
 * fixture on any platform. This project's dev machine is macOS, so the
 * fixture-based tests are the only verification this has had -- it has
 * never run against a real Linux kernel's cpufreq sysfs tree.
 */
export async function checkCpuGovernorAt(governorPath: string): Promise<Check> {
  try {
    const governor = (await readFile(governorPath, 'utf8')).trim()
    return cpuGovernorVerdict(governor)
  } catch (e) {
    return notAvailable('cpu-governor', `scaling_governor unreadable: ${(e as Error).message}`)
  }
}

async function checkCpuGovernor(): Promise<Check> {
  if (process.platform !== 'linux') {
    return notAvailable('cpu-governor', `scaling_governor is Linux-only (platform "${process.platform}")`)
  }
  return checkCpuGovernorAt('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor')
}

// ---------------------------------------------------------------------------
// Thermal / chip-family risk -- informational only, never a pass/fail
// ---------------------------------------------------------------------------

/**
 * There is no portable, reliable API to read "currently throttled" --
 * macOS's own `pmset -g therm` reports nothing useful on Apple Silicon
 * (confirmed empirically on this machine: "No thermal warning level has
 * been recorded" even under load), which is exactly the kind of probe
 * that always returns "ok" for lack of a real measurement the brief warns
 * against shipping. Instead this reports the chip and, on Apple Silicon,
 * the one thing that is both true and actionable: heterogeneous P/E cores
 * make single-run timings noisy regardless of thermal state. Always
 * `ok: true` -- explicitly informational, not a verdict.
 */
function checkThermalRisk(): Check {
  const cpus = os.cpus()
  const model = cpus[0]?.model.trim() ?? 'unknown CPU'
  const isAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64'
  const detail = isAppleSilicon
    ? `${model}, ${cpus.length} logical cores. Apple Silicon's P/E-core scheduler can place the same benchmark on a fast performance core in one run and a slow efficiency core in the next, adding variance unrelated to any code change -- expect to need more rounds than on a uniform-core machine. Informational only, not a pass/fail check.`
    : `${model}, ${cpus.length} logical cores. Sustained back-to-back runs can trigger thermal throttling on any laptop chip; watch for timings drifting worse over a long session. Informational only, not a pass/fail check.`
  return { name: 'thermal-risk', ok: true, detail }
}

// ---------------------------------------------------------------------------
// Load average relative to core count
// ---------------------------------------------------------------------------

/**
 * Pure so the core-count-relative comparison is testable directly: a raw
 * load of 4 means opposite things on a 4-core and a 64-core machine, so
 * the check is expressed as a fraction of capacity, not a bare number.
 */
export function loadAverageVerdict(load1: number, cores: number): Check {
  const ratio = load1 / cores
  const pct = (ratio * 100).toFixed(0)
  const okVal = ratio < BUSY_LOAD_RATIO
  return {
    name: 'load-average',
    ok: okVal,
    detail: okVal
      ? `1-minute load average ${load1.toFixed(2)} across ${cores} core(s) (~${pct}% of capacity).`
      : `1-minute load average ${load1.toFixed(2)} across ${cores} core(s) (~${pct}% of capacity) -- this machine is already busy. A competing process is exactly what turns a no-op change into a false KEEP or DISCARD; consider waiting or closing other work.`,
  }
}

function checkLoadAverage(): Check {
  if (process.platform === 'win32') {
    // Node documents os.loadavg() as always [0, 0, 0] on Windows.
    return notAvailable('load-average', 'Windows does not report a load average (Node always returns 0)')
  }
  const [load1] = os.loadavg()
  const cores = os.cpus().length || 1
  return loadAverageVerdict(load1 ?? 0, cores)
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

type Probe = () => Check | Promise<Check>

/**
 * Wraps every probe individually so a bug in one check's own logic (not
 * just a missing file the probe already anticipates) still cannot take
 * down `runChecks` as a whole. Each probe already degrades known failure
 * modes to `notAvailable`; this is the outer safety net for the unknown
 * ones, which is why `runChecks` can promise it never throws.
 */
async function safe(name: string, probe: Probe): Promise<Check> {
  try {
    return await probe()
  } catch (e) {
    return notAvailable(name, `probe threw unexpectedly: ${(e as Error).message}`)
  }
}

/**
 * Runs every diagnostic. Total by construction: each probe already
 * degrades a missing file or absent command to `ok: true`, and `safe`
 * catches anything that still escapes. Never rejects, on any platform.
 */
export async function runChecks(): Promise<Check[]> {
  return Promise.all([
    safe('node-version', () => checkNodeVersion()),
    safe('disk-space', () => checkDiskSpace(stateHome())),
    safe('on-battery', () => checkOnBattery()),
    safe('cpu-governor', () => checkCpuGovernor()),
    safe('thermal-risk', () => checkThermalRisk()),
    safe('load-average', () => checkLoadAverage()),
  ])
}

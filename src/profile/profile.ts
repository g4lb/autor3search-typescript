/**
 * Runs one benchmark under Node's built-in `--cpu-prof` sampling profiler
 * and turns the resulting `.cpuprofile` document into an aggregated,
 * sorted list of hot functions.
 *
 * This exists so the optimizing agent works from real profiler data instead
 * of guessing at hot spots from reading source -- a profiler that only ever
 * reports Node internals gives it nothing to act on.
 */
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { runChild } from '../benchrun/invoke.js'

export interface HotFrame {
  functionName: string
  url: string
  lineNumber: number
  /** Sum of the microsecond timeDeltas attributed to this function+url, across every sample. */
  selfTimeUs: number
}

interface CpuProfileNode {
  id: number
  callFrame: {
    functionName: string
    url: string
    lineNumber: number
  }
}

interface CpuProfileDoc {
  nodes: CpuProfileNode[]
  /** Node ids, one per sample. */
  samples: number[]
  /**
   * Microseconds, index-parallel to `samples`: `timeDeltas[i]` is the self
   * time attributed to `samples[i]`.
   */
  timeDeltas: number[]
}

/** True for a frame this report should never surface: it is not the user's own code. */
function isNodeInternal(url: string): boolean {
  return url === '' || url.startsWith('node:')
}

/**
 * Aggregates a raw `.cpuprofile` JSON document into self time per
 * `functionName` + `url`, dropping Node-internal and anonymous-root frames,
 * sorted with the hottest function first.
 *
 * Self time per node id is the sum of `timeDeltas[i]` for every index `i`
 * where `samples[i]` is that node -- `samples` and `timeDeltas` are parallel
 * arrays, not independent ones. A profile that samples nothing but Node
 * internals (a benchmark too fast to catch any user code in a sample) is a
 * real input, not a bug: this returns an empty array rather than throwing,
 * so a caller can tell "genuinely nothing to report" from a parse failure.
 */
export function parseCpuProfile(text: string): HotFrame[] {
  const doc = JSON.parse(text) as CpuProfileDoc
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]))

  const selfUsByNodeId = new Map<number, number>()
  for (let i = 0; i < doc.samples.length; i++) {
    const nodeId = doc.samples[i]
    const delta = doc.timeDeltas[i]
    if (nodeId === undefined || delta === undefined) continue
    selfUsByNodeId.set(nodeId, (selfUsByNodeId.get(nodeId) ?? 0) + delta)
  }

  const byKey = new Map<string, HotFrame>()
  for (const [nodeId, selfTimeUs] of selfUsByNodeId) {
    const node = nodeById.get(nodeId)
    if (!node) continue
    const { functionName, url, lineNumber } = node.callFrame
    if (isNodeInternal(url)) continue
    // A "|" separator is enough here: functionName and url both come from
    // source code the profiler itself observed, and even a collision would
    // only ever merge two frames' self times together (never crash or
    // misattribute to a third, unrelated frame) -- an acceptable, extremely
    // unlikely edge case for a reporting tool, not a security boundary.
    const key = functionName + '|' + url
    const existing = byKey.get(key)
    if (existing) {
      existing.selfTimeUs += selfTimeUs
    } else {
      byKey.set(key, { functionName, url, lineNumber, selfTimeUs })
    }
  }

  return [...byKey.values()].sort((a, b) => b.selfTimeUs - a.selfTimeUs)
}

export interface ProfileOneOptions {
  /** The worktree/repo to measure in -- sets module resolution and tsconfig context. */
  cwd: string
  benchFileAbs: string
  fn: string
  id: string
  benchtimeMs: number
  warmupMs: number
  timeoutMs: number
  nodeArgs: string[]
  /** Directory the `.cpuprofile` file is written into; created if missing. */
  profileDir: string
  log?: ((s: string) => void) | undefined
}

export interface ProfileResult {
  id: string
  /** Absolute path to the written `.cpuprofile` file. */
  profilePath: string
  /** Aggregated, sorted (hottest first) user-code hot frames. */
  hotFrames: HotFrame[]
  /** Sum of every kept hot frame's self time -- the denominator for percentages. */
  totalSelfUs: number
}

/** Turns a benchmark id into a filesystem-safe `.cpuprofile` basename. */
function profileFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_') + '.cpuprofile'
}

/**
 * Profiles one benchmark once, by spawning the same measurement child
 * `runChild` uses elsewhere, with `--cpu-prof` added to its node args.
 *
 * Never requires a baseline: this only ever spawns a fresh child in `cwd`
 * and reads back what Node's own profiler wrote, so it works before a run
 * has ever started -- it is reconnaissance for deciding whether the
 * benchmarks even point at the right code.
 */
export async function profileBenchmark(o: ProfileOneOptions): Promise<ProfileResult> {
  await mkdir(o.profileDir, { recursive: true })
  const name = profileFileName(o.id)
  const profilePath = path.join(o.profileDir, name)
  // Remove any stale file at this exact path first, so a previous run's
  // leftover (e.g. this benchmark crashing before writing one) is never
  // mistaken for the profile this call is about to produce.
  await rm(profilePath, { force: true })

  const nodeArgs = [...o.nodeArgs, '--cpu-prof', '--cpu-prof-dir', o.profileDir, '--cpu-prof-name', name]

  const result = await runChild({
    cwd: o.cwd,
    benchFileAbs: o.benchFileAbs,
    fn: o.fn,
    id: o.id,
    benchtimeMs: o.benchtimeMs,
    warmupMs: o.warmupMs,
    timeoutMs: o.timeoutMs,
    nodeArgs,
    ...(o.log ? { log: o.log } : {}),
  })

  if (!result.ok) {
    throw new Error(`profiling ${o.id} failed: ${result.error}`)
  }

  const text = await readFile(profilePath, 'utf8')
  const hotFrames = parseCpuProfile(text)
  const totalSelfUs = hotFrames.reduce((sum, f) => sum + f.selfTimeUs, 0)

  return { id: o.id, profilePath, hotFrames, totalSelfUs }
}

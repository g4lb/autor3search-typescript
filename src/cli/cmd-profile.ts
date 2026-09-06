import path from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig, parseDuration } from '../config/load.js'
import { CONFIG_PATH } from '../config/schema.js'
import { discoverBenchmarks, type Benchmark } from '../discover/benchmarks.js'
import { profileBenchmark, type HotFrame } from '../profile/profile.js'
import type { RunCtx } from './runctx.js'

/** How many hot functions to print per benchmark. */
const TOP_N = 15

/**
 * Repo-relative directory `.cpuprofile` files are written under. Alongside
 * `config.yaml`, not in the (baseline-only) state home: `profile` must work
 * without a baseline ever existing, and the output is meant for a human to
 * open locally, not for the harness's own cross-run state.
 */
const PROFILE_DIRNAME = path.join('.autoresearch', 'profiles')

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`)
  return 2
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Declared benchmark ids that are not among the discovered benchmarks. Mirrors cmd-baseline.ts. */
function missingDeclared(declared: readonly string[], discovered: readonly Benchmark[]): string[] {
  const found = new Set(discovered.map((b) => b.id))
  return declared.filter((id) => !found.has(id))
}

function printHotFrames(frames: readonly HotFrame[], totalSelfUs: number): void {
  if (frames.length === 0) {
    process.stdout.write(
      '    no user-code samples were captured (every sampled frame was Node internals) -- this ' +
        'benchmark may be too fast to profile meaningfully; try a longer -benchtime.\n',
    )
    return
  }
  for (const f of frames.slice(0, TOP_N)) {
    const pct = totalSelfUs > 0 ? (f.selfTimeUs / totalSelfUs) * 100 : 0
    const name = f.functionName.length > 0 ? f.functionName : '(anonymous)'
    process.stdout.write(`    ${pct.toFixed(1).padStart(5)}%  ${name}  ${f.url}:${f.lineNumber}\n`)
  }
}

/**
 * `profile`: runs the declared benchmarks under Node's built-in `--cpu-prof`
 * sampling profiler and prints where time actually goes.
 *
 * Deliberately does not touch `baseline` or the state home at all: this is
 * reconnaissance a human runs BEFORE starting the loop, to decide whether
 * the benchmarks even point at the right code, so it must work with only
 * `.autoresearch/config.yaml` in place.
 */
export async function cmdProfile(ctx: RunCtx, argv: readonly string[]): Promise<number> {
  let benchtimeOverride: string | undefined
  try {
    const normalized = argv.map((a) => (/^-[A-Za-z][A-Za-z-]+$/.test(a) ? `-${a}` : a))
    const { values } = parseArgs({
      args: normalized,
      options: { benchtime: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    })
    benchtimeOverride = values.benchtime
  } catch (e) {
    return fail(messageOf(e))
  }

  let config: Awaited<ReturnType<typeof loadConfig>>
  try {
    config = await loadConfig(ctx.configPath)
  } catch (e) {
    return fail(messageOf(e))
  }

  let discovered: Benchmark[]
  try {
    discovered = await discoverBenchmarks(ctx.repoRoot)
  } catch (e) {
    return fail(`could not discover benchmarks: ${messageOf(e)}`)
  }

  let benchmarks: Benchmark[]
  const declared = config.benchmarks
  if (declared.length > 0) {
    const missing = missingDeclared(declared, discovered)
    if (missing.length > 0) {
      return fail(
        `config declares benchmark(s) that no longer exist: ${missing.join(', ')}. Update ` +
          `${CONFIG_PATH} or restore the missing benchmark(s).`,
      )
    }
    const byId = new Map(discovered.map((b) => [b.id, b]))
    benchmarks = declared.map((id) => byId.get(id)!)
  } else {
    benchmarks = discovered
  }

  if (benchmarks.length === 0) {
    return fail('no benchmarks found: there is nothing to profile')
  }

  let benchtimeMs: number
  let warmupMs: number
  let timeoutMs: number
  try {
    benchtimeMs = parseDuration(benchtimeOverride ?? config.benchtime)
    warmupMs = parseDuration(config.warmup)
    timeoutMs = parseDuration(config.timeout)
  } catch (e) {
    return fail(messageOf(e))
  }

  const profileDir = path.join(ctx.repoRoot, PROFILE_DIRNAME)

  process.stdout.write('autoresearch-typescript profile -- where does the time actually go?\n\n')

  let failures = 0
  for (const b of benchmarks) {
    process.stdout.write(`${b.id}\n`)
    try {
      const result = await profileBenchmark({
        cwd: ctx.repoRoot,
        benchFileAbs: path.join(ctx.repoRoot, b.file),
        fn: b.fn,
        id: b.id,
        benchtimeMs,
        warmupMs,
        timeoutMs,
        nodeArgs: config.nodeArgs,
        profileDir,
      })
      printHotFrames(result.hotFrames, result.totalSelfUs)
      process.stdout.write(`    profile written to ${result.profilePath}\n`)
      process.stdout.write(
        '    open it in Chrome DevTools (chrome://inspect -> Open dedicated DevTools for Node -> ' +
          'Profiler tab -> Load) or drag it into https://www.speedscope.app/\n',
      )
    } catch (e) {
      failures++
      process.stderr.write(`  error: ${messageOf(e)}\n`)
    }
    process.stdout.write('\n')
  }

  if (failures > 0) {
    process.stderr.write(`${failures} of ${benchmarks.length} benchmark(s) could not be profiled\n`)
    return 2
  }
  return 0
}

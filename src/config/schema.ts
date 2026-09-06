/** The config location, relative to the repository root. */
export const CONFIG_PATH = '.autoresearch/config.yaml'

/** Lockfiles we recognise, in package-manager detection order. */
export const LOCKFILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
] as const

/**
 * Files the agent may never modify, regardless of `scope`.
 *
 * A dependency change is a human decision, not an autonomous one, and a
 * tsconfig change alters what is being measured rather than how fast it runs.
 * Both would invalidate the comparison rather than win it.
 */
export const IMMUTABLE_FILES: readonly string[] = [
  'package.json',
  'tsconfig.json',
  ...LOCKFILES,
]

/** The smallest `count` at which the exact rank test can ever reach ALPHA. */
export const MIN_COUNT = 4

export interface Config {
  /** Declared benchmark ids ("<file>:<function>"). Empty means all discovered. */
  benchmarks: string[]
  /** Glob patterns the agent may modify. */
  scope: string[]
  /** Measured rounds per side. */
  count: number
  /** Measured window per benchmark per round. */
  benchtime: string
  /** Discarded window before each measurement. */
  warmup: string
  /** Largest tolerated significant regression, percent. */
  maxRegressPct: number
  /** Smallest geomean improvement a KEEP will accept, percent. */
  minEffectPct: number
  /** Bounds each subprocess phase. */
  timeout: string
  /** Typecheck gate command. Empty means skip (e.g. no tsconfig.json at init time). */
  typecheckCommand: string
  /** Optional build gate command. Empty means skip. */
  buildCommand: string
  /** Correctness gate command. */
  testCommand: string
  /** Extra flags for the benchmark child process, e.g. ["--expose-gc"]. */
  nodeArgs: string[]
  /** Test/bench files deliberately exempted from freezing. */
  unfreeze: string[]
}

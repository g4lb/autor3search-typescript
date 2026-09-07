import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { type Config, MIN_COUNT } from './schema.js'

/** yaml key -> Config field. The single source of truth for both directions. */
const KEYS: Record<string, keyof Config> = {
  benchmarks: 'benchmarks',
  scope: 'scope',
  count: 'count',
  benchtime: 'benchtime',
  warmup: 'warmup',
  max_regress_pct: 'maxRegressPct',
  min_effect_pct: 'minEffectPct',
  timeout: 'timeout',
  typecheck_command: 'typecheckCommand',
  build_command: 'buildCommand',
  test_command: 'testCommand',
  node_args: 'nodeArgs',
  unfreeze: 'unfreeze',
}

export function defaultConfig(): Config {
  return {
    benchmarks: [],
    scope: ['src/**'],
    count: 10,
    benchtime: '500ms',
    warmup: '100ms',
    maxRegressPct: 5,
    minEffectPct: 1,
    timeout: '15m',
    typecheckCommand: 'npx tsc --noEmit',
    buildCommand: '',
    testCommand: 'npm test',
    nodeArgs: [],
    unfreeze: [],
  }
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/

/** Parses a duration into milliseconds. A bare number is refused as ambiguous. */
export function parseDuration(s: string): number {
  const m = DURATION.exec(String(s).trim())
  if (!m) {
    throw new Error(
      `invalid duration ${JSON.stringify(s)}: use a number with a unit, e.g. 500ms, 2s, 15m`,
    )
  }
  const n = Number(m[1])
  const unit = m[2]!
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
  return n * mult
}

/** A short, friendly noun phrase describing the runtime type of `v`, for error messages. */
function describeType(v: unknown): string {
  if (Array.isArray(v)) return 'an array'
  if (v === null) return 'null'
  const t = typeof v
  return t === 'object' ? 'an object' : `a ${t}`
}

function requireString(v: unknown, yamlKey: string): string {
  if (typeof v !== 'string') {
    throw new Error(`${yamlKey} must be a string, got ${describeType(v)}`)
  }
  return v
}

function requireNumber(v: unknown, yamlKey: string): number {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new Error(`${yamlKey} must be a number, got ${describeType(v)}`)
  }
  return v
}

function requireStringArray(v: unknown, yamlKey: string): string[] {
  if (!Array.isArray(v)) {
    throw new Error(`${yamlKey} must be an array of strings, got ${describeType(v)}`)
  }
  // Deferred item 8: reporting `describeType(v)` for an array with a bad
  // element said "must be an array of strings, got an array", which names
  // the one thing the author already got right. Point at the element.
  const badIndex = v.findIndex((x) => typeof x !== 'string')
  if (badIndex !== -1) {
    throw new Error(
      `${yamlKey} must be an array of strings, but item ${badIndex} is ${describeType(v[badIndex])}`,
    )
  }
  return v as string[]
}

/** Parses a duration field, prefixing the error with the offending yaml key. */
function requireDuration(v: string, yamlKey: string): void {
  try {
    parseDuration(v)
  } catch (e) {
    throw new Error(`${yamlKey}: ${(e as Error).message}`)
  }
}

function validate(c: Config): void {
  // Type checks first: a wrong-typed value (e.g. count: "ten", or scope given
  // as a bare string instead of an array) must be refused with a clear
  // explanation rather than silently accepted by a numeric comparison that
  // coerces it, or crashing later with an unrelated TypeError.
  requireStringArray(c.benchmarks, 'benchmarks')
  requireStringArray(c.scope, 'scope')
  requireNumber(c.count, 'count')
  requireString(c.benchtime, 'benchtime')
  requireString(c.warmup, 'warmup')
  requireNumber(c.maxRegressPct, 'max_regress_pct')
  requireNumber(c.minEffectPct, 'min_effect_pct')
  requireString(c.timeout, 'timeout')
  requireString(c.typecheckCommand, 'typecheck_command')
  requireString(c.buildCommand, 'build_command')
  requireString(c.testCommand, 'test_command')
  requireStringArray(c.nodeArgs, 'node_args')
  requireStringArray(c.unfreeze, 'unfreeze')

  if (c.count < MIN_COUNT) {
    throw new Error(
      `count must be at least ${MIN_COUNT}: the significance test cannot report p < 0.05 with ` +
        `fewer than ${MIN_COUNT} measured rounds per side no matter how large the improvement is, ` +
        `so every experiment would be discarded regardless of what changed (the default is 10)`,
    )
  }
  if (c.maxRegressPct < 0) throw new Error('max_regress_pct must not be negative')
  if (c.minEffectPct < 0) throw new Error('min_effect_pct must be at least 0')
  if (c.minEffectPct >= 100) throw new Error('min_effect_pct must be less than 100')
  if (c.scope.length === 0) throw new Error('scope must list at least one path pattern')
  for (const s of c.scope) {
    if (s.trim() === '') throw new Error('scope must not contain an empty or whitespace-only entry')
  }
  // Throws on anything unparseable, naming the offending key.
  requireDuration(c.benchtime, 'benchtime')
  requireDuration(c.warmup, 'warmup')
  requireDuration(c.timeout, 'timeout')
  if (c.testCommand.trim() === '') throw new Error('test_command must not be empty')
  // typecheck_command, unlike test_command, may legitimately be empty: a
  // repository with no tsconfig.json has nothing for `tsc --noEmit` to check
  // against, and `cmd-init` writes an empty typecheck_command plus a printed
  // warning for exactly that case (see task 16 / Ruling 25). The eval gate
  // chain (task 19) already treats an empty typecheck_command as "skip this
  // gate," mirroring build_command's existing empty-means-skip semantics
  // above -- so rejecting empty here would make a config that `init` itself
  // legitimately writes fail to load, surfacing only at the user's first
  // `eval`, long after `init` reported success.
}

export function parseConfig(text: string): Config {
  const raw: unknown = parseYaml(text) ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('config must be a YAML mapping')
  }
  const c = defaultConfig()
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const field = KEYS[k]
    if (!field) {
      throw new Error(
        `unknown config key ${JSON.stringify(k)}: a typo here would silently leave the ` +
          `default in force, so it is refused rather than ignored`,
      )
    }
    // The cast is safe: validate() below rejects anything of the wrong shape
    // once the value is in place. It goes through `unknown` first because
    // `Config` has no index signature for TS to widen from directly.
    ;(c as unknown as Record<string, unknown>)[field] = v
  }
  validate(c)
  return c
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    throw new Error(`read ${path}: ${(e as Error).message}`)
  }
  try {
    return parseConfig(text)
  } catch (e) {
    throw new Error(`invalid ${path}: ${(e as Error).message}`)
  }
}

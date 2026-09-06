import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { type Config, CONFIG_PATH } from '../config/schema.js'
import { defaultConfig, loadConfig } from '../config/load.js'
import { classify, walkRepo } from '../discover/files.js'
import { discoverBenchmarks } from '../discover/benchmarks.js'
import { currentBranch } from '../gitx/git.js'
import { detect, type PackageManager } from '../pm/detect.js'
import type { RunCtx } from './runctx.js'

const GITIGNORE_ENTRIES = ['.autoresearch/', 'results.tsv', 'run.log', '*.cpuprofile']

/** The `templates/` directory shipped alongside this package. */
export function templatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '../../templates')
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * The command that runs `tsc` through each package manager's own "run a
 * locally-installed binary" mechanism. `npx tsc` alone would silently
 * offer to fetch `typescript` from the registry on a repo that doesn't
 * have it installed yet, which is a materially different (networked,
 * slow, and non-reproducible) behaviour from every other gate.
 */
function typecheckRunner(pm: PackageManager): string {
  switch (pm) {
    case 'npm':
      return 'npx'
    case 'pnpm':
      return 'pnpm exec'
    case 'yarn':
      return 'yarn exec'
    case 'bun':
      return 'bunx'
  }
}

/**
 * `['src/**']` when a `src/` directory exists (the overwhelmingly common
 * case); otherwise the top-level directories that contain at least one
 * file `classify` calls ordinary source -- so a repository laid out as
 * `lib/`, `pkg/`, etc. still gets a scope that actually covers its code,
 * rather than the `src/**` default that would match nothing in it.
 */
async function deriveScope(root: string): Promise<string[]> {
  if (await exists(path.join(root, 'src'))) return ['src/**']

  const files = await walkRepo(root)
  const topDirs = new Set<string>()
  const topLevelSourceFiles = new Set<string>()
  for (const f of files) {
    if (classify(f) !== 'source') continue
    const slash = f.indexOf('/')
    if (slash === -1) {
      topLevelSourceFiles.add(f)
    } else {
      topDirs.add(f.slice(0, slash))
    }
  }
  if (topDirs.size > 0) {
    return [...topDirs].sort().map((d) => `${d}/**`)
  }
  // No subdirectory holds source at all -- fall back to naming the
  // top-level source files themselves, so scope is never empty (which
  // `loadConfig` refuses outright) for a repository that keeps its code
  // directly at the root.
  return [...topLevelSourceFiles].sort()
}

interface PackageScripts {
  test?: string
  build?: string
}

async function readPackageScripts(root: string): Promise<PackageScripts> {
  const text = await readFile(path.join(root, 'package.json'), 'utf8')
  const pkg = JSON.parse(text) as { scripts?: Record<string, string> }
  return pkg.scripts ?? {}
}

/** One "yaml key / comment / rendered value" row of the generated config. */
interface ConfigField {
  key: string
  comment: string[]
  value: string
}

function yamlString(s: string): string {
  return JSON.stringify(s)
}

function yamlStringArray(a: readonly string[]): string {
  return `[${a.map(yamlString).join(', ')}]`
}

/**
 * Renders the generated config as YAML, one comment explaining each key
 * above the key itself. Hand-rolled rather than a generic YAML
 * stringifier: `yaml`'s writer has no notion of a per-key doc comment, and
 * the whole point of this file is that a human reads it before committing.
 */
function renderConfigYaml(cfg: Config): string {
  const fields: ConfigField[] = [
    {
      key: 'benchmarks',
      comment: [
        'Benchmark ids ("<file>:<function>") to measure.',
        'Empty means "everything discoverBenchmarks finds" -- the default, so a new',
        'benchmark file is picked up automatically without editing this file.',
      ],
      value: yamlStringArray(cfg.benchmarks),
    },
    {
      key: 'scope',
      comment: [
        'Glob patterns of files the agent may modify. package.json, tsconfig.json',
        'and any lockfile are always off-limits, regardless of scope.',
      ],
      value: yamlStringArray(cfg.scope),
    },
    {
      key: 'count',
      comment: [
        'Measured rounds per side (baseline vs. candidate). Below 4 no result can',
        'ever reach significance, whatever the effect size.',
      ],
      value: String(cfg.count),
    },
    { key: 'benchtime', comment: ['Measured window per benchmark per round.'], value: yamlString(cfg.benchtime) },
    {
      key: 'warmup',
      comment: ['Discarded warmup window before each measurement.'],
      value: yamlString(cfg.warmup),
    },
    {
      key: 'max_regress_pct',
      comment: [
        'Largest tolerated regression on any one benchmark, percent. A significant',
        'regression past this discards the experiment regardless of overall gain.',
      ],
      value: String(cfg.maxRegressPct),
    },
    {
      key: 'min_effect_pct',
      comment: [
        'Smallest geomean improvement, percent, that a KEEP will accept -- guards',
        'against keeping a change that is "significant" only because of sample size.',
      ],
      value: String(cfg.minEffectPct),
    },
    {
      key: 'timeout',
      comment: ['Upper bound on each subprocess phase (build, test, typecheck, one measurement round).'],
      value: yamlString(cfg.timeout),
    },
    {
      key: 'typecheck_command',
      comment: [
        'Typecheck gate, run before every measurement. Empty disables the gate --',
        'see the warning init printed if this repository has no tsconfig.json.',
      ],
      value: yamlString(cfg.typecheckCommand),
    },
    {
      key: 'build_command',
      comment: ['Optional build gate, run before tests. Empty means skip.'],
      value: yamlString(cfg.buildCommand),
    },
    {
      key: 'test_command',
      comment: [
        "Correctness gate: the repository's own test command. An experiment that",
        'breaks this FAILs before anything is measured.',
      ],
      value: yamlString(cfg.testCommand),
    },
    {
      key: 'node_args',
      comment: ['Extra flags passed to the measurement child process, e.g. ["--expose-gc"].'],
      value: yamlStringArray(cfg.nodeArgs),
    },
    {
      key: 'unfreeze',
      comment: [
        'Test/bench files deliberately exempted from the freeze -- edit these at your',
        'own risk, since they define what "correct" and "measured" mean.',
      ],
      value: yamlStringArray(cfg.unfreeze),
    },
  ]

  return (
    fields
      .map((f) => `${f.comment.map((c) => `# ${c}`).join('\n')}\n${f.key}: ${f.value}\n`)
      .join('\n')
  )
}

function renderProgramMd(template: string, benchmarkIds: readonly string[], runTag: string): string {
  const list = benchmarkIds.map((id) => `- \`${id}\``).join('\n')
  return template.replace('{{BENCHMARKS}}', list).replace(/\{\{RUN_TAG\}\}/g, runTag)
}

async function ensureGitignore(root: string): Promise<void> {
  const gitignorePath = path.join(root, '.gitignore')
  let text = ''
  try {
    text = await readFile(gitignorePath, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const existingLines = new Set(text.split('\n').map((l) => l.trim()))
  const missing = GITIGNORE_ENTRIES.filter((e) => !existingLines.has(e))
  if (missing.length === 0) return
  const prefix = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  await appendFile(gitignorePath, `${prefix}${missing.join('\n')}\n`, 'utf8')
}

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`)
  return 2
}

/**
 * `init`: writes `.autoresearch/config.yaml`, `program.md` and appends the
 * harness's own output paths to `.gitignore`.
 *
 * Every refusal below happens before anything is written -- a command that
 * exits non-zero after writing half its output would be worse than one
 * that fails cleanly, since a human re-running `init` would then be
 * "fixing" a partially-initialised repository rather than starting clean.
 * `init` never commits: `baseline` is what refuses a dirty tree, and that
 * refusal is what forces a human to review what `init` produced before it
 * becomes part of the run's frozen state.
 */
export async function cmdInit(ctx: RunCtx, argv: readonly string[]): Promise<number> {
  let force: boolean
  try {
    const normalized = argv.map((a) => (/^-[A-Za-z][A-Za-z-]+$/.test(a) ? `-${a}` : a))
    const { values } = parseArgs({
      args: normalized,
      options: { force: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: false,
    })
    force = values.force === true
  } catch (e) {
    return fail((e as Error).message)
  }

  try {
    // 1. detect the package manager -- surfaces workspace/lockfile refusals
    // before anything else runs, let alone is written.
    const detected = await detect(ctx.repoRoot)

    // 2. discover benchmarks. Nothing is written past this point unless at
    // least one exists: a tool whose whole purpose is measuring benchmarks
    // has nothing to do, and no config or program.md to hand an agent, if
    // there are none.
    const benchmarks = await discoverBenchmarks(ctx.repoRoot)
    if (benchmarks.length === 0) {
      return fail(
        'no benchmarks found: looked for exported `bench*` functions in `*.bench.ts` files ' +
          'and found none. Without at least one benchmark this tool has nothing to measure ' +
          'and nothing to optimize -- add a benchmark (e.g. src/foo.bench.ts exporting ' +
          '`benchFoo()`) and run init again.',
      )
    }

    // 3. refuse to clobber an existing config without -force.
    if ((await exists(ctx.configPath)) && !force) {
      return fail(`${CONFIG_PATH} already exists; pass -force to overwrite it`)
    }

    // 4. derive scope.
    const scope = await deriveScope(ctx.repoRoot)

    // 5. derive commands from package.json scripts, using the DETECTED
    // package manager -- never hardcoding npm, which resolves differently
    // (or not at all) against a pnpm or yarn lockfile.
    const scripts = await readPackageScripts(ctx.repoRoot)
    if (!scripts.test) {
      return fail(
        'package.json has no "test" script: the correctness gate has nothing to run before ' +
          'a change is measured. Add a "test" script and run init again.',
      )
    }
    const testCommand = `${detected.pm} test`
    const buildCommand = scripts.build ? `${detected.pm} run build` : ''
    const hasTsconfig = await exists(path.join(ctx.repoRoot, 'tsconfig.json'))
    const typecheckCommand = hasTsconfig ? `${typecheckRunner(detected.pm)} tsc --noEmit` : ''
    if (!hasTsconfig) {
      process.stderr.write(
        'warning: no tsconfig.json found; the typecheck gate is disabled for this run\n',
      )
    }

    const cfg: Config = { ...defaultConfig(), scope, testCommand, buildCommand, typecheckCommand }

    // 6. write .autoresearch/config.yaml.
    await mkdir(path.dirname(ctx.configPath), { recursive: true })
    await writeFile(ctx.configPath, renderConfigYaml(cfg), 'utf8')

    // 7. copy templates/program.md, substituting the benchmark list and tag.
    const template = await readFile(path.join(templatesDir(), 'program.md'), 'utf8')
    let runTag = 'this-branch'
    try {
      runTag = await currentBranch(ctx.repoRoot)
    } catch {
      // Detached HEAD or some other reason `git rev-parse --abbrev-ref HEAD`
      // fails -- the placeholder text above is still a readable fallback.
    }
    const programMd = renderProgramMd(template, benchmarks.map((b) => b.id), runTag)
    await writeFile(path.join(ctx.repoRoot, 'program.md'), programMd, 'utf8')

    // 8. append gitignore entries.
    await ensureGitignore(ctx.repoRoot)

    // Round-trip guard: a config init itself cannot load back is a bug that
    // would otherwise only surface at the user's first eval.
    await loadConfig(ctx.configPath)

    // 9. report what happened and what to do next.
    process.stdout.write('discovered benchmarks:\n')
    for (const b of benchmarks) process.stdout.write(`  - ${b.id}\n`)
    process.stdout.write(
      '\nwrote .autoresearch/config.yaml and program.md. Review both, then:\n' +
        // .autoresearch/ is gitignored on purpose (it is local, machine-specific
        // harness state, not part of the repository's history) -- only
        // program.md and .gitignore are ever meant to be committed here.
        '  1. git add program.md .gitignore && git commit\n' +
        '  2. autoresearch-typescript baseline\n' +
        '  3. hand this repository and program.md to your coding agent\n',
    )
    return 0
  } catch (e) {
    return fail((e as Error).message)
  }
}

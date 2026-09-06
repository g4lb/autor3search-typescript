import { parseArgs } from 'node:util'
import { currentBranch, headCommit, shortSha } from '../gitx/git.js'
import { readBaseline } from '../state/baseline.js'
import { runDir } from '../state/home.js'
import { readEvalLock } from '../state/lock.js'
import { clearStop, requestStop } from '../state/stop.js'
import type { RunCtx } from './runctx.js'

/**
 * Duplicated from cmd-baseline.ts rather than imported -- see the identical
 * note in cmd-eval.ts. Must match the prefix baseline uses when it creates
 * the run branch, or `-tag` inference from the current branch silently
 * stops working.
 */
const BRANCH_PREFIX = 'autoresearch-typescript/'

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`)
  return 2
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * `-tag`'s default: the tag encoded in the current run branch's name.
 * Duplicated from cmd-eval.ts -- see its doc comment for why.
 */
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

/**
 * Signals a process group, refusing to signal pid 1's group.
 *
 * Mirrors `runner/exec.ts`'s private `killGroup` (not exported, so it
 * cannot be reused directly): on Linux a process whose group leader has
 * exited can report ppid 1, and `kill(-1, ...)` means "every process the
 * user may signal" -- which in a container is everything. Any change to
 * that refusal must be mirrored here.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1) return
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone; fall back to the single process.
    try {
      process.kill(pid, signal)
    } catch {
      /* already dead */
    }
  }
}

async function tryGit<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f()
  } catch {
    return null
  }
}

/**
 * `stop`: asks a running (or about-to-run) `eval` loop to end.
 *
 * Plain `stop` only ever writes `stop.json` -- the agent reads it at its
 * next verdict, so the in-flight experiment always finishes and is scored.
 * `-clear` cancels a pending request. `-force` additionally signals the pid
 * recorded in `eval.lock` (if any) to abandon the current experiment right
 * now, and then reports the repository state that leaves -- including the
 * exact command that would drop the abandoned commit -- WITHOUT running it.
 * Dropping an agent's work is the human's decision, never this tool's.
 */
export async function cmdStop(ctx: RunCtx, argv: readonly string[]): Promise<number> {
  let tag: string | undefined
  let clear: boolean
  let force: boolean
  try {
    const normalized = argv.map((a) => (/^-[A-Za-z][A-Za-z-]+$/.test(a) ? `-${a}` : a))
    const { values } = parseArgs({
      args: normalized,
      options: {
        tag: { type: 'string' },
        clear: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    })
    tag = values.tag
    clear = values.clear === true
    force = values.force === true
  } catch (e) {
    return fail(messageOf(e))
  }

  if (clear && force) {
    return fail('-clear and -force are mutually exclusive')
  }

  let resolvedTag: string
  try {
    resolvedTag = tag ?? (await inferTagFromBranch(ctx.repoRoot))
  } catch (e) {
    return fail(messageOf(e))
  }

  const dir = runDir(ctx.repoRoot, resolvedTag)

  try {
    // Confirms a run actually exists before writing (or clearing) any state
    // for it. A human who mistypes a tag must be told the tag is unknown,
    // not silently handed a stop request that nothing will ever read.
    // readBaseline never creates anything -- only reads -- so a nonexistent
    // run is refused here before any state is touched.
    await readBaseline(dir)
  } catch (e) {
    return fail(messageOf(e))
  }

  if (clear) {
    await clearStop(dir)
    process.stdout.write(`stop request for tag ${JSON.stringify(resolvedTag)} cleared\n`)
    return 0
  }

  await requestStop(dir, force)

  if (!force) {
    process.stdout.write(
      `stop requested for tag ${JSON.stringify(resolvedTag)}: the agent will stop after its current ` +
        'experiment reports a verdict.\n',
    )
    return 0
  }

  process.stdout.write(`stop -force requested for tag ${JSON.stringify(resolvedTag)}.\n`)

  const lock = await readEvalLock(dir)
  if (lock === null) {
    process.stdout.write('  no eval lock is currently held: nothing to signal.\n')
  } else {
    killGroup(lock.pid, 'SIGTERM')
    process.stdout.write(`  signalled pid ${lock.pid} (SIGTERM) to abandon its current experiment.\n`)
  }

  const branch = await tryGit(() => currentBranch(ctx.repoRoot))
  const head = await tryGit(() => headCommit(ctx.repoRoot))

  process.stdout.write(`  current branch: ${branch ?? 'unknown'}\n`)
  process.stdout.write(`  HEAD commit:    ${head === null ? 'unknown' : `${shortSha(head)} (${head})`}\n`)
  process.stdout.write(
    '  this is very likely the commit for the experiment just abandoned. Nothing here has been\n' +
      '  changed -- dropping it is your call, not this tool\'s. To drop it:\n' +
      '\n' +
      '    git reset --hard HEAD~1\n',
  )

  return 0
}

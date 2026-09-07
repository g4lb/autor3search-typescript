import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'

/**
 * Largest output we retain per stream, in characters (UTF-16 code units),
 * not bytes. The cap exists to bound retained *memory*, and these are
 * JavaScript strings living in V8 — which stores them as one-byte (latin1)
 * or two-byte sequences, so retained memory tracks `.length` (code units),
 * not UTF-8 byte length. Measuring in UTF-8 bytes would make the name
 * accurate but the bound wrong: for a two-byte-represented string, the
 * UTF-8 length can be smaller than the memory actually held, undercounting
 * exactly where the bound matters most. Beyond this many characters we keep
 * the tail.
 */
export const MAX_CAPTURED_CHARS = 4 * 1024 * 1024

export interface ExecOptions {
  cwd: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  /** Receives output as it arrives, for run.log. */
  log?: (chunk: string) => void
}

export interface ExecResult {
  exitCode: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

/** A result is OK only if it exited zero, was not signalled, and did not time out. */
export function ok(r: ExecResult): boolean {
  return r.exitCode === 0 && r.signal === null && !r.timedOut
}

/** The last `lines` lines of `s`. */
export function tail(s: string, lines: number): string {
  const parts = s.split('\n')
  return parts.slice(Math.max(0, parts.length - lines)).join('\n')
}

/**
 * Accumulates output while keeping only the tail once the cap is exceeded.
 *
 * Exported for testing: the eviction and single-chunk-trim logic below is
 * only reliably exercised by calling `push` directly — a real subprocess's
 * output arrives from the OS pipe in fragments (observed ~64 KiB on this
 * machine for a 4 MiB+ write), so driving it through a spawned process
 * cannot be trusted to ever deliver a single chunk larger than the cap.
 */
export class Capture {
  private chunks: string[] = []
  private size = 0
  truncated = false

  push(s: string): void {
    if (s.length > MAX_CAPTURED_CHARS) {
      // A single incoming chunk can itself exceed the whole cap (a chatty
      // process writing in one huge call, or a pipe that happens to hand us
      // a large read). Chunk-granularity eviction below can't bound this —
      // with only one chunk held there is nothing to evict — so trim this
      // string's own tail directly. Its last MAX_CAPTURED_CHARS characters
      // are also the most recent MAX_CAPTURED_CHARS characters of the whole
      // stream, so anything held from before this chunk is now stale and is
      // discarded along with the front of this one.
      this.chunks = [s.slice(s.length - MAX_CAPTURED_CHARS)]
      this.size = MAX_CAPTURED_CHARS
      this.truncated = true
      return
    }
    this.chunks.push(s)
    this.size += s.length
    while (this.size > MAX_CAPTURED_CHARS && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length
      this.truncated = true
    }
  }

  toString(): string {
    return this.chunks.join('')
  }
}

/**
 * Signals a process group, refusing to signal pid 1's group.
 *
 * On Linux a process whose group leader has exited can report ppid 1, and
 * `kill(-1, ...)` means "every process the user may signal" — which in a
 * container is everything. Refusing is strictly better than the alternative.
 *
 * Exported: `cli/cmd-stop.ts`'s `stop -force` needs this exact same refusal
 * to signal the pid recorded in `eval.lock`. That is the same function, not
 * two views of one enumeration (contrast the lockfile `switch` in
 * `pm/detect.ts`, which genuinely cannot be imported across a `switch`) --
 * so the duplication is eliminated by importing this rather than guarded by
 * a second copy plus a comment. A future edit to the pid-1 refusal (e.g.
 * hardening it for a new edge case) now cannot diverge between the two call
 * sites by simply being forgotten in one of them.
 */
/**
 * The executable to hand `spawn`, resolved for Windows.
 *
 * On Windows `npm` is `npm.cmd`, and CreateProcess does not consult PATHEXT
 * the way a shell does -- so `spawn('npm', args)` fails with ENOENT and the
 * tool could not install, build, typecheck or detect a package manager
 * there at all. The README documented Windows support the whole time; a CI
 * matrix covering it is what finally said otherwise.
 *
 * Resolved by searching PATH ourselves rather than by passing
 * `shell: true`. A shell would fix the ENOENT and simultaneously undo the
 * reason `run` takes an argv ARRAY: with a shell, every argument is
 * re-parsed as shell syntax, and arguments here include repository paths
 * and benchmark ids. `runShell` exists for the config-supplied command
 * strings that are meant to be shell syntax; this path must stay literal.
 *
 * A no-op on POSIX, and on any command already carrying a path or an
 * extension.
 */
function resolveExecutable(cmd: string): string {
  if (process.platform !== 'win32') return cmd
  if (cmd.includes('/') || cmd.includes('\\') || path.extname(cmd) !== '') return cmd

  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e !== '')
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter).filter((d) => d !== '')) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not here; keep looking. A PATH entry that does not exist is
        // ordinary on Windows, not an error worth surfacing.
      }
    }
  }
  // Unresolved: hand back the original so spawn reports its own ENOENT,
  // which names the command the caller asked for.
  return cmd
}

/**
 * Quotes one argument for a Windows command line.
 *
 * Windows does not pass an argv array to a process: it passes ONE string,
 * and each program parses it. These are the rules the C runtime documents
 * and that `CommandLineToArgvW` implements -- backslashes are literal
 * except when they precede a quote, where they must be doubled.
 */
export function quoteForWindows(arg: string): string {
  if (arg !== '' && !/[\s"^&|<>()%!]/.test(arg)) return arg
  // Double only the backslashes that run up against a quote (or the end),
  // then wrap. Doubling every backslash would corrupt ordinary paths.
  const escaped = arg.replace(/(\\*)("|$)/g, (_m, slashes: string, quote: string) =>
    quote === '"' ? `${slashes}${slashes}\\"` : `${slashes}${slashes}`,
  )
  return `"${escaped}"`
}

/**
 * How to actually launch `cmd` with `args` on this platform.
 *
 * The awkward case is Windows batch wrappers. npm, npx, yarn and pnpm are
 * all `.cmd` files there, and since CVE-2024-27980 Node REFUSES to spawn a
 * `.cmd` or `.bat` without a shell -- `spawn` fails with EINVAL. So they
 * must go through `cmd.exe` explicitly.
 *
 * Not `shell: true`, which would be the one-line version: with that option
 * Node concatenates the command and arguments into one string with no
 * quoting at all, so any argument containing a space, a quote or a cmd
 * metacharacter is re-parsed as syntax. Arguments here are repository
 * paths, benchmark ids and config-derived strings; "C:\\Users\\Some One\\repo"
 * alone would break, and `&` in a path would execute. Instead each argument
 * is quoted for the Windows convention and handed to `cmd.exe /d /s /c`
 * with `windowsVerbatimArguments`, which tells Node to pass the line
 * through exactly as built rather than re-quoting it.
 *
 * `/d` skips AutoRun commands from the registry -- otherwise whatever a
 * machine has configured there runs before every measurement.
 */
function launchSpec(
  cmd: string,
  args: readonly string[],
): { file: string; args: string[]; verbatim: boolean } {
  const resolved = resolveExecutable(cmd)
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)
  if (!isBatch) return { file: resolved, args: [...args], verbatim: false }

  const line = [resolved, ...args].map(quoteForWindows).join(' ')
  return {
    file: process.env['ComSpec'] ?? 'cmd.exe',
    // The outer quotes around the whole line are cmd's own convention for
    // /c: with them, cmd strips them and runs the rest verbatim.
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  }
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid <= 1) return

  // Windows has no process groups and no POSIX signals: `process.kill(-pid)`
  // throws, and the single-process fallback below would leave every
  // grandchild running -- a benchmark spawned by a test runner surviving a
  // timeout is precisely the orphan that corrupts later measurements.
  // `taskkill /T` walks the tree; `/F` is required because there is no
  // graceful signal to send. Synchronous so it completes before the caller
  // moves on, matching `process.kill`'s semantics on POSIX.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }

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

/**
 * Every measurement/typecheck/build/test child currently spawned by THIS
 * process, so a signal handler can reach them without any pipeline-layer
 * plumbing. Load-bearing for `stop -force`: `eval.ts` spawns each
 * measurement child `detached: true` so it is its own process-group leader
 * (see `exec` below), which means it is NOT killed for free when `eval`
 * itself receives SIGTERM. Left unhandled, `stop -force`'s SIGTERM to the
 * eval process kills node immediately (SIGTERM's default disposition) with
 * the benchmark child still running and the eval lock still held -- the
 * exact orphaned-process hazard spec section 2 item 4 names explicitly.
 */
const activeChildPids = new Set<number>()

/** Signals every currently-active child's process group, best effort. */
export function killActiveChildren(signal: NodeJS.Signals): void {
  for (const pid of activeChildPids) killGroup(pid, signal)
}

function exec(
  cmd: string,
  args: string[],
  opts: ExecOptions,
  useShell: boolean,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const stdout = new Capture()
    const stderr = new Capture()
    let timedOut = false
    let settled = false

    // `useShell` commands are shell syntax by contract and must not be
    // path-resolved or quoted; everything else is a literal executable
    // name with a literal argv.
    const spec = useShell
      ? { file: cmd, args: [...args], verbatim: false }
      : launchSpec(cmd, args)
    const child = spawn(spec.file, spec.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: useShell,
      windowsVerbatimArguments: spec.verbatim,
      // A new process group is what makes killGroup able to reach
      // grandchildren. Without it, a benchmark spawned by a test runner
      // survives the timeout and corrupts every later measurement.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (child.pid !== undefined) activeChildPids.add(child.pid)

    // A throwing `log` must not take down an unattended overnight run —
    // losing a log line is fine, losing the whole exec because a log
    // stream closed or a disk filled is not.
    const safeLog = (c: string): void => {
      try {
        opts.log?.(c)
      } catch {
        /* a broken logger must not break the run it is only observing */
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => {
      stdout.push(c)
      safeLog(c)
    })
    child.stderr?.on('data', (c: string) => {
      stderr.push(c)
      safeLog(c)
    })

    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid, 'SIGKILL')
    }, opts.timeoutMs)

    const finish = (exitCode: number, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.pid !== undefined) activeChildPids.delete(child.pid)
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      })
    }

    // A missing binary is a result the caller reasons about, not a crash.
    child.on('error', (e: Error) => {
      stderr.push(e.message)
      finish(127, null)
    })
    child.on('close', (code, signal) => finish(code ?? 0, signal))
  })
}

export function run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return exec(cmd, args, opts, false)
}

/** Runs a full command line through the platform shell. */
export function runShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  return exec(command, [], opts, true)
}

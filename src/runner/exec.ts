import { spawn } from 'node:child_process'

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
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid <= 1) return
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

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: useShell,
      // A new process group is what makes killGroup able to reach
      // grandchildren. Without it, a benchmark spawned by a test runner
      // survives the timeout and corrupts every later measurement.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

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

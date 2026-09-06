import { spawn } from 'node:child_process'

/** Largest output we retain per stream. Beyond this we keep the tail. */
export const MAX_CAPTURED_BYTES = 4 * 1024 * 1024

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

/** Accumulates output while keeping only the tail once the cap is exceeded. */
class Capture {
  private chunks: string[] = []
  private size = 0
  truncated = false

  push(s: string): void {
    this.chunks.push(s)
    this.size += s.length
    while (this.size > MAX_CAPTURED_BYTES && this.chunks.length > 1) {
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
 */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
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

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => {
      stdout.push(c)
      opts.log?.(c)
    })
    child.stderr?.on('data', (c: string) => {
      stderr.push(c)
      opts.log?.(c)
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

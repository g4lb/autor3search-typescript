import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_PATH } from '../config/schema.js'
import { makeDemoRepo } from '../testutil/demo.js'
import { main } from './main.js'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

let stdout: string[]
let stderr: string[]
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

function captureOutput(): void {
  stdout = []
  stderr = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
}

afterEach(() => {
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
})

describe('main', () => {
  it('prints the command table and exits 2 with no arguments', async () => {
    captureOutput()
    const code = await main([])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/Commands:/)
    expect(stdout.join('')).toMatch(/init/)
  })

  it('prints the command table and exits 2 for --help', async () => {
    captureOutput()
    const code = await main(['--help'])
    expect(code).toBe(2)
    expect(stdout.join('')).toMatch(/Usage:/)
  })

  it('exits 2 for an unknown subcommand, naming it', async () => {
    captureOutput()
    const code = await main(['bogus'])
    expect(code).toBe(2)
    expect(stderr.join('')).toMatch(/unknown command "bogus"/)
  })

  it('exits 2 with a usage error when -C has no directory', async () => {
    captureOutput()
    const code = await main(['-C'])
    expect(code).toBe(2)
    expect(stderr.join('')).toMatch(/-C requires a directory/)
  })

  it('never prints a raw stack trace when -C points outside any git repository', async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), 'ars-main-norepo-'))
    captureOutput()

    const code = await main(['-C', notARepo, 'init'])

    expect(code).toBe(2)
    const message = stderr.join('')
    expect(message).toMatch(/^error: /)
    expect(message).not.toMatch(/at file:|\.ts:\d+:\d+|node:internal/)
  })

  it('dispatches "init" against -C <dir>, actually writing the config', async () => {
    const root = await makeDemoRepo()
    captureOutput()

    const code = await main(['-C', root, 'init'])

    expect(code).toBe(0)
    expect(await exists(path.join(root, CONFIG_PATH))).toBe(true)
  })

  it('does not touch process.cwd() while dispatching', async () => {
    const root = await makeDemoRepo()
    const cwdBefore = process.cwd()
    captureOutput()
    await main(['-C', root, 'init'])
    expect(process.cwd()).toBe(cwdBefore)
  })
})

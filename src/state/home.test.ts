import { mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDir, stateHome, STATE_HOME_ENV } from './home.js'

describe('stateHome', () => {
  it('honours an absolute override', () => {
    expect(stateHome({ [STATE_HOME_ENV]: '/tmp/ars-state' })).toBe('/tmp/ars-state')
  })

  it('REFUSES a relative override', () => {
    expect(() => stateHome({ [STATE_HOME_ENV]: 'relative/path' })).toThrow(/absolute/)
  })

  it('falls back to a per-user cache directory', () => {
    const h = stateHome({})
    expect(path.isAbsolute(h)).toBe(true)
  })
})

describe('runDir', () => {
  it('keys by repo path and tag', () => {
    const env = { [STATE_HOME_ENV]: '/s' }
    const a = runDir('/repos/one', 'sep6', env)
    const b = runDir('/repos/two', 'sep6', env)
    const c = runDir('/repos/one', 'sep7', env)
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('/s/autoresearch-typescript/')).toBe(true)
  })

  it('is stable for the same repo and tag', () => {
    const env = { [STATE_HOME_ENV]: '/s' }
    expect(runDir('/repos/one', 'sep6', env)).toBe(runDir('/repos/one', 'sep6', env))
  })

  it('rejects a tag that would escape the state directory', () => {
    const env = { [STATE_HOME_ENV]: '/s' }
    expect(() => runDir('/repos/one', '../../etc', env)).toThrow(/tag/)
    expect(() => runDir('/repos/one', 'a/b', env)).toThrow(/tag/)
  })

  it('resolves a trailing slash and a relative path to the same key as the clean absolute path', async () => {
    const env = { [STATE_HOME_ENV]: '/s' }
    const root = await mkdtemp(path.join(tmpdir(), 'ars-state-home-'))
    const clean = runDir(root, 'sep6', env)
    const trailing = runDir(`${root}/`, 'sep6', env)
    const relative = runDir(path.relative(process.cwd(), root), 'sep6', env)
    expect(trailing).toBe(clean)
    expect(relative).toBe(clean)
  })

  it('resolves the same repo identically whether reached directly or through a symlinked parent', async () => {
    const env = { [STATE_HOME_ENV]: '/s' }
    const base = await mkdtemp(path.join(tmpdir(), 'ars-state-home-'))
    const real = path.join(base, 'real')
    await mkdir(real, { recursive: true })
    const linkedParent = path.join(base, 'linked')
    await symlink(base, linkedParent, 'dir')
    const viaSymlink = path.join(linkedParent, 'real')

    expect(runDir(viaSymlink, 'sep6', env)).toBe(runDir(real, 'sep6', env))
  })
})

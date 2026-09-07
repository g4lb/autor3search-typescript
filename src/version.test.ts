import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VERSION, formatVersion } from './version.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('VERSION', () => {
  it('is a semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  // The regex above is what the previous hand-synced constant had, and it
  // passed for the whole time the constant said 0.1.0 while package.json
  // said 0.1.1: a shape check cannot catch drift, only a comparison to the
  // real source can. This is that comparison.
  it('is the version package.json actually declares', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string
    }
    expect(VERSION).toBe(pkg.version)
  })
})

describe('formatVersion', () => {
  it('names the package, its version, and the Node runtime doing the measuring', () => {
    const text = formatVersion()
    expect(text).toContain(`autor3search-typescript ${VERSION}`)
    expect(text).toContain(process.version)
    expect(text).toContain(`${process.platform}/${process.arch}`)
    expect(text.endsWith('\n')).toBe(true)
  })
})

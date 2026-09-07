import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface Pkg {
  name: string
  bin: Record<string, string>
  files: string[]
  scripts: Record<string, string>
}

async function readPkg(): Promise<Pkg> {
  return JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as Pkg
}

/**
 * Nothing else in the suite reads package.json as a PUBLISH artifact, which
 * is why a shape npm objects to shipped in three releases: every publish
 * printed `"bin[autor3search-typescript]" script name was cleaned` and
 * `npm pkg fix`, and the only place that was visible was a human reading
 * publish output.
 */
describe('package.json publish shape', () => {
  // npm normalizes bin paths by stripping a leading "./" and warns that it
  // did. Storing the already-normalized form is the whole fix; this pins it
  // so the "./" cannot come back with the warning in tow.
  it('declares bin paths in the form npm normalizes to, so publishing warns about nothing', async () => {
    const pkg = await readPkg()
    for (const [name, target] of Object.entries(pkg.bin)) {
      expect(target, `bin[${name}] must not start with "./"`).not.toMatch(/^\.\//)
      expect(target, `bin[${name}] must be a relative path`).not.toMatch(/^\//)
    }
  })

  // A bin npm cannot find installs a broken command. `files` decides what
  // actually reaches the tarball, so the bin has to live under one of them.
  it('points every bin at a path the files list actually ships', async () => {
    const pkg = await readPkg()
    const shipped = pkg.files.map((f) => f.replace(/\/$/, ''))
    for (const [name, target] of Object.entries(pkg.bin)) {
      const top = target.split('/')[0]
      expect(shipped, `bin[${name}] -> ${target} is not covered by "files"`).toContain(top)
    }
  })

  // `prepare` runs on both `npm install` from a git URL and before publish.
  // A second build hook (`prepublishOnly`) was removed once already: it ran
  // tsc twice before every publish, which burned the 2FA window.
  it('builds through prepare only, not a second duplicate publish hook', async () => {
    const pkg = await readPkg()
    expect(pkg.scripts['prepare']).toBe('npm run build')
    expect(pkg.scripts['prepublishOnly']).toBeUndefined()
  })
})

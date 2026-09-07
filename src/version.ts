import { createRequire } from 'node:module'

/**
 * The running package's version, read from the package.json that ships in
 * the tarball rather than kept in step with it by hand.
 *
 * The hand-synced constant this replaces drifted on the very first release:
 * it still said 0.1.0 after package.json moved to 0.1.1, and its only test
 * asserted the constant matched a semver regex -- which it did, wrongly.
 * Reading the real file makes that class of drift impossible.
 *
 * `../package.json` resolves from this module's own location, which is one
 * directory below the package root both as `src/version.ts` under tsx and
 * as `dist/version.js` when installed.
 */
const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version?: unknown }

if (typeof pkg.version !== 'string' || pkg.version === '') {
  throw new Error('package.json has no version field')
}

export const VERSION: string = pkg.version

/**
 * Build identity for `version`, mirroring the Go sibling's reasoning: a
 * results.tsv row is only as reproducible as the harness that produced it,
 * and "which version measured this" is otherwise unanswerable from an
 * installed copy. Go reports its toolchain and GOOS/GOARCH; the Node
 * equivalents are the runtime version and platform/arch, which also decide
 * whether two measurements are even comparable.
 */
export function formatVersion(): string {
  return (
    `autor3search-typescript ${VERSION}\n` +
    `running on ${process.version}, ${process.platform}/${process.arch}\n`
  )
}

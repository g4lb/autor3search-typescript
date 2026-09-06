import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { LOCKFILES } from '../config/schema.js'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface Detected {
  pm: PackageManager
  lockfile: string
  /** A frozen-lockfile install: reproducible, and it fails rather than drifting. */
  installCommand: string
}

type LockfileName = (typeof LOCKFILES)[number]

/**
 * The manager and install command for each recognised lockfile.
 *
 * The filenames themselves come from `LOCKFILES` in `src/config/schema.ts`
 * (also the base of `IMMUTABLE_FILES`) rather than being re-declared here, so
 * the two lists cannot drift apart. The `switch` is exhaustive over
 * `LockfileName`: if schema.ts ever adds a lockfile without a case being
 * added here, this fails to typecheck rather than silently detecting nothing.
 */
function managerFor(lockfile: LockfileName): { pm: PackageManager; installCommand: string } {
  switch (lockfile) {
    case 'package-lock.json':
      return { pm: 'npm', installCommand: 'npm ci' }
    case 'pnpm-lock.yaml':
      return { pm: 'pnpm', installCommand: 'pnpm install --frozen-lockfile' }
    case 'yarn.lock':
      return { pm: 'yarn', installCommand: 'yarn install --immutable' }
    case 'bun.lockb':
    case 'bun.lock':
      return { pm: 'bun', installCommand: 'bun install --frozen-lockfile' }
    default: {
      const exhaustive: never = lockfile
      throw new Error(`unhandled lockfile: ${String(exhaustive)}`)
    }
  }
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
 * True if a parsed `workspaces` field expresses a real workspace.
 *
 * `"workspaces": []` and `"workspaces": {}` declare no members, but declaring
 * the key at all signals workspace intent (npm and yarn both treat its mere
 * presence as opting a repository into workspace mode). Since a subtly wrong
 * guess here would weaken a guarantee the user believes they have, an empty
 * declaration is refused in the same way a populated one is.
 */
function isWorkspaceDeclaration(workspaces: unknown): boolean {
  return workspaces !== undefined
}

/**
 * Refuses a workspace root.
 *
 * v0.1 supports single-package repositories only. Saying so plainly is much
 * better than half-working: in a workspace the scope gate, the freeze set and
 * the install layout all mean something different, and getting any of them
 * subtly wrong weakens a guarantee the user believes they have.
 */
export async function assertSinglePackage(pkgJsonText: string, root: string): Promise<void> {
  let pkg: unknown
  try {
    pkg = JSON.parse(pkgJsonText)
  } catch (e) {
    throw new Error(`package.json is not valid JSON: ${(e as Error).message}`)
  }
  const workspaces = (pkg as { workspaces?: unknown }).workspaces
  if (isWorkspaceDeclaration(workspaces)) {
    throw new Error(
      'this repository declares npm/yarn workspaces (a "workspaces" key in package.json). ' +
        'autoresearch-typescript v0.1 supports single-package repositories only: in a ' +
        'workspace the scope gate, the freeze set and the install layout all mean something ' +
        'different, and getting any of them wrong would weaken the guarantee this tool gives. ' +
        'Run autoresearch-typescript from inside one of the workspace packages instead.',
    )
  }
  if (await exists(path.join(root, 'pnpm-workspace.yaml'))) {
    throw new Error(
      'this repository is a pnpm workspace (a pnpm-workspace.yaml is present). ' +
        'autoresearch-typescript v0.1 supports single-package repositories only: in a ' +
        'workspace the scope gate, the freeze set and the install layout all mean something ' +
        'different, and getting any of them wrong would weaken the guarantee this tool gives. ' +
        'Run autoresearch-typescript from inside one of the workspace packages instead.',
    )
  }
}

export async function detect(root: string): Promise<Detected> {
  const pkgPath = path.join(root, 'package.json')
  let pkgText: string
  try {
    pkgText = await readFile(pkgPath, 'utf8')
  } catch {
    throw new Error(
      `no package.json in ${root}: this does not look like a Node package. ` +
        'Run autoresearch-typescript from the package root (the directory that contains ' +
        'package.json).',
    )
  }
  await assertSinglePackage(pkgText, root)

  const present: Detected[] = []
  for (const lockfile of LOCKFILES) {
    if (await exists(path.join(root, lockfile))) {
      present.push({ lockfile, ...managerFor(lockfile) })
    }
  }
  if (present.length === 0) {
    throw new Error(
      `no lockfile found (looked for ${LOCKFILES.join(', ')}). ` +
        'A baseline pinned without a lockfile could not be reproduced, so this is refused. ' +
        'Commit a lockfile and try again.',
    )
  }
  // Two bun lockfile names (bun.lockb, bun.lock) map to the same manager; that
  // is not ambiguity, so we compare distinct managers, not lockfile count.
  const managers = new Set(present.map((p) => p.pm))
  if (managers.size > 1) {
    throw new Error(
      `more than one lockfile is present (${present.map((p) => p.lockfile).join(', ')}), ` +
        'implying more than one package manager. Which one owns this repository would then ' +
        'be a guess, and guessing wrong installs the baseline differently from the ' +
        'candidate. Remove the stale lockfile and try again.',
    )
  }
  return present[0]!
}

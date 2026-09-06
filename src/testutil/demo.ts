import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ok, run } from '../runner/exec.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(HERE, '../../testdata/demo')

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await run('git', args, { cwd, timeoutMs: 60_000 })
  if (!ok(r)) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

/**
 * Copies the demo fixture into a scratch git repository with one commit.
 *
 * A local identity is set so these tests never depend on, or write through,
 * the developer's global git config.
 */
export async function makeDemoRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ars-demo-'))
  await cp(FIXTURE, root, { recursive: true })
  await git(root, ['init', '-q', '-b', 'main'])
  await git(root, ['config', 'user.name', 'Test'])
  await git(root, ['config', 'user.email', 'test@example.invalid'])
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'demo fixture'])
  return root
}

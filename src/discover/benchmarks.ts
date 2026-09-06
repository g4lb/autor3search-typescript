import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { classify, walkRepo } from './files.js'

export interface Benchmark {
  /** "<repo-relative file>:<function name>". */
  id: string
  file: string
  fn: string
}

const PREFIX = 'bench'

function isBenchName(name: string): boolean {
  // "bench" alone is not a benchmark; there must be a suffix.
  return name.startsWith(PREFIX) && name.length > PREFIX.length
}

/** Exported `bench*` function names declared in one source text. */
export function benchNamesInSource(text: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  for (const stmt of sf.statements) {
    const exported = ts.canHaveModifiers(stmt)
      ? ts
          .getModifiers(stmt)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
      : false
    if (!exported) continue

    if (ts.isFunctionDeclaration(stmt) && stmt.name && isBenchName(stmt.name.text)) {
      names.push(stmt.name.text)
      continue
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !isBenchName(decl.name.text)) continue
        const init = decl.initializer
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          names.push(decl.name.text)
        }
      }
    }
  }
  return names
}

/**
 * Finds every benchmark in the repository by parsing, never executing.
 *
 * `init` must work on a tree that does not build, and executing a benchmark
 * module at discovery time would run arbitrary repository code before the user
 * has agreed to anything at all.
 */
export async function discoverBenchmarks(root: string): Promise<Benchmark[]> {
  const files = (await walkRepo(root)).filter((f) => classify(f) === 'bench')
  const out: Benchmark[] = []
  for (const file of files) {
    const text = await readFile(path.join(root, file), 'utf8')
    for (const fn of benchNamesInSource(text, file)) {
      out.push({ id: `${file}:${fn}`, file, fn })
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

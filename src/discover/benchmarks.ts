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

/**
 * Exported `bench*` names declared in one source text, keyed by the name a
 * consumer sees on the imported module — not necessarily the local
 * declaration name.
 */
export function benchNamesInSource(text: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  for (const stmt of sf.statements) {
    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined
    const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
    // A default export is reached as `mod.default`, not `mod[name]` — the measurement
    // child imports by name, so a default-exported bench* would fail at measurement
    // time with "does not export a function named X". Excluding it here, at
    // discovery, is what keeps that failure from ever happening.
    const isDefault = modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true

    if (isExported && !isDefault) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && isBenchName(stmt.name.text)) {
        names.push(stmt.name.text)
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !isBenchName(decl.name.text)) continue
          const init = decl.initializer
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            names.push(decl.name.text)
          }
        }
      }
    }

    // `export { local as exported }` / `export { local }`: what a consumer sees is the
    // *exported* name (`import(file).then((m) => m[fn])`), so that is what must be
    // bench-named, regardless of what the local declaration is called or even is.
    // Idiomatic TypeScript often declares a function and exports it later this way, and
    // missing it would be a silent false negative — the worst failure mode for a tool
    // whose entire output is a measurement. `export { x } from './other'` and
    // `export * from` are deliberately excluded: resolving those would mean walking a
    // module graph, not parsing one file.
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const spec of stmt.exportClause.elements) {
        if (spec.isTypeOnly) continue
        if (isBenchName(spec.name.text)) names.push(spec.name.text)
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

# wordcount-demo

A tiny, real TypeScript package used as a test fixture by
`autor3search-typescript`'s own test suite. It is not a toy: it genuinely
builds (there is nothing to build -- see below), tests and benchmarks, so
that the harness's own tests exercise a real target rather than a mock.

## Zero dependencies, on purpose

This package has no `dependencies` and no `devDependencies` at all. It runs
directly on Node's built-in test runner (`node:test`) and Node's native
TypeScript type stripping -- no `tsc`, no `ts-node`, no `vitest`. That keeps
`npm ci` against this fixture instant and fully offline wherever
`autor3search-typescript`'s own tests spin up a scratch copy of it, and it
demonstrates that the harness genuinely does not care which test runner or
build step the measured repository uses.

## What's here

- `src/wordcount.ts` -- `countWords`, which counts how many times each
  lowercase, alphanumeric word appears in a string. It contains a real,
  fixable performance bug: the per-word character buffer is rebuilt with
  `Array.prototype.concat`, which copies the whole array on every character,
  making word-building `O(n^2)` in the word's length instead of `O(n)`. This
  is the win an optimizing agent is expected to find, by switching to
  `Array.prototype.push`.
- `src/wordcount.test.ts` -- the frozen correctness contract. It asserts real
  output (repeated-word counts, case folding, punctuation stripping, digit
  handling), so an agent cannot pass it by deleting the work.
- `src/wordcount.bench.ts` -- `benchCountWords`, which measures `countWords`
  against a realistic input: a repeated sentence plus one long unbroken token
  (standing in for a URL, hash, or base64 blob) -- the kind of single long
  word that is what actually makes the `O(n^2)` bug show up in a benchmark.
  The result is returned so the measurement harness can sink it; otherwise
  V8 may find the call has no observable effect and delete it entirely.

## Running it directly

```sh
npm test        # node --test
```

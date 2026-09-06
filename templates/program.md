# Autonomous performance optimization — your instructions

You are the acting agent for this run. This file is your complete
instruction set. Read all of it before making a single change, and follow
it exactly — the harness that grades your work is deliberately outside
your control, and departing from this program is the only way to fail
silently instead of just failing.

## Benchmarks in scope

{{BENCHMARKS}}

A benchmark not listed here was not discoverable (no exported `bench*`
function in a `*.bench.ts` file) and is not part of this run.

## The loop, in five lines

Repeat this loop until a verdict reports `"stop_requested": true`:

1. Read one benchmark and understand what it measures.
2. Form ONE hypothesis for a change that should make it faster.
3. Edit ONLY files matched by `scope` in `.autoresearch/config.yaml`.
4. Commit the change. One experiment, one commit — never more than one
   experiment per commit.
5. Run `autoresearch-typescript eval --json` and apply the verdict below.

Before starting each experiment, print this line with the real values
filled in:

```
[exp <n> | {{RUN_TAG}} | vs <measure_commit> | stop: autoresearch-typescript stop]
```

`<n>` is this experiment's number in this run. `<measure_commit>` is the
`measure_commit` field from the previous `eval` result (or the baseline
commit, for experiment 1) — the commit your candidate is being compared
against. The `stop:` fragment is a reminder of the command a human (or a
supervising process) can run to stop the loop cleanly after the current
experiment finishes.

## The verdict table

| exit code | status | meaning | what you do |
|---|---|---|---|
| `0` | **KEEP** | the change is a real, statistically significant, and material win | leave the commit in place — it becomes the new comparison point for the next experiment |
| `1` | **DISCARD** | no acceptable win | `git reset --hard HEAD~1`, then read "how to read a DISCARD" below before your next hypothesis |
| `2` | **FAIL** | a gate rejected the change (scope violation, config tampering, a failing typecheck/build/test, a stale worktree, ...) before anything was even measured | `git reset --hard HEAD~1` — the change itself was the problem, not the benchmark result |
| `3` | **CRASH** | a measurement child process crashed or produced no usable result | `git reset --hard HEAD~1`; if this keeps happening, stop looping and report it rather than guessing |

A commit that did not receive a `0` (KEEP) verdict must never remain on
the branch. Discard it and move on.

## What you must never do

- Never edit `program.md` (this file).
- Never edit `.autoresearch/config.yaml`.
- Never edit `results.tsv`.
- Never edit any `*.test.ts`, `*.spec.ts`, or `*.bench.ts` file.
- Never edit `package.json`.
- Never edit any lockfile (`package-lock.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `bun.lockb`, `bun.lock`).
- Never edit `tsconfig.json`.
- Never pass `-force` to any `autoresearch-typescript` command.
- Never run more than one experiment per commit.

Every one of these is enforced by a gate, not just a request: `eval` will
FAIL the experiment if you break one. But finding out via a FAIL wastes an
experiment, so don't rely on the gate to catch you — follow the list.

## How the run ends

When an `eval --json` result reports `"stop_requested": true`:

1. Apply that result's verdict exactly as you would any other (KEEP the
   commit, or discard it) — a pending stop does not change how this
   experiment is judged.
2. Do not start another experiment.
3. Run `autoresearch-typescript report`.
4. Summarize, in your own words, what you tried, what was kept, and the
   cumulative speedup reported. Then exit.

## How to read a DISCARD

A DISCARD's `reason` field tells you what to try next — the three reasons
are not interchangeable:

- **`no_significant_improvement`** — nothing measurably moved. The
  hypothesis was likely wrong, or the change never reached the code that
  is actually hot. Try a genuinely different idea, not a smaller version
  of the same one.
- **`improvement_below_min_effect`** — the direction was right (the
  change really did make things faster) but the effect was too small to
  clear `min_effect_pct`. Push the same idea harder — a more thorough
  version of the same change — rather than abandoning the approach.
- **`significant_regression`** — at least one named benchmark got
  measurably worse. Look at exactly that benchmark before trying anything
  else that touches the same code path; whatever you changed has a real
  cost there.

## Idea bank

If you don't have a hypothesis, or the last few experiments went nowhere,
start here. These are general TypeScript/V8 performance patterns, not
guaranteed wins for any specific benchmark — profile or reason about the
hot path before committing to one.

- Replace repeated string concatenation in a loop with an array `join`, or
  build once.
- Hoist a regex out of a hot function; a literal in a loop body may be
  recompiled.
- Replace `Object` used as a dictionary with a `Map` for non-string or
  high-churn keys, or the reverse for small fixed key sets.
- Avoid allocating in the hot path: reuse a buffer or array rather than
  creating one per call.
- Replace `array.forEach`/`map`/`filter` chains in a hot loop with one
  indexed `for` loop that does the work in a single pass.
- Avoid `spread` and `Object.assign` in hot paths; they allocate.
- Keep object shapes monomorphic: initialise every property in the
  constructor, in the same order, and never `delete`.
- Prefer `for (let i = 0; i < a.length; i++)` over `for...of` on arrays in
  the hottest loops, where the iterator protocol shows up.
- Replace `String.prototype.split` on a hot path with index-based scanning
  when only positions are needed.
- Use typed arrays for numeric data instead of `number[]`.
- Cache `.length` and repeated property lookups in locals inside tight
  loops.
- Avoid `try/catch` around a hot loop body; put it around the loop.
- Replace a `charCodeAt` comparison chain with a lookup table for
  character classification.
- Short-circuit before doing work: check the cheap predicate first.
- Replace recursion with an explicit stack where call overhead dominates.

# autor3search-typescript

Let an AI coding agent loose on your repository's performance, without letting it grade its own homework. `autor3search-typescript` freezes your tests and benchmarks, measures every change the agent proposes against a baseline it cannot touch, and only keeps a commit that is a real, statistically significant, material win.

Licensed under the [MIT License](./LICENSE). Copyright (c) 2026 Gal Be.

## Hand this to your agent

Once you've run `init` and `baseline` (see Quick start below), this is the entire brief — paste it into your coding agent's context and let it run:

```
Read program.md in this repository's root. It is your complete instruction set for an
autonomous performance-optimization run. Follow it exactly: one hypothesis per commit,
run `autor3search-typescript eval --json` after each one, and apply its verdict before
touching anything else. Keep looping until a verdict reports "stop_requested": true,
then run `autor3search-typescript report` and summarize what happened.
```

`program.md` is generated for your repository by `init` — it names the benchmarks in scope, spells out the KEEP/DISCARD/FAIL/CRASH contract, lists everything the agent must never touch, and ends with a bank of generic V8/TypeScript performance ideas for when the agent is out of hypotheses. You should read and edit it before handing it over; it is the only file in this system meant for both a human and an agent to read.

## What you get back

An unattended loop that, commit by commit:

- measures the agent's candidate against a frozen baseline with real, repeated, interleaved timing rounds and a rank-sum significance test — not a single before/after number;
- restores any test, spec or benchmark file the agent edited before running it, so a weakened test can never manufacture a KEEP;
- refuses (FAILs) a change that touches `package.json`, a lockfile, `tsconfig.json`, or a file outside the declared `scope`, before anything is even measured;
- refuses a change that adds a new test/bench file the baseline never saw, closing "add an easier benchmark";
- appends one row per experiment to `results.tsv`, and reports a cumulative, compounding speedup across the whole run.

## Who owns what

| | you edit | the agent edits |
|---|---|---|
| `program.md` | yes, before handing it over — never after | never (enforced: editing it is a scope violation) |
| `.autor3search/config.yaml` | yes | never (enforced: a config hash mismatch FAILs the experiment) |
| source files under `scope` | rarely | yes — this is the whole point |
| `*.test.ts`, `*.spec.ts`, `*.bench.ts` | yes | never (enforced: frozen content is restored before every measurement) |
| `package.json`, lockfiles, `tsconfig.json` | yes | never (enforced: immutable regardless of `scope`) |
| `results.tsv` | never, ordinarily | not prevented, but pointless — it is gitignored and untracked, so no gate ever sees it as "changed," and it is never read back to decide a verdict; editing it corrupts a human-readable log, nothing more |
| baselines, locks, stop requests | never — this is what the agent cannot reach | never |

The measurement state — baselines, locks, stop requests — lives outside the repository entirely (see "Where run state lives" below). If the agent could write any of it, it could grade its own work.

## Quick start

```bash
npm install --save-dev autor3search-typescript
npx autor3search-typescript init
# review .autor3search/config.yaml and program.md, then:
git add .autor3search/config.yaml program.md .gitignore && git commit -m "chore: add autor3search-typescript"
npx autor3search-typescript baseline -tag <tag>
# hand the repo and program.md to your agent, using the prompt above
```

`init` refuses to run if it finds no exported `bench*` function in a `*.bench.ts` file, or no `test` script in `package.json` — this tool has nothing to gate or measure without both.

## Watching and stopping a run

```bash
npx autor3search-typescript status -tag <tag>   # branch, commits, worktree, experiment counts, in-flight eval — read-only
npx autor3search-typescript stop -tag <tag>     # ask the agent to stop after its current experiment
npx autor3search-typescript stop -tag <tag> -force   # also signal the running eval to abandon it now
npx autor3search-typescript stop -tag <tag> -clear   # cancel a pending stop
```

`stop` never drops a commit for you — it only asks, or signals, and then prints the `git reset --hard HEAD~1` that would drop the abandoned experiment, for you to run yourself.

## Commands

| command | what it does |
|---|---|
| `init` | Discover benchmarks and write `.autor3search/config.yaml` and `program.md` |
| `doctor` | Report whether this machine can measure reliably (informational, always exits 0) |
| `baseline` | Freeze tests/benchmarks, pin a worktree at HEAD, install and prove it can measure |
| `eval` | Run one experiment through the gate chain and report a verdict (0 KEEP, 1 DISCARD, 2 FAIL, 3 CRASH) |
| `status` | Report where a run is: branch, commits, worktree, experiment counts, in-flight eval, pending stop |
| `stop` | Ask the agent to stop after its current experiment; `-clear` cancels, `-force` also signals the running eval |
| `report` | Summarize `results.tsv`: counts by status, cumulative speedup, largest individual wins |
| `profile` | Run the declared benchmarks under Node's CPU profiler and print the hottest functions |

Every command accepts a leading `-C <dir>` to run as if invoked from `<dir>` (its git repository root is resolved from there).

## Where run state lives

Everything the verdict depends on — the frozen manifest, the baseline record, the eval lock, stop requests — lives under the OS cache directory (`~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or `~/.cache` on Linux, `%LOCALAPPDATA%` on Windows), keyed by the repository's own canonical path and the `-tag` you chose, never inside the repository itself. `results.tsv` and `run.log` also live in the repository but are gitignored and untracked — plain, human-readable output, not gated artifacts. `.autor3search/config.yaml` is the one exception: `init` writes `.autor3search/*` to `.gitignore` with a `!.autor3search/config.yaml` negation, so the run configuration itself is committed to version history (a KEEP has to stay reproducible and auditable later), while only its hash — not its content — is what the gate chain actually trusts; a hand-edit to it fails the next `eval` rather than silently loosening it.

## The worked example

This is one real, unmodified run of this tool against the demo fixture shipped in `testdata/demo/`: a `countWords` function whose hot loop rebuilds a whole new array on every character —

```ts
// before
chars = chars.concat([c])   // allocates and copies a new array per character: O(n^2) per word

// after
chars.push(c)                // O(1) amortized per character: O(n) per word
```

This is deliberately **not** a string-concatenation fix. Plain `+=` on a JS string is not the bug here — V8 represents concatenated strings as ropes, so it never re-copies on every append the way Go's naked string concatenation does. The bug is expressed with an array instead, because that is what actually costs O(n²) in this runtime.

Running `autor3search-typescript eval --json` against that one commit, on the machine this project was built on:

| | value |
|---|---|
| baseline | 3.59 ms/op |
| candidate | 268 µs/op |
| improvement | 92.55% |
| verdict | **KEEP** (exit 0) |

The same live session then correctly **DISCARDed** a genuine no-op commit (a comment-only change) measured against that *just-advanced* baseline — proving `measureCommit` really moved and the no-op was not coasting on the earlier win — and **FAILed** a scope violation. All three exit codes (0, 1, 2) were observed in that one live run, and the automated end-to-end test in `src/e2e/full-run.test.ts` reproduces the KEEP-then-DISCARD sequence on every run of this project's own test suite.

**How do we know the measurements themselves mean anything, not just that the harness runs?** The measurement layer was checked against a known quantity, not just against itself: a hand-timed 5 ms busy-spin measured back at **5.0002 ms/op**, and a hand-timed 1 ms spin at **1.0001 ms/op**. That is the strongest evidence in this project that the numbers are real — it is checkable, not merely self-consistent.

## What the harness enforces

| if the agent tries to... | what happens |
|---|---|
| edit `package.json`, a lockfile, or `tsconfig.json` | FAIL, unconditionally — immutable regardless of `scope` |
| edit a file outside `scope` | FAIL — scope violation |
| edit a frozen test/spec/bench file to make it pass trivially | the real, original content is restored before the test ever runs; a `WARNING:` line reports what was restored |
| edit `.autor3search/config.yaml` (e.g. loosen `min_effect_pct`) | FAIL — the config hash no longer matches the baseline's |
| add a new, easier benchmark not present at baseline | FAIL — unmanifested file |
| commit source AND a slowed-down benchmark body together, hoping the slow body inflates its own future baseline | after a KEEP, the base worktree is repointed to the candidate commit and then the frozen benchmark bytes are immediately restored over it — so the tampered bench body never survives into the new baseline; every future comparison still measures the same original frozen bytes on both sides |
| let its own change fail the repo's typecheck, build, or test command | FAIL, before anything is measured |
| edit `program.md` | FAIL — scope violation, never in `scope` |
| edit `results.tsv` | nothing stops this, and nothing needs to: it is a gitignored, untracked, human-readable log the harness only ever appends to, never a gated or tamper-evident artifact, and no gate reads it back to make a decision |
| kill the running `eval` process (e.g. `stop -force`) while a benchmark is measuring | the detached measurement child (its own process group) is signalled and the eval lock is released before the process exits, so neither is left orphaned |
| kill and restart the measurement process to hide a crash | CRASH is reported (exit 3), distinct from FAIL — the harness does not let a crashed child silently become "no verdict" |

Anti-cheat evidence, not assertion: each row above was verified by mutation testing during development — the guard was removed, the attack was demonstrated to succeed, the guard was restored, and the attack failed again. Recorded examples: removing the measurement-commit advance made a comment-only no-op commit report KEEP; removing the post-KEEP worktree restore left a doctored benchmark in the base worktree, inflating every subsequent comparison; removing the symlink guard let a content-matching symlink survive `restore` and be mutated afterward; removing the process-group kill left a live orphaned benchmark process running after the harness exited.

## Scoring

Each declared benchmark is measured `count` times per side (baseline and candidate), interleaved and alternating which side goes first each round to cancel ordering bias, using a Mann-Whitney rank-sum test per benchmark and a Bonferroni correction across however many benchmarks are compared. A commit KEEPs only if:

1. at least one benchmark shows a significant (`p < ALPHA / k`) improvement, and
2. no benchmark shows a significant regression past `max_regress_pct`, and
3. the geometric mean of all candidate/baseline ratios beats `min_effect_pct`.

`count` below 4 is refused outright at config-load time: with fewer than 4 rounds per side, the exact rank-sum test cannot report `p < 0.05` no matter how large the true effect is, so every experiment would DISCARD regardless of what changed. The shipped default is 10.

## Limitations — read this before trusting an overnight run

**A KEEP is evidence, not proof.** Any fixed statistical threshold admits false positives; a KEEP means "this cleared the bar the config set," not "this change is definitely faster in production."

**The candidate side's `node_modules` is not integrity-verified.** A Go project gets this for free from `go.sum`, which is checked on every build. npm verifies package integrity only at install time (against `package-lock.json`'s hashes) — once installed, nothing here re-checks that `node_modules` on disk still matches the lockfile before measuring against it.

**JavaScript measurement is noisier than Go's.** JIT warm-up state, garbage-collection timing, and (on Apple Silicon) P/E-core scheduling all add variance a Go binary's more uniform runtime does not have to the same degree. `doctor` reports what it can about the current machine's load, power source, and core mix, but cannot eliminate any of this.

**Concretely, on this project's own dev machine:** three independent measurements of the exact same fixture, on the exact same code, landed at 3.1, 3.198 and 3.59 ms/op — a spread of roughly 15% from run to run, with nothing else on the machine changed. That is the noise floor this tool exists to reason about statistically rather than paper over; it is also why the numbers above are presented as one coherent run, not averaged together into a false precision no single run actually produced.

**No benchmarks, no value.** This tool cannot invent something to measure. It only ever gates and reports what your own `*.bench.ts` files already exercise.

**Discovery is textual, not semantic.** It finds an exported `bench*` function in a `*.bench.ts` file. It does **not** find `export const benchX = someFactory()`, and it does not follow a cross-module re-export of a benchmark function — if your benchmark isn't a literal `export function bench...() { ... }` in the file that declares it, it will not be discovered.

**Microbenchmarks are not your application.** A benchmark that KEEPs proves the benchmark got faster under the exact conditions it constructs. Whether that improvement is visible in your actual application depends on how hot that code path really is there — something this tool has no way to know.

**`count` below 4 can never reach significance,** for the reason given under Scoring above, which is why it is refused at config-load time rather than silently producing a run that can only ever DISCARD.

A performance tool that oversells its own certainty is worse than useless: it launders noise into a verdict a human then trusts. Every claim above is stated as plainly as it can be for exactly that reason.

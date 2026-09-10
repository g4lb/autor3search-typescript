# autor3search-typescript

[![npm](https://img.shields.io/npm/v/autor3search-typescript?label=npm)](https://www.npmjs.com/package/autor3search-typescript)
[![ci](https://github.com/autor3search/typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/autor3search/typescript/actions/workflows/ci.yml)

Let an AI coding agent loose on your repository's performance, without letting it grade its own homework. `autor3search-typescript` freezes your tests and benchmarks, measures every change the agent proposes against a baseline it cannot touch, and only keeps a commit that is a real, statistically significant, material win.

Licensed under the [MIT License](./LICENSE). Copyright (c) 2026 Gal Be.

## Start here

Open your coding agent inside the TypeScript repository you want to make faster, and
paste this:

```text
Install and run autor3search-typescript on this repository, then optimize it.

Setup:
1. npm install --save-dev autor3search-typescript@^0.2.0
2. npx autor3search-typescript init
   Show me the benchmarks it discovered. If it reports none, STOP and tell me:
   this tool can only optimize what it can measure.
3. git add -A && git commit -m "autor3search-typescript init"
4. npx autor3search-typescript doctor
   Show me any warnings. If the machine looks unfit to measure, stop and ask me
   before continuing.
5. npx autor3search-typescript baseline -tag <today, e.g. sep7>
   This runs your install command once per worktree, so dependency install
   time and node_modules disk use both double. That is expected.

Then:
6. Read program.md in this repository, in full. It is your instruction set for
   the rest of this run. Follow it exactly.

Rules for the whole run:
- One hypothesis per commit. Commit before each experiment, then run
  `npx autor3search-typescript eval --json` and apply its verdict before touching
  anything else: KEEP means the commit stays; anything else (DISCARD, FAIL, CRASH)
  means `git reset --hard HEAD~1`.
- Never edit program.md, .autor3search/config.yaml, results.tsv, any
  *.test.*/*.spec.*/*.bench.* file, package.json, a lockfile, or tsconfig.json.
  They are not yours.
- Never pass -force to any autor3search-typescript command. (I may run
  `autor3search-typescript stop -force` myself; that one is mine, not yours.)
- Print one context line before each experiment, so I can see where you are:
  [exp <n> | <branch> | vs <measure_commit> | stop: npx autor3search-typescript stop]

Run the loop until I stop you. I stop you by running
`npx autor3search-typescript stop` in my own terminal — you will see it as
"stop_requested": true in a verdict. When you do: apply that verdict, do not
start another experiment, run `npx autor3search-typescript report`, summarize
what you tried, and exit the loop.
```

That's the whole handoff. The agent installs the tool, discovers your benchmarks,
freezes a baseline, and then follows `program.md` — generated for your repository by
`init` — which tells it how to run the keep-or-discard loop. `program.md` names the
benchmarks in scope, spells out the KEEP/DISCARD/FAIL/CRASH contract, lists everything
the agent must never touch, and ends with a bank of generic V8/TypeScript performance
ideas for when the agent is out of hypotheses.

Two things worth knowing before you start it:

- **It needs benchmarks.** `init` refuses to run without a discovered `bench*`
  function in a `*.bench.ts` file — the tool optimizes what it can measure, and
  refuses to guess.
- **Numbers are only as good as the machine.** Run `doctor` and read it. See
  Limitations below for how much run-to-run noise a JS runtime can add even on an
  idle machine.

## The idea

You do not edit TypeScript to tune performance. You edit `program.md` — the
instructions that drive your agent. The agent edits the TypeScript. The harness
holds the metric, and the agent cannot reach it.

### Who owns what

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

### What you get back

An unattended loop that, commit by commit:

- measures the agent's candidate against a frozen baseline with real, repeated, interleaved timing rounds and a rank-sum significance test — not a single before/after number;
- restores any test, spec or benchmark file the agent edited before running it, so a weakened test can never manufacture a KEEP;
- refuses (FAILs) a change that touches `package.json`, a lockfile, `tsconfig.json`, or a file outside the declared `scope`, before anything is even measured;
- refuses a change that adds a new test/bench file the baseline never saw, closing "add an easier benchmark";
- appends one row per experiment to `results.tsv`, and reports a cumulative, compounding speedup across the whole run.

## Quick start

```bash
npm install --save-dev autor3search-typescript@^0.2.0
npx autor3search-typescript init
# review .autor3search/config.yaml and program.md, then:
git add .autor3search/config.yaml program.md .gitignore && git commit -m "chore: add autor3search-typescript"
npx autor3search-typescript baseline -tag <tag>
# hand the repo and program.md to your agent, using the prompt above
```

`init` refuses to run if it finds no exported `bench*` function in a `*.bench.ts` file, or no `test` script in `package.json` — this tool has nothing to gate or measure without both.

To install from `main` ahead of a release instead of the last published version, use
`npm install --save-dev autor3search/typescript` — the GitHub form works too,
just builds the tool on the way in instead of using a prebuilt tarball.

## Watching a run, and stopping it

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
| `baseline` | Freeze tests/benchmarks, pin two worktrees at HEAD, install and prove it can measure |
| `eval` | Run one experiment through the gate chain and report a verdict (0 KEEP, 1 DISCARD, 2 FAIL, 3 CRASH) |
| `status` | Report where a run is: branch, commits, worktree, experiment counts, in-flight eval, pending stop |
| `stop` | Ask the agent to stop after its current experiment; `-clear` cancels, `-force` also signals the running eval |
| `report` | Summarize `results.tsv`: counts by status, cumulative speedup, largest individual wins |
| `profile` | Run the declared benchmarks under Node's CPU profiler and print the hottest functions |
| `version` | Print which build of the harness this is, and the Node runtime measuring with it |

Every command accepts a leading `-C <dir>` to run as if invoked from `<dir>` (its git repository root is resolved from there).

### Where run state lives

Everything the verdict depends on — the frozen manifest, the baseline record, the eval lock, stop requests — lives under the OS cache directory (`~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or `~/.cache` on Linux, `%LOCALAPPDATA%` on Windows), keyed by the repository's own canonical path and the `-tag` you chose, never inside the repository itself. `results.tsv` and `run.log` also live in the repository but are gitignored and untracked — plain, human-readable output, not gated artifacts. `.autor3search/config.yaml` is the one exception: `init` writes `.autor3search/*` to `.gitignore` with a `!.autor3search/config.yaml` negation, so the run configuration itself is committed to version history (a KEEP has to stay reproducible and auditable later), while only its hash — not its content — is what the gate chain actually trusts; a hand-edit to it fails the next `eval` rather than silently loosening it.

Two git worktrees live there too, both detached and both pinned by the harness: `baseline-worktree` holds the side every candidate is compared against, and `candidate-worktree` is checked out to the commit currently under evaluation. Each has its own installed `node_modules`, so one side's dependencies can never decide the other side's timings — which is the reason for the main cost of a run: dependencies are installed twice, once per worktree, when `baseline` runs. That is sound for the whole run because `package.json` and the lockfile are immutable while it lasts, so no commit the agent makes can invalidate either install.

**Your own checkout is never written to.** `eval` restores the frozen test and benchmark files into the candidate worktree, not into your working tree, so a change the agent committed to a bench file stays visible on disk where you can review it while the frozen bytes are what actually get measured. Measuring a detached checkout rather than the live tree is also what makes the measurement and the commit it is credited to the same thing by construction: nothing can edit the measured directory midway through a timing round.

## Worked example

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

### When the measurement cannot carry the verdict

`eval` prints `WARNING:` lines above its verdict (and a `warnings` array in `--json`) when the statistics behind a result do not support reading it at face value. They never change the decision. Two matter:

- **Too few rounds for a confidence interval.** At 95% confidence the median's interval needs at least 6 observations per side; below that it is unbounded.
- **No KEEP was reachable.** The Mann-Whitney U test has a floor on the p-value it can produce for a given sample size — with `n` rounds per side the smallest attainable two-sided p is `2/C(2n,n)`, however far apart the two samples are. Rule 1 divides `ALPHA` by the number of benchmarks, so enough benchmarks push the corrected threshold below that floor and *every* experiment discards no matter what the agent does. The `count >= 4` floor cannot catch this: it does not know how many benchmarks a run will compare. The warning names the count to raise to, or says to compare fewer benchmarks when no count would clear it.

`base_ns` is **not** fixed for the whole run. `baseline` pins two things that are kept deliberately separate: a FROZEN commit that the frozen tests and the scope gate always compare against (so an agent cannot expand what it may edit by banking experiments), and a MEASUREMENT commit — what `base_ns` is actually measured against — that starts equal to the frozen one and **advances to the candidate's own commit after every KEEP**. So `score` always answers "did *this* experiment help, compared to the last thing that was kept," never "is the tree better than when the run started." Without this, once one real improvement was kept, every later experiment — however useless — would keep comparing against that same stale starting point, and a no-op could coast to a KEEP on an earlier win it did not contribute to.

One consequence: each kept `score` is only that experiment's own incremental contribution, so `report`'s cumulative speedup is the **product** of every kept score, not the latest one alone — successive real improvements compound the way percentage changes do.

## Limitations

**A KEEP is evidence, not proof.** Any fixed statistical threshold admits false positives; a KEEP means "this cleared the bar the config set," not "this change is definitely faster in production."

**The candidate side's `node_modules` is not integrity-verified.** A Go project gets this for free from `go.sum`, which is checked on every build. npm verifies package integrity only at install time (against `package-lock.json`'s hashes) — once installed, nothing here re-checks that `node_modules` on disk still matches the lockfile before measuring against it.

**JavaScript measurement is noisier than Go's.** JIT warm-up state, garbage-collection timing, and (on Apple Silicon) P/E-core scheduling all add variance a Go binary's more uniform runtime does not have to the same degree. `doctor` reports what it can about the current machine's load, power source, and core mix, but cannot eliminate any of this.

**Concretely, on this project's own dev machine:** three independent measurements of the exact same fixture, on the exact same code, landed at 3.1, 3.198 and 3.59 ms/op — a spread of roughly 15% from run to run, with nothing else on the machine changed. That is the noise floor this tool exists to reason about statistically rather than paper over; it is also why the numbers above are presented as one coherent run, not averaged together into a false precision no single run actually produced.

**No benchmarks, no value.** This tool cannot invent something to measure. It only ever gates and reports what your own `*.bench.ts` files already exercise.

**Discovery is textual, not semantic.** It finds an exported `bench*` function in a `*.bench.ts` file. It does **not** find `export const benchX = someFactory()`, and it does not follow a cross-module re-export of a benchmark function — if your benchmark isn't a literal `export function bench...() { ... }` in the file that declares it, it will not be discovered.

**Microbenchmarks are not your application.** A benchmark that KEEPs proves the benchmark got faster under the exact conditions it constructs. Whether that improvement is visible in your actual application depends on how hot that code path really is there — something this tool has no way to know.

**`count` below 4 can never reach significance,** for the reason given under Scoring above, which is why it is refused at config-load time rather than silently producing a run that can only ever DISCARD.

A performance tool that oversells its own certainty is worse than useless: it launders noise into a verdict a human then trusts. Every claim above is stated as plainly as it can be for exactly that reason.

### Repos with no benchmarks

`init` discovers benchmarks by scanning the repository for `*.bench.ts` files and looking for exported functions named `bench*`. If it finds none, it refuses to write `.autor3search/config.yaml` and exits with an error, rather than generating a config with an empty `benchmarks:` list that would silently optimize nothing.

That refusal is deliberate: this tool has no other notion of "faster." The verdict — KEEP, DISCARD, FAIL, CRASH — is entirely a function of the declared benchmarks' timings across a baseline and a candidate. No benchmarks means no signal to gate on, at which point every candidate would either be rejected for no reason or accepted for no reason.

To use `autor3search-typescript` on a repository like this:

1. Write at least one benchmark covering the code you actually want made faster — a plain exported function in a `*.bench.ts` file:

   ```ts
   export function benchThing(): void {
     thing()
   }
   ```

2. Benchmark the right thing. A benchmark that exercises a cold path, a trivial helper, or a function nobody calls under load produces numbers that are entirely real and entirely useless — confident percentages attached to work that was never the bottleneck. Benchmark the function, loop, or request path that actually dominates the workload you care about, ideally informed by `profile` or a profile of the real program rather than a guess.
3. Re-run `init` once the benchmark exists. It will pick it up and proceed normally.

## License

MIT © 2026 Gal Be

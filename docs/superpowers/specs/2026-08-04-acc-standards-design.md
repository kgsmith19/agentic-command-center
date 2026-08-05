# ACC engineering standard — design (cross-cutting, sub-projects A–J)

- date: 2026-08-04
- status: approved (Kyle, 2026-08-04: "same rules for leanness, high ROI, PDD,
  SDD, TDD, unit tests, integration tests, e2e. Red gates and true objective
  gates as tests that are constructed first")
- scope: the rules every other spec in this wave cites instead of restating
- applies to: every repo created by sub-project **J**, and to every slice in
  sub-projects A, B, C, D, E, F, G, H, I

This document exists so the other nine specs can say "standard applies" in one
line instead of repeating three pages each. It is **not** a sub-project. It has
no slices of its own. Sub-project J's first slice materialises it as a real,
executable gate set (`agent-repo-gates`); until then it is the checklist a
reviewer holds a slice against.

## 1. What counts as a slice

A slice is the unit of work every plan in this wave is decomposed into. A slice
that cannot satisfy all nine of these is too big and must be split:

1. **One behaviour.** Not "one file", not "one feature" — one observable
   behaviour a person could describe in a sentence without the word "and".
2. **Explicit acceptance criteria**, numbered `AC-n`, each written against an
   observable, never against a value we ourselves wrote.
3. **RED first.** The test is written and *observed failing* before the
   implementation exists. The red output is recorded in the slice's evidence.
4. **Smallest credible change.** Reuse before abstraction. No speculative
   generality, no V2/parallel copies, no layer added "for later".
5. **All gates green** (section 3) before the slice is called done.
6. **Integrated into the real workflow** — reachable by the real consumer, not
   only by its test.
7. **Evidence recorded**: the exact commands run and their exact output.
8. **Context preserved** — the slice leaves the repo readable by an agent that
   has not seen the rest of this wave.
9. **Cleaner than before.** Net complexity does not rise.

## 2. PDD, SDD, TDD — what each actually means here

Kyle named three disciplines. They are not synonyms and each has a distinct
obligation:

**SDD — spec-driven.** No slice exists that is not traceable to an `AC-n` in an
approved spec in `docs/superpowers/specs/`. A slice that discovers new required
behaviour stops, amends the spec, and resumes. Code that no spec asked for is
scope creep even when it is good code.

**TDD — test-driven.** RED → GREEN → refactor, per slice, with the red run
recorded. A test written after the code it tests is a *characterisation* test
and must be labelled as one; it does not satisfy this rule.

**PDD — property-driven.** For every module holding invariants rather than
examples, at least one property test asserting the invariant over generated
input, not over three hand-picked cases. The properties this system needs:

| Module class | Invariant that must hold for all inputs |
|---|---|
| path policy (`guard.mjs`) | no input string resolves to a write outside `writeRoots` |
| identity (`standing.mjs`) | `(pid, startTime)` never matches a different console |
| concurrency (`lane.mjs`) | never more than `max` holders, for any interleaving |
| budget bands (`budget.mjs`) | band is monotonic in token count |
| ledger | append-only; no observable sequence loses or reorders a record |
| serialisation (store round-trip) | `parse(write(x))` deep-equals `x` |

Property tests use a seeded generator so a failure is reproducible; the seed is
printed on failure and pinned in the regression test that follows.

## 3. The gate set

Every repo created by J ships these, and every slice in every sub-project must
pass them. They are objective — a human's opinion cannot turn one green.

| Gate | Command | Floor |
|---|---|---|
| unit + integration | `npm test` | all pass, zero skips without a ledgered reason |
| coverage | `node covgate.mjs` | changed files: 100% line, 100% function, 90% branch |
| test plan | `node testplan.mjs` | every `AC-n` in the slice's spec maps to a named test |
| lint/format | repo default | clean |
| e2e | `npm run e2e` | green on the tier the slice touches |
| pre-push | `.git/hooks/pre-push` | runs unit + coverage locally; refuses the push otherwise |
| CI | GitHub Actions | the same set, on every PR; merge only on green |

**Test tiers.** Three, and a slice declares which it needs:

- **unit** — pure, hermetic, no I/O, milliseconds. Every module.
- **integration** — real filesystem, real child processes, real store, no
  network and no real API tokens. Bounded by wall-clock ceilings.
- **e2e** — the real thing: real Claude Code sessions, real pty, real browser
  (Playwright). Two sub-tiers, per the existing autonomy-hardening precedent:
  *hermetic e2e* runs in CI; *real-token e2e* runs on demand and its output is
  archived, never inferred.

## 4. The four standing prohibitions

Restated from the master plan because every slice in this wave is measured
against them:

1. **Evidence before assertion.** No criterion is satisfied by reading back a
   value we wrote. Configuration is not behaviour. The canonical failure never
   to repeat is `4af8cd6`: a regex over a scheduled task's own arguments printed
   "no console window will appear" while the window kept appearing for a day.
2. **Every control reaches its real consumer.** UI → store → policy → hook →
   observable behaviour change. Proving a control changed a stored value proves
   nothing. Sub-project **F** is the enforcement arm of this rule.
3. **Human escalation is the last resort.** A missing capability is a thing to
   build. An escalation must document the blocker, every attempt, why each
   failed, the specific external constraint, the smallest action Kyle must take,
   and what would have to change for it to become automated.
4. **No trickery.** Never weaken a gate, redefine success, silence an error,
   delete a failing test, or mark incomplete work complete. A test born green
   proves nothing; every test must be able to fail against a genuine regression.

## 5. What every repo ships with

J's acceptance criteria enforce this per repo. Listed here once:

- `AGENTS.md` — the front door: stack, commands, engineering standards, and the
  repo's own boundary statement ("this repo owns X; it does not own Y").
- `README.md` — what it is, in the first sentence.
- `OPEN-ISSUES.md` — seeded from the shared template, even when empty.
- `agent-repo-gates` as a dev dependency, wired to `npm test`, `npm run gates`.
- `.github/workflows/ci.yml` — the gate set on every PR.
- `hooks/pre-push` installed by `npm run setup`, pinned to LF, mode 100755.
- A GitHub remote under `kgsmith19/`, created and pushed — a repo that exists
  only locally does not satisfy J.

## 6. Worktrees

Every sub-project is implemented in its own git worktree, per Kyle
(2026-08-04, "use worktrees"), via `superpowers:using-git-worktrees`. Branch
naming: `acc/<letter>-<slug>`, e.g. `acc/j-decomposition`. Rationale: several
sub-projects touch the same files (J moves them, E rewrites them, G adds tests
to them) and worktrees keep a half-finished migration from blocking an
unrelated slice.

One worktree per sub-project, not per slice. Slices land as commits on the
sub-project's branch and the branch merges only on green.

**Concurrency is the point, not a side effect.** Kyle, 2026-08-04: *"don't forget
to utilize worktrees as much as possible when you have a lot of work that can be
going on concurrently."* The master plan's execution order is a wave diagram, not
a queue: everything inside a wave runs at once in its own worktree, and only wave
boundaries are barriers. Before serialising two sub-projects, the plan must state
which files they actually contend for — "it feels safer sequentially" is not a
dependency.

Two things do force serialisation and both are named in the master plan: a
sub-project that **moves or renames files** (J) cannot run beside anything, and
two sub-projects that **design the same screen** (D and E) must not run beside
each other.

## 7. Acceptance criteria for this document

This spec is cross-cutting, so its ACs are verified by J's first slice rather
than on their own:

| AC | Statement | Test |
|----|-----------|------|
| AC-S1 | `agent-repo-gates` exports every gate in section 3 as a runnable command | its own unit suite |
| AC-S2 | A repo missing any section-5 artifact fails `npm run gates` | integration, fixture repo missing each artifact in turn |
| AC-S3 | `testplan` fails when a spec `AC-n` has no named test | integration, fixture spec with an unmapped AC |
| AC-S4 | The property-test helper reports its seed on failure | unit, forced failure |

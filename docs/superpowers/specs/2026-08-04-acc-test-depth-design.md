# Test-depth program — design (sub-project G)

- date: 2026-08-04
- status: approved (Kyle, 2026-08-04)
- scope: give every module a documented scenario pass, and add the test tiers
  coverage floors cannot reach
- standard: `2026-08-04-acc-standards-design.md` applies in full
- ledger: guards `OI-019` (1/12 modules done), `OI-025`

## What this fixes

`covgate`'s 100/100/90 floors prove every line and branch of a changed file
*executes at least once*. They do not prove the suite covers the scenario space a
reliability kernel needs. Kyle, verbatim: *"so many individual units… so many
connective parts… the flow can change or be unpredictable… we must lock it and
harden it as much as possible… we don't want to trick the tests, we truly want to
be objective."*

The pass already pays for itself. The first module audited — `kernel/guard.mjs`,
the deny-by-default boundary — turned up a **real, live bypass**, not a
hypothetical: `norm()` did a raw string-prefix match with no `..` resolution, so
`C:/work/src/../../code/guards/policy.json` textually started with an allowed
`writeRoots` entry and was **allowed**, while the actual OS-resolved write landed
in guard machinery. That is one module of twelve.

## The structural idea

A test-depth program driven by diligence decays the moment attention moves. So G
uses the same mechanism as A and F: **a registry the gate enumerates, so an
unaudited module is a failure rather than an omission.**

Every module carries a scenario record at `<module>.scenarios.md`. The gate walks
the source tree, and a module with no record — or a record whose axes are
unanswered — fails. Adding a module without auditing it becomes impossible rather
than merely discouraged.

## The six axes

Every module's record answers all six. This is OI-019's own vocabulary, made into
a form:

| Axis | The question |
|---|---|
| **standard** | the documented happy path, for every entry point |
| **non-standard** | valid but unusual input: empty, huge, unicode, deeply nested, wrong-but-parseable type |
| **edge** | boundaries: zero, one, max, off-by-one on every threshold and window |
| **rare** | timing and ordering: concurrent calls, reentrancy, out-of-order arrival, clock jumps, PID reuse |
| **error** | every failure the module can raise, and every failure it can receive |
| **fault-tolerance** | the environment breaking underneath: disk full, file locked, permission denied, process killed mid-write, partial/corrupt state on disk |

Each answer is either a named test or an **explicit, dated, reasoned "not
applicable"**. "Not applicable" is a legitimate answer and a poor default; the
gate reports the ratio per module so a record that is all N/A is visible rather
than green.

## The tiers Kyle named that do not exist yet

Unit, integration and e2e exist. These five do not, and each gets a home:

- **Property-based** — per the standard's invariant table. Seeded, reproducible,
  seed printed on failure and pinned into the regression test that follows.
- **Persistence** — every on-disk store round-trips, survives a process kill
  mid-write, and refuses to load a corrupt file silently. Applies to the standing
  orders store, ledger, tamper baseline, lane state, cap state.
- **Failure-recovery** — kill each long-running process at each phase and assert
  the system converges: autopilot, pty host, UI server, runner. "Converges" means
  a defined end state, not "does not crash".
- **Long-running stability** — a soak tier: the loop running for hours with the
  store, log and memory footprint asserted bounded. Run on demand, output
  archived. This is where the six-accumulated-stale-orders defect would have been
  caught before Kyle noticed it.
- **Security** — the negative tests: guardrails deny traversal, the UI refuses
  foreign origins and missing tokens, the runbox refuses to run what it should
  not, no secret reaches stdout or a log.

**Workflow and usability** tests from Kyle's list are covered by E's e2e
(AC-E22's full path) and E's accessibility gates rather than a separate tier;
duplicating them here would be two owners for one behaviour.

## Module order

By risk, continuing OI-019's stated order. Post-J each module lives in its new
repo; the record travels with it.

1. `guardhook` (the enforcement hook) — 2. `run` — 3. `ledger` — 4. `verifier` —
5. `autonomy` — 6. `policy` — 7. `contract` — 8. `credentials` — 9. `adapter` —
10. `adapters/claude-code` — 11. `settings`

Then the modules OI-019 never listed because they were outside the kernel, and
which carry at least as much risk: `standing` (was `goal`), `autopilot`, `lane`,
`budget`, `usage`, `engine`, `tamper`, `traceability`, `runner`, the UI server.

`guard.mjs` is done and its record is written retroactively to the same template,
so the format is proven against a completed audit before eleven more are written.

## OI-025

The deferred real-token `e2e/loop.e2e.mjs` run came back 1/5, and the ledger
records the four failures. G owns finishing that: each failing scenario is either
fixed and re-run green, or re-classified with evidence. Scenario 3's stale
`OI-011` label in the suite's own output is corrected as part of the same slice —
a test that reports the wrong issue id sends the next reader to the wrong place.

## Acceptance criteria

| AC | Statement | Test |
|----|-----------|------|
| AC-G1 | A module with no `.scenarios.md` fails the gate | integration, fixture tree |
| AC-G2 | A record with an unanswered axis fails the gate | integration |
| AC-G3 | "Not applicable" requires a reason and a date | unit |
| AC-G4 | The gate reports the N/A ratio per module | integration |
| AC-G5 | Every named test in a record exists and is executed by the suite | integration — catches a record naming a test nobody wrote |
| AC-G6 | All 11 remaining kernel modules have complete records | integration, real tree |
| AC-G7 | `guard.mjs`'s retroactive record matches the template | integration |
| AC-G8 | Every invariant in the standard's table has a property test | integration, table-driven |
| AC-G9 | Property failures print a reproducible seed | unit, forced failure |
| AC-G10 | Every on-disk store round-trips over generated content | property, one per store |
| AC-G11 | Every store survives a kill mid-write with no silent corruption | integration, real kills |
| AC-G12 | A corrupt store file fails loudly, never loads as empty | integration, one per store |
| AC-G13 | Each long-running process, killed at each phase, converges to a defined state | integration, phase matrix |
| AC-G14 | The soak tier runs the loop for ≥2 h with store, log and RSS bounded | on-demand, archived output |
| AC-G15 | Security negatives pass: traversal denied, foreign origin refused, missing token refused, no secret in any log | integration |
| AC-G16 | Every scenario in `loop.e2e.mjs` is green, or re-classified with recorded evidence | real-token run, archived |
| AC-G17 | No test asserts on a value the test itself wrote as its only assertion | review gate, applied per record |
| AC-G18 | Every repo from J carries the gate and passes it | CI, per repo |

AC-G5 and AC-G17 are the anti-trickery criteria. AC-G5 catches a record that
claims coverage that does not exist; AC-G17 catches the failure mode this repo
has already shipped once — asserting on configuration and reporting it as
behaviour.

## Out of scope

- Raising `covgate`'s floors. Line coverage is not the constraint; scenario
  breadth is, and a higher floor would buy motion instead of assurance.
- Mutation testing. Genuinely the right next tool once records exist, and adding
  it now would be a second incomplete program. Logged as a follow-up rather than
  half-built.

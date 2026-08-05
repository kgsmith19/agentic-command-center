# ACC completion — master plan

- date: 2026-08-04
- source: Kyle's "finish ACC" prompt, archived verbatim at
  `runner/goals/done/g-20260804-222717-lu7o.json`, plus his follow-ups
  ("go with your top tier recommendation and execute", "ultra lean and thin
  slices", "plan, spec all things early", and 2026-08-04: "Absolutely
  everything and use worktrees. Everything means everything. specs, plans All
  numbers/letters. Don't miss a single thing. Make the slices very thin too.")
- status: living. This file is the **authoritative work list**. A session
  resuming this work reads THIS, not the original prompt.

## Standing rules (extracted once, so the long prompt never needs re-reading)

1. **Evidence before assertion.** No acceptance criterion is satisfied by
   reading back a value we ourselves wrote. Configuration is not behaviour.
   The canonical failure to never repeat: `4af8cd6` regex-matched a scheduled
   task's own arguments and printed "no console window will appear" while the
   window kept appearing for another day.
2. **Every control must reach its real consumer.** UI -> store -> policy ->
   hook -> observable behaviour change. Proving a UI control changed a stored
   value proves nothing on its own.
3. **Ultra-thin slices.** One behaviour, explicit acceptance criteria, RED test
   first, smallest credible change, evidence it works.
4. **Human escalation is the last resort.** A missing capability is a thing to
   build, not a reason to stop. Escalation must document the blocker, every
   attempt, the specific external constraint, and the smallest action needed.
5. **Log what is not fixed.** Anything surfaced and not fixed in the same turn
   goes to the right `OPEN-ISSUES.md`. Chat is not a ledger.
6. **No trickery.** Never weaken a gate, redefine success, silence an error, or
   mark incomplete work complete. A test born green proves nothing.

The full engineering standard these compress —  slice definition, what PDD/SDD/TDD
each oblige, the gate set, the test tiers, what every repo ships with, and the
worktree convention — is
`docs/superpowers/specs/2026-08-04-acc-standards-design.md`. Every spec below
cites it instead of restating it.

## Ordering rationale

Kyle's own priority ranking: safety/security, broken core workflows, data loss,
autonomy blockers, reliability, control/recoverability, usability,
maintainability, performance, ROI.

**A** runs first because every later decision depends on a trustworthy
inventory. **B2b** follows because it is small, already specified, and its
`(pid, startTime)` identity is reused by D's session anchor. **J** runs third
because it moves every file and renames the vocabulary the remaining specs are
written in — everything after it is written against the post-J names. **H** runs
last so the charter describes a system that has stopped moving.

## Sub-projects

Status as of 2026-08-04: **all nine specs and all nine plans written; none
implemented.** 150 acceptance criteria across the specs; 6 are B1/B3 criteria
already satisfied by `773005e`, and all 144 remaining are claimed by a named plan
task. That mapping is machine-checked — every `AC-n` in a spec must appear in a
plan, and the check is re-run before any sub-project is called done.

### A — complete ranked inventory
Plan: `plans/2026-08-04-acc-a-inventory.md` (11 tasks)
Spec: `specs/2026-08-04-acc-inventory-design.md` (14 ACs)
One deduped, ranked, regenerable inventory across all five `OPEN-ISSUES.md`
ledgers, `docs/`, and the archived prompt's 22 Definition-of-Done conditions.
The ledger ranks itself via a new `rank:` field; the tool sorts and never judges.
`C:\code` `OI-016` (a real work-item tracker) is explicitly **not** solved here.

### B — the named defects  [B1/B2a/B3 DONE `773005e`; **B2b remains**]
Plan: `plans/2026-08-04-acc-b2b-console-identity.md` (7 tasks)
Spec: `specs/2026-08-04-acc-known-defects-design.md`
Only B2b is left: `OI-034`, console identity by `(pid, startTime)`. Chosen
design, already recorded: autopilot passes the live console table into the
standing-order module rather than that module reaching out to the OS per cycle.
B1 (S4U principal, no desktop), B2a (reaping) and B3 (`dialcheck`) are committed
and verified live.

### J — service decomposition and naming migration  (absorbs **C**)
Plan: `plans/2026-08-04-acc-j-decomposition.md` (12 tasks)
Spec: `specs/2026-08-04-acc-decomposition-design.md` (15 ACs)
Six repos: `agent-repo-gates`, `agent-guardrails`, `claude-session-telemetry`,
`agentic-command-center`, `agentic-command-center-ui`, `claude-launch-cap`.
Separate repos everywhere; network boundaries only where a process boundary
already exists. Renames: `goal`→**standing order**, `clearbot`→**autopilot**,
`guards`→**guardrails**, `kernel/`→**`core/`**, folder `C:\code\guards`→
`C:\code\agentic-command-center`. Absorbs **C** (`OI-026`) because C and J are
the same migration performed twice. The enabling mechanism is per-repo
`install-hooks` installers, so no absolute path is ever hand-written again.

### I — autonomy posture and tamper-evidence
Plan: `plans/2026-08-04-acc-i-tamper-evidence.md` (9 tasks)
Spec: `specs/2026-08-04-acc-autonomy-posture-design.md` (14 ACs)
`OI-032`. Kyle's decision, 2026-08-04: **accept the authority, make its use
impossible to miss.** Prevention was rejected on the merits — text-scanning is
assertion-on-configuration, and a restricted execution identity defeats the
runbox's purpose. Ships: honest docs, a hashed baseline of every protected path
with attribution against `approvals.log`, and a widened protected set.

### F — setting-traceability harness  (absorbs `OI-033`)
Plan: `plans/2026-08-04-acc-f-traceability.md` (10 tasks)
Spec: `specs/2026-08-04-acc-traceability-design.md` (15 ACs)
The enforcement arm of standing rule 2. Seven links per setting, L5 (behaviour
actually changes, proven by A/B observation) being the load-bearing one. Built
on completeness enforcement: any key in a real config file that is not in the
registry fails the gate. Absorbs `dialcheck.mjs` rather than duplicating it, and
must end `OI-033` honestly — the route hook is root-caused and restored, or
retired and its dial deleted. A dial left permanently `false` pointing at an
unregistered hook is not an acceptable end state.

### D — emergency STOP + intervention controls
Plan: `plans/2026-08-04-acc-d-stop-intervention.md` (10 tasks)
Spec: `specs/2026-08-04-acc-stop-intervention-design.md` (21 ACs)
Kyle's scoping rule: STOP kills what this session started — provenance, not
process name. Session anchor is `(pid, startTime)` of the pty child, reusing
B2b. Autopilot is ACC-started so it gets its own separate control, in a
different region. Press-and-hold 600 ms with an accessible keyboard equivalent.
Every activation records the pid list and each pid's confirmed post-kill state;
survivors are reported as `partial`.

### E — web UI completion + first-principles redesign
Plan: `plans/2026-08-04-acc-e-ui-redesign.md` (9 tasks)
Spec: `specs/2026-08-04-acc-ui-redesign-design.md` (22 ACs)
Information architecture is Kyle's own five modes: **Watch / Work / Take over /
Set up / Look back**. Seven tabs audited down to five modes with strictly more
reachable. Every identifier renders through a component that explains its
purpose and where it is stored and logged. No framework, no build step. WCAG 2.2
AA with zero axe violations as the gate. Loopback-only, run-token, strict CSP.

### G — test-depth program
Plan: `plans/2026-08-04-acc-g-test-depth.md` (8 tasks)
Spec: `specs/2026-08-04-acc-test-depth-design.md` (18 ACs)
`OI-019`, 1/12 modules done. Per-module `.scenarios.md` records across six axes,
enumerated by a gate so an unaudited module fails rather than being forgotten.
Adds the five tiers Kyle named that do not exist yet: property-based,
persistence, failure-recovery, long-running stability, security. Owns finishing
`OI-025`'s 1/5 real-token run.

### H — Albert charter
Plan: `plans/2026-08-04-acc-h-albert-charter.md` (9 tasks)
Spec: `specs/2026-08-04-albert-charter-design.md` (14 ACs)
All eleven elements Kyle enumerated. The half that makes it real: **every
obligation clause names its mechanism**, and a gate proves that mechanism exists
and is tested. The compact SessionStart block is generated from `ALBERT.md` so
they cannot drift, size-capped, and proven to reach a live session. Kyle's exact
closing statement is recorded verbatim and gated so it cannot be emitted while
any acceptance criterion is unproven.

## Execution order — waves, not a queue

Kyle, 2026-08-04: *"don't forget to utilize worktrees as much as possible when
you have a lot of work that can be going on concurrently."* So the order below is
the **dependency graph**, not a single file of work. Everything inside a wave
runs concurrently in its own worktree; only the wave boundaries are barriers.

```
wave 1  (parallel)   A          B2b         G-kernel
wave 2  (barrier)              J
wave 3  (parallel)   I          F           G-rest
wave 4  (serial)               D  ->  E
wave 5                         H
```

| Wave | Runs concurrently | Why it is safe together | Barrier after |
|---|---|---|---|
| 1 | **A** (docs + `tools/`), **B2b** (`goal.mjs` only), **G-kernel** (new `*.scenarios.md` + additive tests) | three disjoint file sets; none renames or moves anything | J needs B2b landed — it renames the file B2b edits, and D reuses its identity |
| 2 | **J** alone | J moves every file in the repo; anything concurrent would conflict on every merge | everything after is written against post-J names and paths |
| 3 | **I** (`core/tamper.mjs`), **F** (`core/traceability.mjs`), **G-rest** (per-module records) | three new modules, disjoint; the one shared file is `config.json`, and only I writes it | E's controls must map to F's registry (AC-F14/AC-E12) |
| 4 | **D**, then **E** | both live in `agentic-command-center-ui` and E's *Take over* mode is D's home — running them concurrently means two designs for one screen | |
| 5 | **H** alone | the charter must name mechanisms that have stopped moving | |

Worktree per sub-project, branch `acc/<letter>-<slug>`, created via
`superpowers:using-git-worktrees`. Slices land as commits on that branch; the
branch merges only on green. Post-J, worktrees are per repo — a sub-project that
touches two repos gets a worktree in each, and its plan says which slice lands
where.

D and E are the one pair that could have been parallel and deliberately are not:
they share a screen, and two agents designing one screen concurrently produces
two designs.

## Definition of done

Every sub-project's acceptance criteria pass with recorded evidence (137 ACs
across the nine specs); every ledger entry is fixed, shrunk-and-fixed, or
explicitly retired with a reason; the full gate set green in every repo; the
relevant proof scenarios green where loop behaviour changed; and H's AC-H13
satisfied — the closing statement is unreachable until all of the above is true.

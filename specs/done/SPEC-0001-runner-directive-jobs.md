---
title: The runner runs a directive headless to completion
spec_id: SPEC-0001-runner-directive-jobs
slice: SL-007
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07
owner: Kyle Smith
traces: [FR-011, FR-005, FR-004]
---

# SPEC-0001: The runner runs a directive headless to completion

## 1. In one sentence

`node runner/runner.mjs directive:<id>` runs an active directive as a headless loop — fresh context per run, progress carried by the directive log — until the directive itself reports `done`/`blocked`, holding all runs while the week token tier is red.

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | FR-011 (and FR-005's brake on the new path) |
| What becomes possible | A directive completes overnight with no console, no keystrokes, no pipe — the enabler for deleting the entire keystroke stack (SL-011) |
| Why this slice first | Every deletion in ADR-0004 sits behind it; ADR-0001 sized it at ~100 LOC because the hard part already exists |
| What we learn | Whether the existing `ACC_DIRECTIVE` SessionStart injection genuinely carries continuity headless (F1, SL-008, proves it on real tokens) |

## 3. Scope

### 3.1 In scope

- `loadDirectiveJob(id)` — synthesize a runner job from the directive store (workdir = directive `cwd`, bootstrap = the kick constant, defaults identical to file jobs).
- `ACC_DIRECTIVE` set in the spawned child's env for directive jobs, so `hooks/budget.mjs`'s existing `directiveContext` injects text + log tail + done/blocked protocol. Zero new protocol text.
- `boardState` gains a directive branch: done = directive no longer active; progress hash = cycles + log content.
- After each run, the runner appends the run's result tail to the directive log (`appendCycle`) — continuity for the next fresh context, and an honest progress signal.
- Red-tier hold: before each directive run, check the week tier; red → alert + stop (exit 5). Injectable for tests, real check via `hooks/usage.mjs`.
- The kick constant moves to `hooks/directive.mjs` (`KICK_TEXT`) — canonical owner; `budget.mjs` imports it (3rd caller: runner).

### 3.2 Out of scope

| Not doing | Why not | Where it goes |
|---|---|---|
| Deleting clearbot/PtyHost/etc. | Gated on the F1 proof per ADR-0001 | SL-011 |
| Scheduling directive jobs via `--install` | Directives are ad-hoc, not daily jobs; refuse instead | never (revisit only on real need) |
| GUI surface for launching headless directives | GUI work is its own slice | SL-009 |
| Console-path changes (clearbot still works today) | Both transports coexist until SL-011 | SL-011 |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | An active directive `d1` with `cwd:/tmp/w`, text "fix the tests" | `loadJob("directive:d1")` | Job has `workdir:/tmp/w`, `directiveId:"d1"`, `bootstrap` = `KICK_TEXT`, `maxStuck:3`, `maxRuns:100`, `runTimeoutMin:180`, `name:"directive-d1"` | FR-011 |
| AC-002 | A directive with no `cwd` | `loadJob("directive:d2")` | Throws naming the missing working folder; no job object | FR-011 |
| AC-003 | A directive that is done/archived/nonexistent | `loadJob("directive:gone")` | Throws "not active"; no job object | FR-011 |
| AC-004 | A directive job | `runClaudeOnce` spawns the child | Child env contains `ACC_DIRECTIVE=<id>` (proven via a fake `claude` that prints its env); a file job's child env does NOT | FR-011 |
| AC-005 | A directive job mid-loop | The directive's status leaves `active` (model ran `directive.mjs done`) | Loop exits 0, "queue complete" logged | FR-011 |
| AC-006 | Two consecutive runs whose closing summaries are identical | Loop continues | `stuck` increments (a model repeating itself verbatim is the stuck mode); a differing summary resets it; `maxStuck` reached → alert + exit 2. The hash covers the last cycle's BODY only — never its timestamp/header, which change every run | FR-011 |
| AC-007 | A directive run finishes with result text "did X" | The loop's post-run step | Directive log gains a cycle entry containing "did X"; `cycles` incremented by exactly 1 | FR-011 |
| AC-008 | Week tier is red | Loop would start a run | No spawn happens; alert written; exit 5 | FR-005 |
| AC-009 | Existing file-based jobs | Full runner + fast tier suite | Behavior unchanged (regression) | FR-004 |
| AC-010 | `--install` on a directive job | CLI invoked | Refused with a clear error, nothing registered | FR-011 |

## 5. Properties

| ID | Property | Kind | Traces to |
|---|---|---|---|
| PROP-001 | For any directive in any non-`active` status (done, blocked, dead) or absent, `loadDirectiveJob` throws — a run can never start against it | invariant | FR-011 |
| PROP-002 | One runner run appends at most one cycle entry; `cycles` after N runs ≤ N + starting value | conservation | FR-011 |

## 6. Budget

~80 prod LOC across `runner/runner.mjs` and `hooks/directive.mjs` (constant move). Tests: extend `runner/runner.test.mjs`. Coverage floors per `policy.json` on both changed files.

## 12. Done when

All ACs green (red-first, in `runner/runner.test.mjs`), covgate passes on the in-process-gateable changed files (`runner/runner.mjs`, `hooks/directive.mjs`; `hooks/budget.mjs`'s 2-line constant import is structurally ungateable — its subprocess suite proves it instead, tracked as issue #26), `npm test` no new failures, docs (`runner/README.md`, `AGENTS.md` directive section, TEST-LEDGER) updated in the same commit. PRD FR-011 stays `in-progress` until SL-008's real-token F1 proof — this slice delivers the mechanism, not the claim.

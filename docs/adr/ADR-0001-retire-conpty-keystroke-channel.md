---
title: Retire the ConPTY/keystroke continuity channel in favor of the headless runner
status: accepted
scope: repo
created: 2026-08-07
updated: 2026-08-07
owner: Kyle Smith
traces: [FR-004, UC-002]
supersedes: none
superseded_by: none
---

# ADR-0001: Retire the ConPTY/keystroke continuity channel in favor of the headless runner

> Condensed from `docs/2026-08-03-acc-adversarial-review.md` (deleted; full text in git history). Raised 2026-08-03; **accepted in direction by Kyle 2026-08-07** ("we need to migrate it to something much much much better as what we are doing is not that great"). Direction is decided; the migration itself is future work with its own spec — nothing has been deleted yet.

## Context

ACC survives a Claude Code context-limit `/clear` by typing into a live Windows console: `watcher/clearbot.ps1` sends real keystrokes/pipe writes, `hooks/directive.mjs` binds a directive to the console's PID, and `gui/PtyHost.cs` hosts an embedded ConPTY terminal. This mechanism works today (`kernel/README.md`'s two invariants: continuity is console-PID not session-id; nothing but fixed constants is ever typed) but is roughly 1,400+ LOC plus 1.1 MB of vendored terminal assets, and is the origin of most of the directive-loop's historical bugs (closed: OI-002, OI-003, OI-004, OI-009, OI-010, OI-012; still open: issues #13, #14 filed 2026-08-07). A separate, already-built, already-tested headless mechanism (`runner/runner.mjs`, `claude -p` per job, fresh context by construction, 39 tests) exists in the same repo and has never been wired to the directive store.

## Decision

We migrate directive continuity off the ConPTY/keystroke channel and onto the headless runner: wire `runner.mjs` to the directive store (set `ACC_DIRECTIVE`, read `done`/`blocked` instead of scraping a console), then retire `sendconsole.ps1`, `winfind.ps1`, the typing core of `clearbot.ps1`, `gui/PtyHost.cs`, `term.html`, and `gui/vendor/` in that order. Kyle accepted this direction 2026-08-07. The migration is real, multi-session work and gets its own spec under `specs/active/` before any code moves — per this repo's own STOP conditions, not as a side effect of another change.

## Options considered

| Option | How it works | Maturity cost | Migration cost if we leave | Lock-in | Ecosystem gaps |
|---|---|---|---|---|---|
| **Keep ConPTY/keystroke channel (current)** | Type `/clear` + a fixed resume phrase into a live console bound by PID | Proven in production since 2026-07-31; 0 automated PowerShell/C# coverage | n/a (status quo) | Windows-only, ConPTY-specific | No test harness exists for the PowerShell/C# surface at all |
| Migrate to `runner.mjs` (headless) | `claude -p` per job, fresh context, no console, no keystrokes | Already built and tested (39 tests) but never run against real unattended work | ~100 LOC to wire `ACC_DIRECTIVE` in; then incremental deletion of the keystroke stack | None — plain child-process spawn | None identified — `runner.mjs` already has its own test suite |
| Hybrid (keep both, gate by use case) | Interactive sessions use ConPTY; long unattended directives use the runner | Doubles the surface area to maintain | Ongoing — never fully retires the fragile stack | Same as "keep" for the interactive half | Two continuity mechanisms to reason about at once |

## Sequencing note

The review's recommended proving step (F1: point the runner at one real, low-stakes job overnight behind a hard per-run ceiling — issue #15) has still not been run, and remains the right first slice of the migration: it validates the destination before the working keystroke stack is deleted. Deletion happens incrementally behind that proof, never ahead of it.

## Consequences if migration proceeds

| | |
|---|---|
| We can now | Run truly unattended, headless overnight jobs with fresh context per run — no console, no keystroke injection, no pipe |
| We can no longer | Rely on a live interactive terminal for continuity; the embedded GUI terminal would become a read-only log viewer at most |
| We must maintain | `runner.mjs`'s job-file contract instead of the directive-store/console-binding contract |
| We are exposed to | Losing the interactive "watch it work" experience the GUI currently provides, unless a log-viewer replacement ships first |

## Reversal

| Field | Answer |
|---|---|
| Cost to reverse | Low while unstarted (nothing built yet); high once the keystroke stack is actually deleted — it would need to be rebuilt from git history |
| What would trigger a reversal | The headless runner proves unreliable on real unattended work (F1 fails) |
| What is proprietary and would not transfer | Nothing — both mechanisms are first-party code |

## Verification

Run the review's own F1 experiment as the migration's first slice: point `runner.mjs` at one real, low-stakes job overnight behind a hard per-run ceiling (issue #15). A produced PR validates proceeding to deletion; no PR after a fair run means the bottleneck is model reliability, not the mechanism — in that case, write a superseding ADR reversing this one rather than deleting the working keystroke stack anyway.

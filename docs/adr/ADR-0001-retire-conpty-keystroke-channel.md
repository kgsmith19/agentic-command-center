---
title: Retire the ConPTY/keystroke continuity channel in favor of the headless runner
status: proposed
scope: repo
created: 2026-08-07
updated: 2026-08-07
owner: Kyle Smith
traces: [FR-004, UC-002]
supersedes: none
superseded_by: none
---

# ADR-0001: Retire the ConPTY/keystroke continuity channel in favor of the headless runner

> Condensed from `docs/2026-08-03-acc-adversarial-review.md` (deleted; full text in git history). This decision was raised 2026-08-03 and has **not been acted on** as of 2026-08-07 — status stays `proposed` until Kyle decides.

## Context

ACC survives a Claude Code context-limit `/clear` by typing into a live Windows console: `watcher/clearbot.ps1` sends real keystrokes/pipe writes, `hooks/goal.mjs` binds a goal to the console's PID, and `gui/PtyHost.cs` hosts an embedded ConPTY terminal. This mechanism works today (`kernel/README.md`'s two invariants: continuity is console-PID not session-id; nothing but fixed constants is ever typed) but is roughly 1,400+ LOC plus 1.1 MB of vendored terminal assets, and is the origin of most of the goal-loop's historical bugs (closed: OI-002, OI-003, OI-004, OI-009, OI-010, OI-012; still open: issues #13, #14 filed 2026-08-07). A separate, already-built, already-tested headless mechanism (`runner/runner.mjs`, `claude -p` per job, fresh context by construction, 39 tests) exists in the same repo and has never been wired to the goal store.

## Decision

**Not yet decided.** This ADR records the open question and the case for each side so the decision, whenever made, has the context it needs. The 2026-08-03 review's recommendation was: migrate goal continuity onto `runner.mjs` (set `ACC_GOAL`, read `done`/`blocked` instead of scraping a console) and retire `sendconsole.ps1`, `winfind.ps1`, the typing core of `clearbot.ps1`, `gui/PtyHost.cs`, `term.html`, and `gui/vendor/` in that order.

## Options considered

| Option | How it works | Maturity cost | Migration cost if we leave | Lock-in | Ecosystem gaps |
|---|---|---|---|---|---|
| **Keep ConPTY/keystroke channel (current)** | Type `/clear` + a fixed resume phrase into a live console bound by PID | Proven in production since 2026-07-31; 0 automated PowerShell/C# coverage | n/a (status quo) | Windows-only, ConPTY-specific | No test harness exists for the PowerShell/C# surface at all |
| Migrate to `runner.mjs` (headless) | `claude -p` per job, fresh context, no console, no keystrokes | Already built and tested (39 tests) but never run against real unattended work | ~100 LOC to wire `ACC_GOAL` in; then incremental deletion of the keystroke stack | None — plain child-process spawn | None identified — `runner.mjs` already has its own test suite |
| Hybrid (keep both, gate by use case) | Interactive sessions use ConPTY; long unattended goals use the runner | Doubles the surface area to maintain | Ongoing — never fully retires the fragile stack | Same as "keep" for the interactive half | Two continuity mechanisms to reason about at once |

## Why this isn't decided yet

The review's own recommended first step (F1: prove the runner produces one real PR on a real job overnight) has not been run. Deciding to delete 1,400+ LOC of working, load-bearing code before that proof exists would be premature — the review itself says so ("do not build more harness before running one real job"). This ADR exists so the decision is visible and traceable, not to force it.

## Consequences if migration proceeds

| | |
|---|---|
| We can now | Run truly unattended, headless overnight jobs with fresh context per run — no console, no keystroke injection, no pipe |
| We can no longer | Rely on a live interactive terminal for continuity; the embedded GUI terminal would become a read-only log viewer at most |
| We must maintain | `runner.mjs`'s job-file contract instead of the goal-store/console-binding contract |
| We are exposed to | Losing the interactive "watch it work" experience the GUI currently provides, unless a log-viewer replacement ships first |

## Reversal

| Field | Answer |
|---|---|
| Cost to reverse | Low while unstarted (nothing built yet); high once the keystroke stack is actually deleted — it would need to be rebuilt from git history |
| What would trigger a reversal | The headless runner proves unreliable on real unattended work (F1 fails) |
| What is proprietary and would not transfer | Nothing — both mechanisms are first-party code |

## Verification

Run the review's own F1 experiment: point `runner.mjs` at one real, low-stakes job overnight behind a hard per-run ceiling (issue #15). A produced PR validates the migration case; no PR after a fair run means the bottleneck is model reliability, not the mechanism, and this ADR should be closed as "keep ConPTY" instead.

---
title: Test Justification Ledger
status: active
created: 2026-08-07
updated: 2026-08-07
owner: Kyle Smith
---

# Test Justification Ledger

> **Purpose.** Every test in this repo earns its keep by catching a specific failure. Coverage is not a reason; "it might break someday" is not a reason.
>
> **Adoption note:** this repo's ~445 existing tests predate this ledger and are not backfilled here row by row — that would be a multi-day mechanical exercise with no functional value, since their justification already lives where it's more durable: in `kernel/README.md`, `AGENTS.md`'s "The regression, exactly" section, and the git history of the bugs each one was written to catch (the 12-module kernel scenario-enumeration pass, closed as former `OPEN-ISSUES.md` OI-019, is the single largest example). **Section 1 starts empty and is required for every NEW test from here forward** (`rules/06-TESTS.md` GATE-TEST-JUSTIFIED). Section 3 (regression register) is seeded with the highest-value historical regressions so their "which gate missed it" lesson isn't lost.

---

## 1. Active tests

| Test ID | Name / location | Level | Traces to | Failure mode caught | Why not cheaper | Why not duplicate | Mutation verified | Runtime (ms) | Deletion criterion | Added |
|---|---|---|---|---|---|---|---|---|---|---|

*(empty — populated going forward; see adoption note above for existing coverage)*

## 2. Level distribution

Not tracked per-level yet for the existing suite (445 tests across `hooks/`, `kernel/`, `gui/`, `runner/`, plus Windows-only PowerShell suites). Populate at the first Test Review that adopts this ledger for new work.

## 3. Regression register

The highest-value historical regressions — each found a real bug, not a hypothetical one. Full detail lives in git history and `AGENTS.md`; this table is the index.

| Test ID | Defect | Date found | How it reached the code | Root cause | Fixed in | Also fixed by a cheaper mechanism? |
|---|---|---|---|---|---|---|
| T-R-001 | `kernel/guard.mjs`'s path check did a raw string-prefix match with no `..`-segment resolution — a crafted `writeRoots`-adjacent path bypassed the deny boundary | 2026-08-04 | No scenario-enumeration pass existed yet for the kernel's deny-by-default boundary | Missing `path.posix.normalize` before the prefix comparison | `kernel/guard.mjs`, `kernel/guard.test.mjs` (4 new tests) | Yes — `norm()` now normalizes before comparing, a pure-function fix, not just a test |
| T-R-002 | `guardhook.mjs`'s tool-call ceiling check was a TOCTOU race — concurrent tool-call fires could all read the same "attempts so far" and all pass a ceiling meant to allow one more | 2026-08-06 | No concurrent-fire scenario had been tested | Read-then-append with no synchronization across processes | `kernel/ledger.mjs`'s `withDecisionLock`, `kernel/guardhook.test.mjs` (60 concurrent fires) | Yes — a cross-process file lock, not just a test |
| T-R-003 | `kernel/run.mjs`'s supervisor tick had no try/catch around `readState()` — a harness fault crashed the whole kernel process, not just the one run | 2026-08-06 | No fault-injection test existed for the tick path | A timer callback isn't covered by `runTask`'s own async try/catch | `kernel/run.mjs`, `kernel/run.test.mjs` | Yes — the tick is now wrapped, the test proves the wrap |
| T-R-004 | `hooks/goal.mjs`'s `bindSession` rebound an active goal to any UUID-shaped session id from a hand-piped SessionStart payload, hijacking a live session's goal | 2026-08-03 (observed live) | A hand-run hook against live state, not a sandboxed test | No validation that the incoming id was UUID-shaped before rebinding | `hooks/goal.mjs`, `hooks/goal.test.mjs` | Yes — the UUID-shape check is the fix, not just a test |

**Still open, no test yet (tracked as GitHub issues, not ledger rows, since no fix has landed):** issue #13 (pipe/request-channel auth), issue #14 (unlocked goal-store writes), issue #15 (missing per-goal hard ceiling).

## 4. Deleted tests

| Test ID | Name | Deleted | Reason | Replaced by |
|---|---|---|---|---|
| — | `kernel/credentials.test.mjs`: `"vaultNames returns names and never values"` | 2026-08-07 | Tested a zero-caller export (`vaultNames()`) removed in the same pass; its one genuinely useful assertion (missing vault file yields no keys) is preserved via `envForKeys([])` | (adjacent existing test, adjusted) |
| — | `kernel/adapters/claude-code.test.mjs`: `"the handle's own stop() convenience method calls stopTask"` | 2026-08-07 | Tested a zero-caller convenience method (`handle.stop`) removed in the same pass; `stopTask` itself is still called directly by `run.mjs` and still covered | nothing needed — the real code path is `run.mjs` calling `stopTask` directly |
| — | `hooks/prompts.test.mjs` (whole file) | 2026-08-07 | Tested `hooks/prompts.mjs`, a module with zero callers anywhere in the repo (not wired into any hook, the GUI, or the CLI) — speculative infrastructure never adopted | nothing needed |

## 5. Quarantine

*(none)*

## 6. Ledger self-check (GATE-LEDGER)

- [ ] Every test file in the repo has a matching row in section 1. **Not yet true — see adoption note.**
- [x] Section 3's regressions are indexed with a real defect, root cause, and fix.
- [x] Section 4 records every deletion made in this cleanup pass with a reason.
- [ ] Quarantine has no expired entries. (empty, trivially true)

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
| T-I-001 | `hooks/directive.test.mjs`: "issue #14: N concurrent appendCycle processes lose no update" | integration (real subprocesses) | FR-004 (directive survives resets — a lost update stalls the loop silently) | Two concurrent hook processes each read-modify-write the same directive file; one side's update is silently lost, which presents as the exact silent stall the directive loop exists to prevent | A type/lint rule cannot see a cross-process race; only a real multi-process test exercises the file lock | No other test runs concurrent real processes against the directive store | 2026-08-07 (lock neutered via a temporary seam → test went red, 48/49; restored → green ×3) | ~400 | When the directive store moves off per-file JSON (e.g. the ADR-0001 headless-runner migration replaces this mechanism entirely) | this change |
| T-U-001 | `hooks/directive.test.mjs`: "issue #14: a kick with no resulting turn is presumed swallowed and re-armed" | unit | FR-004 | A kick whose keystrokes miss produces no turn, so nothing re-arms `needsKick` — the loop stalls silently forever (the 2026-08-03 adversarial review's D3, observed class) | The stall is emergent from timing across two processes; no static check can see it | The cooldown/settle tests never exercise a kick that produced no turn end | 2026-08-07 (git-stash red-proof against pre-fix code: failed; with fix: green) | <5 | Same as T-I-001 — dies with the keystroke mechanism if ADR-0001's migration lands | this change |
| T-U-002 | `runner/runner.test.mjs`: AC-001…AC-003, PROP-001 (directive-job synthesis + refusals) | unit | FR-011 | A run starting against a done/blocked/missing directive, or one with no working folder — headless token spend against work nobody asked for | Refusal is a runtime decision over live store state; no static check sees it | First tests ever touching `loadDirectiveJob` | 2026-08-07 red-first: all failed before the implementation existed (12-red run recorded in the PR) | <10 | Dies only if directive-backed jobs are removed | SPEC-0001 |
| T-U-003 | `runner/runner.test.mjs` + `hooks/directive.test.mjs`: directiveState/lastCycleBody timestamp exclusion | unit | FR-011 | Cycle headers carry timestamps; hashing them makes every run read as "progress", silently disarming the stuck brake — the runaway-loop failure that burns maxRuns×180min of tokens | The hash-input choice is semantic; only a test pinning "identical bodies compare equal" holds it | The file-job hash tests never exercise the log format | 2026-08-07 red-first | <10 | Dies with the directive log format | SPEC-0001 |
| T-I-002 | `runner/runner.test.mjs`: AC-004 (ACC_DIRECTIVE env isolation, real spawn) | integration (fake claude) | FR-011 | A file job's child inheriting a directive identity would adopt and mutate a directive it was never launched for (the OI-006 hijack class, headless edition) | Env passthrough is real-spawn behavior; only a subprocess proves it | Only test asserting the env var on the real spawn path | 2026-08-07 red-first | ~600 | Dies with directive jobs | SPEC-0001 |
| T-U-004 | `runner/runner.test.mjs`: AC-008 (red tier holds the loop) + liveTier fail-shapes | unit | FR-005 | The headless path spending tokens straight through a red week — FR-005's brake silently absent from the new transport | Tier is a runtime read; injectable fn makes each failure shape deterministic | clearbot's hold is PowerShell-side; nothing else gates the runner | 2026-08-07 red-first | <10 | When FR-005's thresholds mechanism is redesigned | SPEC-0001 |
| T-U-005 | `runner/runner.test.mjs`: AC-005/AC-007/PROP-002 (done detection, one cycle per run) | unit | FR-011 | A loop that never notices `done` (runs forever) or double-appends cycles (corrupts the continuity log the next fresh context reads) | Loop behavior over injected runs; milliseconds, no spawn | Only tests of runLoop's directive branch | 2026-08-07 red-first | <10 | Dies with directive jobs | SPEC-0001 |
| T-U-006 | `hooks/directive.test.mjs`: KICK_TEXT pin | unit | FR-004, FR-011 | The wire constant drifting from what clearbot types / budget.mjs recognizes — human-hold detection silently desyncs | One-line equality is the cheapest possible pin | Single canonical constant, single pin | trivially (change the string → red) | <1 | Dies with the kick mechanism (SL-011 removes the console half) | SPEC-0001 |
| T-I-003 | `gui/server.test.mjs`: guards API group (AC-001…AC-009 + error paths, fake engine) | integration (real HTTP, fake engine subprocess) | FR-010, NFR-001 | An unallowlisted verb or malformed/traversal-shaped browser input reaching `engine.mjs`; CSRF against the localhost mutator; an engine failure masked as success | The allowlist and validation are runtime request handling; only real HTTP requests prove the refusals refuse | First tests of the guards API; kernel-policy tests cover a different route | 2026-08-07 red-first (11 red before the routes existed) | ~1.5s | Dies if the web GUI is retired (reversal of ADR-0002/0004) | SPEC-0002 |
| T-E-001 | `gui/e2e/guards.spec.mjs` (3 specs, Playwright, fake engine) | e2e | FR-010, NFR-008 | The page rendering stale state after a mutation, or wiring a button to the wrong verb — invisible to API-level tests, exactly the WinForms GUI's historical un-testability this migration exists to end | Only a real browser proves DOM↔API wiring | API tests cannot see the DOM | UI wiring: a mis-wired id fails the locator | ~2s | Dies with the guards page | SPEC-0002 |
| T-I-004 | `gui/server.test.mjs`: vault API group (AC-001…AC-007, PROP-001/002) | integration (real HTTP, fake engine records stdin) | FR-010, NFR-001 | A secret value leaking into argv (process listing/log), a response body, or a forged extra vault line via a `\n` in a value or an `=`/reserved name in a key — the exact reasons SPEC-0002 deferred this surface | The stdin-only channel and the framing-injection defenses are runtime request handling; only a test recording the child's stdin proves the value never went anywhere else | The other guards routes carry no secret value | 2026-08-07 red-first (8 red before the routes) | ~0.5s | Dies if the vault moves off the by-name engine model | SPEC-0003 |
| T-E-002 | `gui/e2e/guards.spec.mjs` vault specs (2, Playwright) | e2e | FR-010, NFR-001 | The value lingering in the DOM after a save (readable by any later script), or the name list not reflecting the store | Only a real browser proves the input is cleared and the DOM never holds the value | API tests cannot see the DOM lifecycle | asserting `#vaultInput` empties + the secret absent from persisted state | ~1s | Dies with the vault tab | SPEC-0003 |

## 2. Level distribution

Not tracked per-level yet for the existing suite (445 tests across `hooks/`, `kernel/`, `gui/`, `runner/`, plus Windows-only PowerShell suites). Populate at the first Test Review that adopts this ledger for new work.

## 3. Regression register

The highest-value historical regressions — each found a real bug, not a hypothetical one. Full detail lives in git history and `AGENTS.md`; this table is the index.

| Test ID | Defect | Date found | How it reached the code | Root cause | Fixed in | Also fixed by a cheaper mechanism? |
|---|---|---|---|---|---|---|
| T-R-001 | `kernel/guard.mjs`'s path check did a raw string-prefix match with no `..`-segment resolution — a crafted `writeRoots`-adjacent path bypassed the deny boundary | 2026-08-04 | No scenario-enumeration pass existed yet for the kernel's deny-by-default boundary | Missing `path.posix.normalize` before the prefix comparison | `kernel/guard.mjs`, `kernel/guard.test.mjs` (4 new tests) | Yes — `norm()` now normalizes before comparing, a pure-function fix, not just a test |
| T-R-002 | `guardhook.mjs`'s tool-call ceiling check was a TOCTOU race — concurrent tool-call fires could all read the same "attempts so far" and all pass a ceiling meant to allow one more | 2026-08-06 | No concurrent-fire scenario had been tested | Read-then-append with no synchronization across processes | `kernel/ledger.mjs`'s `withDecisionLock`, `kernel/guardhook.test.mjs` (60 concurrent fires) | Yes — a cross-process file lock, not just a test |
| T-R-003 | `kernel/run.mjs`'s supervisor tick had no try/catch around `readState()` — a harness fault crashed the whole kernel process, not just the one run | 2026-08-06 | No fault-injection test existed for the tick path | A timer callback isn't covered by `runTask`'s own async try/catch | `kernel/run.mjs`, `kernel/run.test.mjs` | Yes — the tick is now wrapped, the test proves the wrap |
| T-R-004 | `hooks/directive.mjs`'s `bindSession` rebound an active directive to any UUID-shaped session id from a hand-piped SessionStart payload, hijacking a live session's directive | 2026-08-03 (observed live) | A hand-run hook against live state, not a sandboxed test | No validation that the incoming id was UUID-shaped before rebinding | `hooks/directive.mjs`, `hooks/directive.test.mjs` | Yes — the UUID-shape check is the fix, not just a test |

**Still open, no test yet (tracked as GitHub issues, not ledger rows, since no fix has landed):** issue #13 (pipe/request-channel auth), issue #15 (missing per-directive hard ceiling). Issue #14 (unlocked directive-store writes) is fixed and covered by T-I-001 in section 1.

## 4. Deleted tests

| Test ID | Name | Deleted | Reason | Replaced by |
|---|---|---|---|---|
| — | `kernel/credentials.test.mjs`: `"vaultNames returns names and never values"` | 2026-08-07 | Tested a zero-caller export (`vaultNames()`) removed in the same pass; its one genuinely useful assertion (missing vault file yields no keys) is preserved via `envForKeys([])` | (adjacent existing test, adjusted) |
| — | `kernel/adapters/claude-code.test.mjs`: `"the handle's own stop() convenience method calls stopTask"` | 2026-08-07 | Tested a zero-caller convenience method (`handle.stop`) removed in the same pass; `stopTask` itself is still called directly by `run.mjs` and still covered | nothing needed — the real code path is `run.mjs` calling `stopTask` directly |
| — | `hooks/prompts.test.mjs` (whole file) | 2026-08-07 | Tested `hooks/prompts.mjs`, a module with zero callers anywhere in the repo (not wired into any hook, the GUI, or the CLI) — speculative infrastructure never adopted | nothing needed |

## 4a. Strengthened tests (leanness Pass 1)

A fresh test-quality audit (Lens B, 2026-08-07) found 5 tests that would still pass if the function under test were replaced with a hardcoded return value. Rather than delete the coverage outright, each was rewritten to assert the real, independently-computed value (an "oracle" — reading the real file/directory the fallback is supposed to resolve to, same pattern `hooks/usage.test.mjs` already used) — the underlying fallback behavior is real and worth testing, the old assertion just didn't prove it.

| Test | Location | What changed |
|---|---|---|
| `kernelRoot falls back to the repo root when ACC_ROOT is unset` | `kernel/policy.test.mjs` | `path.isAbsolute(...)` → equals an independently-computed real repo root |
| `loadKernelPolicy falls back to the repo policy.json when ACC_POLICY is unset` | `kernel/policy.test.mjs` | `doesNotThrow` → asserts the loaded `harness` matches the real `policy.json`'s own value |
| `end-to-end: ACC_ROOT unset falls back to the real repo root` | `hooks/testplan.test.mjs` | Switched from a non-firing prompt (proved nothing landed) to a firing one; asserts the latch file lands under the real repo's `runner/state/`, cleaned up immediately |
| `POLICY() and LANE_DIR() fall back to their real defaults` | `hooks/lane.test.mjs` | `cfg.slots >= 1` → equals the real `policy.json`'s own `lane.slots` value |
| `acquireSlot works end to end with ACC_LANE_DIR genuinely unset` | `hooks/lane.test.mjs` | No assertion → reads the real `owner.json` under `os.tmpdir()/acc-lane/slot-N/`, and confirms `release()` actually removes it |

## 5. Quarantine

*(none)*

## 6. Ledger self-check (GATE-LEDGER)

- [ ] Every test file in the repo has a matching row in section 1. **Not yet true — see adoption note.**
- [x] Section 3's regressions are indexed with a real defect, root cause, and fix.
- [x] Section 4 records every deletion made in this cleanup pass with a reason.
- [ ] Quarantine has no expired entries. (empty, trivially true)

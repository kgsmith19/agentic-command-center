---
title: The spending/process tab exists in the web GUI
spec_id: SPEC-0004-spending-tab-web-delete-winforms
slice: SL-009
status: done
created: 2026-08-07
updated: 2026-08-08
completed: 2026-08-08
owner: Kyle Smith
traces: [FR-010, NFR-006, NFR-007, NFR-008]
---

# SPEC-0004: The spending tab moves to web

## 1. In one sentence

The web `/guards` page gains the spending/process controls — 7-day spend + tier, the policy dials, the emergency STOP/Resume/fan-out, and the cleanup (clearbot) start/stop/test with autoApprove — leaving `guards-gui.ps1` with only its "Start work" launch tab.

## 0. Correction (2026-08-07)

The original scope said this slice deletes `guards-gui.ps1`. That was wrong: the file still owns the **"Start work" launch tab** — profile selection, route suggestion, directive creation, and launching claude in the embedded ConPTY terminal (its interactive-lane handshake is tested by `gui/guards-gui.test.mjs`, closing OI-015). That launch surface is entangled with the ConPTY stack that **SL-011** retires behind the F1 proof, and is explicitly out of scope here. Deleting the file now would remove the only working launch UI. So `guards-gui.ps1` **stays** until SL-011 ports the launch tab; this slice ports the spending tab and nothing more. SL-009 = "every non-launch tab is on the web," which this completes.

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement served | FR-010 (control surface), NFR-006 (spend visible/gated), NFR-007 (cleanup revivable), NFR-008 (testable on Linux CI) |
| What becomes possible | The last WinForms tab in web → the 1,636-LOC un-testable shell is deleted; ADR-0004's largest single LOC drop |
| Why now | Every other tab already ported (SPEC-0002/0003); Kyle's call 2026-08-07 is to port ALL of it, including the clearbot-tied controls, rather than leave a stub shell |
| What we learn | Whether the web GUI can own the full control plane with no WinForms fallback |

## 3. Scope

### 3.1 In scope

- `GET /api/process/status`: the tier verdict (`usage.mjs check` JSON), the 7-day spend report (`usage.mjs week` text), the policy dials (context.soft/hardK, week.amber/redTokens, review.maxFinders, subagents.allow, autoApprove.enabled), the slice-runner stop-file state, and the clearbot kill-switch state (`watcher/clearbot.stop` presence — a file check, cross-platform).
- `POST /api/process/dials`: validated numeric/array dials merged into `policy.json` **preserving every unknown key** (a pure, tested `mergeDials`), atomic write. Bad input → 400, file untouched.
- `POST /api/process/control` over an allowlisted action map: `stop` (write `runner/stop/slice-runner.stop`), `resume` (`budget.mjs unstop`), `fanout` (`budget.mjs fanout 30`), `cleanup-on`/`cleanup-off` (the `start-clearbot`/`stop-clearbot` commands), `clear-now` (`budget.mjs clear-now`, behind an explicit `confirm`). Node verbs run cross-platform; the clearbot start/stop commands are resolved through an injectable command map so the routing is testable off-Windows and the real launch is proven on Kyle's box.
- `gui/guards.html`: a "Spending & limits" section — the big tier line + spend summary, the dials form, the STOP/Resume/fan-out buttons, and the cleanup on/off/test + autoApprove checkbox.
- Playwright coverage of the display, a dials save, and a control action against a sandboxed fake.
- Docs: note in AGENTS.md/README that every tab EXCEPT "Start work" is now web; ADR-0002 gets a pointer to ADR-0004 for the migration's completion path.

### 3.2 Out of scope

| Not doing | Why | Where |
|---|---|---|
| The "Start work" launch-lane tab / embedded terminal | Entangled with the ConPTY stack; headless directives (SPEC-0001) are its replacement | SL-011 |
| Deleting clearbot itself | Its start/stop is ported; the keystroke core dies behind the F1 proof | SL-011 |
| A live clearbot process-count light | A Windows process scan; the file-based kill-switch state is the cross-platform substitute | never (Windows-only enrichment, not worth porting) |
| Kernel tab (already at `/`) | Shipped | done |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces |
|---|---|---|---|---|
| AC-012 | The repo after this change | grep for a live launcher pointing at `guards-gui.ps1` | it still exists ON PURPOSE — the Start-work tab is unported (SL-011); only docs claim "every non-launch tab is web" | — |
| AC-001 | Sandbox policy + fake usage emitting `{tier:"amber",pct:60,weekTokens:...}` | `GET /api/process/status` | 200 with `tier`, the week text, every dial value, `stopped:false`, `cleanupKilled:false` | FR-010, NFR-006 |
| AC-002 | Valid dials `{softK:400,hardK:600,amberTokens:1.2e9,redTokens:1.8e9,maxFinders:5,allow:["Explore"],autoApprove:true}` | `POST /api/process/dials` with X-ACC | 200; policy.json's context/week/review/subagents/autoApprove updated; **`kernel`, `rates`, `_comment`, and every other block byte-unchanged** | FR-010 |
| AC-003 | Dials with a non-numeric softK, a negative token count, or a non-array allow | POST | 400 naming the bad field; policy.json untouched | NFR-001 |
| AC-004 | `POST /api/process/control {action:"stop"}` | with X-ACC | 200; `runner/stop/slice-runner.stop` now exists | FR-010 |
| AC-005 | Stop file present, `{action:"resume"}` | POST | 200; `budget.mjs unstop` invoked (fake records argv) | NFR-007 |
| AC-006 | `{action:"fanout"}` | POST | 200; `budget.mjs fanout 30` invoked | FR-010 |
| AC-007 | `{action:"cleanup-on"}` / `{action:"cleanup-off"}` | POST | 200; the injected start/stop command recorded — routing proven off-Windows | NFR-007 |
| AC-008 | `{action:"clear-now"}` without `confirm` | POST | 400; no invocation. With `confirm:true` → `budget.mjs clear-now` invoked | FR-010 |
| AC-009 | An action not in the allowlist (`rm`, `__proto__`) | POST | 400; nothing invoked | NFR-001 |
| AC-010 | Any /api/process route | no X-ACC or foreign Origin/Host | 403; nothing invoked/written | NFR-001 |
| AC-011 | Playwright, fake backend | load, save dials, click STOP | tier renders; dials POST fires; STOP creates the file | FR-010, NFR-008 |

## 5. Properties

| ID | Property | Kind | Traces |
|---|---|---|---|
| PROP-001 | For any valid dials save, every policy.json key the dials form does not own is byte-identical before and after | invariant | FR-010 |
| PROP-002 | For any request, the process-control child argv is built only from the allowlist action map — no browser string becomes argv, a flag, or shell input | invariant | NFR-001 |

## 6. Budget

~120 prod LOC `gui/server.mjs` (+ pure `mergeDials`), ~120 LOC `gui/guards.html`, tests in `gui/server.test.mjs` + Playwright. Coverage floors on `gui/server.mjs`. `/security-review` gate (new controls that stop/start automation). The −1,636 LOC from deleting `guards-gui.ps1` lands in SL-011 with the launch tab.

## 12. Done when

All ACs green, covgate clears `gui/server.mjs`, `npm test` no new failures, `/security-review` clean, docs (AGENTS.md, README, ADR-0002 pointer to ADR-0004) in the same commit. This completes SL-009's non-launch tabs; `guards-gui.ps1`'s deletion moves to SL-011 with the Start-work launch tab.

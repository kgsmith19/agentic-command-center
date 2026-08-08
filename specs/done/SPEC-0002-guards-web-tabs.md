---
title: The guards control tabs exist in the web GUI
spec_id: SPEC-0002-guards-web-tabs
slice: SL-009
status: done
created: 2026-08-07
updated: 2026-08-08
completed: 2026-08-08
owner: Kyle Smith
traces: [FR-010, NFR-008]
---

# SPEC-0002: The guards control tabs exist in the web GUI

## 1. In one sentence

`node gui/server.mjs` serves a guards page with the toggle, the protections tab ("What Claude cannot touch") and the requests tab ("Claude's requests"), each backed by the same `hooks/engine.mjs` verbs the WinForms GUI shells — the first increment of SL-009 (ADR-0004: finish ADR-0002's migration, then delete `guards-gui.ps1`).

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | FR-010 (the human control surface), NFR-008 (testable on Linux CI, which WinForms never was) |
| What becomes possible | The two highest-traffic control tabs usable from a browser; each ported tab shrinks what `guards-gui.ps1`'s eventual deletion must wait for |
| Why this increment first | Config protections + runbox approvals are the tabs with existing engine verbs and no secret-value flow; the vault tab needs its own security review (SPEC-0003) |
| What we learn | Whether "server shells the engine" holds up as the pattern for every remaining tab |

## 3. Scope

### 3.1 In scope

- `gui/server.mjs`: `/guards` page route; `GET /api/guards/status`, `GET /api/guards/list` (pending + trashed, `--json` verbs); `POST /api/guards/engine` over an **allowlisted verb map** (toggle, secret-add/rm, protected-add/rm, projects-add/rm, run, trash, restore, flush); `POST /api/guards/preview` (script content, ref resolved through the engine's own list — browser input never becomes a filesystem path). Same CSRF gates as the existing route (local Host/Origin, X-ACC on every POST, body cap).
- `ACC_ENGINE` env override for the engine path — tests drive the server against a **fake engine fixture** (runner.test.mjs's fake-claude discipline); the real engine is never mutated by a test.
- `gui/guards.html`: toggle + status header, protections tab, requests tab (pending list, preview pane, run/trash/restore, trash list, confirmed flush). Plain HTML/JS, kernel.html's idiom.
- Playwright spec against a sandboxed fake engine (`ACC_ENGINE`, same `ACC_GUI_E2E_DIR` discipline as kernel-settings.spec.mjs).

### 3.2 Out of scope

| Not doing | Why not | Where it goes |
|---|---|---|
| Vault tab (Passwords and keys) | Secret values transit browser→server→engine stdin; wants the security-review pass, not a rushed port | SPEC-0003 |
| Spending tab (usage/tier/policy dials) | Independent; kernel.html's POST pattern already proves the shape | SPEC-0003 |
| Start-work tab / launch lane / embedded terminal | Entangled with the ConPTY stack SL-011 deletes; headless directives (SPEC-0001) are the replacement direction | SL-010/SL-011 |
| Deleting `guards-gui.ps1` | Only after every kept tab exists in web | SL-009 final increment |
| Engine.mjs changes of any kind | Top-level CLI, structurally ungateable (same class as #26); the server adapts to it, not it to the server | SL-010 may split it |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | A fake engine echoing canned `status` JSON | `GET /api/guards/status` | 200 `{enabled, secrets, protected, projects, vaultKeys, pending, trashed}` passthrough | FR-010 |
| AC-002 | Fake engine | `POST /api/guards/engine` `{verb:"toggle", arg:"on"}` with X-ACC | 200 `{code:0, out}`; the fake recorded argv `toggle on` | FR-010 |
| AC-003 | Any state | POST with a verb NOT in the allowlist (e.g. `apply`, `vault-import`, `rm -rf`) | 400 naming the verb; engine never invoked | FR-010 |
| AC-004 | Any state | POST without X-ACC, or foreign Origin/Host | 403; engine never invoked | NFR-001 |
| AC-005 | Fake engine listing a script `fix.ps1` with a known file | `POST /api/guards/preview` `{ref:"central:fix.ps1"}` | 200 with the file's content | FR-010 |
| AC-006 | Same | preview with a traversal-shaped ref (`../../etc/passwd`) or one not in the engine's list | 404; no file read outside the listed entries | NFR-001 |
| AC-007 | Fake engine that exits 1 with stderr | Any allowlisted POST | 200 `{code:1, out}` carrying the stderr text — failure is reported, never masked | FR-010 |
| AC-008 | `flush` verb | POST `{verb:"flush"}` without `{confirm:true}` | 400; with confirm, argv is `flush --really` | FR-010 |
| AC-009 | Real engine, real repo | `GET /api/guards/status` (read-only) | 200 with this repo's actual config shape — proves the wiring beyond the fake | FR-010 |
| AC-010 | Playwright, sandboxed fake engine | Page loads; toggle click; a pending script's Run | Status renders from engine output; each action fires the right API call and re-renders | FR-010, NFR-008 |

## 5. Properties

| ID | Property | Kind | Traces to |
|---|---|---|---|
| PROP-001 | For every request, the engine argv is built ONLY from the allowlist map and a validated single arg — no browser string is ever passed as a path, a flag, or through a shell | invariant | NFR-001 |
| PROP-002 | A GET never mutates: only POST routes reach a mutating verb | invariant | NFR-001 |

## 6. Budget

~110 prod LOC in `gui/server.mjs`, ~220 LOC `gui/guards.html`, tests in `gui/server.test.mjs` + one Playwright spec. Coverage floors on `gui/server.mjs`.

## 12. Done when

All ACs green (red-first), covgate clears `gui/server.mjs`, `npm test` no new failures, docs (`AGENTS.md` GUI note) in the same commit. `guards-gui.ps1` stays until SPEC-0003 finishes the remaining tabs.

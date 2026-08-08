---
title: The vault tab exists in the web GUI, with secret values never leaving the stdin channel
spec_id: SPEC-0003-guards-vault-web-tab
slice: SL-009
status: done
created: 2026-08-07
updated: 2026-08-08
completed: 2026-08-08
owner: Kyle Smith
traces: [FR-010, NFR-001]
---

# SPEC-0003: The vault tab exists in the web GUI

## 1. In one sentence

The web `/guards` page can add and remove named vault secrets, with each value travelling browser → server → `engine.mjs` **stdin** and never touching argv, a log line, a filesystem path built from it, or any response body — the secret-value-in-transit surface SPEC-0002 deferred.

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | FR-010 (the human control surface), NFR-001 (fail-closed, secrets never leak) |
| What becomes possible | The vault tab off WinForms — one of the two tabs still pinning `guards-gui.ps1` |
| Why now | SPEC-0002 shipped every non-secret guards tab; the vault is what it explicitly held back for its own review |
| What we learn | Whether the "server shells the engine" pattern holds when the payload is a secret that must never be observable |

## 3. Scope

### 3.1 In scope

- `POST /api/guards/vault-import`: body `{ pairs: [{key, value}, ...] }`. Server pipes `KEY=VALUE\n` lines to `engine.mjs vault-import` over **stdin**. Response is `{ stored: [names] }` — **names only, never a value**.
- `POST /api/guards/vault-rm`: `{ key }` — the key NAME is not secret, travels as argv like every other verb.
- Vault key names already surface via `GET /api/guards/status` (`vaultKeys`), so the page lists them with no new read route.
- `gui/guards.html`: a "Passwords and keys" section — a paste box (one `KEY=VALUE` per line), a Save button, the key-name list, a per-key Delete. The value inputs are cleared from the DOM immediately after a successful save.
- Input validation as a **security boundary**, not politeness (see §4/§5): key must match `^[A-Za-z_][A-Za-z0-9_]*$`; value must contain no `\n`/`\r` (either would inject a forged `KEY=VALUE` line into the stdin framing).

### 3.2 Out of scope

| Not doing | Why not | Where it goes |
|---|---|---|
| `apply` (vault → target file) | That is an agent action, not a GUI one — agents call it directly; no browser reason to expose it | never (agent-only) |
| The spending tab (usage/tier/policy dials + emergency-stop + cleanup controls) | Independent slice; Kyle's call 2026-08-07 is to port ALL of it to web — including the clearbot-tied start/stop-cleanup, autoApprove, and emergency-stop controls — so `guards-gui.ps1` can be deleted sooner even though SL-011 later reworks the clearbot half | SPEC-0004 |
| Deleting `guards-gui.ps1` | Vault is the last *secret* tab, not the last tab | SL-009 final increment |
| Showing a stored value, ever | The whole vault model is by-name-only | never |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | Fake engine recording stdin | `POST /api/guards/vault-import` `{pairs:[{key:"API_KEY",value:"s3cr3t"}]}` with X-ACC | 200 `{stored:["API_KEY"]}`; the fake's recorded stdin is exactly `API_KEY=s3cr3t\n`; the value appears in NO argv and NO response field | FR-010, NFR-001 |
| AC-002 | Two pairs | import both | stdin carries both `KEY=VALUE` lines; `stored` names both, in order | FR-010 |
| AC-003 | A key `BAD KEY` / `1KEY` / `A=B` / `` (empty) | import | 400 naming the invalid key; engine never invoked; nothing stored | NFR-001 |
| AC-004 | A value containing `\n` (e.g. `a\nINJECTED=x`) | import | 400 (newline would forge a second vault line); engine never invoked | NFR-001 |
| AC-005 | `POST /api/guards/vault-rm` `{key:"API_KEY"}` | with X-ACC | 200; argv is exactly `vault-rm API_KEY` | FR-010 |
| AC-006 | Any vault route | no X-ACC, or foreign Origin/Host | 403; engine never invoked | NFR-001 |
| AC-007 | Engine exits non-zero (e.g. no valid lines) | import | the failure surfaces as `{code, out}`; `out` carries the engine's own message, which by engine contract names only keys, never values | FR-010 |
| AC-008 | Playwright, fake engine | paste `K=v`, Save | key-name list shows `K`; the value input is cleared from the DOM; the fake's stdin got `K=v\n` | FR-010, NFR-008 |
| AC-009 | Playwright | Delete a listed key | it disappears; argv `vault-rm K` recorded | FR-010 |

## 5. Properties

| ID | Property | Kind | Traces to |
|---|---|---|---|
| PROP-001 | For any accepted import, no vault value appears in argv, in any log line, or in any response body — the only sink is engine stdin | invariant (security) | NFR-001 |
| PROP-002 | For any `{key, value}` accepted by the server, `key` matches `^[A-Za-z_][A-Za-z0-9_]*$` and `value` contains no `\r`/`\n` — so the `KEY=VALUE\n` framing cannot be escaped to forge a second entry | invariant (security) | NFR-001 |

## 6. Budget

~45 prod LOC in `gui/server.mjs`, ~40 LOC `gui/guards.html`, tests in `gui/server.test.mjs` + `gui/e2e/guards.spec.mjs`. Coverage floors on `gui/server.mjs`. A `/security-review` pass is a merge gate (values-in-transit).

## 12. Done when

All ACs green (red-first), covgate clears `gui/server.mjs`, `npm test` no new failures, `/security-review` clean on the stdin path, docs (AGENTS.md vault note) in the same commit.

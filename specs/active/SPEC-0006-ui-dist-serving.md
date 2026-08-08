---
title: ACC serves the UI repo's built dist same-origin (--ui-dist)
spec_id: SPEC-0006-ui-dist-serving
slice: SL-014
status: in-progress
created: 2026-08-08
updated: 2026-08-08
completed:
owner: Kyle Smith
traces: [FR-010, FR-012, NFR-001]
---

# SPEC-0006: `--ui-dist` static serving

## 1. In one sentence

`node gui/server.mjs --ui-dist <path>` (or `ACC_UI_DIST`) makes `/` and every non-API GET serve the UI repo's built `dist/` same-origin — the security model (loopback, X-ACC, no CORS) unchanged — with the built-ins still at `/guards` and `/kernel.html` until ADR-0006's parity criterion retires them.

## 2. Why / scope

The ACC half of ADR-0006 (the UI-repo split): ~45 LOC in `gui/server.mjs`, nothing else. This is the FIRST request-derived filesystem path in the server, so the traversal containment IS the spec. Out of scope: deleting the built-ins (parity criterion), any dist path committed to this repo (none — the flag names it at launch).

## 4. Acceptance criteria (all red-first in `gui/server.test.mjs`, "ui-dist" group)

| ID | Given a fixture dist | When | Then | Traces |
|---|---|---|---|---|
| AC-301 | `ACC_UI_DIST` set | GET `/`, `/assets/app.js`, `/spending` | dist index; asset with its content type; SPA fallback to index for client routes | FR-012 |
| AC-302 | same | GET `/guards`, `/kernel.html`, `/api/*` | built-ins and API unshadowed | FR-010 |
| AC-303 | a secret file OUTSIDE the dist | GET `/../s`, `/..%2Fs`, `/%2e%2e/s`, `/assets/../../s`, `/..\\s` | the outside file's content is NEVER served (no decode by design; backslashes normalized; resolved-path containment) | NFR-001 |
| AC-304 | unset / broken dist | GET `/` | unset: kernel page byte-identical to before; dist without index.html: 500, never a crash | FR-010 |
| AC-305 | the CLI flag | `--ui-dist <path>` | sets the env the handler reads; unknown extensions serve as octet-stream | FR-012 |

## 5. Properties

PROP-301: for all request paths, the file read is inside `resolve(dist)` or is `dist/index.html` — no decoding, `\\`→`/` normalization, prefix check on the resolved path (AC-303's generator: raw/encoded/backslash traversal shapes).

## 8/12. Tests, budget, done

T-I-007 (ledger). +45 source LOC / +75 test LOC, 0 new deps. Done when: suite green (67/67), covgate `gui/server.mjs` ≥100/100/90 (actual 100/100/90.2), a real UI-repo dist verified serving via the flag with built-ins + API intact, `gui/README.md` updated same commit. Moves to done with Kyle's round-trip check (a guards toggle from the new UI landing in `config.json` — ADR-0006's verification).

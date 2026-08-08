---
title: The UI moves to its own repo; ACC becomes a headless core with a loopback API
status: accepted
scope: repo
created: 2026-08-08
updated: 2026-08-08
owner: Kyle Smith
traces: [FR-010, FR-012, NFR-008]
supersedes: ADR-0002 (trajectory only — its in-repo pages stay until parity)
superseded_by: none
---

# ADR-0006: UI in its own repo, ACC as headless core + loopback API

## Context

ADR-0002 chose the web platform and migrated the GUI tab by tab into in-repo plain-HTML pages (`gui/guards.html`, `gui/kernel.html`). That migration is complete enough that the GUI's ceiling is now the pages themselves: no components, no typing, no design system, and CON-002 (zero runtime dependencies) rightly forbids building a modern front end inside this repo. Kyle wants an industry-grade UI on a current stack, kept useful for a portfolio, and ACC reduced to what it is: a guard/kernel/runner core with a small local API.

## Decision

The UI becomes its own repo, `agentic-command-center-ui` (React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui on Base UI, per the 2026-08-07 stack research). ACC stays zero-dependency and serves two things: the loopback API (contract: `gui/README.md`) and, later, the UI's **built** `dist/` via a `--ui-dist <path>` flag — same origin, so the existing Host/Origin/X-ACC model is untouched and no CORS grant is ever issued.

## Options considered

| Option | How it works | Maturity cost | Migration cost if we leave | Lock-in | Ecosystem gaps |
|---|---|---|---|---|---|
| **Separate repo, ACC serves the dist (chosen)** | UI builds to static files; ACC's server serves them same-origin | Two repos to version; an API contract to keep honest | Delete the repo; built-ins still exist until parity | none | none |
| Build the React app inside ACC | `package.json` gains the whole front-end toolchain | Breaks CON-002 (zero runtime deps) and floods this repo's test/covgate discipline with a foreign toolchain | n/a | none | none |
| Keep extending plain-HTML pages | More `guards.html` | No components/typing/design system; the ceiling already reached | n/a (status quo) | none | none |

## Why the chosen option

CON-002 is load-bearing: this repo's auditability rests on `node:test` and zero runtime dependencies, and a front-end toolchain would end that. A separate repo gives the UI a real stack without costing ACC anything, and same-origin dist serving means the security model (loopback bind, Host/Origin checks, X-ACC header, no CORS) survives unchanged. The API contract in `gui/README.md` — updated in the same commit as any route change — is the coupling point, enforced by the UI repo's contract e2e suite running against a real ACC server.

## Consequences

| | |
|---|---|
| We can now | Build a component-grade UI (dark mode, design system, animation) without touching ACC's dependency surface |
| We can no longer | Change an API route without updating `gui/README.md` in the same commit — the UI repo builds against it |
| We must maintain | The contract doc, and (until parity) the built-in pages alongside the new UI |
| We are exposed to | Contract drift between repos — mitigated by the UI repo's Playwright contract suite against a live ACC server (fake seams: `ACC_ENGINE`/`ACC_USAGE`/`ACC_BUDGET`/`ACC_RUNNER`/`ACC_ROOT`) |

## Built-in pages: the deletion criterion

`gui/guards.html` and `gui/kernel.html` stay exactly until the UI repo passes its contract suite against a live ACC server **for every page it replaces** (guards/vault/spending/start-work/kernel). Then the built-ins are deleted in one PR that also drops their Playwright specs — before that, deleting them would strand Kyle with no working UI on any regression in the new repo.

## Reversal

| Field | Answer |
|---|---|
| Cost to reverse | Low: stop serving `--ui-dist`; the built-in pages (or their git history, post-parity) resume |
| What would trigger a reversal | The UI repo goes unmaintained or its build breaks in a way not worth fixing |
| What is proprietary and would not transfer | Nothing |

## Verification

Within 90 days: the UI repo's contract suite green against a live ACC server for at least the Start-work page, and `/` serving the built dist on Kyle's machine via `--ui-dist`. Measured by the UI repo's CI plus one manual round-trip (a guards toggle from the new UI landing in `config.json`).

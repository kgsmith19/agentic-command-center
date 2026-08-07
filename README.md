# Agentic Command Center

A guard rail and control panel that lets Claude Code sessions run longer and more unattended on one Windows machine without more risk: a hook that blocks risky file touches, a headless kernel that runs bounded tasks under independent verification, and a directive loop that lets work survive a context-limit reset. See `docs/PRD.md` for the full picture.

## Prerequisites

- Node.js >= 22 (pinned in `package.json`'s `engines`)
- Windows, PowerShell 5.1+, and the WebView2 runtime for the GUI/watcher/shim layers (`gui/`, `watcher/`, `shim/`) — these do not run on Linux
- `npm install` (pulls the one devDependency, `@playwright/test`, for GUI e2e only)

## Run it

```bash
node kernel/run.mjs <contract.json>     # one headless, bounded, verified task
node kernel/ledger.mjs query            # inspect past kernel runs
```

```powershell
.\Guards Control.cmd                    # the GUI control panel (Windows only)
```

## Test it

```bash
npm test               # fast tier, hermetic, portable subset — runs on Linux CI and locally
node hooks/covgate.mjs # coverage gate on changed lib files
```

Windows-only suites (PowerShell, C#, the full GUI) and the real-token proof-tier suites are documented in `AGENTS.md`, "The regression, exactly" — they are not part of `npm test` because they either need Windows or spend real API tokens.

## Where things are

| Doc | What it answers |
|---|---|
| `docs/PRD.md` | What this does, for whom, and why — the source of truth |
| `docs/SYSTEM-REQUIREMENTS.md` | What the system must be so the PRD is achievable |
| `docs/DATA-FLOW-DIAGRAM.md` | Where data comes from, goes, and rests |
| `docs/adr/` | Standing architecture decisions, including one still-open question (`ADR-0001`) |
| `AGENTS.md` | The deep operational reference for every subsystem |
| `CLAUDE.md` | How an agent should work in this repo |
| `specs/` | In-progress and completed specs, and the test justification ledger |

## Workflow

New work follows the SDD cycle in `prompts/`: research (`10-research.md`) → PRD update (`12-prd-update.md`) → spec (`20-spec-write.md`) → red tests (`30-tests-red.md`) → green implementation (`31-implement-green.md`) → review (`40-lean-review.md`) → merge (`33-integrate-merge.md`). `prompts/91-cycle.md` is the one-slice-end-to-end shortcut. Most of this repo predates that cycle; it governs new work going forward.

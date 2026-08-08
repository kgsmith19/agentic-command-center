# Agentic Command Center

A guard rail and control panel that lets Claude Code sessions run longer and more unattended on one Windows machine without more risk: a hook that blocks risky file touches, a headless kernel that runs bounded tasks under independent verification, and a directive loop that lets work survive a context-limit reset. See `docs/PRD.md` for the full picture.

## Prerequisites

- Node.js >= 22 (pinned in `package.json`'s `engines`)
- Windows + PowerShell 5.1+ only for the launch shim and cap-watch (`shim/`, `watcher/`) — everything else runs anywhere Node does
- `npm install` (pulls the one devDependency, `@playwright/test`, for GUI e2e only)

## Run it

```bash
npm run gui                             # the web Command Center -> http://127.0.0.1:43117
node kernel/run.mjs <contract.json>     # one headless, bounded, verified task
node kernel/ledger.mjs query            # inspect past kernel runs
node runner/runner.mjs directive:<id>   # run a directive headless to completion
```

## Test it

```bash
npm test               # fast tier, hermetic, portable subset — runs on Linux CI and locally
node hooks/covgate.mjs # coverage gate on changed lib files
```

The three Windows-only PowerShell suites (shim + cap-watch) and the real-token proof-tier suites are documented in `AGENTS.md`, "The regression, exactly" — they are not part of `npm test` because they either need Windows or spend real API tokens.

## Where things are

| Doc | What it answers |
|---|---|
| `docs/PRD.md` | What this does, for whom, and why — the source of truth |
| `docs/SYSTEM-REQUIREMENTS.md` | What the system must be so the PRD is achievable |
| `docs/DATA-FLOW-DIAGRAM.md` | Where data comes from, goes, and rests |
| `docs/adr/` | Standing architecture decisions, see `ADR-0005`/`ADR-0006` for the latest |
| `AGENTS.md` | The deep operational reference for every subsystem |
| `CLAUDE.md` | How an agent should work in this repo |
| `specs/` | In-progress and completed specs, and the test justification ledger |

## Workflow

New work follows one SDD cycle: research → PRD update → spec → red tests → green implementation → review (lean + security) → merge, docs updated in the same commit. See `CLAUDE.md` for the phase-by-phase table. Most of this repo predates that cycle; it governs new work going forward.

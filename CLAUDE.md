# CLAUDE.md

## What this repo is

A guard rail and control panel that lets Claude Code sessions run longer and more unattended on Kyle's machine without more risk: a hook that blocks risky file touches, a headless kernel that runs bounded tasks under independent verification, and a directive loop that survives context-limit resets.

## Read before you act

| Order | File | Why |
|---|---|---|
| 1 | `docs/PRD.md` | **Source of truth.** Living document. |
| 2 | `rules/00-CORE.md` | Principles, halts, output contract |
| 3 | `AGENTS.md` | The deep operational reference — guard, vault, runboxes, kernel, launch lane, directive loop, folder routing. Read the section for whatever you're touching before touching it. |
| 4 | The rule card a prompt names | Do not read all of `rules/` by default |
| 5 | `specs/active/` | What is being built right now, if anything is |

`docs/SYSTEM-REQUIREMENTS.md` and `docs/DATA-FLOW-DIAGRAM.md` are read when the work touches architecture, interfaces, data, or security. `docs/adr/` holds standing decisions — read the ones relevant to what you're touching (`ADR-0001` before touching the ConPTY/directive-loop mechanism, `ADR-0002` before touching the GUI, `ADR-0003` before touching the launch cap).

## STOP conditions

**Do not write a spec, write code, or merge if any of these is true.** Report and ask instead.

1. `docs/PRD.md` does not exist.
2. `docs/PRD.md` contains an unfilled `<placeholder>`.
3. Any `FR-` or `NFR-` has no value in its Status column.
4. The work implements something no PRD requirement asks for. Update the PRD first, or do not build it.
5. The PRD contradicts an active spec or an accepted ADR.
6. The change needs a new library, service, or third-party integration (this repo runs on zero runtime dependencies by design — CON-002).
7. The change would touch guard machinery, `~/.claude/settings.json`, or another protected path — that goes through the runbox handoff (`AGENTS.md`), never a direct edit.

## Where things live

```
docs/PRD.md                    source of truth
docs/SYSTEM-REQUIREMENTS.md    what the system must be
docs/DATA-FLOW-DIAGRAM.md      where data comes from, goes, rests
docs/adr/ADR-NNNN-<kebab>.md   decisions with trade-offs
docs/notes/YYYY-MM-DD-<kebab>.md   everything else doc-shaped
specs/active/SPEC-NNNN-<kebab>.md  in progress
specs/done/SPEC-NNNN-<kebab>.md    completed
specs/TEST-LEDGER.md           every test's justification (enforced going forward; see its own header for backfill status)
kernel/README.md               the kernel's own deep reference
runner/README.md               the slice-runner's own deep reference
```

`docs/` root holds **exactly three** `.md` files. Nothing else goes there, ever. Full rules: `rules/04-DOCS.md`.

## Workflow

| Phase | Prompt | Notes |
|---|---|---|
| Explore | `prompts/10-research.md` | |
| Requirements | `prompts/11-prd-create.md` / `12-prd-update.md` | |
| Spec | `prompts/20-spec-write.md` | |
| Build | `prompts/30-tests-red.md` / `31-implement-green.md` | Red-first, per `rules/06-TESTS.md` |
| Review | `prompts/40-lean-review.md`, `41-security-review.md` | |
| Ship | `prompts/33-integrate-merge.md`, `90-ship.md` | |

`prompts/` is copied in from the SDD pack but not yet wired into day-to-day work on this repo — most changes so far are direct fixes against the existing, already-shipped system rather than fresh slices. Adopt the cycle (`prompts/91-cycle.md`) for new, greenfield work going forward.

## Non-negotiables

1. **Cheapest sufficient mechanism.** Type/schema constraint -> lint -> pure function -> DB constraint -> test -> runtime check -> network call -> LLM call.
2. **Every real regression test stays.** This repo's kernel and hooks carry hard-won tests tied to specific historical bugs (TOCTOU races, uncaught-throw crashes, timing bugs). Do not delete or weaken one without naming the bug it guards and why it's safe.
3. **No abstraction with fewer than three callers.** Two similar blocks is a coincidence, not a pattern.
4. **Docs update in the same commit** as the behavior change, never later.
5. **Deletion is progress** and gets reported as progress.
6. **No secret ever appears in a commit, a log, or an agent transcript.** Vault values flow by name only (`AGENTS.md`).

## Commands

```bash
npm test              # fast tier, hermetic, portable subset (Linux CI + local)
npm run test:windows  # fast tier, full set including Windows-only PowerShell suites
node hooks/covgate.mjs   # coverage gate on changed lib files (lines 100 / functions 100 / branches 90)
node e2e/loop.e2e.mjs    # proof tier — spends real tokens, run deliberately
node kernel/kernel.e2e.mjs   # proof tier — spends real tokens, run deliberately
npm run e2e:gui        # Playwright GUI e2e
```

Full regression command block, including the Windows-only PowerShell/GUI suites this Linux environment cannot run: `AGENTS.md`, "The regression, exactly."

## Project variables

```yaml
PROJECT_NAME:  Agentic Command Center (ACC / "guards")
LANGUAGE:      Node 22 (hooks, kernel, runner), PowerShell 5.1+ (GUI, watcher, shim), C# / .NET (PtyHost)
FRAMEWORK:     node:test (zero runtime deps); @playwright/test (one devDependency, GUI e2e only)
DATABASE:      none — JSONL append-only files, no schema
MAIN_BRANCH:   main
```

## Review cadence

No fixed slice-count cadence yet — this repo predates that discipline. Going forward: lean review and doc refresh before any change that touches more than one subsystem; security review before anything touching the guard, vault, or the ConPTY channel.

## Never

- Declare a gate passed without showing its command output.
- Edit a test to make it pass without writing down why the test was wrong.
- Add a dependency to avoid writing 30 lines.
- Leave `TODO`, `FIXME`, or commented-out code in a merged change.
- Create `archive/`, `old/`, or `_backup/`. Git is the archive.
- Reference a path outside this repo, or a deleted file (this pass fixed every stale reference to the old `OPEN-ISSUES.md` and `docs/superpowers/` — keep it that way).
- Track issues in a markdown ledger. Open a GitHub issue instead.

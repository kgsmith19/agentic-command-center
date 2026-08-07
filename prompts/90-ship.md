# 90: SHIP (goal: spec all -> implement all -> review -> merge)

**Read:** `rules/00-CORE.md`, `rules/07-SKILLS.md`
**Skills:** the full superpowers chain, per stage
**Produces:** merged `main`, specs in `done/`, docs current, reviews clean

The top-level goal. Runs the whole loop unattended until a halt or a merge. **Every stage is a barrier: do not start the next until the current one fully passes.**

## CONFIG

```yaml
MODE:            full | spec-only | implement-only
SLICES:          auto | [SL-007, SL-008]
MAX_WORKTREES:   3
STOP_AFTER:      <n slices, or "all ready">
AUTO_MERGE:      true
DRY_RUN:         false
```

| `MODE` | Runs stages |
|---|---|
| `full` | 0 through 6 |
| `spec-only` | 0, 1 |
| `implement-only` | 0, 2 through 6 |

## Stages

### Stage 0: Preflight (barrier)

| # | Check | Fail action |
|---|---|---|
| PF1 | `docs/PRD.md` exists, zero unfilled placeholders, every `FR`/`NFR` has a status | **Halt.** Run `prompts/11-prd-create.md` or `12-prd-update.md`. |
| PF2 | Suite is green on `main` | Halt. Fix before anything else. |
| PF3 | Working tree clean, no stale worktrees | Clean up |
| PF4 | Every variable in `rules/01-BUDGETS.md` is set | Halt |
| PF5 | At least one slice is ready (dependencies in `specs/done/`) | Stop, report nothing to do |
| PF6 | Superpowers available, or fallbacks selected and noted | Note in report |

With `DRY_RUN: true`, run stage 0, print the plan for stages 1 through 6, and stop.

### Stage 1: Spec all

Run `prompts/22-spec-all.md`.

**Barrier:** every spec passes GATE-SPEC and the reconciliation pass completed with a published file-ownership map. Nothing proceeds until `specs/active/` is coherent.

If `MODE: spec-only`, stop here and report.

### Stage 2: Implement all

Run `prompts/32-implement-all.md`. Worktree per spec; subagents per task inside each worktree.

**Barrier:** every worktree at GATE-GREEN in isolation, then the integration barrier (merge in slice order, full suite after **each** merge), then GATE-GREEN on the integrated branch.

A worktree that halts stops itself only. Others continue. Report every halt.

### Stage 3: Reviews (parallel, all must clear)

Run concurrently on the integration branch, `APPLY: apply-safe`:

| Review | Blocks on |
|---|---|
| `prompts/40-lean-review.md` | Any P0 or P1 |
| `prompts/41-security-review.md` | Any P0 |
| `prompts/43-doc-refresh.md` | GATE-DOC failing |

Cadence extras, run only if due: `42-test-review.md` every `{{TEST_REVIEW_EVERY}}` slices, `44-process-review.md` every `{{PROCESS_REVIEW_EVERY}}`.

**Barrier:** zero blocking findings open. A finding needing judgment stays a finding and blocks if it is P0.

### Stage 4: Ship

Run `prompts/33-integrate-merge.md`. Rebase, re-verify, GATE-SHIP SH1-SH8, open the PR, merge with `AUTO_MERGE`.

**Barrier:** every SH check green. No override.

### Stage 5: Post-merge verification

Full suite on `main`. Red means **revert immediately**, then diagnose. Never fix forward on `main`.

Confirm PRD status columns read `done` for every delivered requirement. Confirm every migration applied and its down path is still in the repo. Delete merged branches and worktrees.

### Stage 6: Loop or stop

| Condition | Action |
|---|---|
| More slices ready and `STOP_AFTER` not reached | Return to stage 1 |
| `STOP_AFTER` reached | Stop and report |
| No slices ready | Stop. Report what unblocks the next one. |
| Any halt | Stop. Report the decision needed and the options with their costs. |

## GATE-SHIP-GOAL

| # | Check |
|---|---|
| SG1 | Every stage barrier passed in order, none skipped |
| SG2 | Every spec that entered stage 1 is in `done/` or explicitly reported as not shipped, with a reason |
| SG3 | Full suite green on `main` after merge |
| SG4 | Zero P0 findings open |
| SG5 | GATE-DOC passes on `main` |
| SG6 | Every worktree removed |
| SG7 | The run report states what was **not** done |

## OUTPUT

```
### Stage log
| Stage | Started | Outcome | Barrier passed | Notes |

### Shipped
| Slice | Spec | Requirements | Tests + | Tests - | Net LOC | Commit |

### Not shipped
| Slice | Stage reached | Why | Unblocked by |

### Reviews
| Review | Findings P0/P1/P2/P3 | Applied | Deferred |

### Gates
| Gate | Result | Evidence |

### Cumulative budget
| Metric | Total | Per-slice ceiling respected? |

### Assumptions promoted to the PRD
| ID | Assumption | Blast radius |

### Deleted this run
<code, tests, docs>

### Next
<the next ready slice, or the decision needed>
```

## HALT

Core halts, plus any stage barrier failing. On halt: report the stage, the exact failing check, what has already been committed and is safe, what is in an intermediate state, and the options with their costs. **Never leave a worktree or an integration branch in an undocumented state.**

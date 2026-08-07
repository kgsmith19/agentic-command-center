# 91: CYCLE (goal: one slice, end to end)

**Read:** `rules/00-CORE.md`, `rules/07-SKILLS.md`
**Skills:** the full superpowers chain
**Produces:** one slice specced, built, reviewed, merged

The single-slice loop. Use this by default. Use `prompts/90-ship.md` only when three or more slices are ready and their file sets are disjoint.

## CONFIG

```yaml
SLICE_ID:     SL-<NNN> | next
AUTO_MERGE:   true
SKIP_REVIEWS: false     # true only when reviews are not due by cadence
```

## Steps

| # | Step | Prompt | Skill | Barrier before continuing |
|---|---|---|---|---|
| 0 | Preflight | - | - | PRD valid, suite green on `main`, tree clean, budgets set |
| 1 | Pick the slice | - | - | `SLICE_ID: next` takes the lowest-numbered slice whose dependencies are all in `specs/done/` |
| 2 | Refresh requirements if needed | `12-prd-update.md` | - | PRD has no contradiction with this slice |
| 3 | Write the spec | `20-spec-write.md` | `brainstorming` only if behavior is fuzzy | GATE-SPEC |
| 4 | Review the spec | `21-spec-review.md` | - | Verdict `READY` |
| 5 | Worktree | `31-implement-green.md` step 1 | `using-git-worktrees` | Clean green baseline in the worktree |
| 6 | Plan | `31-implement-green.md` step 2 | `writing-plans` | Every task under `{{MAX_TASK_MINUTES}}`, task 1 is the red tests, last task is docs |
| 7 | Red | `30-tests-red.md` | `test-driven-development` | GATE-RED R1-R7, GATE-PROPERTY PR1-PR6 |
| 8 | Green | `31-implement-green.md` steps 3-5 | `subagent-driven-development`, `test-driven-development`, `requesting-code-review` | GATE-GREEN G1-G10, GATE-MINIMAL M1-M10 |
| 9 | Docs | `31-implement-green.md` step 6 | - | GATE-DOC |
| 10 | Close the spec | `31-implement-green.md` step 7 | `verification-before-completion` | Definition of Done, spec in `specs/done/` |
| 11 | Reviews if due | `40`, `41`, `42`, `43`, `44` | - | Zero P0 open |
| 12 | Ship | `33-integrate-merge.md` | `finishing-a-development-branch` | GATE-SHIP SH1-SH8 |
| 13 | Post-merge | - | - | Suite green on `main`; revert on red, never fix forward |

## Which reviews are due

Check the slice number after step 10:

| Divisible by | Run |
|---|---|
| `{{LEAN_REVIEW_EVERY}}` | `40-lean-review.md` |
| `{{DOC_REFRESH_EVERY}}` | `43-doc-refresh.md` |
| `{{SECURITY_REVIEW_EVERY}}` | `41-security-review.md` |
| `{{TEST_REVIEW_EVERY}}` | `42-test-review.md` |
| `{{PROCESS_REVIEW_EVERY}}` | `44-process-review.md` |

State which are due and which you ran. **Never skip silently.** `SKIP_REVIEWS: true` still requires reporting what was skipped.

## Where this most often goes wrong

| Symptom | Real cause | Do this |
|---|---|---|
| Step 7 red is an `ImportError` | GATE-RED R2 ignored | Write the minimum stub, re-run |
| Step 8 needs `MAX_RED_GREEN_CYCLES`+ attempts | The spec or the test is wrong | **Halt.** Report both hypotheses. Do not keep debugging. |
| Step 8 breaches budget | The slice was too big at step 3 | Stop, split, redo the spec |
| Step 9 feels like busywork | Docs were left to the end instead of the same commit | Correct, but do it anyway; then fix the habit next slice |
| Step 12 blocked by a review finding | The finding is real | Fix it as its own slice, not by widening this one |
| A subagent drifts off-task | It was handed too much context | Give it only the spec, its task, and the two rule cards |

## OUTPUT

```
### Slice
SL-NNN <title> | Spec SPEC-NNNN | Requirements <FR ids>

### Step log
| # | Step | Barrier | Result | Evidence |

### Budget
| Metric | Actual | Ceiling | Status |

### Tests
| T-id | Level | Traces to | Mutation verified |
Deleted: <T-ids or none>

### Assumptions
| ID | Assumption | How to verify | Blast radius |

### Reviews due / run
| Review | Due | Ran | Findings |

### Merged
Commit <sha> | Suite on main: <result>

### Next
<the next ready slice>
```

## HALT

Core halts, plus any barrier failing. Report the step, the failing check, what is committed and safe, what is in an intermediate state, and the options with their costs.

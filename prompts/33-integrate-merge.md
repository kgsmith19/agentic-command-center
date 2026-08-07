# 33: Integrate, PR, Merge

**Read:** `rules/00-CORE.md`, `rules/02-GATES.md`, `rules/04-DOCS.md`
**Skill:** `superpowers:finishing-a-development-branch`
**Produces:** a merged `main`, or a blocked report naming exactly what failed

Auto-merge is permitted **only** when every GATE-SHIP check passes. There is no override.

## CONFIG

```yaml
BRANCH:        integrate/<YYYY-MM-DD> | slice/SL-<NNN>-<kebab>
MAIN_BRANCH:   main
AUTO_MERGE:    true
DELETE_BRANCH: true
```

## DO

### 1. Rebase and re-verify

Rebase `BRANCH` onto current `MAIN_BRANCH`. Run the **full** suite after the rebase.

Green before rebase means nothing. `main` moved.

### 2. Run the required reviews

Not optional before a merge. Each must report zero P0 findings.

| Review | Prompt | Blocks on |
|---|---|---|
| Lean | `prompts/40-lean-review.md` | Any P0 or P1 |
| Security | `prompts/41-security-review.md` | Any P0 |
| Doc refresh | `prompts/43-doc-refresh.md` | GATE-DOC failing |

Run them with `APPLY: apply-safe`. Findings that need judgment stay as findings and block if they are P0.

### 3. Verify GATE-SHIP

| # | Check | Evidence |
|---|---|---|
| SH1 | GATE-GREEN passes on this branch, not only per worktree | command + exit code |
| SH2 | GATE-DOC passes | |
| SH3 | Every spec in the batch passed its Definition of Done | list |
| SH4 | Lean, security, and doc refresh ran; zero P0 open | reports |
| SH5 | Every migration has a tested down path | the test output |
| SH6 | Zero secrets in the diff or in history | scan output |
| SH7 | PR description lists delivered requirement IDs and the rollback plan | the text |
| SH8 | Rebased on current `main` and green after rebase | |

Any failure: **stop, report exactly which check and why, do not merge.**

### 4. Open the PR

```markdown
## What changed
<one sentence per slice, plain language>

## Requirements delivered
| ID | Requirement | Spec | Tests |

## Budgets
| Slice | Net LOC | Tests + | Tests - | Within ceiling |

## Migrations
| Migration | Down path tested | Zero-downtime approach |

## Gates
| Gate | Result | Evidence |

## Rollback
<exact mechanism, time to execute, what survives rollback, who decides, what triggers it>

## Assumptions made
| ID | Assumption | Blast radius | Promoted to PRD? |

## Deleted
<what was removed and why>
```

### 5. Merge

With `AUTO_MERGE: true` and every SH check green: merge to `MAIN_BRANCH`.

| Step | |
|---|---|
| Strategy | Squash for a single slice; merge commit for an integration branch, so each slice stays a distinct commit |
| Message | `SL-NNN: <outcome>` or `integrate: SL-NNN..SL-MMM` |
| After merge | Run the full suite on `MAIN_BRANCH`. Red means revert immediately, then diagnose. Do not fix forward on `main`. |
| Migrations | Apply forward. Confirm the down path is still present in the repo. |
| Cleanup | Delete the branch and every worktree if `DELETE_BRANCH: true` |

### 6. Post-merge

Confirm PRD status columns say `done` for every delivered requirement. State which reviews are now due per cadence. Report the next slice.

## OUTPUT

```
### GATE-SHIP
| # | Check | Result | Evidence |

### Merged
| Slice | Spec | Requirements | Commit |

### Blocked (if any)
| Check | Why | What must happen |

### Post-merge verification
Suite on main: <result> | Migrations applied: <list> | Branches deleted: <list>

### Next
<the next slice, or the reviews now due>
```

## HALT

Core halts, plus: any GATE-SHIP check fails; the suite is red on `main` after merge (revert first, then report); a migration cannot be rolled back; a secret is found in history (needs rotation plus history rewrite, both human decisions); the rebase produces a conflict needing a product decision.

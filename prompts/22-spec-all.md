# 22: Spec All (goal, worktree-parallel)

**Read:** `rules/00-CORE.md`, `rules/05-SPECS.md`, `rules/07-SKILLS.md`
**Skill:** `superpowers:using-git-worktrees`, `superpowers:dispatching-parallel-agents`
**Produces:** every ready slice specced, reviewed, reconciled, and in `specs/active/`

Specs do not compile, so writing several at once is cheap. **The risk is not conflict during writing, it is contradiction at the end.** The reconciliation barrier in step 4 is the whole point of this prompt.

## CONFIG

```yaml
SLICES:          auto | [SL-007, SL-008, SL-009]
MAX_WORKTREES:   3
STOP_AFTER:      <n slices, or "all ready">
```

## DO

### 1. Select

With `SLICES: auto`, take slices from the PRD plan where **every** dependency is in `specs/done/`. Cap at `MAX_WORKTREES`.

Skip and report any slice that: has no PRD requirement, depends on an unfinished slice, or is already specced.

**If fewer than three slices are ready, do not parallelize.** Run `prompts/20-spec-write.md` sequentially and say so. Below three, coordination costs more than it saves.

### 2. Fan out

One worktree per slice via `superpowers:using-git-worktrees`. Branch `spec/SL-NNN-<kebab>`.

Each agent runs `prompts/20-spec-write.md` with its own `SLICE_ID` and `REQUIREMENTS`. Give each agent: the PRD, the system requirements, the DFD, `rules/05-SPECS.md`, `rules/06-TESTS.md`, and its slice. **Nothing else.**

Agents do not talk to each other. Cross-talk during authoring produces averaged specs, which are worse than either original.

### 3. Self-review

Each agent runs `prompts/21-spec-review.md` on its own spec before reporting. A spec returning `REWRITE` is redone in its own worktree, not escalated.

### 4. Reconciliation barrier (mandatory)

**Nothing enters `specs/active/` until every spec is drafted and this pass completes.** Run it in the main worktree, reading all drafts together.

| Conflict | Action |
|---|---|
| Two specs modify the same file | Serialize them, or find the seam that separates them |
| Two specs add the same table or column | One owns it; the other declares a dependency on that slice |
| Two specs define overlapping acceptance criteria | Deduplicate. One requirement, one owner. |
| Two specs assume different shapes for the same interface | **Halt.** This is a system-requirements gap; fix `docs/SYSTEM-REQUIREMENTS.md` first. |
| Combined budget breaks a shared ceiling (tables, libraries, third-party) | Reorder so the shared resource lands in exactly one slice |
| Two specs claim the same requirement ID | One owns it; the other traces to a different requirement or is deleted |
| A spec contradicts the PRD | Halt that spec. Run `prompts/12-prd-update.md` first. |

Record every conflict found and its resolution. **A reconciliation pass reporting zero conflicts across three or more specs is suspicious**: check that the agents actually read the same PRD version.

### 5. Land

For each surviving spec, in slice order: `git mv` the draft into `specs/active/` on the main branch, commit `spec: SL-NNN <title>`, remove the worktree.

Then verify: no two specs in `specs/active/` modify the same file, and every spec still passes GATE-SPEC after reconciliation edits.

### 6. Report

State explicitly which slices were **not** specced and why. Silent truncation reads as "we covered everything".

## GATE-SPEC-BATCH

| # | Check |
|---|---|
| SB1 | Every spec individually passes GATE-SPEC |
| SB2 | Reconciliation ran and its findings are recorded |
| SB3 | No two specs in `specs/active/` modify the same file |
| SB4 | No two specs add the same table or column |
| SB5 | Combined budget respects every shared ceiling |
| SB6 | Every worktree removed |
| SB7 | Slices not specced are listed with a reason |

## OUTPUT

```
### Specced
| Slice | Spec | Requirements | Verdict | Budget (tightest line) |

### Not specced
| Slice | Why | Unblocked by |

### Reconciliation
| Conflict | Specs | Resolution |

### File ownership map
| File | Owned by spec | Any contention? |
```

## HALT

Core halts, plus: two specs need incompatible interface shapes; a shared ceiling cannot be satisfied by reordering; a draft contradicts the PRD.

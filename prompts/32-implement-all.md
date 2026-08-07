# 32: Implement All (goal, worktree-parallel + subagents)

**Read:** `rules/00-CORE.md`, `rules/02-GATES.md`, `rules/07-SKILLS.md`
**Skills:** `using-git-worktrees`, `dispatching-parallel-agents`, then `prompts/31-implement-green.md` inside each worktree
**Produces:** every ready spec green, integrated, and in `specs/done/`

Two levels of parallelism. Keep them separate: **worktrees isolate specs; subagents execute tasks inside one worktree.** Conflating them is the main way parallel work goes wrong.

## CONFIG

```yaml
SPECS:                  auto | [SPEC-0007, SPEC-0008]
MAX_WORKTREES:          3
MAX_SUBAGENTS_PER_TREE: 4
INTEGRATION_BRANCH:     integrate/<YYYY-MM-DD>
```

## DO

### 1. Select and prove disjointness

With `SPECS: auto`, take every spec in `specs/active/` that passed GATE-SPEC and whose dependencies are in `specs/done/`.

**Then compare their "files expected to change" lists.** Any overlap means serialize those two; parallelize the rest. Also serialize any pair that:

| Shares | Because |
|---|---|
| A migration on the same table | One slice owns a schema change; the other depends on it |
| The dependency manifest or lockfile | Two worktrees editing a lockfile is a guaranteed conflict |
| A shared config or route registry | Unless the registry is append-only by convention |

**Do not parallelize at all** when fewer than three specs are ready, the codebase is under about 2000 LOC (everything still touches everything), or the data model is still changing shape. Sequential is genuinely faster there. Say so plainly and run `prompts/31-implement-green.md` in a loop.

Publish the file-ownership map before starting. It is the artifact that makes this safe.

### 2. Fan out

One worktree per spec, capped at `MAX_WORKTREES`. Branch `slice/SL-NNN-<kebab>` from current `main`. Each gets its own database (Supabase branch, separate schema, or container).

Each worktree runs the full `prompts/31-implement-green.md` **through step 7 only**. It does not merge. It does not update the three canonical docs (that happens once, at integration).

Inside each worktree, subagents run per `rules/07-SKILLS.md` level 2: one per task, fresh context, given only the spec, its task, and the two rule cards.

### 3. Wait for all green

**Nothing merges until every worktree reaches GATE-GREEN in isolation.**

A worktree that halts stops itself only. The others continue. Report the halt and its cause; do not let a stuck worktree block healthy ones or silently drop out.

### 4. Integration barrier (mandatory)

Individual green does not imply integrated green. This barrier is the entire reason parallel work is safe.

1. Create `INTEGRATION_BRANCH` from current `main`.
2. Merge worktrees **in slice-number order**.
3. After **each** merge, run the **full** suite including every other slice's tests.
   - Green: continue.
   - Red: **that slice owns the fix.** The others wait. Fix it in its own worktree, re-verify GATE-GREEN, re-merge.
4. After the last merge, run GATE-GREEN again on the integrated branch, in full.

### 5. Docs once

On the integration branch, covering all merged slices: PRD status column, system requirements, DFD, README, test ledger, any ADRs. Run GATE-DOC.

Doing this per-worktree produces three conflicting edits to the same PRD table. Doing it once does not.

### 6. Close and clean

For each merged spec: fill Actual budgets, run its Definition of Done, `git mv` to `specs/done/`. Remove every worktree.

Hand off to `prompts/33-integrate-merge.md` for reviews, PR, and merge.

### 7. Report what did not happen

List every spec **not** implemented and why. Silent truncation reads as "we covered everything".

## GATE-BATCH

| # | Check |
|---|---|
| BA1 | File-ownership map published before starting, with zero contention |
| BA2 | Every worktree passed GATE-GREEN in isolation |
| BA3 | Merges happened in slice-number order |
| BA4 | Full suite ran after **every** merge, not only the last |
| BA5 | GATE-GREEN passes on the integrated branch |
| BA6 | Docs updated once, on the integration branch |
| BA7 | Every worktree removed |
| BA8 | Every spec not implemented is listed with a reason |

## OUTPUT

```
### File ownership map
| File | Owned by | Contention |

### Worktrees
| Spec | Branch | Tasks | Subagents | Outcome | Budget (tightest) |

### Integration log
| Order | Spec merged | Full suite | Fix needed | Owner |

### Not implemented
| Spec | Why | Unblocked by |

### Combined budget
| Metric | Total across slices | Per-slice ceiling respected? |
```

## HALT

Core halts, plus: two worktrees produce an unresolvable merge conflict (lower slice number wins, the other rebases and re-runs its full suite; escalate only if that fails); the integrated suite is red and no single slice owns the failure; a shared migration was added by two slices.

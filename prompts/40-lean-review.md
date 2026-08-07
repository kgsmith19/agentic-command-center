# 40: Lean Review

**Read:** `rules/00-CORE.md`, `rules/01-BUDGETS.md`
**Skill:** `engineering:tech-debt` for ranking, optional
**Produces:** deletions

**Deletion is the deliverable.** A lean review ending with "the code looks good" and nothing on the delete list has not looked hard enough. Formatting is a lint rule's job; you are hunting **structural excess**: things that exist, cost maintenance, and buy nothing.

## CONFIG

```yaml
SCOPE:   whole-repo | <path> | last-<n>-slices
APPLY:   report-only | apply-safe | apply-all
```

Preconditions: suite green, working tree clean.

## DO

### 1. Measure

Source LOC, test LOC, test-to-source ratio, file count, largest file, longest function, direct and transitive dependencies, exported symbols, tables, columns, endpoints, config keys, environment variables, suite runtime, p95 cyclomatic complexity. Compare each to the last review.

**Growth rate is the signal, not the absolute number.** LOC growing faster than delivered requirements means complexity is outpacing value.

### 2. Dead weight

| Target | How to find | Default verdict |
|---|---|---|
| Unreferenced code | Static analysis, then delete and run the suite | Delete |
| Unreachable branches | Coverage showing zero hits | Delete |
| Commented-out code | grep | Delete. Git remembers. |
| `TODO`/`FIXME` over 30 days | grep + blame | Do it, spec it, or delete the comment |
| Feature flags permanently on or off | grep the flag | Delete the flag and the dead side |
| Config keys and env vars never read | grep | Delete |
| Exported symbols with no external caller | Reference search | Make private, or delete |
| Tables and columns never written or never read | Schema vs code | Delete, with a migration |
| Endpoints with no caller | Routes vs clients and access logs | Delete |
| Dependencies with one shallow use | Manifest vs usage | Inline the 30 lines, drop the dependency |
| Files under 20 lines that only re-export | Inspection | Merge into the caller |

### 3. Premature abstraction

The rule is three. Two instances is a coincidence.

| Smell | Verdict |
|---|---|
| Interface with one implementation | Inline it |
| Factory producing one type | Call the constructor |
| Base class with one subclass | Merge |
| Generic parameter with one instantiation | Make it concrete |
| Wrapper adding no behavior | Delete |
| Layer that only forwards calls | Delete |
| Utility module that is a bag of unrelated functions | Move each function beside its only caller |
| Event or callback with one subscriber | Call it directly |
| Abstraction created "for testing" | The test is at the wrong level. Fix the test. |

### 4. Requirement orphans

| Finding | Action |
|---|---|
| Code implementing nothing in the PRD | Add the requirement, or delete the code. **Never leave it ambiguous.** |
| A requirement marked `done` with no implementing code | The status is wrong, or the code was deleted. Investigate. |
| A requirement `not-started` over 90 days | Propose `dropped` |

### 5. Complexity hotspots

Function over `{{MAX_FUNCTION_LOC}}`, file over `{{MAX_FILE_LOC}}`, complexity over `{{MAX_CYCLOMATIC}}`, nesting over 3, more than 4 parameters (they are a struct you have not named), more than 7 public methods (it is two classes), any import cycle (a design defect, not a style issue).

### 6. Expensive-mechanism audit

Core principle 1. For every costly thing, ask whether something cheaper suffices.

| Found | Ask | Cheaper |
|---|---|---|
| An LLM call | Is the output genuinely open-ended? | Lookup table, regex, rule, pure function |
| An LLM call in a loop | Can it be one batched call? | Batch, or eliminate |
| A network call | Is the data already local or derivable? | Local computation, a join |
| A cache | Is the underlying operation measurably slow? | Delete it. An unnecessary cache is a correctness bug waiting. |
| A queue | Is anything actually asynchronous here? | Inline |
| A retry loop | Is the operation idempotent? | If not, the retry is a bug |
| A runtime validation | Can a type or constraint enforce it? | Move it down |
| A polling loop | Is there an event? | Subscribe |

### 7. Rank and apply

P0 causing a defect or hazard | P1 costing maintenance now | P2 will cost later | P3 cosmetic, note only.

Sort by maintenance cost saved divided by effort to remove.

| `APPLY` | Behavior |
|---|---|
| `report-only` | Findings only |
| `apply-safe` | Remove only where the suite stays green and no public interface changes |
| `apply-all` | Also remove abstractions and public surface |

**One commit per logical removal**, message `lean: remove <thing> (<reason>)`, full suite after each. Never batch unrelated deletions: when one breaks something you need to know which.

## GATE-LEAN

| # | Check |
|---|---|
| L1 | Zero unreferenced code, commented-out code, or `TODO` over 30 days |
| L2 | Zero interfaces with one implementation, zero abstractions with one caller |
| L3 | Zero config keys, env vars, tables, or columns never used |
| L4 | Zero code implementing nothing in the PRD |
| L5 | Every function, file, and complexity value under its ceiling |
| L6 | Zero import cycles |
| L7 | Every LLM call and network call has a written reason no cheaper mechanism suffices |
| L8 | Test-to-source LOC ratio under 2.0 |

## OUTPUT

Run report, plus metrics with deltas, a findings table (id, priority, location, recommendation, LOC saved, removal risk), what was removed, the expensive-mechanism audit, requirement orphans, deferred items needing a human decision, and one paragraph: **is the repo getting leaner or heavier per delivered requirement?**

## HALT

Core halts, plus: a removal changes a public interface with external callers; a removal needs a migration dropping columns holding real data; code implements something not in the PRD and it is unclear whether it is needed; a removal would exceed a slice budget (make it its own slice).

# 21: Spec Review

**Read:** `rules/00-CORE.md`, `rules/02-GATES.md`, `rules/05-SPECS.md`, `rules/06-TESTS.md`
**Skill:** none
**Produces:** a verdict, and a list of edits. Changes nothing unless `APPLY: fix`.

Run this on every spec before implementation, and on every spec written by a parallel agent before it enters `specs/active/`.

## CONFIG

```yaml
SPEC_PATH:  specs/active/SPEC-<NNNN>-<kebab>.md
APPLY:      report-only | fix
```

## DO

Work the checks in order. Stop at the first **blocking** failure and report; the rest of the review is wasted on a spec that will be rewritten.

### 1. Blocking checks

| # | Check | Blocking because |
|---|---|---|
| B1 | GATE-SPEC S1-S11 all pass | It is the gate |
| B2 | Every `AC`/`PROP` traces to a requirement that **exists in the PRD** and is not `dropped` | Untraceable work is unjustifiable work |
| B3 | Every declared budget line is under its ceiling | An over-budget spec produces an unreviewable slice |
| B4 | The one-sentence outcome is genuinely one sentence | Two sentences means two specs |
| B5 | Every data change has a down migration | Halt condition H8 |

### 2. Ambiguity hunt

For each `AC`, ask: **could two competent implementers build different things from this?**

| Smell | Fix |
|---|---|
| "valid", "appropriate", "correct", "properly" | Name the exact rule |
| An input described by type, not by value | Give the literal value |
| An error described without its code and message | Write both |
| Ordering unstated where more than one order is possible | State it, or state that any order is acceptable |
| Null, empty, and missing treated as one thing | Separate them |
| A time or timezone left implicit | Make it explicit |
| An `AC` whose "Then" describes internal state | Rewrite against observable behavior |

### 3. Completeness hunt

| Check | Failure means |
|---|---|
| At least one failure-case `AC` | Only the happy path was thought about |
| Error totality property present or excluded with a reason | The most common real bug class is untested |
| Out-of-scope has three or more entries | The boundary was not drawn |
| Every `AC` has exactly one acceptance test | Duplication, or a gap |
| Every `PROP` has exactly one property test with a written domain | A vacuous property |
| Every planned test has a failure mode in **user-observable** terms | Tests written for coverage, not for failures |
| Rollback plan is executable without thinking | It will not be executed |

### 4. Excess hunt

| Check | Action |
|---|---|
| An `AC` no requirement asked for | Delete it, or update the PRD first |
| A test that duplicates another at a cheaper level | Delete the expensive one |
| An E2E test for logic a unit test proves | Move it down |
| A file in the change list no `AC` needs | Remove it |
| A property that passes against broken code | Rewrite or delete it (GATE-PROPERTY PR6) |

### 5. Verdict

| Verdict | Meaning |
|---|---|
| `READY` | Passes everything. May enter `specs/active/`. |
| `FIX` | Non-blocking issues listed. Fix, then re-review. |
| `REWRITE` | A blocking check failed. Back to `prompts/20-spec-write.md`. |
| `SPLIT` | Over budget. Return the proposed split. |

With `APPLY: fix`, apply only unambiguous mechanical fixes (missing IDs, missing down migration reference, wording). **Never invent an acceptance criterion or a value.** That is a rewrite, not a fix.

## OUTPUT

```
### Verdict
READY | FIX | REWRITE | SPLIT

### Blocking failures
| # | Check | Detail |

### Findings
| Severity | Section | Finding | Required edit |

### Ambiguities
| AC/PROP | Could be read as A | Or as B | Resolution |

### Excess removed or flagged
| Item | Why it does not belong |
```

## HALT

Core halts, plus: resolving an ambiguity needs a product decision; the spec traces to a requirement that does not exist and it is unclear whether the PRD or the spec is wrong.

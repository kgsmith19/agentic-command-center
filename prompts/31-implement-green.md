# 31: Implement Slice to GREEN (worktree + subagents)

**Read:** `rules/00-CORE.md`, `rules/01-BUDGETS.md`, `rules/02-GATES.md`, `rules/07-SKILLS.md`
**Skills, in order:** `using-git-worktrees` -> `writing-plans` -> `subagent-driven-development` -> `test-driven-development` -> `requesting-code-review` -> `verification-before-completion`
**Produces:** one slice green, docs updated, spec in `specs/done/`

Write the least code that could possibly work, and nothing else. **Every line must be demanded by a currently-failing test or an explicit acceptance criterion.** If you cannot point at the test that demands a line, delete the line.

## CONFIG

```yaml
SPEC_PATH:              specs/active/SPEC-<NNNN>-<kebab>.md
BRANCH:                 slice/SL-<NNN>-<kebab>
MAX_SUBAGENTS:          4
MAX_RED_GREEN_CYCLES:   3
```

## DO

### 1. Worktree (`superpowers:using-git-worktrees`)

Create the worktree on `BRANCH` from current `main`. Run project setup. **Reach a clean green baseline before any task starts.** Give this worktree its own database: a Supabase branch, a separate schema, or a container. Migrations from two worktrees must never meet.

Record the baseline: suite result and runtime, source LOC, test LOC, file count. You cannot report a budget delta without it.

### 2. Plan (`superpowers:writing-plans`)

Derive the task list **from the spec**. The spec is the contract; the plan is only its breakdown. **The plan adds no behavior the spec does not require.**

| Rule | |
|---|---|
| Task 1 is always | `prompts/30-tests-red.md`: write the red tests, prove GATE-RED |
| Task size | Under `{{MAX_TASK_MINUTES}}` minutes. Larger is two tasks. |
| Each task names | Exact file paths, the acceptance criterion or property it serves, and its verification command |
| Task order | Properties -> acceptance -> unit -> integration -> E2E |
| Last task is always | Docs update (step 6) |

### 3. Execute (`superpowers:subagent-driven-development`)

One subagent per task, fresh context. **Each receives: the spec, its single task, `rules/02-GATES.md`, `rules/06-TESTS.md`. Nothing else.** A subagent handed the repo history loses the task.

Sequential by default. Run tasks concurrently via `superpowers:dispatching-parallel-agents` **only** when they touch disjoint files, capped at `MAX_SUBAGENTS`.

For each task, the subagent runs `superpowers:test-driven-development` under GATE-RED and GATE-GREEN, and applies **least code**:

| Situation | Do | Not |
|---|---|---|
| One test asks for a value | Return it, hardcoded | Build the general algorithm |
| Two tests ask for different values | Now write the rule connecting them | Anticipate a third case |
| A branch has no test | Do not write the branch | Add it "for safety" |
| A function needs data | Take it as a parameter | Reach for a global or a context |
| Something might fail | Let it fail loudly | Swallow it |
| A shape repeats twice | Leave it duplicated | Extract an abstraction |
| A shape repeats a third time | Now extract | Have extracted at two |

Never write: logging beyond an `NFR`, config nobody configures, flags nobody flips, interfaces with one implementation, factories for one type, generics with one instantiation, `else` branches no test reaches, defensive checks the type system already prevents, comments restating the code.

**Two-stage review after every task** (`superpowers:requesting-code-review`): stage 1 spec compliance (does the diff satisfy the criteria it claims, and nothing more?), stage 2 GATE-MINIMAL M1-M10. A finding that widens scope becomes a new spec entry, never more code here.

A red test that will not go green: `superpowers:systematic-debugging`. After `MAX_RED_GREEN_CYCLES`, **stop debugging and halt.** The spec or the test is wrong, not your persistence. Report both hypotheses.

### 4. Mutation-verify

For every test added: break the code in the exact way that test claims to catch, confirm red, revert, write today's date and the mutation into the ledger.

**If a mutation turns no test red, you have a hole exactly where you believed you had coverage.** Fix it, or delete code no requirement demands.

### 5. One refactor pass (cap `{{MAX_REFACTOR_PASSES}}`)

Allowed: delete duplication now at three instances; rename for clarity; split a function over `{{MAX_FUNCTION_LOC}}` lines; move code where it belongs; **delete anything no test requires.**

Not allowed: adding an abstraction layer; introducing a named pattern; changing an interface no test asked to change; cleaning up code outside this slice (that is a lean-review finding).

Suite green before and after, with no test edits.

### 6. Docs, in the same commit

| Changed | Update |
|---|---|
| A requirement is delivered | `docs/PRD.md` status column |
| Interface, container, or technology | `docs/SYSTEM-REQUIREMENTS.md` |
| Data store, flow, or trust boundary | `docs/DATA-FLOW-DIAGRAM.md` |
| How to run or test | `README.md` |
| Any test added or deleted | `specs/TEST-LEDGER.md` |
| A decision with real trade-offs | new `docs/adr/ADR-NNNN-*.md` |

### 7. Verify and close (`superpowers:verification-before-completion`)

Run GATE-GREEN G1-G10 in full, every command, every exit code shown. Give **G7** real attention: read your own diff line by line and name the test that demanded each line. Lines with no answer get deleted. This is where over-building is caught.

Measure every budget line (`rules/01-BUDGETS.md` has the commands). Any breach: stop, report, propose a split, wait.

Fill the spec's Actual budget column and its section 11 assumptions. Run its Definition of Done. `git mv` to `specs/done/`. Commit `SL-NNN: <one-line outcome>` with the delivered requirement IDs in the body.

### 8. Cadence check

State which reviews are now due per `rules/04-DOCS.md`. Do not skip silently.

## GATE

GATE-GREEN, GATE-MINIMAL, GATE-DOC, and the spec's Definition of Done.

## OUTPUT

Run report, plus:

```
### Red-to-green log
| T-id | Cycles | What was written | LOC |

### Mutation verification
| T-id | Mutation applied | Went red | Notes |

### Diff justification (G7)
| File | Lines | Demanded by |

### Budget actuals
| Metric | Baseline | After | Delta | Ceiling | Status |

### Deliberately not built
| Thing an implementer might have added | Why not |
```

## HALT

Core halts, plus: `MAX_RED_GREEN_CYCLES` reached on one test; green requires changing another test; a test appears wrong (report evidence and the proposed change, never edit silently); green requires touching a file another active spec owns; an assumption with large blast radius has no safe default.

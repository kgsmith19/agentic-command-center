# 30: Tests to RED

**Read:** `rules/00-CORE.md`, `rules/02-GATES.md`, `rules/06-TESTS.md`
**Skill:** `superpowers:test-driven-development`, held to GATE-RED
**Produces:** failing tests passing GATE-RED, plus their ledger rows

**You write tests. You do not write production code.** The only exception is the minimum stub required by GATE-RED R2.

This is task 1 of every slice, run by the test-author role inside the slice's worktree.

## CONFIG

```yaml
SPEC_PATH:   specs/active/SPEC-<NNNN>-<kebab>.md
TEST_CMD:    <command>
PROPERTY_LIB: <hypothesis | fast-check | jqwik | proptest | ...>
```

## PRECONDITIONS

The spec passed GATE-SPEC. **The existing suite is green.** Never add red tests to an already-red suite: you will not be able to tell which red is yours.

## DO

1. **Re-derive properties independently.** Do not just copy the spec's list. Walk the nine kinds in `rules/06-TESTS.md` yourself, then compare.
   - Found one the spec missed -> add it to the spec and say so.
   - Cannot justify one the spec has -> challenge it before implementing it.

2. **Write each generator domain precisely** before writing the property: bounds, structure, required edge values, exclusions, pinned seed, shrinking on. A vague domain produces a vacuous pass.

3. **Eliminate before writing.** For every candidate test, find the cheaper mechanism (`rules/06-TESTS.md` table). Every elimination gets recorded, because in six months nobody remembers the reasoning and re-adds the test. **This is the highest-leverage step in the whole workflow.**

4. **Run GATE-TEST-JUSTIFIED on every survivor.** Any "no" and it does not get written. Watch two in particular:
   - **J2**: the failure mode must be user- or operator-observable. "Returns `None` instead of `[]`" is not one. "The dashboard shows a crash instead of an empty list" is.
   - **J6**: cheapest level. An E2E for logic a unit test proves costs 100x the runtime and fails for 10x the unrelated reasons.

5. **Register in the ledger before writing.** `specs/TEST-LEDGER.md`, every column except mutation-verified.

6. **Write the tests.** Order: properties, acceptance, unit, integration, E2E. Properties first, because they routinely reveal that several planned example tests are redundant. Naming and writing rules: `rules/06-TESTS.md`.

7. **Drive RED and verify it properly.** Run them. Check GATE-RED R1-R7 for each.
   - Seeing `ImportError` / `ModuleNotFound` / `NameError` -> write the minimum stub (empty function, route returning `501`) and re-run. This is the only production code allowed here.
   - Compare each failure message to the reason written in the spec. **A test red for the wrong reason is worse than no test**, because it will go green when the wrong thing is built.

8. **Vacuity-check every property** (GATE-PROPERTY PR6): break the code deliberately, confirm the property fails. A property like "the result is a list" passes against almost any bug.

9. **Show the failing output** in the report. Assertions, not import errors.

Mutation verification happens at GREEN (`prompts/31-implement-green.md` step 4), because there is nothing to mutate yet.

## GATE

GATE-RED on every test. GATE-PROPERTY PR1-PR6. GATE-TEST-JUSTIFIED on every test. Ledger rows complete.

## OUTPUT

Run report, plus:

```
### Properties
| ID | Kind | Statement | Domain | Cases | Seed | Vacuity checked |

### Property kinds rejected
| Kind | Why not applicable here |

### Tests written
| T-id | Level | Traces to | Failure mode | Reason for red |

### Tests eliminated before writing
| Candidate | Eliminated because | Cheaper mechanism now used |

### Cheaper mechanisms added instead of tests
| Mechanism | Where | Replaces which candidate |

### RED evidence
<actual failing output, showing assertion failures>
```

## HALT

Core halts, plus: a property cannot be made non-vacuous (the requirement is not actually a constraint; fix the spec); an `AC` cannot be tested without infrastructure larger than the slice; the property library is not installed; the suite was already red; determinism requires a production design change (report it as a spec item, never a silent edit); the count would exceed `{{MAX_NEW_TESTS}}` even after elimination.

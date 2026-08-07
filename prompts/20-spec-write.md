# 20: Spec Write (one slice)

**Read:** `rules/00-CORE.md`, `rules/01-BUDGETS.md`, `rules/05-SPECS.md`, `rules/06-TESTS.md`, `templates/SPEC.md`
**Skill:** `superpowers:brainstorming` only if the slice's behavior is still fuzzy. If the PRD is clear, skip it.
**Produces:** `specs/active/SPEC-NNNN-<kebab>.md` passing GATE-SPEC

You write the spec. **You do not write code or tests.** If you are describing an implementation, describe the observable behavior instead.

## CONFIG

```yaml
SLICE_ID:      SL-<NNN>
SPEC_ID:       SPEC-<NNNN>-<kebab-title>
REQUIREMENTS:  [FR-<nnn>]
```

## PRECONDITIONS

Every ID in `REQUIREMENTS` exists in the PRD and is not `dropped`. The slice appears in the PRD slice plan. Every slice it depends on is in `specs/done/`. No spec in `specs/active/` touches the same files, unless running `prompts/22-spec-all.md`.

## DO

1. **Read the ground truth**: the requirements in scope, their use cases, every NFR that could apply, the constraints, the glossary, the relevant parts of the system requirements and DFD. **Then read the code in the area.** A spec written without reading the code produces a slice that fights it.

2. **One-sentence outcome.** What becomes true, phrased so a non-technical person can confirm it happened. More than one sentence means two specs.

3. **Draw the boundary.** Out-of-scope needs **at least three entries**. Each is something an implementer would otherwise plausibly build. Usual suspects: pagination, caching, retries, admin UI, bulk operations, i18n, undo, audit trail, rate limiting, edge cases in data you do not have yet.

4. **Acceptance criteria.** Given/When/Then, literal values, at least one failure case, each independently verifiable, each naming its requirement, none describing an implementation.

   Coverage check: for each requirement in scope, what must be true for a user to say "yes, it does that"? No `AC` captures it -> add one. An `AC` captures something no requirement asked for -> delete it, or update the PRD first.

5. **Derive properties.** Walk **all nine kinds** in `rules/06-TESTS.md`, one line each: the property, or why the kind does not apply. Do not skip the walk; the kinds you would not have thought of are the ones that find bugs.

   Write the exact generator domain for each, including the edge values it must include. Error totality first: it applies almost always. If you conclude no property applies, recheck error totality; that conclusion is usually wrong.

6. **Declare the budget.** Every line, honestly, before implementation. Any line over its ceiling means **stop and split now** (`rules/01-BUDGETS.md` has the seam table). Never write a spec you already know breaches budget.

7. **Specify the changes.** Interfaces (breaking ones get a caller migration path), data (every change gets a down migration, no exceptions), and the files you expect to touch.

8. **Plan the tests.** You are deciding which tests **deserve to exist**, not writing them. Run GATE-TEST-JUSTIFIED on each candidate *on paper* before it enters the table. Then check the shape: exactly one acceptance test per `AC`, exactly one property test per `PROP`, unit tests only for logic no property covers, integration only where two real components first meet, E2E only for a revenue or safety path, total at or under `{{MAX_NEW_TESTS}}`.

9. **Risks and rollback.** The rollback plan must be executable at 3am without thinking. "Revert the commit" is valid only if no migration ran and no data was written.

10. **Run GATE-SPEC.** Then place the file in `specs/active/`.

## OUTPUT

Run report, plus:

```
### Spec summary
Delivers <FR ids> | ACs <n> (<n> failure) | Properties <n> | Tests planned <n>
Tightest budget line: <e.g. LOC 240/300>

### Properties derived
| ID | Kind | Statement | Domain | Traces to |

### Property kinds rejected
| Kind | Why it does not apply here |

### Tests rejected during planning
| Candidate | Rejected because | Cheaper mechanism used instead |

### Split decision
<"no split needed", or the split made and why>
```

**The rejected-tests table matters more than the accepted one.** It is the evidence the suite is lean by decision rather than by accident.

## HALT

Core halts, plus: a requirement in scope is too ambiguous for an objective `AC`; the slice cannot get under budget by splitting (the PRD slice plan is wrong, go fix it); the slice needs a capability the system requirements do not describe; the data change has no safe down migration.

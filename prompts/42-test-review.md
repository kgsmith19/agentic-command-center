# 42: Test Review

**Read:** `rules/00-CORE.md`, `rules/02-GATES.md`, `rules/06-TESTS.md`
**Skill:** none
**Produces:** deleted tests, and the gaps nothing was catching

One standard: **does every test earn its place?** Deleting tests is the expected output. A review that deletes nothing on a suite over 50 tests has admired, not audited.

## CONFIG

```yaml
SCOPE:  whole-suite | <path>
APPLY:  report-only | apply-safe | apply-all
```

Preconditions: suite green, ledger exists, tree clean.

## DO

### 1. Reconcile with the ledger

| Check | Action on mismatch |
|---|---|
| Every test file has a ledger row | Add the row with a justification, or **delete the test** |
| Every ledger row has a test | Delete the stale row |
| Every `Traces to` resolves two hops to a real `FR-`/`NFR-` | Fix the trace, or delete the test |
| Every row has a mutation-verified date | Flag as unproven; step 4 handles it |
| Every row has a deletion criterion | Write one, or delete the test |

Report counts by level against the target shape in `rules/06-TESTS.md`.

### 2. GATE-TEST-JUSTIFIED on every test

J1-J8. Any "no" puts it on the deletion list unless repairable. The two that catch most:

- **J5 duplicate.** Group tests touching the same function with the same input shape. Keep the cheapest level; delete the rest.
- **J6 wrong level.** Any E2E whose failure could only come from logic a unit test proves is at the wrong level.

### 3. Banned patterns

Every pattern in `rules/06-TESTS.md`, plus: tests with `if` or loops around assertions, tests depending on execution order (**run the suite in random order to find them**), tests with `sleep`, tests with real network or wall-clock dependence, skipped or `xfail` over 14 days, commented-out tests.

### 4. Mutation audit

Every test lacking a mutation date, plus a random 20% of the rest: apply the mutation its failure mode implies, confirm red, revert, record the date.

**A test surviving its own mutation is not testing what it claims.** Fix or delete.

For surviving mutants with no failing test: real gap (add one test), equivalent mutant (record and ignore), or **code no requirement demands (delete the code)**. The third is the best outcome.

### 5. Coverage as a diagnostic

Read it to find uncovered code, never to raise a number. Verdicts in `rules/06-TESTS.md`.

**Never add a test solely to raise coverage.** That is the exact behavior this system exists to prevent. Say so in the report whenever the temptation appears.

### 6. Find failures nothing catches

The inverse audit, and the highest-value part of this review.

| Source | Method |
|---|---|
| Requirements | Every `FR`/`NFR` marked `done`: find its test. None means a gap. |
| Acceptance criteria | Every `AC` in `specs/done/`: find its test |
| Property kinds | Was each of the nine considered for each core module? |
| Real defects | Every regression register entry: is there a test, and does it still pass? |
| Boundaries | Every numeric bound, length limit, and time window in the PRD: tested at exactly the limit, one below, one above? |
| Error paths | Every named error in the interface tables: triggered by a test? |
| Concurrency | Any state written by two paths: is order independence tested? |
| Constraints | Every `NOT NULL`, `UNIQUE`, `CHECK`: violation path tested **once**, at the boundary |

### 7. Suite performance

Total under `{{MAX_SUITE_SECONDS}}`; slowest unit test under `{{MAX_UNIT_TEST_MS}}` (over means it is not a unit test); tests hitting a real database should be integration only.

**A slow suite gets run less, catches less, and is therefore actively reducing safety.** That argument beats "but it tests something".

### 8. Apply

| `APPLY` | Behavior |
|---|---|
| `report-only` | Findings |
| `apply-safe` | Delete tests failing J1, J2, J5, or matching a banned pattern. Record each in the ledger's deleted table. |
| `apply-all` | Also reclassify levels, rewrite against public behavior, add tests for step 6 gaps |

One commit per group, full suite after each.

## GATE-SUITE

| # | Check |
|---|---|
| Q1 | Every test has a complete ledger row |
| Q2 | Every test passes J1-J8 |
| Q3 | Zero banned patterns |
| Q4 | Every test mutation-verified within 90 days |
| Q5 | Every requirement marked `done` has a passing test |
| Q6 | Every regression register entry has a passing test |
| Q7 | Runtime under `{{MAX_SUITE_SECONDS}}` |
| Q8 | Suite passes in random order |
| Q9 | Suite passes twice in a row with no state leakage |
| Q10 | Zero skipped or `xfail` over 14 days |
| Q11 | Level distribution within the target shape |
| Q12 | Test-to-source LOC ratio under 2.0 |

## OUTPUT

Run report, plus suite health with deltas (count by level, runtime, tests per delivered requirement, mutation-verified share), deleted tests with what is now uncovered, reclassifications, coverage gaps that matter, mutation results, **code deleted instead of tested**, and one paragraph: **is this suite catching real failures, or performing safety?**

## HALT

Core halts, plus: deleting a test would leave a `done` requirement uncovered; a test is red and it is unclear whether the test or the code is wrong; a gap needs infrastructure larger than a slice; the ledger cannot be reconstructed from the specs; the suite fails in random order (a real defect, report before changing anything).

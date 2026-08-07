---
title: <plain-language spec title>
spec_id: SPEC-<NNNN>-<kebab-title>
slice: SL-<NNN>
status: draft
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
completed: <YYYY-MM-DD or blank>
owner: <name>
traces: [FR-001, NFR-003, SR-002]
---

# SPEC-<NNNN>: <plain-language title>

> One spec, one thin slice, one shippable change. If this spec cannot be implemented inside the budget in section 6, it is two specs. Split it now, not later.
>
> A spec lives in `specs/active/` while in progress and moves to `specs/done/` only when section 12 fully passes.

---

## 1. In one sentence

<What becomes true when this is done. Written so a non-technical person can confirm whether it happened.>

## 2. Why this, why now

| Field | Answer |
|---|---|
| Requirement being served | <FR-00x> |
| What a user can do after this that they could not before | <plain language, or "nothing user-visible; this is infrastructure for SL-00y"> |
| Why this slice comes before the next one | <dependency or risk reason> |
| What we learn from shipping it | <the uncertainty it removes> |

## 3. Scope

### 3.1 In scope

- <specific change>

### 3.2 Out of scope

Required. A spec with an empty out-of-scope list has not been thought about.

| Not doing | Why not | Where it goes instead |
|---|---|---|
| <thing> | <reason> | SL-00y / never |

## 4. Acceptance criteria

Given/When/Then with concrete values. No placeholders, no "appropriate", no "valid input" without saying what valid means. These become acceptance tests.

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | <exact starting state, with values> | <exact action, with values> | <exact observable result, with values> | FR-001 |
| AC-002 | <error case> | <action> | <exact error code and message> | FR-001 |

**Every AC must include at least one failure case.** A spec whose ACs only describe the happy path is incomplete.

## 5. Properties

Properties are statements true for *all* valid inputs, not just the examples in section 4. They are where property-driven development lives. Each becomes a generative test running `{{MIN_PROPERTY_CASES}}` cases.

| ID | Property (for all X, ...) | Kind | Input domain (exact) | Traces to |
|---|---|---|---|---|
| PROP-001 | For all <X> in <domain>, <invariant holds>. | invariant | <generator description with bounds> | FR-001 |
| PROP-002 | For all <X>, decode(encode(X)) equals X. | round-trip | <domain> | DR-001 |
| PROP-003 | Applying <op> twice equals applying it once. | idempotence | <domain> | FR-002 |

**Property kinds to check for, in this order:**

| Kind | Question to ask | Typical form |
|---|---|---|
| Invariant | What is always true after this operation, no matter the input? | `postcondition(result)` |
| Round-trip | Is there an inverse? | `decode(encode(x)) == x` |
| Idempotence | Is repeating it safe? | `f(f(x)) == f(x)` |
| Commutativity / order independence | Does order matter? It should not, or it must be stated. | `f(a,b) == f(b,a)` |
| Oracle / model | Is there a slow-but-obviously-correct version to compare against? | `fast(x) == naive(x)` |
| Metamorphic | If the input changes this way, how must the output change? | `f(x+k) == f(x)+k` |
| Conservation | Is something preserved (count, sum, total)? | `sum(out) == sum(in)` |
| Monotonicity | Does more input mean more (or never less) output? | `x <= y => f(x) <= f(y)` |
| Error totality | Does every input either succeed or return a named error, never crash? | no unhandled exception over the domain |

Write "None applies because <reason>" for a slice with no properties, rather than leaving this section blank. That answer is rare and usually wrong: even a CRUD slice has round-trip and error-totality properties.

## 6. Budget declaration

Filled before implementation begins. Checked at GATE-GREEN.

| Metric | Declared | Ceiling | Actual (fill at completion) |
|---|---|---|---|
| Net source LOC | <n> | {{MAX_NET_LOC}} | |
| Test LOC | <n> | {{MAX_TEST_LOC}} | |
| New modules/classes | <n> | {{MAX_NEW_MODULES}} | |
| Source files touched | <n> | {{MAX_SOURCE_FILES_TOUCHED}} | |
| New tables | <n> | {{MAX_NEW_TABLES}} | |
| New columns | <n> | {{MAX_NEW_COLUMNS}} | |
| New endpoints | <n> | {{MAX_NEW_ENDPOINTS}} | |
| New UI surfaces | <n> | {{MAX_NEW_UI_SURFACES}} | |
| New libraries | <n> | {{MAX_NEW_LIBRARIES}} | |
| New third-party services | <n> | {{MAX_NEW_THIRD_PARTY}} | |
| New tests | <n> | {{MAX_NEW_TESTS}} | |
| New config keys | <n> | {{MAX_NEW_CONFIG_KEYS}} | |

Any declared value above its ceiling means this spec is not approved. Split it.

## 7. Changes

### 7.1 Interfaces

| ID | Change | Breaking? | Migration path for callers |
|---|---|---|---|
| API-00x | <added/changed/removed> | yes / no | <n/a or steps> |

### 7.2 Data

| Change | Table | Forward migration | Down migration | Backfill needed | Zero-downtime approach |
|---|---|---|---|---|---|
| <add column> | <name> | `<file>` | `<file>` | yes / no | <expand-migrate-contract steps> |

A migration without a down path is a halt condition (kernel H7).

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| <path> | create / modify / delete | <one line> |

Deviating from this list during implementation is allowed, but every deviation gets reported in the RUN REPORT.

## 8. Test plan

Every row must pass GATE-TEST-JUSTIFIED before it is written. Rows also get copied into `specs/TEST-LEDGER.md`.

| Test ID | Level | Traces to | Failure mode it catches | Why not a cheaper level | Why not covered already | Deletion criterion |
|---|---|---|---|---|---|---|
| T-U-001 | unit | PROP-001 | <specific wrong behavior a user would notice> | <reason> | <reason> | <when this test becomes obsolete> |
| T-I-001 | integration | AC-001 | | | | |
| T-A-001 | acceptance | AC-001 | | | | |

**Level guidance (cheapest that can catch it wins):**

| Level | Catches | Does not catch | Target count per slice |
|---|---|---|---|
| Unit | Logic errors in one function or module | Wiring, contracts, config | most of them |
| Property | Whole classes of input the examples missed | Integration, ordering across services | 1 to 3 |
| Integration | Wrong contract between two real components | Full user journeys | 0 to 2 |
| Acceptance | The AC as written, from the outside | Internal correctness | 1 per AC |
| E2E | The critical path through the real stack | Anything cheap | 0 to 1, and only for revenue/safety paths |
| Regression | A bug that actually happened, with a link to it | Bugs that never happened | 1 per fixed defect, never speculative |

## 9. Risks

| ID | Risk | Likelihood | Impact | Mitigation in this slice | Accepted by |
|---|---|---|---|---|---|
| RISK-001 | <what could go wrong> | low/med/high | low/med/high | <concrete action, or "accepted, no action"> | <name> |

## 10. Rollback plan

| Field | Answer |
|---|---|
| How to undo | <exact mechanism> |
| Time to undo | <minutes> |
| Data written that survives rollback | <what, and whether it is safe> |
| Feature flag | <name, or "none because...">  |
| Who decides to roll back | <name/role> |
| Signal that triggers rollback | <objective condition> |

## 11. Assumptions made during implementation

Filled by the implementing agent, not in advance. Every gap the spec did not cover gets a row. An empty table on a non-trivial slice means the agent did not look.

| ID | Assumption | Why it was needed | How to verify | Blast radius if wrong | Promoted to PRD? |
|---|---|---|---|---|---|
| ASM-00x | | | | | yes / no |

## 12. Definition of Done (GATE-SPEC-DONE)

The spec moves to `specs/done/` only when every box is checked and the evidence is attached.

- [ ] Every `AC` has a passing acceptance test, with the test ID recorded.
- [ ] Every `PROP` has a passing property test running at least `{{MIN_PROPERTY_CASES}}` cases.
- [ ] GATE-GREEN passes in full (G1 through G10), with command output shown.
- [ ] Every declared budget line has an Actual value, and none exceeds its ceiling.
- [ ] Every test in section 8 passed GATE-TEST-JUSTIFIED, including the mutation check (J3).
- [ ] PRD status column updated for every requirement this slice delivered.
- [ ] System Requirements and Data Flow Diagram updated if containers, interfaces, data stores, or flows changed.
- [ ] README updated if how-to-run changed.
- [ ] Every assumption in section 11 is either verified, promoted to a PRD `ASM-` row, or explicitly accepted.
- [ ] Rollback plan tested or explicitly waived with a reason.
- [ ] Nothing was added that no `AC` or `PROP` required.
- [ ] Dead code, dead tests, and stale docs removed as part of this slice.
- [ ] `updated` and `completed` dates set in front matter.

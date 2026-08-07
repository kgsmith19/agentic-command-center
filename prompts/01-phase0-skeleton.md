# 01: Phase 0 Walking Skeleton (SL-000)

**Read:** `rules/00-CORE.md`, `rules/01-BUDGETS.md`, `rules/02-GATES.md`, `rules/05-SPECS.md`
**Skill:** `superpowers:test-driven-development`, held to GATE-RED and GATE-GREEN
**Produces:** one request that travels the full stack and returns a real value

## CONFIG

```yaml
STACK_DECIDED:  <yes|no>
LANGUAGE:       <lang or "propose">
BACKEND:        <framework or "propose">
FRONTEND:       <framework | none | "propose">
DATABASE:       <e.g. Supabase Postgres or "propose">
TEST_CMD:       <command or "propose">
```

Budgets: `PHASE0_*` in `rules/01-BUDGETS.md`, not the normal ceilings.

## The bar

**If a reader sees the diff and thinks "that's it?", it is correct. If they think "nice start", it is too big.**

No feature. One API call, one UI fetch, one table, one rule, end to end.

## DO

1. **PRD minimum.** Fill `docs/PRD.md` sections 1-5 and 13 completely. Sections 6-12 hold only what you are certain of today. Section 13 opens with `SL-000` delivering **zero** requirements, then your best guess at `SL-001` through `SL-005`. The guess will be wrong; write it anyway, because its shape reveals whether the product is understood. Run GATE-PRD.

2. **Pick the skeleton path.** The single simplest end-to-end path: most generic, most central, most boring. Write it as one sentence: *"A user \<does the simplest thing\> and sees \<the simplest true answer\>."*

   | Product | Correct | Too big |
   |---|---|---|
   | Trash pickup lookup | Type any address, get the one hardcoded row back | Address validation, geocoding, multiple cities |
   | Prompt organizer | Save one prompt with title and body, list it back | Tags, versions, variables, search |
   | Metrics tracker | Record one named number, read it back | Aggregation, charts, multiple types |

3. **Write `SPEC-0000-walking-skeleton.md`.** Exactly one happy-path `AC` and one failure `AC`. One or two properties, near-always: error totality, and round-trip. The "one rule" is the simplest rule the PRD actually requires, such as "an empty title is rejected". Run GATE-SPEC.

4. **Propose the stack** if `STACK_DECIDED: no`, then **halt for approval**:

   | Layer | Proposal | Why (first principles) | Maturity cost | Migration cost | Lock-in | Rejected |
   |---|---|---|---|---|---|---|

5. **Install the minimum.** Pin every version exactly, no ranges or `latest`. One server, one client, one database, one test runner. Nothing more. No component library, no state manager, no ORM abstraction layer, no logging framework, no CI matrix. Record the exact commands in `README.md`.

6. **RED.** Write at most `{{PHASE0_MAX_TESTS}}` tests. Verify GATE-RED in full, especially R2. Show the failing output.

7. **GREEN.** Least code that passes. **Hardcode anything no test requires**, noting in the spec which slice replaces it: that is correct engineering here, not debt. One table with at most 4 columns plus a down migration. One versioned endpoint (`/v1/...`). One UI surface making one real fetch. Security is: parameterized queries, no secrets in the repo, and auth only if the PRD requires it. Nothing more. Run GATE-GREEN in full.

8. **Prove it by hand, once.** Run the app. Perform the action in a real browser or client. Confirm the value came from the database, not a mock. Paste what you saw into the report. A passing test is not proof the skeleton walks.

9. **Write the remaining docs.** `docs/SYSTEM-REQUIREMENTS.md` (sections 1, 2, 4, 5.1, 6, 7, 9; rest "None yet" with a date). `docs/DATA-FLOW-DIAGRAM.md` (genuinely tiny now, which is the point: it grows correct because it starts correct). Fill `CLAUDE.md` command values. Run GATE-DOC.

10. **Close.** Fill the spec's Actual budget column, run its Definition of Done, `git mv` to `specs/done/`, commit `SL-000: walking skeleton`.

## GATE-SKELETON

| # | Check |
|---|---|
| K1 | Total files under `{{PHASE0_MAX_FILES}}` |
| K2 | Net source LOC under `{{PHASE0_MAX_NET_LOC}}` |
| K3 | Exactly one table, one endpoint, one UI surface |
| K4 | A human observed the round trip (step 8 evidence attached) |
| K5 | Zero abstractions with one caller, zero interfaces with one implementation, zero folders with one file |
| K6 | Zero dependencies beyond the approved minimum |
| K7 | Every hardcoded value listed in the spec with its retiring slice |

K5 fails most often: an agent builds a clean architecture for four columns of data. Delete the layers.

## OUTPUT

Run report, plus the skeleton sentence, what the human saw, files/LOC against ceilings, the pinned dependency list, the hardcoded-value table, and the stack decision record.

## HALT

Core halts, plus: the skeleton needs more than one sentence; a `PHASE0_*` ceiling would break; the simplest path still needs real business logic (propose a simpler skeleton and ask).

**Phase 0 is not parallelizable.** It is one linear path by definition. Run it in the main worktree. Parallelism begins at `SL-002`.

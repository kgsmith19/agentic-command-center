# Complete ranked inventory — design (sub-project A)

- date: 2026-08-04
- status: approved (Kyle, 2026-08-04)
- scope: one deduped, ranked, regenerable inventory of every open work item
  across all five `OPEN-ISSUES.md` ledgers plus unfinished items in `docs/`
- standard: `2026-08-04-acc-standards-design.md` applies in full
- ledger: guards `OI-025`, `OI-015` get homes here; `C:\code` `OI-016` is
  explicitly **not** solved here

A is the input to every sub-project after it. It runs first because ranking
work you have not enumerated is guessing.

## The problem A actually solves

Five ledgers exist and none of them knows about the others:

```
C:\code\OPEN-ISSUES.md
C:\code\guards\OPEN-ISSUES.md                     (35 entries, ~14 open)
C:\code\lifeos-ecosystem\OPEN-ISSUES.md
C:\code\lifeos-ecosystem\lifeos\OPEN-ISSUES.md
C:\code\lifeos-ecosystem\lifeos-ui\OPEN-ISSUES.md
```

Each uses the same entry template, and each numbers independently — so there are
five `OI-001`s. There is no single answer to "what is open, and what should I do
next". Kyle's prompt asks for exactly that, ranked by his stated priority order.

## The design decision that matters

A hand-written inventory is stale the day it is written, and this system already
has a documented failure mode for documents that describe a system rather than
being wired into it. So the inventory is **generated**, not authored.

But generation cannot judge. "Is OI-019 a reliability item or a maintainability
item?" is a judgment call, and a script that guesses it produces a confidently
wrong ranking — the worst possible output for a document whose only job is to
order the work.

**Resolution: the ledger ranks itself.** Each entry gains one new field, `rank:`,
carrying one of Kyle's ten priority classes. The script sorts; it never judges.
Backfilling `rank:` across the open entries is a mechanical, reviewable pass, and
the shared entry template carries the field forward so new entries arrive ranked.

This also makes the ranking *arguable in the right place*: if a rank is wrong,
you fix it in the ledger entry where the context lives, not in a generated table.

## Rank vocabulary

Kyle's priority order, verbatim from his prompt, becomes a closed set. Ordered
best-first; the script sorts on ordinal, ties broken by ledger then id:

| ordinal | `rank:` value | Kyle's wording |
|---|---|---|
| 1 | `safety` | Safety and security |
| 2 | `broken-workflow` | Broken core workflows |
| 3 | `data-loss` | Data loss or incorrect behavior |
| 4 | `autonomy-blocker` | Autonomy blockers |
| 5 | `reliability` | Reliability |
| 6 | `control` | User control and recoverability |
| 7 | `usability` | Usability |
| 8 | `maintainability` | Maintainability |
| 9 | `performance` | Performance |
| 10 | `roi` | Additional ROI |

An entry with no `rank:` is not silently defaulted — it is reported as
`UNRANKED` and sorts to the top of the output, because an unranked entry is an
unmade decision and hiding it is the failure this document exists to prevent.

## Deduplication

Cross-ledger duplicates are real: the guards ledger's `OI-016` (unlaned manual
terminals) and `C:\code`'s tracker request overlap; `OI-031`/`OI-034` were split
from one entry. Dedup is by an explicit `duplicate-of:` field naming a
fully-qualified id (`guards#OI-031`), added by the same human pass that adds
`rank:`. The script never infers a duplicate from title similarity — a false
merge loses a requirement, and Kyle's prompt says deduplicate "without losing any
requirements".

## Scope of the sweep

Three sources, all parsed by the same tool:

1. **The five ledgers** — every `## OI-nnn` heading, its status markers
   (`[RESOLVED]`, `[RETIRED]`, `[SHRUNK]`, `[SUPERSEDED]`), and its fields.
2. **`docs/` unfinished items** — any spec or plan under
   `docs/superpowers/{specs,plans}/` with unsatisfied acceptance criteria or
   unchecked tasks. Discovered, then **promoted into the ledger as real entries**
   rather than tracked in a second place. Checkbox state has already proven
   unreliable here (the kernel plan reads 0/119 checked and is fully landed), so
   promotion is a human pass, and the tool's job is only to *list candidates*.
3. **The archived source prompt** — `runner/goals/done/g-20260804-222717-lu7o.json`.
   Its "Definition of Done" is 22 numbered conditions; each becomes a ledger
   entry or is explicitly mapped to an existing one. This is how "don't miss a
   single thing" becomes checkable rather than aspirational.

## Deliverables

- `tools/inventory.mjs` — parses the five ledgers, emits ranked Markdown and
  `--json`. Pure functions over file contents; the only I/O is at the edges.
  Ships in this repo now; **J moves it to `agent-repo-gates`**, since it spans
  repos and that is the shared dev-tooling home.
- `INVENTORY.md` at `C:\code\` — the generated snapshot, regenerated on demand
  and stamped with the commit it was generated from. Carries a header saying it
  is generated and must not be hand-edited.
- `rank:` and optional `duplicate-of:` backfilled on every open entry in all
  five ledgers.
- The shared entry template updated so new entries require `rank:`.
- Three ledger entries created for the orphans this wave uncovered:
  **OI-025** (loop e2e re-run vs. accept launch-cap credit — Kyle's call,
  recorded as a decision request), **OI-015** (GUI half needing Kyle), and the
  Definition-of-Done conditions with no existing home.

## Explicitly not in scope

- **A work-item tracker.** `C:\code` `OI-016` asks for one. A delivers the
  inventory; the tracker is a separate decision and building it here would be
  speculative generality. Named so it is not silently dropped.
- **Fixing anything the inventory finds.** A ranks; B–J fix.
- **Touching lifeos-ecosystem code.** A reads those ledgers and adds `rank:` to
  their entries. Nothing else.

## Acceptance criteria

| AC | Statement | Test |
|----|-----------|------|
| AC-A1 | Parses an entry's id, title, status marker, and fields from the real template | unit, fixtures from all five ledgers |
| AC-A2 | An entry with a `[RESOLVED]`/`[RETIRED]`/`[SUPERSEDED]` marker is excluded from the open set | unit |
| AC-A3 | A `[SHRUNK` marker keeps the entry open | unit — `OI-015` is live proof |
| AC-A4 | Entries sort by rank ordinal, then ledger, then id | unit, shuffled input |
| AC-A5 | An entry with no `rank:` is emitted as `UNRANKED` and sorts first | unit |
| AC-A6 | An unknown `rank:` value fails the run loudly; it is never coerced to a default | unit |
| AC-A7 | `duplicate-of:` collapses entries into one row listing every id | unit |
| AC-A8 | `duplicate-of:` naming a nonexistent id fails the run | unit |
| AC-A9 | Ids are fully qualified by ledger, so five `OI-001`s never collide | unit, two fixtures with the same id |
| AC-A10 | `--json` and Markdown carry identical data | property: round-trip over generated ledgers |
| AC-A11 | Runs against all five real ledgers and exits zero | integration, real files |
| AC-A12 | `INVENTORY.md` records the commit it was generated from | integration |
| AC-A13 | Every open entry in all five ledgers carries a valid `rank:` | integration — this is the backfill's own gate |
| AC-A14 | Every one of the 22 Definition-of-Done conditions maps to a ledger id | integration, mapping table checked against the ledgers |

AC-A13 and AC-A14 are the ones that make A worth doing. Everything above them is
plumbing; those two are the ones that fail if the sweep was incomplete.

## Verification

```
node --test tools/inventory.test.mjs
node tools/inventory.mjs --json > /dev/null   # all five ledgers, exit 0
node tools/inventory.mjs --check              # AC-A13: fails on any UNRANKED
npm run test:windows && node hooks/covgate.mjs
```

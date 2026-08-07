# 43: Doc Refresh

**Read:** `rules/00-CORE.md`, `rules/03-WRITING.md`, `rules/04-DOCS.md`
**Skill:** none
**Produces:** documentation that is true, lean, findable, correctly placed

Documentation that is wrong is worse than documentation that is missing, because it is trusted. First job: find where docs and reality diverged. Second job: **delete.** Most repos accumulate documents nobody reads and nobody dares remove.

## CONFIG

```yaml
SCOPE:  whole-repo | docs | specs | <path>
APPLY:  report-only | apply-safe | apply-all
```

Precondition: suite green, so code behavior can be trusted as the reference.

## DO

### 1. Inventory

Every markdown file: path, type, front matter complete, `updated` date, last code change in its area, stale, correctly placed, referenced by.

A doc whose `updated` precedes the last behavior change it describes is stale until proven otherwise.

### 2. Verify truth against code, not memory

| Document | Verify by |
|---|---|
| PRD status column | Every `done` has a passing test; every `in-slice-NNN` has that spec in `active/` |
| PRD requirements | Sample five, confirm the code behaves that way |
| System requirements: containers | Compare to what actually deploys |
| System requirements: interfaces | Every endpoint against the route table; shapes against the schemas |
| System requirements: data model | Against the migrations |
| System requirements: tech decisions | Against the dependency manifest |
| DFD: stores | Against actual tables, buckets, caches, queues |
| DFD: flows | Trace every network call and database access in the code |
| DFD: boundaries | Against where authn and authz actually happen |
| README commands | **Run them.** A README whose commands were not executed has not been verified. |
| `specs/done/` | Each delivered what it claimed |
| Test ledger | Reconcile against the suite |
| Code samples | Execute them, or mark `# illustrative, not tested` |

**Every divergence gets a verdict: the doc is wrong (fix the doc), or the code is wrong (file a spec).** Never "they differ" with no verdict.

### 3. Enforce placement

| Violation | Fix |
|---|---|
| More than three `.md` files directly in `docs/` | Move the extras to `notes/` or `adr/` |
| A note without a date in its filename | Rename using its git-add date |
| A doc about one subsystem sitting at repo root | Move to that subsystem's `docs/` |
| A doc about a general product rule sitting in a subsystem | Move to `docs/notes/` |
| A decision with trade-offs written as a note | Convert to a numbered ADR |
| A spec in `active/` whose work is done | `git mv` to `done/`, set `completed` |
| A spec idle in `active/` 30 days | **Halt and ask:** finish it or delete it |
| An `archive/`, `old/`, `deprecated/`, or `_backup/` folder | Delete it. Git is the archive. |
| A banned filename (`notes`, `misc`, `temp`, `wip`, `untitled`, `new`, `final`, `v2`) | Rename descriptively or delete |
| A doc referencing a path outside the repo | Fix or delete |

### 4. Naming and front matter

Dated notes lead with `YYYY-MM-DD`. Titles descriptive kebab-case. ADRs and specs zero-padded four digits, never reused. Front matter complete including `scope`. `updated` reflects the last real content change (correct it from git). `traces` lists real IDs.

### 5. Delete

Apply the governing rule: what breaks if this is deleted?

| Candidate | Verdict |
|---|---|
| Describes something that no longer exists | Delete |
| Duplicates a fact stated elsewhere | Delete the copy, link to the source |
| Aspirational content never implemented | Move to the PRD slice plan, or delete |
| A generated report nobody has referenced | Delete, and stop generating it |
| A meeting note with no decision in it | Delete |
| An investigation whose conclusion now lives in code | Delete, unless the reasoning would be expensive to re-derive |
| A subfolder README restating the root README | Delete |
| Referenced by nothing, read by nobody | Delete |
| A **superseded ADR** | **Keep.** Mark `status: superseded`, link both ways. That history is the point of ADRs. |
| A **completed spec** | **Keep** in `specs/done/`. It is the traceability record. |

### 6. Fix the writing

Every remaining document against `rules/03-WRITING.md`: banned words, adjectives without numbers, "should" in a requirement, passive voice hiding the actor, a term with two names, a sentence a non-technical reader could not parse, a paragraph that should be a table, unfilled placeholders, binary diagrams with no text source.

### 7. Fill real gaps, and only real ones

| Gap | Add |
|---|---|
| A container in code, absent from system requirements | The row |
| A table in the schema, absent from the data model | The row |
| A data store or flow in code, absent from the DFD | The element and its register row |
| A requirement in code, absent from the PRD | The requirement, or delete the code |
| A decision with trade-offs, undocumented | An ADR |
| An operational procedure only one person knows | A runbook in `docs/notes/` |

**Do not add:** a changelog nobody maintains, an architecture doc restating the folder tree, API docs generatable from the schema, a contributing guide for a solo repo, comments explaining what the code plainly says.

### 8. Apply

`report-only` findings; `apply-safe` fixes front matter, dates, naming, placement, links, writing violations, and deletes clearly dead docs; `apply-all` also rewrites stale content and fills gaps.

Commit as `docs: <what changed>`. **Never mix doc changes with code changes in one commit**, so both stay reviewable.

## GATE

GATE-DOC D1-D7, plus:

| # | Check |
|---|---|
| DR1 | Every behavior claim verified against code this run |
| DR2 | Every README command executed successfully this run |
| DR3 | Every Mermaid block renders |
| DR4 | Every divergence has a verdict naming which side is wrong |
| DR5 | Zero facts stated in two places |
| DR6 | Every document answers "what breaks if this is deleted" |

## OUTPUT

Run report, plus: divergences with verdicts, moved, deleted (with "what would break"), renamed, rewritten, gaps filled, and doc health (total documents, **documents per 1000 source LOC**, stale, unreferenced, front matter complete, broken links).

Documents per 1000 LOC is the useful trend. Growing much faster than the code means docs are being produced rather than maintained.

## HALT

Core halts, plus: code contradicts the PRD and it is unclear which is intended; a doc records a decision whose reasoning is lost; a spec has sat idle 30 days; deleting a doc would lose the only record of a decision; reality diverges from the DFD enough that trust boundaries are unknown.

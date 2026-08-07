# 12: PRD Update

**Read:** `rules/00-CORE.md`, `rules/03-WRITING.md`
**Skill:** none
**Produces:** an updated `docs/PRD.md` with intact traceability

The PRD is a living document. Updating it is routine. Losing its integrity while updating it is not.

## CONFIG

```yaml
TRIGGER:   <what prompted this update>
MODE:      update | audit
```

Common triggers: a slice revealed a missing requirement; an assumption proved false; a constraint changed; scope was cut; an implementer's assumption needs promoting.

## MODE: update

1. **State the trigger** in one sentence.

2. **Map the blast radius before editing anything.**

   | Changed ID | Depends on it | Downstream to update |
   |---|---|---|
   | FR-007 | UC-002, SR-004, SPEC-0011, T-U-019 | system requirements, active spec, ledger |

3. **Apply the minimum edit.** Never rewrite a section to change one line.

   | Rule | Why |
   |---|---|
   | Never renumber an ID | Every spec and test referencing it breaks silently |
   | A dropped requirement keeps its ID with `Status: dropped` and a reason | Deleting the row destroys traceability |
   | A changed requirement keeps its ID; the change log carries the history | |
   | A genuinely new requirement gets the next unused number | |

4. **Propagate.** Update `docs/SYSTEM-REQUIREMENTS.md` and `docs/DATA-FLOW-DIAGRAM.md` if containers, interfaces, data, or flows changed.

5. **Check active specs.** Any spec in `specs/active/` now contradicted by this change is **halted** until reconciled. Name it explicitly; do not let it keep running.

6. **Append to the change log.** Every row states the reason, not just the change.

7. **Re-run GATE-PRD** on the affected sections, plus the pairwise contradiction check.

## MODE: audit

Read-only. Change nothing; produce findings.

1. GATE-PRD, every box.
2. **Traceability both ways.** Every `FR`/`NFR` reachable from a use case and reaching a spec, or marked `not-started`. Every spec in `specs/` tracing to a live requirement.
3. **Status drift.** Every `done` requirement has a passing test in the ledger. Every `in-slice-NNN` has that spec in `specs/active/`.
4. **Reality drift.** Sample five requirements and verify the code behaves that way. Report each divergence with a verdict naming which side is wrong.
5. **Rot.** Requirements `not-started` for over 90 days are `dropped` candidates. List them and ask.

## GATE-UPDATE

| # | Check |
|---|---|
| PU1 | No ID renumbered or deleted |
| PU2 | Every dropped requirement retains its row with a reason |
| PU3 | Downstream artifacts updated or explicitly listed as pending |
| PU4 | Every contradicted active spec named and halted |
| PU5 | Change log appended with a reason |
| PU6 | GATE-PRD passes on affected sections |

## OUTPUT

Run report, plus:

```
### PRD delta
| ID | Action | Change | Reason |

### Downstream impact
| Artifact | Action needed | Blocking? |

### Specs halted by this change
| Spec | Conflict | Reconciliation needed |
```

## HALT

Core halts, plus: the change invalidates a spec currently being implemented and the reconciliation is a product decision; code and PRD disagree and it is unclear which is intended.

# 13: System Requirements and Data Flow Diagram

**Read:** `rules/00-CORE.md`, `rules/03-WRITING.md`, `templates/SYSTEM-REQUIREMENTS.md`, `templates/DATA-FLOW-DIAGRAM.md`
**Skill:** `engineering:architecture` when a decision needs an ADR
**Produces:** `docs/SYSTEM-REQUIREMENTS.md`, `docs/DATA-FLOW-DIAGRAM.md`

Run this at Phase 0, and again whenever a slice adds a container, interface, data store, or trust boundary.

## CONFIG

```yaml
MODE:   create | update
SCOPE:  whole-system | <what changed>
```

## DO

1. **Derive, never invent.** Every `SR-` derives from an `FR-`/`NFR-`/`DR-`/`CON-` that exists in the PRD. A system requirement with no parent means either the PRD is missing something (fix it there first) or the requirement is invented (delete it).

2. **System requirements, in order:**

   | Section | Rule |
   |---|---|
   | 1 Context (C4 L1) | One diagram. Fixes the system boundary and nothing else. |
   | 2 Containers (C4 L2) | Each container names **what breaks if it is merged into another**. A new container is a major complexity purchase. |
   | 3 Components (C4 L3) | Only where the code layout does not already say it. Usually empty. |
   | 4 `SR-` table | One verification method per row: Test, Analysis, Inspection, Demonstration. Prefer Test; if not Test, say why in one line. |
   | 5 Interfaces | Versioned paths from day one. Every error code has a stated trigger. No endpoint without an `FR-`. |
   | 6 Data model | Plus the invariants the **database itself** enforces. Those are cheaper than tests (`rules/00-CORE.md` principle 1). |
   | 7 Security | Every row filled or `not applicable because <reason>` |
   | 8 Operations | Rollback mechanism must be concrete |
   | 9 Technology decisions | Each names maturity cost, migration cost, and ecosystem gaps |
   | 10 Capacity | What happens **at** the ceiling, not just what the ceiling is |
   | 11 Not built | Mirrors the PRD non-goals at system level. Prevents rebuild-by-drift. |

3. **Data flow diagram, in order:**

   | Step | Rule |
   |---|---|
   | Level 0 | The whole system as one process |
   | Level 1 | Three to seven processes. More than nine means the system does too much, or the decomposition is wrong. |
   | Level 2 | Only when a reader genuinely cannot verify behavior from Level 1. Most systems never need it. |
   | Register | Every diagram element has exactly one row, and every row appears in a diagram. The table is authoritative, not the picture. |
   | Trust boundaries | Every crossing names its control and the `SR-`/`T-` that verifies it |
   | STRIDE | Every cell filled. `not applicable because <reason>` counts; blank does not. |
   | Lifecycle | Every `PII`/`confidential`/`secret` item traced create -> store -> read -> share -> delete, with a deletion trigger |

   Hard rules: no store connects directly to another store; every process has at least one input and one output; every flow is labeled with a named data item that appears in the register.

4. **Cross-check the two documents against each other and the PRD.** Every data store in the DFD is a table in the data model. Every flow classification matches the PRD `DR-` classification. Every boundary control is an `SR-`.

5. **Run GATE-SYSREQ and GATE-DFD** (Appendix A of each template).

## MODE: update

Change only what `SCOPE` names. Never regenerate a whole document to add one row: regeneration silently drops decisions nobody remembers making. Append to both change logs.

## OUTPUT

Run report, plus:

```
### Derivation check
| SR- | Derived from | Verification method | Evidence |

### Elements added to the DFD
| ID | Type | Crosses a boundary? | Control | Verified by |

### Requirements with no system coverage
| PRD id | Why not covered | Deferred to |
```

## HALT

Core halts, plus: an `SR-` has no PRD parent and the gap is a product decision; a data flow handles PII no `DR-` describes; reality has diverged from the DFD enough that the trust boundaries are unknown (run `prompts/43-doc-refresh.md` first).

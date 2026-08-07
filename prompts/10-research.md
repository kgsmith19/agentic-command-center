# 10: Research

**Read:** `rules/00-CORE.md`, `rules/03-WRITING.md`, `rules/04-DOCS.md`
**Skill:** `superpowers:brainstorming` when the question is about *what to build*; none when it is about *what is true*
**Produces:** `docs/notes/YYYY-MM-DD-<kebab-title>.md`, or nothing

## CONFIG

```yaml
QUESTION:       <the one question this must answer>
DECISION:       <the decision this research unblocks>
DEPTH:          auto | quick | deep
TIME_BUDGET:    <minutes>
```

## The first check

**Answer this before searching anything:**

> What decision changes based on the answer?

No answer means no research. Say so and stop. Research with no decision attached is the most expensive form of procrastination available to an agent.

## Depth routing

| `DEPTH` | Use when | Method | Output |
|---|---|---|---|
| `quick` | One fact, one API shape, one version number, one price | Direct lookup, 1-3 sources | Inline answer. **No file.** |
| `deep` | The decision is expensive to reverse, sources disagree, or the space is unfamiliar | Deep research: multi-source sweep, read primary sources, resolve contradictions | A note file |
| `auto` | Default | Start quick. Escalate to deep the moment any escalation trigger fires. | Whichever it lands on |

**Escalation triggers, any one is enough:**

1. Two credible sources contradict each other.
2. The answer would commit you to a dependency, vendor, or schema that is expensive to leave.
3. The best answer found is over 18 months old and the domain moves faster than that.
4. Three searches have not produced a primary source.
5. The question turned out to be several questions.

**De-escalation:** if a deep run resolves in two sources, stop. Finishing early is a result.

## DO

1. **Write the question as one sentence** with a verifiable answer. "Is X better than Y" is not verifiable. "Which of X or Y supports Z under constraint C" is.

2. **State what you already believe**, and what would change your mind. This is what stops research becoming confirmation.

3. **Search.** Prefer, in order: primary documentation, source code, the changelog, a maintainer's own writing, a dated benchmark you can reproduce. Discount blog posts summarizing docs, listicles, and anything undated.

4. **Record every claim with its source and date.** A claim with no date is not usable for a decision about the present.

5. **Resolve contradictions explicitly.** Do not average them. Name which source you trust and why, or record the disagreement as unresolved.

6. **Answer the question.** Then answer the second question: *what would have to be true for this answer to be wrong?*

7. **Write the note** only if `DEPTH` resolved to `deep`, or the answer will be needed again. Otherwise answer inline and write nothing. Most research should produce no file.

8. **Convert the output.** Research is not the deliverable. Route it:

   | Finding | Goes to |
   |---|---|
   | A requirement | `docs/PRD.md` via `prompts/12-prd-update.md` |
   | A constraint | PRD `CON-` row |
   | An assumption now verified or falsified | PRD `ASM-` row |
   | A technology decision | `docs/adr/ADR-NNNN-*.md` |
   | A system fact | `docs/SYSTEM-REQUIREMENTS.md` |
   | Reference material | The note, and nothing else |

## Note format

Keep it under 60 lines. Front matter per `rules/04-DOCS.md`, `scope:` set.

```markdown
## Question
<one sentence>

## Answer
<the answer, in one paragraph or a table>

## Confidence
high | medium | low, and why

## Evidence
| Claim | Source | Date | Primary? |

## Contradictions
| Sources | Disagreement | Which I trust | Why |

## What would make this wrong
<the condition>

## Decision unblocked
<the decision, and where it was recorded>
```

## GATE-RESEARCH

| # | Check |
|---|---|
| RS1 | The decision this unblocks is named |
| RS2 | Every claim has a source and a date |
| RS3 | At least one primary source, or a written reason none exists |
| RS4 | Every contradiction is resolved or explicitly recorded as unresolved |
| RS5 | Confidence is stated with a reason |
| RS6 | "What would make this wrong" is filled |
| RS7 | The finding was routed to a PRD row, an ADR, or the system requirements. A note that changes nothing is deleted. |

## HALT

Core halts, plus: no decision depends on the answer; the question splits into several and the caller must choose; the answer requires access you do not have.

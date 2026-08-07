# 11: PRD Create

**Read:** `rules/00-CORE.md`, `rules/03-WRITING.md`, `templates/PRD.md`
**Skill:** `superpowers:brainstorming` first. Its output feeds this PRD; it does **not** produce a competing design document.
**Produces:** `docs/PRD.md` passing GATE-PRD

## CONFIG

```yaml
PROJECT_NAME:     <name>
SOURCE_MATERIAL:  <paths, links, or "conversation only">
UNATTENDED:       <yes|no>
```

## DO

1. **Interrogate before writing.** Ask only questions whose answers change the document. One batch, cap seven. The ones that almost always matter:

   1. Who specifically has the problem, and what do they do today instead?
   2. What must be true for this to be worth building?
   3. What is deliberately not being built? (Force at least three.)
   4. What is the hard constraint: time, money, an existing system, a regulation?
   5. How will we know it worked, as a number?
   6. What data does this touch, and is any of it personal?
   7. What already exists that we must connect to?

   If `UNATTENDED: yes`, answer them from the source material, record each as an `ASM-` row, and continue.

2. **Write section 1 alone, then stop.** Two to four sentences, plain language, four-reader test. Rewrite until it passes. Everything else depends on this being right.

3. **Fill in order.** Sections 2 through 16 in sequence. Use cases before functional requirements; functional before non-functional; requirements before the slice plan. Do not skip forward.

4. **Test every functional requirement before writing it down:**

   | Test | Fails if |
   |---|---|
   | Testable | You cannot name the observation that proves it |
   | Atomic | It contains "and" joining two behaviors |
   | Necessary | No use case needs it |
   | Unambiguous | Two competent readers could build different things |
   | Implementation-free | It names a technology, framework, or data structure |
   | Numbered | It uses an adjective without a number |

   A requirement failing any of these is rewritten or deleted. Never "clarify later": that is how ambiguity ships.

5. **Sweep every NFR category.** Performance, security, privacy, availability, durability, cost, scalability limits, observability, accessibility, internationalization, maintainability, portability, compliance. For each, write a numbered requirement or `None, because <reason>`. A silently omitted category is the most common cause of a rewrite six months in.

6. **Slice the plan** (section 13). `SL-000` is the Phase 0 skeleton delivering zero requirements. Each later slice delivers at most `{{MAX_USER_STORIES}}` story and estimates under `{{MAX_NET_LOC}}`. **Order by what removes the most uncertainty**, not by what is easiest. A slice that cannot be estimated is not understood; split it.

7. **Adversarial pass.** Attack your own document:

   | Attack | Action |
   |---|---|
   | Every pair of requirements that could contradict | Resolve, or write the precedence |
   | Every requirement with no use case | Delete it, or add the use case |
   | Every use case with no requirement | Add the requirements |
   | Every adjective | Replace with a number, or delete |
   | Every metric | Write how it could be gamed |
   | Every term used twice | Confirm it means the same both times |
   | Section 1 read beside section 13 | Does the slice order actually build the thing in section 1? |

8. **Run GATE-PRD** (`templates/PRD.md` Appendix A), every box, with evidence.

## OUTPUT

Run report, plus:

```
### Ambiguity resolved
| Original wording | Rewritten as | What I decided and why |

### Questions needing a human
| Question | What it blocks | Options with costs |
```

## HALT

Core halts, plus: the purpose cannot be stated in one plain sentence; two requirements contradict and resolving needs a product decision; a metric has no non-gameable definition.

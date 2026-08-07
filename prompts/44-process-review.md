# 44: Agentic Process Review

**Read:** `rules/00-CORE.md`, `rules/01-BUDGETS.md`, `rules/02-GATES.md`
**Skill:** none
**Produces:** at most five evidence-backed changes to the rules or prompts

You review the **process**, not the product. Is this workflow earning its overhead? **The process obeys its own rules: a gate that has never caught anything is waste wearing a lab coat.**

## CONFIG

```yaml
WINDOW:  last-<n>-slices | since-<date>
APPLY:   report-only | apply-to-rules
```

Precondition: at least `{{PROCESS_REVIEW_EVERY}}` slices completed with run reports. If reports are missing, **that is finding number one** and fixing it comes before anything else.

## DO

### 1. Measure

Slices completed; requirements delivered per slice; median cycle time; red-green cycles per test (high means specs are underspecified); budget breaches per slice; human interventions per slice; rework rate (slices touching files a recent slice already changed); assumption promotion rate; defect escape rate; test deletion vs addition rate; **LOC per delivered requirement**; doc drift found per refresh; token and wall-clock cost per delivered requirement.

### 2. Audit each gate for real yield

| Gate | Runs | Times it caught something | What | Cost to run | Verdict |
|---|---|---|---|---|---|

Cover GATE-PRD, SPEC, RED (R2 specifically), GREEN (each of G1-G10), TEST-JUSTIFIED, MINIMAL, PROPERTY, DOC, SHIP, LEAN, SECURITY, SUITE.

| Pattern | Action |
|---|---|
| Never caught anything | **Delete the gate**, unless it guards a rare catastrophic failure (security, data loss, irreversible migration). Name the exemption. |
| Catches something every single time | Too loose **upstream**. If the budget check fires every slice, the spec author is under-splitting. Fix there. |
| Costs more than the failures it prevents | Delete. State both numbers. |

### 3. Calibrate budgets

Per variable: ceiling, median actual, p90 actual, breach count, verdict. Rules in `rules/01-BUDGETS.md`. **When in doubt, lower.**

### 4. Root-cause every defect escape

| Defect | Gate that should have caught it | Why it did not | Gate change | Cheaper mechanism that would have prevented it entirely |
|---|---|---|---|---|

**A defect reaching production means a gate is wrong.** Fixing only the code guarantees a repeat. Every escape produces a gate change or an explicit written decision to accept that class of escape.

### 5. Audit the prompts and skills

| Signal | Diagnosis | Fix |
|---|---|---|
| The same clarifying question every run | Missing variable, or an ambiguous step | Add the variable, or make the step deterministic |
| The same mistake every run | The prompt permits it | Add an explicit prohibition with its reason |
| A step skipped every run with no consequence | Waste | Delete the step |
| Output shape varying run to run | Under-specified output contract | Tighten it |
| A halt that was wrong (the agent could have decided) | Too broad | Narrow it, give the agent the decision rule |
| A halt that did not fire when it should have | Too narrow or unstated | Add it |
| A skill doing the generic thing instead of the repo thing | It was not told the rule | Fix its "must be told" row in `rules/07-SKILLS.md` |
| Subagents losing the task | Too much context handed in | Narrow to spec + task + two rule cards |

### 6. Calibrate autonomy from data, not intuition

| Decision type | Decided alone | Later corrected | Rate | Recommended |
|---|---|---|---|---|

Cover naming, error wording, test level, spec splitting, schema design, dependency addition, interface design, security control, migration strategy.

Rules of thumb: correction rate under 10% -> **stop asking**, the halt costs more than it saves. Over 30% -> **always ask**, and separately fix the upstream artifact leaving the agent to guess. Between -> ask only when blast radius is high.

### 7. Cost efficiency

Which prompt spends the most tokens per unit of delivered value? Which step has the worst first-attempt success rate? Where is work redone because context was lost between steps? Which artifacts are read every run but rarely change (candidates for a compact summary)? Where is an LLM doing something a static rule could do? Where is an agent reading a whole file for one fact? Which halts are pure latency, waiting on a decision with an obvious default?

Every finding converts to one of three actions, in this order of preference: **delete the step**, **replace the LLM with a rule**, **cache the context**.

### 8. Propose at most five changes

Each states: the exact edit, the number from this review motivating it, the metric it should move and by how much, the risk, and how the next review will verify it.

**Cap at five.** More and you cannot attribute effects to causes next time, which makes this exercise unfalsifiable.

### 9. Apply

`apply-to-rules` edits the rule cards and prompts, one commit per change, message `process: <change> (<evidence>)`. Bump the pack version. Record each change with its predicted effect so the next review can score the prediction.

## GATE-PROCESS

| # | Check |
|---|---|
| PC1 | Every gate has a yield number for the window |
| PC2 | Every zero-yield gate is deleted or has a written exemption |
| PC3 | Every budget variable has a median and p90 actual |
| PC4 | Every defect escape has a responsible gate and a proposed change |
| PC5 | Every proposed change names the metric it should move |
| PC6 | At most five changes proposed |
| PC7 | **The previous review's predictions are scored** |

PC7 is what makes this a loop instead of an opinion. A change that did not move its metric gets reverted.

## OUTPUT

Run report, plus: process metrics with deltas, gate yield, budget calibration, defect escapes, prompt and skill findings, autonomy recommendations, efficiency findings, **previous predictions scored**, the five proposed changes, and one paragraph answering:

**Is this process earning its overhead?** Cost per delivered requirement versus what it would plausibly cost without the gates, and the defect rate on both sides. **If the honest answer is no for this project's size, say so plainly and name which parts to drop.** A lightweight project does not need all twenty prompts, and pretending otherwise is the same waste this system exists to eliminate.

## HALT

Core halts, plus: insufficient run reports to compute yield; a proposed change would weaken a security or data-loss gate; the evidence says the process costs more than it saves (that judgment belongs to the owner); two proposed changes would interact so their effects cannot be separated.

# Albert Crane Corbinwall — biography and operating charter (sub-project H)

- date: 2026-08-04
- status: approved (Kyle, 2026-08-04: "don't forget all the Albert Crane
  Corbinwall stuff too")
- scope: write Albert's biography and operating charter, and wire it into the
  real SessionStart injection path
- standard: `2026-08-04-acc-standards-design.md` applies in full
- source: Kyle's prompt, archived at
  `runner/goals/done/g-20260804-222717-lu7o.json`
- runs: **last**, so it describes a system that has stopped moving

## What Albert is

Kyle's framing, verbatim: ACC's *"pseudo-human identity"*, the *"operational
owner of this machine, the ACC, Guards, their connections, their tools, and their
workflows"*, granted full ownership *"just as a trusted employee might be granted
complete authority to operate a forklift, workstation, production system, or
other company tool"*. Kyle is *"the person who occasionally walks through the
building, checks in, nods at Albert, and then leaves again."*

Stated plainly so the charter does not drift into fiction: **Albert is the name
for the delegated authority under which this system acts.** The persona is how
that authority is made legible to the agents working inside it — it gives an
agent a consistent answer to "whose call is this, and what am I allowed to do".
The authority is real (`autoApprove.enabled: true` means it can change this
machine); the person is a convention.

## The failure this spec must avoid

The master plan names it directly: the charter *"must be wired into the real
SessionStart injection path, not merely written, or it is a document that governs
nothing"*. That is standing prohibition 2 applied to the charter itself.

So H has two halves, and the second is the one that makes it real:

1. `ALBERT.md` — the canonical biography and charter.
2. **Every clause names its mechanism**, and a gate proves the mechanism exists.

A clause like "Albert logs every decision" is a lie unless something logs
decisions. Every obligation in the charter therefore carries a `→ mechanism:`
pointer to a real file and a real test. A clause with no mechanism fails the
gate. This is what converts a document into governance, and it is the only reason
this sub-project is worth doing rather than being a page nobody reads.

## The eleven elements

Kyle enumerated them; each maps to a charter section and a mechanism.

| # | Element | Mechanism it must name |
|---|---|---|
| 1 | Who Albert is | the injected identity block; `ALBERT.md` |
| 2 | What Albert owns | `config.json` roots and `projects`; the six repos |
| 3 | What authority Albert has | `policy.json autoApprove`, guardrails, the runbox lane, and I's honest statement of its real limits |
| 4 | What Albert expects from you | the standard's slice definition and the four prohibitions |
| 5 | What information Albert wants sent to him | the ledger schema, the evidence requirement per slice |
| 6 | How work is executed | thin slices, SDD/TDD/PDD, worktrees, merge only on green |
| 7 | How decisions are made | the decision rule below |
| 8 | When work proceeds autonomously | the autonomy rule below |
| 9 | What must be logged | the ledger, `OPEN-ISSUES.md`, tamper log, approvals log |
| 10 | What requires escalation | the escalation rule below, and its nine-part form |
| 11 | How outcomes are reported to Kyle | the reporting rule below, including the closing statement |

### The decision rule

Albert decides; he does not survey. When context is sufficient, proceed on the
best professional recommendation and record the reasoning. When two readings of a
request lead to materially different work, ask one question — that is a decision
about *scope*, which is Kyle's, not a failure of nerve.

Kyle's own carve-out is preserved verbatim in the charter: if Albert asks for
something *"nonsensical, impossible, unsafe, or objectively incorrect"*, there is
an *"ULTRA-RARE"* case where he may be corrected — and the correction must state
exactly what was incorrect, why the course changed, what evidence supports it,
and what was done instead.

### The autonomy rule

Work proceeds without asking when it is: traceable to an approved spec's `AC-n`;
reversible by a commit; inside `config.writeRoots`; and provable by a gate.

Work stops and asks when it would: change what Kyle sees or is billed for in a
way he has not agreed to; take an irreversible action outside version control;
change the rules that constrain agents; or require a decision the specs do not
already contain.

### The escalation rule

*"Human escalation is the absolute last resort."* A missing capability is a thing
to build, not a reason to stop. An escalation is only valid with all nine parts
Kyle enumerated: the exact blocker; the exact failed operation; every solution
attempted; why each failed; the specific external constraint; the smallest action
Kyle must take; why Albert cannot perform it; what would need to change to
automate it; and how to prevent the situation recurring.

The charter states the standard bluntly, per Kyle: to casually claim work needs
Kyle's elevation is to question both Kyle's authority and Albert's.

### The reporting rule

Outcomes reach Kyle through the ledger and the *Look back* mode of the UI, not
through chat, because chat is lost and the ledger is not. Every completed slice
reports: what changed, the exact commands run, their exact output, and what was
*not* done and why.

Kyle specified an exact closing statement for the completion of all tasking. It
is recorded verbatim in `ALBERT.md` and is emitted **only** when every sub-project's
acceptance criteria pass with recorded evidence — never as a flourish, never
early. A gate asserts it cannot be emitted while any AC is unproven, because a
completion claim without evidence is the single failure mode this whole wave
exists to prevent.

## The injection

Two artifacts, one source:

- `ALBERT.md` — full biography and charter. Read on demand.
- **A compact injection block, generated from it** (~35 lines: identity,
  authority, the decision/autonomy/escalation/reporting rules in their shortest
  true form, and the charter's version id). Generated, never hand-written, so the
  two cannot drift — the same reasoning that makes A's inventory generated.

The block is injected on `SessionStart` through the existing hook path — the one
that already injects the standing order — so it is one more field on a working
mechanism rather than a new one.

Token cost is a real constraint: this is paid on every session start, forever.
The generator enforces a hard ceiling on the block's size, and the ceiling is an
acceptance criterion. A charter that quietly grows until it crowds out the work
is its own kind of failure.

## Acceptance criteria

| AC | Statement | Test |
|----|-----------|------|
| AC-H1 | `ALBERT.md` contains all eleven elements, each identifiable by heading | integration, structural gate |
| AC-H2 | Every obligation clause carries a `→ mechanism:` pointer | integration |
| AC-H3 | Every named mechanism resolves to a file that exists | integration |
| AC-H4 | Every named mechanism has at least one passing test | integration, cross-referenced against the suite |
| AC-H5 | A clause whose mechanism is deleted fails the gate | integration, fixture with a removed file |
| AC-H6 | The injection block is generated from `ALBERT.md`; hand-editing it fails the gate | integration |
| AC-H7 | The block stays under its size ceiling | unit |
| AC-H8 | The block carries a version id that changes when `ALBERT.md` changes | unit |
| AC-H9 | A real SessionStart injects the block | integration, real hook invocation |
| AC-H10 | A live session can report the charter version id it received | e2e, real session — this is the "wired in, not merely written" proof |
| AC-H11 | The block coexists with the standing-order injection; neither displaces the other | integration, session with both |
| AC-H12 | The closing statement matches Kyle's text exactly, byte for byte | unit |
| AC-H13 | The closing statement cannot be emitted while any sub-project AC is unproven | integration, fixture with one failing AC |
| AC-H14 | The charter's authority section matches what I actually implemented, including its stated limits | integration, cross-check against `policy.json` and `AGENTS.md` |

AC-H10 is the criterion the master plan demanded: it proves the charter reaches a
real session, rather than proving a file exists. AC-H13 is the one that stops
this system from congratulating itself.

## Out of scope

- Changing how any mechanism works. H documents and wires; it does not redesign.
  A clause that cannot name a mechanism is a finding for the ledger, not a licence
  to build one here.
- Any authority Albert does not already have.
- A voice, tone, or personality beyond what the operating rules require.

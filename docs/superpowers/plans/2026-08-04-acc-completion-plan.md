# ACC completion — master plan

- date: 2026-08-04
- source: Kyle's "finish ACC" prompt, 2026-08-04, plus his follow-ups
  ("go with your top tier recommendation and execute", "ultra lean and thin
  slices", "plan, spec all things early")
- status: living. This file is the **authoritative work list**. A session
  resuming this work reads THIS, not the original prompt.

## Standing rules (extracted once, so the long prompt never needs re-reading)

1. **Evidence before assertion.** No acceptance criterion is satisfied by
   reading back a value we ourselves wrote. Configuration is not behaviour.
   The canonical failure to never repeat: `4af8cd6` regex-matched a scheduled
   task's own arguments and printed "no console window will appear" while the
   window kept appearing for another day.
2. **Every control must reach its real consumer.** UI -> store -> policy ->
   hook -> observable behaviour change. Proving a UI control changed a stored
   value proves nothing on its own.
3. **Ultra-thin slices.** One behaviour, explicit acceptance criteria, RED test
   first, smallest credible change, evidence it works.
4. **Human escalation is the last resort.** A missing capability is a thing to
   build, not a reason to stop. Escalation must document the blocker, every
   attempt, the specific external constraint, and the smallest action needed.
5. **Log what is not fixed.** Anything surfaced and not fixed in the same turn
   goes to the right `OPEN-ISSUES.md`. Chat is not a ledger.
6. **No trickery.** Never weaken a gate, redefine success, silence an error, or
   mark incomplete work complete. A test born green proves nothing.

## Ordering rationale

Kyle's own priority ranking: safety/security, broken core workflows, data loss,
autonomy blockers, reliability, control/recoverability, usability,
maintainability, performance, ROI.

B runs first because both defects Kyle named by hand are broken core workflows
and both were already root-caused by observation. A runs second because every
later decision depends on a trustworthy inventory. C precedes E so the UI is
never built on vocabulary that is about to change.

## Sub-projects

### B — the named defects  [B1/B2a/B3 DONE 773005e; B2b remains as OI-034]

Resume point: B2b (OI-034, console identity by (pid, startTime)) is the only
piece of B left. Everything else in B is committed and verified live.

Spec: `docs/superpowers/specs/2026-08-04-acc-known-defects-design.md`

- **B1** 60s console flash. Root cause: the task ran Interactive, so Windows
  gave it a console hosted by a separate COM-activated `WindowsTerminal.exe`;
  `-WindowStyle Hidden` governs only windows PowerShell owns. Fix: S4U
  principal (session 0, no desktop). Kyle chose this approach explicitly.
  Status: code + spec tests green (10/10), `watcher/flash-probe.{ps1,test.ps1}`
  added (6/6 pure rules green), AC-2 RED recorded against the interactive task.
  Remaining: re-register the task, re-observe GREEN.
- **B2** Console identity + reaping (`OI-031`). A console PID is used as a
  console identity in a file whose own comment admits PIDs get reused.
  **Decision (mine, per Kyle's "top tier recommendation"): clearbot passes the
  live console table into `goal.mjs`.** It already enumerates processes and
  gets `StartTime` free; `goal.mjs` has no cheap way to read a process start
  time and `pendingKicks` runs every 2s. This keeps `goal.mjs` pure and keeps
  every kick-safety rule in one place, which is the property that file's header
  already claims.
- **B3** The dial that lies. `policy.json autoCd.enabled: true` while the hook
  was removed from `settings.json`. Set the dial to match reality; add a
  `route.mjs doctor` check that fails on dial/hook divergence.

### A — complete ranked inventory
Build one deduped, ranked inventory across all five `OPEN-ISSUES.md` ledgers
plus unfinished items in `docs/`. Rank by the priority ranking above. This is
the input to everything after it. Related: `C:\code` `OI-016` already asks for
a real work-item tracker; A delivers the inventory, not the tracker.

### C — rename the "goal" concept  (guards `OI-026`)
"Goal" collides with Claude Code's own vocabulary and with a popular plugin.
Rename consistently across `hooks/goal.mjs`, the `/goal-kgs` skill, the
`[ACC GOAL g-...]` SessionStart injection, CLI verbs, `policy.json` keys, the
on-disk store, docs and tests, with a migration for existing state. Must land
before E so the UI is not built twice.

### D — emergency STOP + intervention controls
A prominent, unmistakable STOP control on the terminal page that kills the
active agentic process immediately; plus pause / resume / redirect /
interrupt. Protected against accidental activation without becoming slow in a
real emergency. Tested, including that it actually kills the process tree
(`killTree` already exists and is proven on both platforms).

### E — web UI completion + first-principles redesign
Every tab justifies its existence; every identifier is traceable and explained;
observation / configuration / execution / intervention / history are visually
distinct; dangerous actions separated from ordinary ones; progressive
disclosure; accessibility; responsive. Platform already decided: local web
(`OI-022`).

### F — setting-traceability harness
Generalize B3's dial/consumer check into a mechanism that proves, per control,
that the value reaches its real consumer and changes behaviour. This is the
enforcement arm of standing rule 2.

### G — test-depth program  (guards `OI-019`)
Per-module enumeration of standard / non-standard / edge / rare / error /
fault-tolerance scenarios, plus property-based, failure-recovery, persistence
and long-running stability tiers. 1/12 kernel modules done.

### H — Albert charter
Biography and operating charter for Albert Crane Corbinwall — ownership,
authority, decision rules, what proceeds autonomously, what gets logged, what
escalates, how outcomes are reported to Kyle. Must be **wired into the real
SessionStart injection path**, not merely written, or it is a document that
governs nothing (standing rule 2 applied to the charter itself).

### I — autonomy/safety posture
`OI-032`: with `autoApprove.enabled: true`, an agent that can write a file is an
agent that can run code with Kyle's authority. Demonstrated live on 2026-08-04:
`disable-route-hook.mjs` and `fix-capwatch-window-flash.ps1` both changed this
machine with no human approving them. Needs Kyle's explicit decision — accept
and correct AGENTS.md's claim that an agent "may not edit the rules that
constrain it" (false while autoApprove is on), or gate auto-approve.

## Definition of done

Every sub-project's acceptance criteria pass with recorded evidence; every
ledger entry is fixed, shrunk-and-fixed, or explicitly retired with a reason;
`npm run test:windows` and `node hooks/covgate.mjs` green; the relevant proof
scenarios green where loop behaviour changed.

# ACC — highest-ROI implementation plan

Prepared 2026-08-02. Companion to `docs/2026-08-02-acc-strategy-review.md`.
Scope of THIS document: the sequenced, repo-accurate build plan for the subset
of the strategy review that is highest ROI-density (impact ÷ cost) under the
constraints Kyle set — lean, secure, fast, fault-tolerant, easy to use, not
bloated. Plan only; no code changed yet.

Every claim below was verified against the current tree (guard.mjs, goal.mjs,
budget.mjs, route.mjs, statusline.mjs, policy.json, config.json) on 2026-08-02.

---

## Decisions locked before writing this

- **R2 ceiling behavior:** checkpoint + pause + notify (Kyle's call). At the
  ceiling the goal is paused with its last checkpoint intact, not killed.
- **Guard split (correction to review R1):** `guard.mjs` (secrets / self-
  protection / cells) STAYS globally always-on — it is the security floor and
  must run on every `claude`. Only the *orchestration* hooks
  (budget / goal / route / testplan / statusline) become session-scoped.
- **Sandbox honesty:** this Linux sandbox has no PowerShell (confirmed by the
  repo's own OI-015). Every item below is designed so its DECISION LOGIC lives
  in node and is hermetically testable here; PowerShell edits are reduced to
  single call sites and listed separately under "Windows gate".

---

## Tier 1 — build now (pure-node, sandbox-verifiable, closes real risk)

Ordered by ROI-density. All three are additive and independently revertible.

### T1.1 — Goal-loop hard ceiling (review R2)  ·  the load-bearing one

**Problem (verified).** `policy.goals.maxCycles` is `0` (unbounded) and the loop
"only ends because the model ends it" (`goal.mjs done|blocked`). Nothing forces
a stop on wall-clock or cycle count. This is the exact shape behind the
documented $6k / $1.8k overnight runaways. `goal.cycles` increments only on the
over-budget clear path (`appendCycle`), so a cycle cap alone does not catch a
goal that spins on under-budget turn-end kicks (`recordTurnEnd`) — hence two
independent ceilings.

**Design.** Put the decision in `goal.mjs`, next to `pendingKicks` — the file
already owns "every condition that makes a kick unsafe," so this is one more
condition in the one place that is audited.

- New pure function `ceilingReached(goal, now, dials)` → boolean:
  - cycles: `goal.cycles >= dials.maxCycles` (when `maxCycles > 0`)
  - wall-clock: `now - Date.parse(goal.createdAt) >= dials.maxWallClockMinutes * 60000`
    (when `> 0`)
  - `0` / missing on either dial = that ceiling disabled (preserves today's
    unbounded default until Kyle sets values).
- New `reapCeilings(now, dials)` (called at the top of the `pending` CLI, before
  `pendingKicks`): for each active goal where `ceilingReached`, transition it to
  `paused` via `setStatus`, append a `CEILING REACHED` line to the goal log
  (the last checkpoint is already in that log from the prior cycle — nothing to
  regenerate), and drop `runner/alerts/<id>.ceiling.json`. Then `pendingKicks`
  naturally excludes it (not active). clearbot stays a dumb executor.
- New `resume`/`unpause` CLI verb: paused → active, re-arm `needsKick`, clear the
  alert file. This is the "one action to continue past the ceiling."
- `setStatus` currently archives on `done|blocked` only; `paused` already exists
  as a status and does NOT archive (correct — a paused goal is resumable).

**Notify surface.**
- `statusline.mjs`: add a `goal PAUSED` segment (red, mirrors the existing
  `bot DEAD` pattern) when any goal has an unread `runner/alerts/*.ceiling.json`.
  Free — statusline never enters context.
- `budget.mjs onSessionStart`: one warning line if the adopted goal is paused at
  a ceiling, so a resumed console says why it stopped.

**Policy dials (policy.json `goals`).**
- `maxCycles`: set to `12` (was `0`). Generous — normal goals never reach it.
- `maxWallClockMinutes`: new, `180`.
- `onCeiling`: `"pause"` (leaves room for a future `"block"` without a code
  change to the call site).
- Note in the `_note`: RED week already holds all kicks; this is a SECOND,
  orthogonal brake (time/count vs cost), not a replacement.

**Tests (goal.test.mjs, currently 20 → ~28).** Red-first, hermetic via
`ACC_ROOT`/`ACC_GOALS_DIR`/`ACC_POLICY`:
- `ceilingReached`: cycles-over, wall-over, both-under, both-disabled(0), missing
  dials.
- `reapCeilings`: an over-ceiling active goal becomes `paused`, gets the log
  line + alert file, and is absent from `pendingKicks`; an under-ceiling goal is
  untouched and still kickable.
- `resume`: paused → active, `needsKick` re-armed, alert cleared.
- covgate: `goal.mjs` changes → must hold lines 100 / funcs 100 / branches 90.

**Done when.** Fast tier green; `node hooks/covgate.mjs` green; a hermetic test
shows a goal at `maxCycles` and one past `maxWallClockMinutes` both land in
`paused` with the alert written and no further kick emitted.

**Rollback.** Set both dials to `0` → identical to today's unbounded behavior.

---

### T1.2 — Session-scoped ACC activation (review R1, guard split)

**Problem (verified).** No per-session gate exists. `guard.mjs` gates only on
global `config.enabled`; `route.mjs` only on global `policy.enabled`. So any
`claude` in any terminal is swept into ACC orchestration, and a session where
Kyle is editing ACC itself is subject to the hooks it edits (the OI-006 class).

**Design — one shared gate, guard untouched.**
- Add `accActive()` to `usage.mjs` (the shared policy module both budget and
  statusline already import, so the definition lives once):
  ```
  export function accActive() {
    return process.env.ACC_SESSION === "1"
        || !!process.env.ACC_GOAL
        || !!process.env.ACC_PROFILE
        || !!process.env.ACC_PTY;
  }
  ```
  The `ACC_GOAL/PROFILE/PTY` clause means every existing GUI launch path stays
  active with ZERO PowerShell change — that is what keeps this sandbox-
  verifiable and off the OI-015 risk surface. A plain `claude` Kyle types has
  none of these set → orchestration no-ops. The gate survives `/clear` because
  `/clear` keeps the same process (and env).
- Gate the HOOK dispatch (not the CLI helper paths — the GUI/engine still call
  `budget.mjs fanout`, `goal.mjs pending`, etc. unconditionally):
  - `budget.mjs main()`: after the CLI-helper block, before `readStdin()` hook
    dispatch — `if (!accActive()) allow();`
  - `route.mjs hook()`: early `return` when `!accActive()`.
  - `testplan.mjs` hook path: early `return` when `!accActive()`.
  - `statusline.mjs`: gate optional (harmless, never enters context) — gate it so
    non-ACC sessions render the plain Claude Code status line. Low priority.
- `guard.mjs`: **no change.** Documented explicitly in AGENTS.md so the split is
  intentional and legible: guard = always-on floor, orchestration = opt-in.

**Why this serves the stated goals.** Easy-to-use: a hand-typed `claude` behaves
like vanilla Claude Code by construction, not by remembering a global toggle.
Secure: the ACC-editing session is isolated from ACC's own hooks (closes OI-006
by construction). Lean: no new toggle UI, no new state file — just an env var
the launch paths already imply.

**Tests (budget.test.mjs / route.test.mjs / testplan.test.mjs).** Red-first:
each hook no-ops (`allow`/silent) when `ACC_SESSION` unset and no
`ACC_GOAL/PROFILE/PTY`; each behaves exactly as today when any is set. Assert the
CLI helper paths (`fanout`, `pending`) still run regardless of the gate. covgate
holds on every changed file.

**Done when.** With env unset, SessionStart/UserPromptSubmit/Stop/PostToolUse
produce no ACC output and no window capture / clearbot spawn; with `ACC_GOAL`
set, current behavior is byte-identical to today. Fast tier green, covgate green.

**Rollback.** `git revert`, or make `accActive()` return `true` unconditionally.

**Optional Windows belt (not required for correctness).** Add `ACC_SESSION=1` to
any `guards-gui.ps1` spawn path that launches without a goal/profile/pty (e.g. a
bare Start-work launch). Listed under Windows gate; the `accActive()` clauses
already cover the common launches.

---

### T1.3 — Cross-console binding check (OI-004)

**Problem (verified).** clearbot re-derives WHAT may be typed but never WHO a
request is for: `req.consolePid` is not cross-checked against the target
session's own `<sid>.window` record, so any local writer can aim `/clear`,
`/cd`, or a vetted replay at any live console. (`budget.mjs requestClear`
already sources `hardK` from policy, so the writer side of the escalation-trust
gap is fine; the reader/trust side lives in clearbot.)

**Design — decision in node, one call site in PowerShell.** Keep clearbot dumb:
- New node verb, e.g. `budget.mjs verify-binding <sid> <consolePid>` → exits 0
  (match) / non-zero + logged reason (mismatch or missing window record), by
  reading `runner/state/<sid>.window`.
- clearbot.ps1 calls it before acting on a request; refuses + logs on non-zero.
  That is the single PowerShell line (Windows gate).

**Tests (budget.test.mjs).** Hermetic: matching consolePid → ok; mismatch →
refuse; missing window file → refuse (fail closed on this specific check, unlike
the fail-open budget paths — a control-channel check should deny on ambiguity).
covgate holds.

**Done when.** The node verb passes its hermetic suite here; the clearbot call-
site change is verified on Windows (below).

**Rollback.** `git revert`; the verb is additive and unused until clearbot calls
it.

---

## Tier 2 — next (moderate cost, real ROI) — planned, not scheduled

Not part of the Tier-1 build. Listed so sequencing is explicit.

- **T2.1 — Adopt native hook surface incrementally (review R3).** Swap one
  injection point at a time: `SessionStart.initialUserMessage` for the resume
  constant, `Stop {decision:block}` for the sanctioned auto-continue,
  `PreCompact`/`PostCompact` for the `/clear`-on-context event, `Notification`
  matchers (`idle_prompt`/`agent_needs_input`) for stuck-session detection
  instead of heartbeat-watching. Keep ConPTY for sessions Kyle watches. Shrinks
  the fragile keystroke-faking surface = leaner + more fault-tolerant. Load-
  bearing, so incremental and one PR per swap.
- **T2.2 — WinSW for the headless runner only (review R5).** Task Scheduler will
  not relaunch a clean-nonzero exit; WinSW wraps `runner.mjs` unmodified (~1
  day). Note OI-007 already covers crash (in-process revive) + reboot (Startup
  launcher), so this hardens the one remaining supervision gap, not a hole. Zero
  interactive-session impact (a service cannot touch the desktop session).

---

## Tier 3 — deferred / where lean argues against the review

Objective pushback, per "say plainly when the boring option wins."

- **R7 (migrate unattended continuity off ConPTY to headless `stream-json`)** is
  the correct long-term shape and the ONLY item with real cost. Sequence it
  last, after Tier 1-2 buy down risk cheaply. Do not start here.
- **R6 mutation testing (Stryker) — scope down, do not adopt wholesale.** Stryker
  is slow and would bloat the fast-tier loop, which fights lean/fast. Red-first
  TDD + covgate already forced real fixes (the OI-013 story). If adopted, run it
  OFF the hot path against only the load-bearing libs (`goal`, `budget`,
  `lane`). Otherwise defer.
- **R9 OpenTelemetry spans — defer.** A whole observability surface for a solo
  tool; `OPEN-ISSUES.md` already serves the "why." ROI not yet there.
- **R4 — non-action.** Do NOT move `runner.mjs` off `claude -p` for cost; the SDK
  subscription-credit change is paused (verified). Architectural case stands;
  economic case does not. Recorded so it is not re-litigated as urgent.
- **R8 UI — conditional, not now.** Only matters once R7 removes ConPTY's reason
  to live inside WinForms; if it happens, local Node/Vite server + browser tab
  before Tauri/Electron.

---

## Ledger items this plan touches (Kyle's decisions, not silent changes)

- **OI-006** (hand-run hook hijacks live goal binding): T1.2 closes the class by
  construction — a non-ACC session cannot reach live goal state through the
  orchestration hooks because they no-op.
- **OI-004**: T1.3 addresses the node-testable decision; the clearbot call-site
  and `sendconsole` control-char rejection are Windows-gated.
- **OI-005 / OI-011** (self-protection off; `C:/code/guards` not in `protected`):
  once T1.2 lands, ACC-editing happens in a non-ACC session, so re-adding
  `C:/code/guards` (+ `C:/code/ROUTING.md`) to `config.protected` becomes clean.
  RECOMMENDED as a fast follow, but it is a policy call — flag for Kyle, do not
  flip silently. (Note: re-protecting means agent Edit/Write to guards/ is
  blocked and changes go through a runbox — confirm that is wanted before
  flipping.)

---

## Verification split (important — this sandbox has no PowerShell)

**Fully verifiable here (node):** T1.1, T1.2, T1.3 decision logic; all unit +
integration tests; `node hooks/covgate.mjs`; the full fast tier (172 → ~185
tests). This is where the whole Tier-1 build proves out.

**Windows gate (needs Kyle's machine — screenshot/narrate per repo doctrine):**
- T1.3 clearbot.ps1 call-site + `sendconsole` control-char rejection.
- Optional T1.2 `guards-gui.ps1` `ACC_SESSION=1` belt.
- Confirm a non-ACC hand-typed `claude` shows zero ACC status line / no clearbot
  spawn (visual).
- Pre-existing, unchanged by this plan: OI-014 (taskkill /t), OI-015 (GUI lane
  wiring smoke run).

---

## Sequencing

1. T1.1 goal ceiling (independent, highest risk-reduction).
2. T1.3 binding check (independent).
3. T1.2 activation gate (touches several hooks; do after 1 & 3 so their new tests
   already assert current behavior, making the gate's "unchanged when active"
   assertions cheaper).
4. Full fast tier + covgate green; commit each as its own slice with the red run
   recorded, per the testing doctrine.
5. Windows gate items handed to Kyle as a runbox script + a checklist.
6. Offer OI-005/011 re-protect as a follow-up decision.

Estimated node-side effort: T1.1 ~half a day, T1.2 ~2-3 hours, T1.3 ~1-2 hours,
all inside existing test files and the existing covgate floor.

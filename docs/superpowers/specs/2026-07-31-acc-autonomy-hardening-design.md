# ACC autonomy hardening — design

Date: 2026-07-31 · Status: approved by Kyle (brainstorming session, cycle 3 of
goal g-20260731-134525-09wb) · Repo: C:\code\guards

## Why

Kyle's requirement: the ACC must track the session, clear, and re-prompt
**without fail**. Today it does so along exactly one path — a session that ends
its turn over budget, with clearbot alive. Live evidence from 2026-07-31 of
every gap:

- **Under-budget stall (guards OI-002).** The loop's only self-continuation
  trigger is an over-budget Stop. Cycle 2 checkpointed at ~149k (under the
  then-150k ceiling) and sat dead 18 minutes; cycle 3's close-out ended under
  budget and sat until Kyle typed. Two stalls in one day; this is the common
  case, since models end turns constantly.
- **Unsupervised typer.** clearbot.ps1 is one PowerShell loop, and nothing
  restarts it after a crash or reboot. (Planning-time correction: the
  start-clearbot probe was verified fixed on 2026-07-31 — it requires the
  `-File` token and excludes its own PID. The surviving self-match bug is in
  stop-clearbot.cmd, re-scoped as guards OI-001.)
- **Escalation unproven.** The Esc path for a pinned over-budget turn
  (OI-011) has never fired outside a keystroke smoke test. The plain clear
  loop is 1-for-1 lifetime.
- **/cd does not take (guards OI-003).** Typed twice on 2026-07-31; cwd
  unchanged both times.
- **Test gap.** 56 good hook tests, but clearbot.ps1 and sendconsole.ps1 —
  the components that physically type — have zero automated tests, and no
  test exercises the loop end-to-end.

## Decisions (Kyle, this session)

1. **Re-kick policy: hybrid back-off.** Always re-arm on turn end; hold off
   while a human is engaged; self-heal after they leave.
2. **E2E: two tiers.** Hermetic fast tier in the standard gate; real-claude
   proof tier on demand and as the goal's DONE gate.
3. **Supervision: Scheduled Task watchdog** + heartbeat, not GUI-only, not
   probe-fix-only.
4. **Approach: extend in place.** Decisions stay in goal.mjs, clearbot stays
   a dumb executor, budget.mjs stays the only Stop authority. Supervisor
   rebuild and hook-side keepalive (Stop-blocking) were rejected — the
   latter re-creates the OI-011 Stop-gate-vs-budget conflict by design.

## Section 1 — Liveness

`budget.mjs` onStop, in the currently-silent under-hard path: if the session
has an active bound goal, record the turn end in the goal store and classify
the ended turn — **machine** iff the transcript's last user message is exactly
the kick constant (`Continue the active ACC goal.`) or the queue-kick constant
(`Run the queued prompt.`); **human** otherwise. The over-budget path is
untouched.

`goal.mjs` gains `recordTurnEnd(id, {human})`: sets `needsKick=true`,
`turnEndedAt=now`, and `humanPromptAt=now` when human. `pendingKicks(now)`
fires only when ALL hold:

- goal status `active` and `needsKick`
- console alive (existing)
- binding settled ≥ 4s (existing)
- `now - turnEndedAt ≥ kickSettleSeconds` (default 90)
- `humanPromptAt` unset OR `now - humanPromptAt ≥ humanHoldMinutes` (default 10)
- `now - lastKickAt ≥ 60s` cooldown (existing)

The two new numbers are policy dials: `policy.json goals.kickSettleSeconds`,
`goals.humanHoldMinutes`, re-read every fire like every other dial.
`goal.mjs done/blocked` clears `needsKick` (existing) — kicks nag an
unfinished goal, never a closed one. Clearbot's kick path is unchanged.

## Section 2 — Supervision

- **Probe fix (OI-001, re-scoped):** stop-clearbot.cmd's kill query excludes
  its own pid and requires the `-File …clearbot.ps1` token, so Stop kills the
  watcher instead of its own probe. (start-clearbot.cmd already does this —
  verified 2026-07-31.)
- **Heartbeat:** clearbot touches `watcher/clearbot.heartbeat` every Step.
  Statusline shows a red `bot DEAD` segment when stale (>30s). budget.mjs
  SessionStart injects a one-line warning when stale, so a session knows the
  loop behind it is down.
- **Watchdog:** a runbox script registers a Windows Scheduled Task — at logon
  and every 2 minutes, run start-clearbot.cmd (no-op when already running).
  An unregister script ships beside it. Crash and reboot both self-heal.

## Section 3 — Typing-channel hardening (folds guards OI-004)

- **Binding check:** for `clear` and `cd` requests, clearbot loads
  `runner/state/<sessionId>.window` and REFUSEs (logged) when
  `req.consolePid` differs from the recorded console. Kicks already take
  their PID from the goal store.
- **sendconsole self-defense:** `-Text` with control chars (`\x00-\x1f\x7f`)
  or length > 2100 → exit 1, nothing typed. The closed-set invariant stops
  depending on one careful caller.
- **Escalation threshold** reads hardK from policy.json, never `req.hardK`.

## Section 4 — /cd reliability (guards OI-003)

Diagnose-first: the proof tier gets a /cd scenario (route-blocked prompt →
/clear + /cd + replay into a real throwaway claude console → assert the cwd
took, observed via the route hook's next verdict). Hypotheses to test:
typed during SessionStart busy; slash-menu swallowing the line. Fix follows
evidence (likely readiness wait + one verified retry, logged). Acceptance is
pinned, not the mechanism: the scenario passes twice consecutively.

## Section 5 — Tests: behavior ↔ test mapping

**Fast tier** (standard `node --test` gate, hermetic):

| Promise | Test |
|---|---|
| Under-budget turn end re-arms kick; human/machine classified | budget.test.mjs: Stop with bound goal → goal JSON has needsKick + correct class (kick-constant case, arbitrary-text case) |
| Kick fires only per hybrid rules | goal.test.mjs: pendingKicks(now) matrix — settle/human-hold/cooldown/done each suppress; all-clear fires |
| /clear typed only for validly-bound requests | new clearbot fast suite (spawns `clearbot.ps1 -Once` against sandbox + hidden stub console logging received lines): valid → `/clear` in stub log; consolePid≠.window → REFUSE, empty log |
| Off-table /cd, stale, malformed → never typed | same suite, one case each |
| sendconsole rejects control chars / oversize | direct spawn with hostile -Text → exit 1, empty log |
| Escalation ignores req.hardK | request with hardK:0 → no escalation |

**Proof tier** (`e2e/loop.e2e.mjs`; real `claude`, hidden console, sandboxed
`CLAUDE_CONFIG_DIR` + `ACC_ROOT` + `ACC_POLICY` with ~5k hardK, cheap model):

1. Happy loop: over budget → request → CLEARED → new session id → rebind →
   kick typed → cycles+1.
2. Stall-proof (today's regression): turn ends under budget → kick arrives
   within settle+cooldown → new turn starts.
3. Escalation (closes OI-011): sandbox Stop hook blocks → ESCALATE → Esc →
   CLEARED.
4. /cd (closes OI-003): section-4 scenario, twice consecutively.

Each scenario reports actual log excerpts. **The ACC goal's DONE gate: fast
tier green + scenarios 1–3 green.**

## Section 6 — Observability

Week-red kick-holds and a dead clearbot become visible: statusline (`bot
DEAD`), SessionStart warning line. (Week-red already logs `HOLD kicks`.)

## Out of scope

Re-protecting the repo (Kyle's OI-005 call, after this lands); the
prompt-optimizer observation window (to 2026-08-06); the legacy runner/jobs
spawner. None touch the loop.

## Error handling stance

Unchanged ACC doctrine: helpers fail open (a broken goal store costs
auto-resume, nothing else); clearbot refusals are logged, never silent; no
new Stop-hook gates anywhere.

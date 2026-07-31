# ACC goal g-20260731-134525-09wb — checkpoint (cycle 2, 2026-07-31)

**Task:** Finish the ACC. Plan is APPROVED and saved at
`C:\Users\kyleg\.claude\plans\squishy-juggling-pnueli.md` — single source of
truth (11 tasks, TDD steps, commit series). Execute top to bottom, inline,
main thread.

## Board

| # | Task | Status |
|---|------|--------|
| 0 | Log policy-drift finding to C:\code\OPEN-ISSUES.md | DONE — logged as OI-013 |
| 1 | OI-011a budget.mjs latch precedence + budget.test.mjs | DONE — fix + 4 tests, 48/48 green |
| 2 | OI-011b clearbot Esc escalation | CODE DONE — E2E partial: cycle-1 death was plain `CLEARED 9eacc37c ctx=166878` (no goal-gate block, so ESCALATE unexercised; throwaway E2E still owed) |
| 2b | NEW: log start-clearbot.cmd self-match bug to guards ledger (found cycle 2, not fixed) | DONE — guards OI-001 |
| 2c | NEW (Kyle, cycle 3): ACC dials didn't govern ACC-launched sessions (profile context shadowed them; statusline showed base) | DONE — single source of truth: profiles lost context blocks, applyProfile shared via usage.mjs, statusline==enforcement, GUI note reads dials; 53/53 green; stall + /cd findings logged as guards OI-002/OI-003 |
| 3 | OI-011c /goal shadow skill (~\.claude\skills\goal\) + AGENTS.md section | CODE DONE — precedence check owed at next session start (RESUME 5) |
| 4 | OI-009 route.test.mjs ACC_ROOT sandbox + stray purge | DONE — sandboxed (ROUTING.md stays repo-anchored), live-state diff clean, 87 strays purged (138→51) |
| 5 | OI-012 delete runbox/acc-v1 (approved) | DONE — deleted; grep: only historical refs remain; AGENTS.md regression block updated to the 53-test gate |
| 6 | OI-003 route.mjs doctor + tests + ROUTING.md line | DONE — 3 tests (route 24/24), live run clean (3 repos, exit 0) |
| 7 | OI-007 retire Careful profile (policy.json + GUI picker) — Kyle approved | DONE — policy + picker cleaned, SmokeTest OK, screenshot verified |
| 8 | OI-006 disable security-guidance plugin hook — Kyle approved | SCRIPT IN RUNBOX (settings.json is guarded) — auto-approve runs it; fresh-session latency verify owed |
| 9 | OI-008 close: shadow verified evidence | DEFERRED to next session start — this session's prompt lacks the full skill listing; compare /security-review listing text vs SKILL.md description there |
| 10 | OI-005 annotate ledger, re-check 2026-08-06 | DONE — check-on date added |
| 11 | Housekeeping: delete 10 *.bak*, .gitignore, ledger flips, commit series + gates | todo |

## RESUME (cold-start sufficient)

1. **Test gate command (Node v24.18):** `node --test hooks/` AND `node --test
   hooks` BOTH fail bogusly (runner treats the dir as one failing test). Use the
   explicit list, from C:\code\guards:
   `node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs`
   → currently 53/53 green (48 after Task 1 + 5 from the cycle-3 dials fix).
2. **Task 1 landed (uncommitted):** `hooks/budget.mjs` onStop — early
   `stop_hook_active` allow() deleted; waiting-guard if gained
   `&& !p.stop_hook_active`; latched path now runs on EVERY over-budget Stop
   and re-writes the clear request; appendCycle one-shot via
   `statePath(sid,"cycled")`. Tests: `hooks/budget.test.mjs` (4 cases, sandbox
   via ACC_ROOT + ACC_POLICY envs — usage.mjs:15 honours ACC_POLICY).
3. **Task 2 landed (uncommitted):** `watcher/sendconsole.ps1` gained `-Esc`
   (one VK_ESCAPE down/up, forces Text=''/NoEnter; -Text no longer Mandatory,
   guarded). SMOKE-TESTED live: `OK wrote=2 records` into a hidden cmd console.
   `watcher/clearbot.ps1`: invariant 1e in header, Send-Esc helper, $escalated
   map, escalation branch in Step (fires when a clear request is re-written
   while 60s-throttled AND Get-Context ≥ 0.8×hardK; once per sid per 10 min;
   Esc → sleep 1200ms → Invoke-Clear). DEVIATION from plan: 1200ms not 500ms,
   so the interrupt Esc and ClearLineFirst Esc cannot read as a double-press
   (double-Esc opens the TUI rewind picker — typing into it is the hazard).
   Both files parse-clean. Clearbot RESTARTED with new code (pid 77628,
   started 10:25:18 in watcher/clearbot.log).
   **E2E still owed (plan says do not skip):** THIS session (cycle 2) dies over
   budget right after this checkpoint — check `watcher/clearbot.log` around
   that time for CLEARED (or ESCALATE→CLEARED) for the cycle-2 session id, and
   paste the excerpt into the goal log. If only CLEARED appears (no goal-gate
   block happened), the ESCALATE path still needs the throwaway-session E2E
   from plan Task 2 before OI-011 can be closed.
4. **start-clearbot.cmd bug (Task 2b, unfixed):** its already-running probe
   matches ANY powershell whose command line mentions clearbot.ps1 — including
   a status probe — so it said "already running (1)" while 0 were running.
   Same self-match bug clearbot-status guards against (budget.mjs ~line 677).
   Log to the guards-repo ledger (create C:\code\guards\OPEN-ISSUES.md from the
   C:\code template if absent), or fix inline if trivial (exclude own pid tree
   / require -File token exactly like the status probe does).
5. **Task 3 code landed cycle 3** — `~\.claude\skills\goal\SKILL.md` written
   (log CONDITION via goal.mjs, no Stop hook ever) + AGENTS.md Goals section
   extended. **FIRST ACTION next session:** check this session's skill listing
   for `/goal` — if the user skill shows, mark Task 3 DONE; if the built-in
   wins, rename the dir to `acc-goal`, update the AGENTS.md sentence + add a
   ledger line (OI-008 evidence pattern).
6. Then Tasks 4..11 per plan. Kyle decisions locked: OI-011 full option, retire
   Careful, disable security-guidance hook. Deletions pre-approved: 10 *.bak*
   + runbox/acc-v1. Commit gates per batch: test list above green →
   /diff-review → /security-review → commit (branch master, Task 11 order:
   baseline acc-v2 commit first, then per-task fix commits).
7. User emphasis (Kyle, cycle 2 prompt): ACC must be able to PRESS keys live
   (Enter/Esc), not just buffer text — VERIFIED REAL this cycle: sendconsole
   injects true KEY_EVENT records via WriteConsoleInputW (Enter = VK_RETURN
   lines, Esc smoke-tested); it needs no window focus. Carry this assurance
   into the E2E evidence when closing OI-011.

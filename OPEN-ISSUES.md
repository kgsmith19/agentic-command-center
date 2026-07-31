# Open issues — guards

Standing ledger for this repo. Scope: the guard hook, engine, GUI, ACC hooks
(budget/goal/route/usage/statusline), watcher, runner. Cross-repo or harness-
wide items belong in `C:\code\OPEN-ISSUES.md`.

Append an entry whenever something is raised and not fixed. `/resolve-issues`
works this list to zero. Entry format:

```
## OI-001 Short title
- opened: 2026-07-31
- where: path/or/area
- what: the actual problem in one line, not the symptom
- why open: blocked-by X / out of scope then / needs a decision / deferred
- done when: the observable check that proves it is fixed
```

IDs are per-file and never reused. On resolution, delete the entry and add one
line under `## Resolved`.

---

## Open

## OI-001 start-clearbot.cmd "already running" probe matches itself
- opened: 2026-07-31 (found cycle 2 of goal g-20260731-134525-09wb)
- where: watcher/start-clearbot.cmd
- what: the already-running probe matches ANY powershell whose command line
  mentions clearbot.ps1 — including its own status probe — so it reported
  "already running (1)" while 0 instances were running and refused to start
  one. Same self-match class the clearbot-status check in budget.mjs (~line
  677) already guards against.
- why open: found mid-goal while landing OI-011a/b; logging was the assigned
  slice, the fix was not.
- done when: the probe requires the `-File …clearbot.ps1` token (or excludes
  its own pid tree) exactly like the status probe, and starting when none are
  running actually starts one.

## OI-002 Goal loop stalls when a goal session ends its turn UNDER hardK
- opened: 2026-07-31
- where: hooks/budget.mjs onStop + hooks/goal.mjs pending + watcher/clearbot.ps1
- what: the loop's only continuation trigger is an OVER-budget Stop (block →
  latch → clear request → clearbot). A goal session that voluntarily ends its
  turn under the ceiling gets allow() and nothing else — no clear request, no
  kick — and the goal sits dead until a human types. Observed live: cycle-2
  session 130aefc6 checkpointed ~10:26:54 under the then-150k ceiling and
  stalled 18 minutes (clearbot.log silent 10:25:18→10:45:13); it resumed only
  because Kyle's unrelated prompt triggered a route re-scope clear.
- why open: surfaced while root-causing the dials fix (cycle 3); the fix is a
  liveness rule in goal.mjs pending ("goal active + turn ended + no clear
  request pending → kickable after a short idle"), which is OI-011-adjacent
  design work, not a one-liner.
- done when: a throwaway-console E2E shows an active-goal session that ends
  its turn under hardK gets the resume constant typed (no /clear needed)
  within the kick cadence, and clearbot.log records why.

## OI-003 A clearbot-typed /cd does not take effect
- opened: 2026-07-31
- where: watcher/clearbot.ps1 (cd requests) / hooks/route.mjs
- what: two consecutive cd requests to `C:\code` were typed and replayed
  (clearbot.log 10:45:13 `CD 130aefc6 → C:\code clear=True`, 10:45:37
  `CD dde31bdb → C:\code clear=False`) yet the session's cwd stayed
  `C:\code\guards` — the next prompt fell back to the advisory line (the
  designed escape hatch, so no deny-loop, but the scope move itself failed
  twice). Suspect timing (typed while the fresh session was still starting)
  or /cd needing different input than a plain typed line.
- why open: found in the same cycle-3 timeline reconstruction; needs the
  throwaway-console injection rig to reproduce safely, per AGENTS.md.
- done when: a clearbot-typed /cd verifiably changes the session cwd in a
  throwaway console (route verdict matches cwd on the replayed prompt).

## OI-004 Local request/job files are an unauthenticated command channel
- opened: 2026-07-31 (pre-commit security review)
- where: watcher/clearbot.ps1 + runner/clear-requests/; runner/runner.mjs +
  runner/jobs/; watcher/sendconsole.ps1
- what: clearbot re-derives WHAT may be typed (routes byte-checked, replay
  re-vetted as printable single-line, constants otherwise) but never verifies
  WHO a request is for — `req.consolePid` is not cross-checked against the
  session's own `runner/state/<sid>.window` record, so any local writer
  (including agent Bash, the guard's documented ceiling) can aim `/clear`,
  `/cd <route>`, or a vetted single-line replay at ANY live console. Same
  class: runner.mjs spawns `claude` from job files; sendconsole.ps1 types
  whatever its caller passes (the closed set lives one layer up only); the
  escalation threshold trusts `req.hardK` from the request.
- why open: hardening. AGENTS.md is explicit that guards is a convention
  enforcer, not a security boundary, so nothing promised is broken — but the
  binding check is cheap and closes the cross-console case.
- done when: clearbot refuses (and logs) a request whose consolePid does not
  match the `<sid>.window` record; sendconsole itself rejects control chars
  and multi-line text; escalation reads hardK from policy.json, not the
  request.

## OI-005 Guard self-protection is off while the docs still claim it
- opened: 2026-07-31 (pre-commit security review)
- where: config.json `protected` vs AGENTS.md "Self-protection";
  clearbot.ps1 invariant-1b comment
- what: `C:/code/guards` was removed from the protected list (deliberate
  2026-07-30 unprotect so the ACC build-out could edit the repo;
  settings.json stays guarded), but AGENTS.md still documents repo writes as
  blocked, and clearbot's comment calls ROUTING.md "a table the guard
  protects" though `C:\code\ROUTING.md` was never in the protected list.
- why open: re-protecting mid-goal would block the remaining ACC work; when
  to flip it back is Kyle's call.
- done when: after the ACC goal closes, `C:/code/guards` is back in
  `protected` (ideally with `C:/code/ROUTING.md` added), or the AGENTS.md /
  clearbot wording is changed to match reality.

## Resolved

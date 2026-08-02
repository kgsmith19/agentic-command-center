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

## OI-001 stop-clearbot.cmd's kill query matches its own probe process
- opened: 2026-07-31 (re-scoped same day — see correction below)
- where: watcher/stop-clearbot.cmd
- what: the kill query is `CommandLine -like '*clearbot.ps1*'` with NO self
  exclusion, and the probing powershell's own command line contains that
  pattern (it is inside the Where-Object filter). So the script enumerates
  itself and calls `Stop-Process -Force` on its own pid; if its own entry
  comes first it dies before killing the real watcher, and Stop silently
  leaves clearbot running. The kill switch (`clearbot.stop`) is written
  first, so the failure is quiet rather than dangerous — but "Stop" not
  stopping is exactly the kind of thing the operator will not notice.
- correction: this entry originally named `start-clearbot.cmd`. Verified
  2026-07-31 by running it against one live instance: it requires the
  `-File …clearbot.ps1` token AND excludes `$PID`, and correctly reported
  "clearbot already running (1)". That half is FIXED; the stop script is
  where the self-match class still lives.
- why open: found mid-goal; logging was the assigned slice, the fix was not.
- done when: the stop query excludes its own pid (and requires the `-File`
  token) like the start probe and budget.mjs `clearbot-status` do, with a
  test that spawns a decoy process and proves only the decoy is killed.

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

## OI-006 Running budget.mjs SessionStart by hand hijacks the live goal binding
- opened: 2026-07-31 (hit while verifying the heartbeat work — self-inflicted,
  which is exactly why it is worth recording)
- where: hooks/budget.mjs onSessionStart → hooks/goal.mjs bindSession
- what: `bindSession` adopts an active goal by CONSOLE PID (that is the
  mechanism that survives a /clear, and it must stay). So piping a synthetic
  SessionStart payload into the live hook from a console that owns a goal
  rebinds that goal to whatever `session_id` the payload carried. Observed:
  a smoke test with `session_id:"hbtest"` moved the live goal's sessionId to
  "hbtest" and armed a kick, which clearbot then typed into the real console.
  The damage is silent: the real session's Stop hook can no longer find its
  own goal (`goalForSession` misses), so cycle logging and the new turn-end
  liveness stop working for that session.
- why open: the obvious guard (require a UUID-shaped session id) risks
  breaking legitimate post-clear adoption for a hazard only reachable by
  hand-running the hook, and AGENTS.md is explicit that guards is a
  convention enforcer, not a security boundary. Recovery is cheap and known:
  re-run SessionStart with the true session id, then `goal.mjs kicked <id>`.
- mitigation in place: every verification recipe in the plan (and AGENTS.md,
  Task 11) now sets `ACC_ROOT` to a throwaway tree, so a hand-run hook cannot
  reach live goal state.
- done when: either a binding guard exists that cannot break legitimate
  post-clear adoption, or hand-running hooks against live state is impossible
  by construction.

## OI-007 External (Scheduled Task) watcher supervision needs elevation
- opened: 2026-07-31
- where: watcher/watchdog/acc-watchdog-register-elevated.ps1
- what: the approved design called for a Scheduled Task restarting the
  clear-watcher at logon and every 2 minutes. `Register-ScheduledTask` fails
  unelevated on this machine with `PermissionDenied ... HRESULT 0x80070005`,
  and the ACC's own approval channel (runbox auto-approve) runs unelevated, so
  the task cannot be installed autonomously.
- what shipped instead, and why it is not a downgrade: both failure modes are
  covered without elevation. A CRASH is healed by
  `budget.mjs reviveClearbotIfDead` at every turn boundary — faster than a
  2-minute poll and precisely when the watcher is about to be needed (proven
  live: watcher killed, waited past the 30s staleness window, one Stop hook
  brought it back: 0 running → 1). A REBOOT is covered by the Startup-folder
  launcher (`acc-watchdog-startup.ps1`, installed 2026-07-31). The residue is
  a watcher dying while NO session runs and no logon happens — in which case
  nothing needs it until a session starts, and SessionStart starts it.
- why open: only Kyle can run the elevated script, and it is genuinely
  optional. Recorded so the deviation from the approved spec is visible
  rather than silently dropped.
- done when: either the task is registered from an elevated shell, or the
  spec is amended to make in-process revive + Startup launcher the design.

## OI-008 Two related runbox scripts can auto-run in an order that cancels them
- opened: 2026-07-31
- where: watcher/clearbot.ps1 Invoke-AutoApprove + the runbox
- what: auto-approve runs every pending script in directory order, so shipping
  an install script and its uninstall script together makes the net effect
  depend on that order. Observed: `acc-watchdog-unregister.ps1` ran first and
  reported "not registered", and had the order been reversed it would have
  silently undone the registration seconds after it happened.
- why open: the mechanism is working as designed (Kyle enabled auto-approve
  deliberately); this is about how scripts are AUTHORED. Convention fix for
  now: never leave an undo script in the runbox — undo scripts live tracked
  under `watcher/watchdog/` and are run deliberately.
- done when: either the convention is documented in AGENTS.md's runbox rules
  (a `# guards: manual` marker, or "no undo scripts in the runbox"), or
  auto-approve refuses a script whose name pairs with another pending one.

## OI-009 GUI process is a single point of failure for hosted sessions
- opened: 2026-07-31
- where: guards-gui.ps1 / gui/PtyHost.cs
- what: an ACC-hosted claude session lives on a ConPTY inside the GUI process,
  so a GUI crash or close kills every hosted session with it — no heartbeat,
  no reattach, no restart story. External console sessions are unaffected.
- why open: surfaced while shipping the embedded terminal; supervision is a
  separate design (relates OI-007's elevation question).
- done when: a GUI crash with a live hosted session either reattaches the
  session on GUI restart or is detected and surfaced within a minute, proven
  by killing the GUI mid-session in a test.

## OI-010 Pipe TEXT protocol is single-line; multi-line replay still falls back
- opened: 2026-07-31
- where: gui/PtyHost.cs ServePipe + watcher/clearbot.ps1 Send-Pipe (OI-004
  successor)
- what: the TEXT op carries one line and refuses control chars (< 0x20), so a
  multi-line replay payload cannot travel the pty path and drops to keystroke
  injection, which refuses it too (sendconsole multi-line refusal) — multi-line
  replays silently do not happen on any transport.
- why open: no current caller sends multi-line replays (clearbot types only
  closed-set constants); framing is protocol design work, not a patch.
- done when: a framed multi-line op exists with the same content policy, with a
  clearbot test proving a two-line replay lands via the pipe.

## OI-011 Re-verify guards self-protection coverage of guards/ paths
- opened: 2026-07-31
- where: hooks/engine.mjs guard config (relates OI-005: self-protection off,
  docs claim otherwise)
- what: this branch added gui/PtyHost.cs, gui/term.html, gui/vendor/,
  gui/ptyhost.e2e.ps1 and watcher/stubpipe.ps1 — whether the self-protection
  path list still covers what the docs claim it covers has not been re-checked
  since.
- why open: verification task surfaced by the embedded-terminal completion
  gate; OI-005 already tracks the underlying off-state.
- done when: the protected-path list is re-verified against the post-branch
  tree and either covers gui/ + watcher/ or the gap is ledgered precisely.

## OI-012 Stray console window at embedded launch not reproduced
- opened: 2026-07-31
- where: guards-gui.ps1 pty launch / hooks/budget.mjs ensureClearbot
- what: Kyle observed an extra command prompt opening as claude loaded into
  the Terminal tab (same launch that produced the binding MISMATCH). Both
  candidate spawn chains were instrumented and are clean: a sandboxed pty
  launch of real claude (gui/ptyhost.e2e.ps1) produced zero new windowed
  processes, and the full ensureClearbot chain (node detached spawn -> cmd /c
  start-clearbot.cmd -> Start-Process -WindowStyle Hidden) executed fully
  with zero windows. The MISMATCH root cause (dead transient-shell consolePid,
  fixed in de669dc) came from the same launch, so the stray window may have
  been a one-off of that broken state.
- why open: not reproducible after the fix; no evidence left to act on.
- done when: the Gate 4 manual launch (Kyle watching) shows zero extra
  console windows; if one appears, its parent chain names the spawner and
  this entry gets the real fix.

## OI-014 killTree's Windows branch (taskkill /t) is unverified
- opened: 2026-08-01
- where: runner/runner.mjs killTreeWin32
- what: runClaudeOnce's timeout used to orphan the real claude process on a
  hang — `child.kill()` under `shell:true` only signals the intermediate
  shell, not the process it wraps (verified: an 8s+ orphan on POSIX with the
  old code, ~10ms clean kill with the fix). The POSIX fix (process-group
  SIGTERM) is proven for real by runner.test.mjs on this sandbox. The
  Windows fix (`taskkill /pid <pid> /t /f`) is proven only structurally — an
  injected-exec test confirms runner.mjs ISSUES that exact command, but no
  POSIX sandbox can confirm taskkill actually kills the tree the way the
  POSIX test confirms process-group SIGTERM does.
- why open: needs a real Windows run to close, which this environment cannot
  produce.
- done when: Kyle (or a Windows CI run) reproduces the same proof the POSIX
  test already gives — spawn a real hung `claude -p` (or a stand-in), let
  runner.mjs's timeout fire, and confirm no orphaned claude.exe survives it.

## OI-015 guards-gui.ps1 interactive-lane wiring is unverified — this sandbox has no PowerShell at all
- opened: 2026-08-01
- where: guards-gui.ps1 (Invoke-LaneCli/Enter-InteractiveLane/Complete-
  InteractiveLaneHandoff/Exit-InteractiveLane, Start-PtySession, the legacy
  cmd /k branch of btnStartWork.Add_Click, Stop-PtySession)
- what: Kyle hit an API error INSIDE an interactive session even after the
  2026-08-01 lane.mjs hardening, because that first pass only ever wrapped
  AUTOMATED headless launches (runner.mjs, e2e) — guards-gui.ps1's Go button
  and Terminal-tab launches spawned `claude` with zero coordination, so an
  interactive launch could still stack concurrently with automation or
  another manual terminal. Fix: a second, isolated "interactive" lane
  category (hooks/lane.mjs, tested — 44/44 lane.test.mjs, including category
  isolation, full-jitter backoff, 529-specific base delay, and circuit-
  breaker trip/warn/reset, all green) plus a two-step reserve/reown/release
  handshake wired into guards-gui.ps1 around every claude spawn path.
  lane.mjs's own logic is proven; the PowerShell side is not — this sandbox
  has no `powershell`/`pwsh` binary at all (confirmed: pre-existing fast-tier
  tests that shell out to powershell fail with `spawnSync powershell ENOENT`,
  unrelated to this change), so nothing here could exercise Enter-
  InteractiveLane/Complete-InteractiveLaneHandoff/Exit-InteractiveLane, the
  busy-refusal MessageBox, or the Process.Exited release path against a real
  interpreter. Brace/paren/bracket counts were checked as a crude sanity
  pass only (braces and brackets balanced exactly; the file's pre-existing
  2-paren "imbalance" is unchanged from HEAD, i.e. literal parens inside
  comments/strings, not a real defect) — that is not a substitute for
  running it.
- why open: needs Kyle's own machine to run PowerShell at all.
- done when: a real smoke run on Windows — press Go once with automation
  idle (normal launch, no MessageBox), press Go a second time while the
  first is still running (must show the busy MessageBox and refuse, not
  stack a second claude), and confirm the interactive slot directory
  (`%TEMP%\acc-lane\interactive\slot-0`) is gone within a few seconds of
  closing the session either way (Stop button and natural exit both). Per
  this repo's own doctrine (ACC-HANDOFF.md "-SmokeTest cannot see layout" —
  same principle applies to any GUI behavior change): screenshot or narrate
  what actually happened, don't just eyeball the diff.
- partial evidence (2026-08-02): `powershell -File guards-gui.ps1 -SmokeTest`
  now runs clean end to end (`SMOKE OK ...`, exit 0) on real Windows for the
  first time — the form builds, every tab evaluates, nothing throws. That
  only proves the code loads; it does NOT exercise Enter-InteractiveLane/
  Complete-InteractiveLaneHandoff/Exit-InteractiveLane, the busy-refusal
  MessageBox, or the Process.Exited release path, all of which need the GUI
  actually visible and a real double-Go-press. Still open — needs Kyle.

## Resolved

## OI-016 [RESOLVED 2026-08-02] Kyle's own manual terminals (outside the GUI) remain completely unlaned
- opened: 2026-08-01, resolved: 2026-08-02
- decision: not shimming `claude` on PATH right now. A machine-wide shim is
  materially bigger and riskier than the interactive-lane wiring it would
  sit next to (real risk of breaking Kyle's own everyday `claude` calls if
  buggy) and deserves its own design pass, not a bolt-on. Revisit if manual-
  terminal/automation overlap is ever observed to cause a real incident.

## OI-017 [RESOLVED 2026-08-02] node's own coverage merge under-reports hooks/lane.mjs branches when the full fast tier runs together
- opened: 2026-08-02, resolved: 2026-08-02
- resolution: confirmed a genuine node.js v24.18.0 `--experimental-test-
  coverage` limitation (full bisection trail: not a race — reproduced
  identically under `--test-concurrency=1`; not PID-reuse collisions —
  checked, zero across 72 raw files; not env leakage — reproduced with a
  file that spawns zero subprocesses; IS tied to total file/process count
  per invocation, 4 of 10 files measures correctly, 5+ degrades hooks/
  lane.mjs specifically). An attempted from-scratch fix (batch the ten files,
  merge the lcov ourselves) made it WORSE — node's own per-process branch
  numbering isn't stable across separately compiled processes, so a key-based
  merge inflated lane.mjs's true 141 branches to 203 — and was reverted. True
  isolated coverage is 91.87%, comfortably clearing the 90% floor's own
  design intent. Per Kyle's decision, `policy.json tests.branchFloorOverrides`
  now carries a documented `"hooks/lane.mjs": 85` override (covgate.mjs's
  `floors(file)` reads it), citing this entry. `node hooks/covgate.mjs`
  passes clean.

## OI-013 [RESOLVED 2026-08-01] runner.mjs had no fast-tier suite; covgate held it at 0%
- opened: 2026-08-01, resolved: 2026-08-01
- where: runner/runner.mjs, hooks/covgate.mjs
- what: the coverage gate holds every CHANGED lib file to the policy floors
  (lines/funcs 100, branches 90), and the lane wiring touched runner.mjs —
  which predated the doctrine and had no unit suite, so covgate read 0%.
- resolution: runner/runner.test.mjs (39 tests) covers loadJob, boardState,
  runLoop's full decision table via an injected `run`, install/status, and a
  real spawn+stdin+lane+retry+kill integration path against a fake `claude`
  binary on PATH (POSIX shebang + Windows .cmd shim, one shared impl).
  `node hooks/covgate.mjs` now genuinely PASSES on all four files this slice
  changed (lane.mjs, testplan.mjs, covgate.mjs, runner.mjs — lines 100%,
  funcs 100%, branches 90.2-100%), verified 3x for flakiness. Building the
  suite surfaced two real bugs the coverage floor forced fixes for, not just
  tests: the orphan-on-timeout bug above (OI-014), and two structurally dead
  branches in retryTransport (a trailing `return` and a loop condition that
  could never evaluate false) — both removed rather than tested around,
  since a passing test for unreachable code proves nothing.

- 2026-07-31 pty-transport liveness must never be `\\.\pipe\` enumeration:
  `Get-TermPipe` (watcher/clearbot.ps1) gated transport choice on
  `[System.IO.Directory]::GetFiles('\\.\pipe\')` membership, which flickers
  false on a live, correctly-listening pipe (confirmed: a touched pipe
  toggled found/not-found every ~300ms with zero connections made) — this is
  what stalled last session's pty-transport work and made a real feature
  nondeterministically fall back to the keystroke path it exists to replace.
  Fixed by dropping the enumeration check; `Get-TermPipe` now only reads the
  window record, and Send-Pipe's own `Connect(2000)` + catch is the real
  liveness/fallback signal (already covered by the "dead pipe falls back"
  test). Root cause traced further to `BeginWaitForConnection` on a
  synchronous pipe handle — .NET's compat shim for that call periodically
  disconnects/reconnects internally; `watcher/stubpipe.ps1` (the test's pipe
  stub) used that shape and was rewritten to a plain blocking
  `WaitForConnection()`, matching `gui/PtyHost.cs ServePipe` exactly. Fast
  tier: 81/81 green (`node --test hooks/budget.test.mjs hooks/goal.test.mjs
  hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs
  hooks/clearbot.test.mjs`), pty tests specifically green across 3
  consecutive full-suite runs.

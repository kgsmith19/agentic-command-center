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
- why open: the fix has landed but is UNVERIFIED. Root cause identified
  2026-08-04: `Invoke-Cd`'s 1200ms settle lived inside the `$req.clear`
  branch, so a `clear=$false` request typed `/cd` with no delay at all — and
  `hooks/route.mjs` sets `clear = midSession`, which means a `clear=$false`
  request is BY DEFINITION a session's first scope, i.e. always the freshest
  possible REPL. "Typed into a session that was not listening yet" and "no
  settle" were therefore the same request every time. The settle now runs on
  both paths (no new constant, no new dial). Verification needs a real
  claude in a throwaway console, which is Kyle's to run, not the fast tier's.
- done when: a clearbot-typed /cd verifiably changes the session cwd in a
  throwaway console (route verdict matches cwd on the replayed prompt).
  `runbox/verify-oi003-cd.ps1` is that repro — run it via `/approve`, then
  again with `-Control` (types the identical /cd with no settle, reproducing
  the old behaviour). Fix run PASS + control run FAIL closes this. Both
  passing means the race did not reproduce on that machine and proves
  nothing either way; read the transcript the script prints.

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
- why open: BUILT 2026-08-04, awaiting its first green Windows run. The op is
  `TEXTB64 <base64>` (gui/PtyHost.cs `Handle`), sender is
  `Send-MultilineKeys` (watcher/clearbot.ps1). Root cause was worse than the
  content check the entry describes: the wire is line-based
  (`ReadLine`/`WriteLine`), so a raw newline would truncate the REQUEST, not
  just fail validation — hence base64 rather than a relaxed TEXT. Content
  policy is TEXT's with one exception, `\n` as the separator, which PtyHost
  converts to `\r` because a carriage return is what Enter transmits and what
  SUBMIT already writes. That also retired the entry's one open empirical
  question (does a bare `\n` submit on ConPTY?) rather than answering it: the
  console never receives an LF. No keystroke fallback, deliberately —
  sendconsole.ps1 refuses multi-line outright, so the caller gets ok=$false
  instead of a silent single-line approximation.
- done when: a framed multi-line op exists with the same content policy, with a
  clearbot test proving a two-line replay lands via the pipe.
  `gui/ptyhost.test.ps1` now carries that test (two-line TEXTB64 + SUBMIT
  against a real cmd.exe on a real ConPTY, asserting BOTH lines execute, plus
  refusals for bad base64 / `\r` / control chars / over-length). It is
  hermetic and free — no claude, no API — and CI's windows-latest job runs
  it. Close this when that job is green; nothing here can run PowerShell.
- what this widens, stated plainly (pre-commit security review 2026-08-04):
  before TEXTB64 one pipe write could type ONE line, and submitting it needed
  a separate SUBMIT op. A TEXTB64 write can now submit N lines by itself,
  because every `\n` becomes a real carriage return. It does not change WHO
  can write to the pipe — that channel is unchanged, still local, still
  unauthenticated, and still the class OI-004 left open — only how much one
  accepted write can do. The content policy is otherwise identical to TEXT
  (printable only, `\r` refused, 2100 chars), and the decoded-length cap is
  what bounds it. Worth re-reading if the pipe ever gains a remote or
  cross-user path, because that is the assumption this rests on.

## OI-011 Re-verify guards self-protection coverage of guards/ paths
- opened: 2026-07-31
- where: hooks/engine.mjs guard config (relates OI-005: self-protection off,
  docs claim otherwise)
- what: this branch added gui/PtyHost.cs, gui/term.html, gui/vendor/,
  gui/ptyhost.e2e.ps1 and watcher/stubpipe.ps1 plus many watcher/ system
  scripts (clearbot.ps1, launchers, watchdog/ integration). The full post-branch
  file list is: `gui/PtyHost.cs`, `gui/term.html`, `gui/vendor/`, `gui/*.ps1`
  (test/e2e), `watcher/clearbot.ps1`, `watcher/*.ps1` (screenshot, sendconsole,
  stubs), `watcher/*.cmd` (start/stop launchers), `watcher/watchdog/*.ps1`
  (system integration). All are strategic infrastructure and should be protected.
- why open: verification task surfaced by the embedded-terminal completion
  gate; OI-005 already tracks the underlying off-state (self-protection is
  currently disabled while ACC build-out continues).
- done when: `protected` list in config.json gains `C:/code/guards/gui/` and
  `C:/code/guards/watcher/` (or the full `C:/code/guards/` prefix), verified
  safe to re-enable once OI-005 re-protection happens, documented in AGENTS.md
  (done 2026-08-03).

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
- why open: the test gap is closed as of 2026-08-04 and now needs one green
  Windows CI run to confirm. `runner/runner.test.mjs`'s hung-run test had its
  `if (process.platform !== "win32")` guard removed, so the direct
  pid-liveness proof (`process.kill(pid, 0)`, which is a real liveness probe
  on Windows too) runs natively in CI's windows-latest job. The same change
  turned the proof's single 300ms settle into a bounded poll: termination is
  asynchronous on both platforms and `taskkill /t` walks a tree, so a fixed
  sleep would have handed CI a flake instead of a proof. (Verified while
  making the change: that 300ms genuinely raced the reap under load on Linux,
  failing while `ps` showed no surviving process at all. 3/3 green after.)
- done when: Kyle (or a Windows CI run) reproduces the same proof the POSIX
  test already gives — spawn a real hung `claude -p` (or a stand-in), let
  runner.mjs's timeout fire, and confirm no orphaned claude.exe survives it.
  Close this when CI's windows-latest `npm run test:windows` step is green
  with the guard gone.

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

## OI-022 [RESOLVED 2026-08-04] node's coverage reports ONE module instance per file, so a re-importing suite's number is arbitrary
- opened: 2026-08-04, resolved: 2026-08-04 (found while clearing covgate for OI-006)
- where: hooks/goal.mjs store resolution, hooks/goal.test.mjs, hooks/covgate.mjs
- what: `hooks/goal.mjs` resolved its store path at MODULE LOAD, so
  goal.test.mjs had to re-import it under a fresh `?t=N` URL for every test to
  point it at a sandbox. node's `--experimental-test-coverage` does not union
  coverage across those instances — it reports one of them — so goal.mjs's
  number was read off whichever instance happened to load last. The gate was
  not merely pessimistic, it was ARBITRARY: it reported `createGoal` and
  `bindSession` as never executed in a run that called both dozens of times.
- evidence (isolated, non-root, node v22.22.2): a probe importing goal.mjs 1,
  5 and 20 times where every instance did identical work reported an identical
  66.08% — first suggesting the merge was fine. The decisive probe made the
  FIRST instance do heavy work and the LAST do almost none: coverage collapsed
  to 36.43%, with createGoal (129-163) and bindSession (180-204) listed as
  uncovered. Nothing about the executed code changed, only which instance
  loaded last. Adding 21 genuine tests to goal.test.mjs had, for the same
  reason, DROPPED the reported number from 65.3% to 50.5%.
- resolution: goal.mjs resolves `GOALS`/`ROOT` per call instead of at load, so
  the whole suite shares one instance and the measurement means something.
  goal.mjs went 65.3% → **lines 100% / funcs 100% / branches 94.5%**, clearing
  the 100/100/90 floors — most of that is genuinely new tests (the CLI
  dispatcher, appendCycle/logTail/setStatus, the fail-open paths, consoleAlive's
  EPERM branch), not a measurement artifact, but the artifact is what had made
  the gap invisible. Related to but distinct from OI-017: that one is node
  under-reporting BRANCHES as the file count rises, this one is node discarding
  whole instances.
- the rule this leaves behind: a fast-tier suite must not re-import its subject
  per test. If a module needs redirecting, it resolves that per call. A suite
  that cachebusts its import is not measuring itself. (`hooks/budget.test.mjs`
  still re-imports goal.mjs twice; harmless, because budget.test.mjs gates
  budget.mjs, which it drives as a subprocess.)

## OI-006 [RESOLVED 2026-08-04] Running budget.mjs SessionStart by hand hijacks the live goal binding
- opened: 2026-07-31, resolved: 2026-08-04
- resolution: `bindSession` (hooks/goal.mjs) now only adopts a UUID-shaped
  `sessionId`. Adoption by CONSOLE PID is untouched — it is what survives a
  /clear and had to stay — so the guard is not "stop adopting": a non-UUID id
  is treated exactly as if none were passed. The goal is still found, its
  consolePid/cwd still refresh, and `sessionId`/`needsKick`/`boundAt` are left
  alone, so the hand-run payload cannot arm a kick for clearbot to type. This
  satisfies the entry's own first option (a guard that cannot break legitimate
  post-clear adoption), and the feared cost does not exist: a real Claude Code
  session id is always a UUID.
- what the fix surfaced: several existing tests had been binding goals with
  ids like `"s1"` and `"s-goal"` — i.e. silently exercising a path production
  never takes. Those are now real UUID shapes in both hooks/goal.test.mjs and
  hooks/budget.test.mjs, with a note saying why, so the suite tests the rule
  it ships. Two regression tests added: the `"hbtest"` hijack is refused (goal
  still found, sessionId/needsKick/boundAt unchanged, and `goalForSession`
  still resolves for the REAL session), and an uppercase UUID still adopts and
  still arms its kick. Verified: 22/22 hooks/goal.test.mjs, 16/16
  hooks/budget.test.mjs.

## OI-008 [RESOLVED 2026-08-04] Two related runbox scripts can auto-run in an order that cancels them
- opened: 2026-07-31, resolved: 2026-08-04 (ledger-only — the fix already
  shipped in 2b09f24 "docs: fix OI-005/OI-008/OI-011")
- resolution: this entry's own first option was already satisfied and the
  ledger just never caught up. AGENTS.md's runbox rules carry it verbatim:
  "**Never leave undo/uninstall scripts in the runbox** (guards OI-008). Undo
  scripts live tracked in their own directory (e.g. `watcher/watchdog/`) and
  are run deliberately. Auto-approve's directory order guarantee can cancel
  conflicting scripts (`install` + `uninstall` in the same folder), making the
  net effect undefined." Re-read and confirmed present before closing. Third
  time a resolved item has sat under `## Open` (see OI-001, OI-002) — the
  ledger needs cross-checking against git log, not append-only trust.

## OI-018 [RESOLVED 2026-08-04] lane.test.mjs's full-jitter test carries a ~6% false-failure rate by design
- opened: 2026-08-04, resolved: 2026-08-04
- where: hooks/lane.test.mjs, "retry backoff is full jitter"
- what: the test drew 4 backoff samples and asserted at least one landed under
  400ms — with base=cap=1000ms that is a coin flip per sample, and the test's
  own comment did the math and accepted it: "(0.5)^4 ~= 6%". A documented
  flake budget is still a flake, and it fired for real twice.
- resolution: same assertion, same thing proven (nobody can revert to equal
  jitter unnoticed), 20 draws instead of 4 — (0.5)^20 ~= 0.0001%. The sample
  count is now asserted too, so a future edit that quietly shrinks it fails
  loudly rather than restoring the flake. No production code touched;
  lane.mjs's jitter formula is untouched. Verified green.

## OI-021 [RESOLVED 2026-08-04] No explicit handling for upstream API-overload / silent harness hangs
- opened: 2026-08-04, resolved: 2026-08-04
- where: runner/runner.mjs runClaudeOnce, AGENTS.md
- what: if the Anthropic API is overloaded and the CLI wedges without ever
  printing an error, nothing in the ACC is watching for that specific failure.
- resolution: resolves via the entry's "or" clause — documented, no new code,
  because the guarantee already holds by construction. `runClaudeOnce` arms a
  wall-clock `setTimeout` at spawn and calls `killTree` when it fires; that
  decision never reads stdout, stderr, or an exit code, so a silently-wedged
  CLI is not a case the supervisor has to RECOGNISE — it is indistinguishable
  from any other hang and bounded by the identical ceiling. `retryTransport`
  is the deliberate complement, covering failures the harness DID report and
  classified as transport. AGENTS.md's launch-lane section now states this
  explicitly ("A hang is bounded whether or not the harness ever says
  anything") and names the existing proof: runner.test.mjs's "a hung run is
  killed PROMPTLY at its timeout", whose fake claude blocks for 15s and
  reports nothing at all — structurally the silent-overload case, run every
  fast tier.

## OI-001 [RESOLVED 2026-08-03] stop-clearbot.cmd's kill query matches its own probe process
- opened: 2026-07-31, resolved: 416e9ab "fix: stop-clearbot kill query
  excludes its own probe process (guards OI-001)"
- resolution: `watcher/stop-clearbot.cmd`'s kill query now excludes `$PID`
  and requires the `-File …clearbot.ps1` token, matching the start probe and
  `budget.mjs clearbot-status`. This entry sat open under `## Open` well
  after the fix landed — found and corrected 2026-08-03 during a docs pass;
  a reminder the ledger needs occasional cross-checking against git log, not
  just append-only trust.

## OI-002 [RESOLVED 2026-08-03] Goal loop stalls when a goal session ends its turn UNDER hardK
- opened: 2026-07-31, resolved: 0fa3407 "feat: under-budget turn ends re-arm
  the goal kick, with a human back-off (guards OI-002)" + e796130 "feat: Stop
  hook reports under-budget turn ends to the goal store"
- resolution: `hooks/goal.mjs`'s `recordTurnEnd`/`pendingKicks` implement
  exactly the liveness rule this entry called for — an under-budget turn end
  re-arms the kick, gated by `kickSettleSeconds` and `humanHoldMinutes` so it
  stays quiet during an active conversation and self-heals once Kyle walks
  away. Covered by `hooks/goal.test.mjs`. Same stale-ledger note as OI-001.

## OI-004 [RESOLVED 2026-08-03] Local request/job files are an unauthenticated command channel
- opened: 2026-07-31, resolved: 3fc2ec4 "fix: verify request bindings,
  refuse unsafe text, source hardK from policy (guards OI-004)"
- resolution: `watcher/clearbot.ps1`'s `Test-Binding` now refuses (and logs)
  a request whose `consolePid` doesn't match the session's own
  `<sid>.window` record, on both the cd and clear paths; escalation reads
  `hardK` from `policy.json` rather than trusting the request. Covered by
  `hooks/clearbot.test.mjs`. **Not fully closed in spirit** — the underlying
  request/window files are still local, unsigned, and agent-writable, so a
  local writer can still forge a matching pair (see
  `docs/2026-08-03-acc-adversarial-review.md` §2.5); the specific
  cross-console mistargeting this entry described is fixed, the class it's
  drawn from is not.

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

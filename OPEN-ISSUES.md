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

## OI-018 lane.test.mjs full-jitter test is flaky under real randomness
- opened: 2026-08-03
- where: hooks/lane.test.mjs:370 "retry backoff is full jitter — delay can
  land anywhere from 0 up to the exponential ceiling, not just the top half"
- what: asserts at least one sampled delay lands under 400ms across a small
  fixed number of draws from `Math.random()`-based full jitter; occasionally
  every draw lands high by chance (observed: 709,854,575,924,494ms all >=
  400) and the test fails with no code change. Found running the fast tier
  while gating unrelated kernel/ work (T5-T8 of the ACC kernel plan);
  confirmed flaky by rerunning `node --test hooks/lane.test.mjs` 3x (1 fail,
  2 pass) with lane.mjs/lane.test.mjs untouched.
- why open: out of scope for the kernel effort; needs either more samples,
  a seeded RNG seam, or a statistical (not single-draw) assertion in
  lane.test.mjs itself.
- done when: the test passes deterministically across many repeated runs
  (e.g. 50x `node --test hooks/lane.test.mjs` with zero flakes), or the
  assertion is restructured to not depend on a single low-probability draw.

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

## OI-019 Kernel test suite meets coverage floors but not the scenario breadth Kyle wants before trusting it
- opened: 2026-08-03
- where: kernel/*.test.mjs (all suites through Task 16; applies to every
  remaining kernel task, T17-T22)
- what: covgate's 100/100/90 floors prove every line/branch of a CHANGED file
  executes at least once — they do not prove the suite covers the scenario
  space a reliability kernel needs. Non-standard inputs, rare/bizarre timing,
  overlapping/concurrent runs, performance under load, and combinations of
  failures across the launch -> guard -> verify -> ledger chain are largely
  untested today; only the failure modes each task's plan text happened to
  enumerate are covered. Kyle, verbatim intent: "so many individual units...
  so many connective parts... the flow can change or be unpredictable... we
  must lock it and harden it as much as possible... we don't want to trick
  the tests, we truly want to be objective."
- why open: raised as a standing concern for the rest of the kernel effort
  (T17-T22), not a defect in any one file today; needs a deliberate scenario-
  enumeration pass (or a new task inserted into the plan) rather than being
  folded piecemeal into whichever task happens to touch a given module.
- done when: for each kernel module, a documented pass has enumerated
  standard / non-standard / edge / rare / error / fault-tolerance scenarios
  (beyond AC-ID traceability) and either added a real test or recorded an
  explicit, ledgered reason none is needed. No test may be added or loosened
  just to turn red green — every test must be able to fail against a genuine
  regression, never tuned to the current implementation's behavior.

## OI-020 No Playwright-driven remote e2e verifies the actual kernel GUI (screen, flow, layout)
- opened: 2026-08-03
- where: guards-gui.ps1 kernel settings tab (T21, not yet built); relates
  OI-015 (interactive-lane wiring is PowerShell-only smoke-tested)
- what: every GUI proof in this repo today is either a PowerShell
  `-SmokeTest` (proves the form constructs, not what renders) or a human
  screenshot/narration — ACC-HANDOFF.md's own stated limit is "-SmokeTest
  cannot see layout." Kyle wants a real Playwright e2e, run in a remote
  environment, that drives the kernel GUI and asserts on what is genuinely
  on screen: the settings tab's fields, a live policy edit's visible effect,
  the flow of starting/stopping a run.
- why open: T21 (GUI kernel settings tab) has not been built yet, so this is
  a requirement for that task's test plan, not a fix against existing code.
  Also needs a design decision this codebase hasn't made: what "remote
  environment" means for a WinForms desktop app — Playwright normally
  targets browser/web UIs, so driving a WinForms PTY-hosted GUI needs its
  own bridge (headless Windows CI? a screenshot/pixel harness?) that does
  not exist yet.
- done when: T21 (or a follow-up task) ships a Playwright-based e2e that
  runs against a real rendered kernel settings tab in a remote/CI
  environment and asserts on visible field state plus at least one
  live-edit-applies-without-restart flow, replacing screenshot-only proof.

## OI-021 Kernel has no explicit handling for upstream API-overload errors, including failures in the harness's own error reporting
- opened: 2026-08-03
- where: kernel/adapters/claude-code.mjs (identity/startTask), hooks/lane.mjs
  (529-specific backoff exists per OI-017 but is proven only for automated
  runner.mjs launches, not yet against kernel/run.mjs's own launch path),
  kernel/run.mjs failClosed paths
- what: Kyle, verbatim: "the API itself can be overloaded and Claude Code
  does not see those as [errors] — that would turn his connection off from
  reading the error... we must even handle those ULTRA META errors." I.e. a
  529/rate-limit/overload condition from Anthropic's API may not surface as
  a clean, catchable error from the `claude` CLI subprocess at all — the
  harness's OWN error-reporting path can itself fail silently, a level
  beyond "startTask threw" (already covered by Task 16's failed-to-start
  test). Nothing in the kernel today distinguishes "the harness process
  exited/errored cleanly" from "the harness process is hung or silently
  degraded because the upstream API is overloaded and the CLI never told
  anyone."
- why open: needs research into what a real API-overload/degraded-CLI
  failure looks like from the outside (stdout/stderr shape, hang vs clean
  exit, exit code) before a test can be written against it — currently
  unknown and not yet reproducible on demand. Intersects T17/T18 (ceilings)
  and the proof tier (T19), which spends real tokens and is the one place
  concurrent real launches are most likely to hit this for real.
- done when: either a real or faithfully-simulated overload scenario is
  captured (e.g. a fake adapter mimicking a hung/silently-failed CLI) with a
  kernel-level test proving the run still fails closed within its
  wall-clock ceiling rather than hanging forever, or the mitigating design
  (e.g. `ttlMs` already bounds this — confirm and document) is written down
  and cited here.

## OI-022 GUI frontend for T21: WinForms vs web is an open architecture decision, not yet made
- opened: 2026-08-03
- where: guards-gui.ps1, gui/PtyHost.cs, gui/term.html, gui/vendor (T21, not
  yet built); relates OI-009 (GUI process is a SPOF for hosted sessions),
  OI-020 (no Playwright e2e for the kernel GUI)
- what: discussed switching T21's kernel settings tab (and possibly the
  whole GUI) from WinForms to a web frontend, dev time not a factor. Upsides
  identified: (1) decouples session hosting from the viewer, which would
  structurally fix OI-009 — a persistent backend owns the ConPTY, a browser
  tab is disposable/reconnectable, unlike today where closing the GUI process
  kills every hosted session; (2) remote/multi-device access to the ledger,
  decision log, and autonomy tightening, matching the kernel's already-
  headless (`claude -p`) operating model; (3) much cheaper live/searchable
  views (WebSocket/SSE push) than WinForms' manual redraw model.
  Code-reuse question answered by direct inspection (2026-08-03): the split is
  NOT even close to 50/50. `gui/PtyHost.cs` already serves a plain named-pipe
  protocol (TEXT/SUBMIT/ESC in, OK/FAIL + output out) with zero UI-class
  dependency — any client, web or WinForms, can drive it as-is over the same
  pipe (or a thin WebSocket bridge in front of it). `gui/term.html` already
  renders via xterm.js and talks to PtyHost only through structured JSON
  messages over `window.chrome.webview.postMessage` (WebView2) — swapping that
  transport for a plain WebSocket/fetch call is a small, contained change; the
  terminal UI itself is already web technology. `guards-gui.ps1`'s own logic
  is ~80% backend glue (hooks/kernel module calls, lane management, policy/
  ledger reads) with no WinForms dependency at all, and only ~15-20% actual
  WinForms construction (Form/Tab/Button/MessageBox wiring). Net: the
  overwhelming majority of the code carries over untouched or near-untouched;
  what's WinForms-specific is a small, well-bounded slice.
- why open: this is a real architecture decision for Kyle to make, not
  something to decide mid-task. The main tradeoff against switching: it adds
  a network-facing surface (even localhost-only) to a project whose whole
  ethos is local, deny-by-default enforcement — a philosophical tension, not
  just an engineering one. OI-010's noted gap (multi-line pipe payloads fall
  back to keystroke injection) is fine for today's single-line use but would
  need closing for a richer web client.
- done when: Kyle decides WinForms-vs-web for T21 (or explicitly defers the
  decision past T21), and that decision is reflected in the T21 task text
  before it's executed.

## OI-023 claude-code adapter spawns with shell:true and an args array — Node's own runtime now flags this as unescaped, not just concatenated
- opened: 2026-08-03
- where: kernel/adapters/claude-code.mjs `identity()` (line ~24) and
  `startTask()` (line ~62), both `execFileSync("claude", [...], {shell:true})`
  / `spawnFn("claude", buildArgs(...), {shell:true})`; found during T22's
  full-branch security review, visible live in this session's own
  `kernel.e2e.mjs` runs: `(node:PID) [DEP0190] DeprecationWarning: Passing
  args to a child process with shell option true can lead to security
  vulnerabilities, as the arguments are not escaped, only concatenated.`
- what: Node's own child_process now warns that `shell:true` + an args array
  does NOT safely escape each element — it concatenates them into one command
  line. `buildArgs()`'s current inputs are all kernel-controlled today
  (`settingsPath` = a generated staging path already manually quoted,
  `sessionId` = a `randomUUID()`, `tools` = a hardcoded literal vocabulary
  from `contract.mjs`'s `toolsFor()`, never contract-supplied free text), so
  there is no exploitable injection through this call site RIGHT NOW — but
  the pattern itself is exactly the class of finding a security review must
  flag, and it is inherited from `runner/runner.mjs`'s pre-existing use of
  the same idiom (`.cmd` shims cannot be spawned without `shell:true` on
  Windows), so it is not new to this effort, just newly re-surfaced by Node
  version drift.
- why open: a real fix needs research into safely invoking a Windows `.cmd`
  shim without `shell:true` (e.g. resolving `claude.cmd`'s real target and
  spawning that directly, or hand-verifying Node's actual Windows quoting
  behavior well enough to trust it), which is a design decision, not a
  same-pass fix — and touching `runner/runner.mjs` too would widen this past
  the kernel effort's own scope fence.
- done when: either a spawn path that does not trigger DEP0190 is adopted
  for both `runner/runner.mjs` and `kernel/adapters/claude-code.mjs`, or a
  written decision records why `shell:true` remains safe here (inputs are
  provably never attacker-controlled) and the warning is suppressed
  deliberately rather than left as ambient noise.

## OI-024 The guardhook's per-fire tool-call ceiling never reflects autonomy tightening — only the periodic supervisor check does
- opened: 2026-08-03
- where: kernel/guardhook.mjs line ~84-86 (`ceiling = contract?.budget?.toolCalls
  ?? policy.budget.toolCalls`) vs kernel/run.mjs's supervisor timer (Task 18),
  which correctly uses `effectiveCeilings(contract, policy, readAutonomy())`;
  found during T22's full-branch security/lean review.
- what: when autonomy has tightened ceilings after a run of failures (T17),
  `kernel/run.mjs`'s periodic check enforces the SHRUNK `toolCalls` number
  (e.g. 100 instead of 200 at factor 0.5) — but `kernel/guardhook.mjs`, which
  fires on every single tool call and is the faster of the two enforcement
  points, still computes its own hard-stop ceiling from the RAW contract or
  policy default, never the tightened value. A tightened run can therefore
  still make up to the FULL untightened number of tool calls before the
  supervisor's next tick (default 60s) notices and aborts it — the guardhook
  never bypasses the deny-by-default boundary itself (writeRoots/readRoots/
  bashPatterns/etc. are unaffected), but the tightening feature's toolCalls
  dimension is enforced with tick-interval latency rather than immediately,
  which the traceability table's AC-B1/AC-B2 language does not call out as
  an accepted gap.
- why open: fixing it means guardhook.mjs importing kernel/autonomy.mjs and
  computing effectiveCeilings() on every fire (autonomy state is a small
  JSON file, cheap to re-read) — a real code change to an already
  checkpointed (R4) file, needing its own new test in guardhook.test.mjs,
  which is a decision about whether that tighter latency actually matters in
  practice (the wall-clock and stall dimensions are unaffected; only
  toolCalls sees the gap) rather than something to slip in unreviewed at the
  very end of the plan.
- done when: either guardhook.mjs reads the live autonomy-adjusted ceiling
  for toolCalls (with a guardhook.test.mjs case proving a tightened contract
  is denied at the SHRUNK count, not the raw one), or this latency is
  written down as an accepted tradeoff (the supervisor's checkpointMin/tick
  interval is the real enforcement point for tightening, guardhook's ceiling
  is a secondary hard stop only).

## OI-025 e2e/loop.e2e.mjs (5 scenarios) was not re-run as part of T22's final verification sweep
- opened: 2026-08-03
- where: plan `docs/superpowers/plans/2026-08-03-acc-kernel-plan.md` Task 22
  Step 5, final bullet ("`node e2e/loop.e2e.mjs` -> scenarios 1-5 still PASS,
  proves the kernel did not disturb the goal loop").
- what: Kyle explicitly chose to skip this run for this pass (real tokens,
  ~15-20+ minutes) rather than run it during T22. Nothing in this kernel
  effort touches the goal-loop files that suite covers (`hooks/goal.mjs`,
  `hooks/budget.mjs`, `watcher/clearbot.ps1`, `gui/ptyhost.e2e.ps1`) — the
  kernel lives entirely under `kernel/` plus additive changes to
  `hooks/covgate.mjs`, `package.json`, `.github/workflows/ci.yml`,
  `guards-gui.ps1`, and `policy.json`'s new `kernel` block — so no code path
  this suite exercises changed. Risk is judged low, but not verified live.
- why open: needs the 15-20+ minute real-token run Kyle deferred; a decision
  only he can make on timing, not a defect to fix.
- done when: `node e2e/loop.e2e.mjs` is run once against this branch (or
  after merge) and scenarios 1-5 confirmed PASS, or a diff-only argument
  (nothing touched that this suite covers) is accepted as sufficient instead.

## OI-026 "goal" terminology collides with the popular Claude Code Goal plugin
- opened: 2026-08-03
- where: `hooks/goal.mjs`, `/goal` skill, `[ACC GOAL g-...]` SessionStart
  injection, AGENTS.md "Goals" section, this repo's docs/specs generally
- what: ACC's "goal" is a persistent working-condition store that survives
  `/clear` and drives the goal loop (bind a condition to a session, resurrect
  it across clears/resumes). There is a separately popular, differently-
  scoped Claude Code plugin also called "Goal" (or similarly named). Same
  word, different mechanism, different owner — raised while running the
  `/goal` skill on a session that turned out to have no ACC goal bound to it,
  which surfaced the naming ambiguity directly (see chat: 2026-08-03,
  "concurrent claude.exe cap" brainstorming session).
- why open: needs a real naming/process design pass (what ACC's concept
  should be called instead, whether to rename the skill/hook/CLI verbs/
  policy keys, migration cost for the existing goal store on disk) — Kyle
  asked to document now and dig into the actual rename later, not decide it
  inline mid-unrelated-task.
- done when: a decision is made and recorded (rename ACC's concept to a
  distinct term, or some other disambiguation) and, if renamed, `hooks/
  goal.mjs`, the `/goal` skill, the SessionStart injection format, and
  AGENTS.md are updated consistently with no stale references to the old
  name left in code or docs.

## Resolved

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

## OI-016 [SUPERSEDED 2026-08-03] Kyle's own manual terminals (outside the GUI) remain completely unlaned
- opened: 2026-08-01, resolved: 2026-08-02, superseded: 2026-08-03
- original decision: not shimming `claude` on PATH right now. A machine-wide
  shim is materially bigger and riskier than the interactive-lane wiring it
  would sit next to (real risk of breaking Kyle's own everyday `claude` calls
  if buggy) and deserves its own design pass, not a bolt-on. Revisit if
  manual-terminal/automation overlap is ever observed to cause a real
  incident.
- what changed: the revisit trigger fired. `node e2e/loop.e2e.mjs` (real
  tokens) failed 4/5 scenarios on timeouts while `tasklist` showed 9
  concurrent `claude.exe` processes at once — unrelated manual/automation
  sessions overlapping exactly as this entry warned. Ran the deferred design
  pass via the brainstorming skill; landed on a machine-wide `lane.total`
  cap (default 3) enforced by a fail-open PATH shim (`shim/claude.cmd` ->
  `hooks/lane.mjs gate`, falls through to the real exe on any gate error,
  only an explicit exit 42 refuses) plus a standalone alert-only watcher
  (`watcher/claude-cap-watch.ps1`) that flags both over-cap breaches and a
  silently-dropped shim. Full design:
  `docs/superpowers/specs/2026-08-03-claude-launch-cap-design.md`.
- status: design approved 2026-08-03; implementation tracked via that spec's
  plan, not this entry. Re-open a fresh OI if the shipped gate itself proves
  insufficient (e.g. a launch vector it doesn't cover is found).

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

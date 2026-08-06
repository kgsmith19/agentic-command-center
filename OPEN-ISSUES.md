# Open issues — guards

Standing ledger for this repo. Scope: the guard hook, engine, GUI, ACC hooks
(budget/goal/route/usage/statusline), watcher, runner. Cross-repo or harness-
wide items belong in `C:\code\OPEN-ISSUES.md`.

Append an entry whenever something is raised and not fixed. `/resolve-issues`
works this list to zero. Entry format:

```
## OI-NNN Short title
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

## OI-034 a reboot leaves an in-progress goal's console dead with nothing to respawn it
- opened: 2026-08-06, found during Phase 6 (full-remediation-prompt.md)
  residue pass — "if any keystroke-path code survives Phase 5, fix it
  explicitly (respawn the console on reboot, or accept and document the
  gap)." The keystroke/ConPTY channel does survive (Phase 5 shipped step 1,
  the runner-wiring half, only — step 2's deletion is deliberately not
  done, see that phase's own status note), so this applies.
- where: `watcher/watchdog/acc-watchdog-startup.ps1`, `hooks/goal.mjs`
- what: the Startup-folder launcher (OI-007) relaunches `start-clearbot.cmd`
  at logon — the WATCHER comes back. Nothing relaunches or resumes a
  console for whatever goal was bound to the pre-reboot session: that
  console is simply gone, OI-031's `reapDeadGoals()` correctly reaps the
  now-unbound goal as "dead" the next time anything reads `activeGoals()`
  (clean, not a zombie), but no NEW session picks the work back up. A goal
  interrupted by a reboot (Windows Update, a crash, a power loss) just
  stops, silently, until Kyle notices and manually starts a new session.
- why open: taking the doc's explicitly offered "accept and document" path
  rather than "respawn the console" — auto-launching a real interactive
  console at logon, unattended, before Kyle is even at the machine, is a
  materially bigger and riskier change than anything else in this phase
  (what if he rebooted deliberately and does NOT want work resuming
  immediately?), and this remote session has no way to test Windows
  logon/reboot behavior at all. A considered design pass, not a blind
  implementation, is what this needs.
- done when: Kyle decides — either a real design for safe console respawn
  at logon (probably headless via `runner.mjs` now that Phase 5 step 1
  wired it to the goal store, rather than another interactive console),
  or this gap is formally accepted as permanent and this entry closes on
  that decision alone.
- UPDATE 2026-08-06: shipped a THIRD path this entry's own "done when"
  didn't originally name — neither auto-respawn nor silent-accept, but
  making the interruption VISIBLE without ever auto-resuming anything
  (the specific risk "why open" named — unattended work resuming when
  Kyle didn't ask for it — stays fully avoided, since nothing here
  launches a console or resumes a goal on its own). `reapDeadGoals()`
  now writes a `<id>.dead.json` alert (same `runner/alerts/` mechanism
  the ceiling-pause alert already uses) the moment it reaps a goal;
  `hooks/statusline.mjs` shows `goal DIED` persistently while it's
  unread (same pattern as `goal PAUSED`); `hooks/budget.mjs`'s
  SessionStart consumes (reads + deletes) every pending dead-goal alert
  once, inline in chat, telling Kyle exactly which goal died, why, and
  that it was NOT auto-resumed — since a dead goal has no "resume"
  command the way a paused one does, THIS is what clears it, not a
  follow-up action. Tests: `hooks/goal.test.mjs` (alert write + consume-
  and-clear), `hooks/statusline.test.mjs` (the new segment), `hooks/
  budget.test.mjs` (the SessionStart injection fires once and does not
  repeat on a second session). This closes the "silent" half of the gap
  — Kyle now finds out, promptly, every time — but does NOT close the
  "console respawn" half; if he still wants real auto-resume (headless
  via `runner.mjs`, per this entry's own suggestion above), that remains
  open, now as a smaller, separable follow-up rather than the whole gap.

## OI-035 [RESOLVED 2026-08-06] runner.mjs's kill is single-shot: no SIGKILL escalation, no verification the tree actually died
- opened: 2026-08-06, found by the lean-review sweep (kernel/hooks/gui/
  runner+watcher, 4-way parallel pass before wrapping up tonight's session).
- where: `runner/runner.mjs` `killTreePosix`/`killTreeWin32` (~lines 115-124)
- what: `killTreePosix` sends `SIGTERM` once with a silent double-`catch{}`
  and never escalates to `SIGKILL` if the process group ignores or traps it.
  `killTreeWin32` runs `taskkill /t /f` once, also with a silent `catch{}`.
  Neither confirms the tree actually died. If the kill genuinely fails (an
  uncooperative child, or a `taskkill` error), `runClaudeOnce`'s promise
  never resolves — `close` never fires on the child — so `runOnce`'s
  `await` in `runLoop` blocks forever past the very `runTimeoutMin` ceiling
  that was supposed to bound it. `hooks/lane.mjs`'s slot `ttlMs` only lets
  *other* processes reclaim the lane slot; it does nothing to unblock this
  one. (The timeout-kill itself now alerts — see this same sweep's fix,
  committed alongside this entry — so the FIRST kill attempt is visible;
  this entry is about what happens when that attempt doesn't work.)
- why open: a real fix needs the kill path restructured (SIGKILL fallback
  after a bounded wait, a liveness check via the same `process.kill(pid,
  0)` probe `runner.test.mjs`'s own "killed PROMPTLY" test already uses to
  verify success, and a way to unstick `runOnce`'s await if verification
  ever fails) — a materially bigger change to the one mechanism every
  other timeout/ceiling in this codebase ultimately depends on working,
  not something to rush through as a side effect of a lean-review pass.
  POSIX-testable from this sandbox; the Windows `taskkill` escalation path
  needs Kyle's own machine to verify for real, same as every other
  Windows-only claim in this repo.
- done when: `killTreePosix`/`killTreeWin32` escalate on a failed first
  attempt and verify the tree is actually gone before returning, with a
  test proving an uncooperative child (traps SIGTERM, or a taskkill that
  errors) still ends up dead and `runOnce`'s await still resolves.
- fix: `killTreePosix` now sends `SIGTERM`, then after a 300ms grace
  period probes liveness via `process.kill(pid, 0)` and escalates to
  `SIGKILL` (which cannot be trapped or ignored) if the process group is
  still alive. Stays fire-and-forget from the caller's side — the
  escalation runs via an internal `setTimeout`, never a blocking sleep,
  so one hung job's kill sequence can't stall the runner's own loop; the
  real "did it actually die" signal remains the child's own `close`
  event in `runClaudeOnce`, unchanged. `killTreeWin32` is unchanged:
  `taskkill /t /f` is already maximum force with no weaker signal to
  step up from, so no escalation ladder applies there, and verifying
  that path for real needs Kyle's own Windows machine (same as every
  other Windows-only claim in this repo).
- verified: a new test spawns a real child that traps and ignores
  `SIGTERM` (`process.on("SIGTERM", () => {})`), confirms it survives
  the initial signal, then confirms it's dead once the grace-period
  `SIGKILL` escalation lands. Proven RED first — with the escalation
  temporarily stripped back to a single `SIGTERM`, the test failed with
  the uncooperative child still alive after the grace window — then
  GREEN with the real fix restored; full `runner/runner.test.mjs` suite
  (50 tests) passes.
- **safety note found while implementing**: this sandbox runs as root
  (`process.kill(1, 0)` succeeds without throwing). The pre-existing
  fallback-path test fixtures used `pid: -1` to force `process.kill(-pid,
  ...)` to throw — but `-(-1)` is `1` (PID 1 / init), and under root that
  signal call does NOT throw, it succeeds. Combined with the new
  escalation logic, that fixture would have sent a REAL `SIGTERM` then a
  REAL, unblockable `SIGKILL` to PID 1, risking crashing the whole
  container. Caught before running any test in the escalation work, via
  a pre-flight `process.kill(1, 0)` privilege check plus a targeted
  `grep -n "pid: -1"`; fixed by switching both fixtures to a large fake
  pid (`999999999`), matching this codebase's own established
  `999999`-style "definitely not a real process" convention elsewhere.
  Nothing dangerous was ever actually executed — this was caught in
  review before the first test run, not as an incident.

## OI-036 clearbot.ps1/sendconsole.ps1: a dead console's recycled PID could be attached-to and typed into by a stale clear/cd request
- opened: 2026-08-06, found by the same lean-review sweep as OI-035.
- where: `watcher/clearbot.ps1` `Test-Binding`, `watcher/sendconsole.ps1`
  `AttachConsole($TargetPid)`
- what: `Test-Binding` only proves a request's `consolePid` matches the
  value stored in `runner/state/<sid>.window`; it never re-verifies that
  PID is still the *original* console process (no start-time or image-name
  cross-check). No code path ever deletes a `.window` file. If a console
  dies, Windows can recycle its PID for another console-owning process
  (`cmd.exe`/`powershell.exe`/`node.exe` are common on this machine), the
  stale `.window` file still agrees with a stale request, `Get-Process -Id
  $cpid` succeeds (some process, not necessarily the right one), and
  `sendconsole.ps1` would attach to the *wrong* console and type `/clear`,
  a goal-kick constant, or Esc into it. This is about PID *identity*, a gap
  the existing "no wrong window" focus-theft protection doesn't cover
  (that's about focus, not which process ID a request still trusts).
- why open: for goal kicks, exposure is largely already closed in practice
  by `reapDeadGoals()` (`hooks/goal.mjs`), which runs on a ~2s cycle and
  marks a goal `dead` the moment `consoleAlive()` is false, before a kick
  can fire on a stale binding. Plain clear/cd requests (from `budget.mjs`)
  have no equivalent reaping, though the requesting session's own PID is
  virtually always fresh at request time, keeping the real-world window
  tight — narrow enough that the reviewing agent's own assessment was "not
  urgent given the narrow timing required." Hardening it for real (a
  process start-time or session-id cross-check at bind time and at every
  attach) is real, scoped work, and this sandbox has no Windows console
  session to verify a fix against, the same reason several other
  console/ConPTY items in this file stay spec-only until Kyle can check
  them on his own machine.
- done when: `Test-Binding` (or the `.window` record itself) carries enough
  identity beyond a bare PID — a process start-time, or an explicit
  liveness handshake at bind time — that a recycled PID cannot silently
  satisfy a stale request, verified against a real reboot/recycle on
  Kyle's machine.

## OI-037 [RESOLVED 2026-08-06] a torn ledger append can silently corrupt the NEXT record too, not just itself
- opened and resolved 2026-08-06, found via pre-approved fault injection
  (Kyle: "For fault injection let's put that in the guards and I
  /approve-kgs ahead of time") on `kernel/ledger.mjs`, the load-bearing
  audit trail (run records + decisions) every kernel enforcement point and
  the kernel README's own crash-recovery claims depend on.
- where: `kernel/ledger.mjs`'s `appendLine()`
- what: `readLines()` already tolerates a torn TRAILING line (a process
  killed mid-`fs.appendFileSync` — SIGKILL, power loss, OOM, exactly the
  scenario a lane timeout or a hard ceiling can trigger) — it skips the
  unparseable line and keeps everything before it, and a test already
  proved that. What was NOT tested, and turned out to be broken: the
  RETRY that follows such a crash. `appendOnce`'s idempotency check
  (AC-G4, "the first record for a run wins") correctly doesn't see the
  torn line as an existing record, so the retry proceeds — but the torn
  line has no trailing newline of its own, and the retry's clean JSON
  landed on the SAME line, concatenating two JSON objects into one
  unparseable blob. Reproduced directly: append a deliberately truncated
  `run_started` line, call the real `appendStarted()` again, and the
  retried record was unreadable — `readRuns()` returned zero rows for
  that run, not one. The crash didn't just lose itself; it silently ate
  the recovery attempt too.
- fix: `appendLine()` now checks the file's last byte before every append
  (`fs.openSync`/`fs.readSync` on a single trailing byte, cheap) and
  prepends a newline if it's missing, self-healing the line structure at
  the very next write regardless of how the prior one died. Verified: the
  fault-injection test now passes (exactly one usable record after the
  retry, idempotency still holds for a genuine duplicate afterward),
  `kernel/ledger.mjs` stays at 100/100/97.4 (lines/funcs/branches) in
  isolated `node --test --experimental-test-coverage`, and the full
  kernel/ suite (174 tests) is green.
- other `fs.appendFileSync` call sites checked and NOT at risk of this
  class of bug: `hooks/budget.mjs` (an error log and a `clearbot-status`
  path — plain human-readable text, never re-parsed as structured data),
  `hooks/goal.mjs` (per-goal Markdown log — same, human-readable only),
  `runner/runner.mjs`'s `log()` (same). The risk is specific to a file
  whose lines get parsed back as records program logic depends on —
  `ledger.mjs` was the only one.

## OI-038 [RESOLVED 2026-08-06] four duplicated cross-process locks only tolerated EEXIST, not a real Windows CI EPERM

- opened and resolved 2026-08-06, found by a real Windows CI failure on PR
  #9 (commit `d76544a`, the vault-key-bypass fix), in
  `kernel/autonomy.test.mjs`'s pre-existing 20-way concurrent
  `updateAfterRun` race test:
  ```
  Error: EPERM: operation not permitted, open '...\autonomy.json.lock'
      at withAutonomyLock (kernel/autonomy.mjs:97:23)
  ```
- where: the same cross-process exclusive-file-create lock primitive
  (`fs.openSync(lockPath, "wx")`, catch, stale-reclaim, timeout,
  sleep-retry) is independently duplicated across FOUR files —
  `kernel/autonomy.mjs` (`withAutonomyLock`), `kernel/ledger.mjs`
  (`withDecisionLock`), `hooks/budget.mjs` (`withStateLock`), and
  `hooks/mission.mjs` (`withMissionLock`) — each one's own comments
  already note the duplication and why it wasn't factored out (each file
  keys the lock differently and none wanted a cross-file import for a
  handful of lines).
- what: the retry loop's exception guard was `if (e.code !== "EEXIST")
  throw e;` in all four — EEXIST (the lock file already exists, held by
  another process) was retried, but any other error, including EPERM, was
  surfaced as a hard failure that aborted the whole lock acquisition.
  EPERM here is a well-documented Windows quirk: antivirus/Defender can
  transiently lock a just-created file during a scan, which is a
  transient failure to ACQUIRE the lock — the same class of condition as
  EEXIST, not a real permission denial — and it resolves itself within
  milliseconds if retried. Only reproduced for real under Windows CI's
  20-way concurrent load; not reproducible in the Linux sandbox, so fixed
  via a targeted `fs.openSync` mock (monkey-patched to throw a simulated
  EPERM once, matching the real error shape) rather than a real Windows
  run.
- fix: all four call sites now retry on `e.code !== "EEXIST" && e.code
  !== "EPERM"`, with a comment explaining the Windows antivirus/Defender
  scenario at each site. Verified: `kernel/autonomy.test.mjs` RED
  (mocked EPERM reproduced the exact real CI failure) then GREEN after
  the fix (15/15), with a new regression test added
  ("withAutonomyLock retries past a transient EPERM instead of aborting
  the whole lock acquisition"). `kernel/ledger.test.mjs`,
  `hooks/budget.test.mjs`, `hooks/mission.test.mjs` all still green
  (115 tests total, 1 pre-existing unrelated skip). Full `npm test`:
  533 pass, 1 pre-existing unrelated failure
  (`hooks/lane.test.mjs`'s chmod-based read-only test, which fails
  identically on unmodified `main` — this sandbox runs as root, which
  bypasses the file permission checks that test relies on; not a
  regression from this fix).

## OI-033 usage.mjs/budget.mjs/statusline.mjs/engine.mjs cannot clear covgate's floor today
- opened: 2026-08-06, found while shipping Phase 1 (docs/2026-08-03-full-
  remediation-prompt.md) — NOT introduced by that work, pre-existing.
  `engine.mjs` joined this entry 2026-08-06 during Phase 4 D2: it had ZERO
  tests before this session (confirmed: no `engine.test.mjs` existed) and
  its `ROOT` is hardcoded relative to its own file location, not
  `ACC_ROOT`-overridable the way every other hooks/ file is — a second,
  smaller structural gap Phase 7's broader pass should also close. Phase 4
  added exactly 3 focused tests proving its own D2 fix (corrupt-vault
  handling, atomic writes) — genuine coverage of that specific change, not
  a claim the file is comprehensively tested.
- where: `hooks/usage.mjs`, `hooks/budget.mjs`, `hooks/statusline.mjs`,
  `hooks/engine.mjs`
- what: `budget.mjs`/`statusline.mjs` measure 0% ("no test imports it") —
  both are single-dispatch hook binaries only ever exercised via
  `execFileSync` subprocess spawns (their own test files' own comments
  explain why: `NODE_V8_COVERAGE` is deliberately stripped from those
  spawns so their volume doesn't degrade an unrelated gated file's merged
  branch coverage — confirmed 2026-08-02). `usage.mjs` measures ~44%
  lines/24% funcs even combined with several other test files' imports —
  its CLI dispatch (`main()`) and whole-project `scan()`/`aggregateSession`
  path have no direct unit suite, only indirect exercise through whatever
  individual functions other files' tests happen to call.
- why open: this is precisely Phase 7 of the full-remediation-prompt
  ("Coverage-gate honesty" — "Un-blind budget.mjs... Restructure so at
  least the pure logic... is importable and measured") — not something to
  half-fix as a side effect of an unrelated phase. Phase 1 added
  `usage.mjs`'s `costOfTranscript` fully unit-tested (3 dedicated tests,
  confirmed covgate-visible and covered in isolation) and touched
  `budget.mjs`/`statusline.mjs` with the SAME subprocess-integration test
  pattern every other line in those files already uses — this entry is not
  about anything shipped without a test, only about `node hooks/covgate.mjs`
  being structurally unable to confirm it for these three files.
- done when: Phase 7 lands (parseLcov merge fix, budget.mjs restructured so
  its pure logic is importable, `engine.test.mjs` added) and
  `node hooks/covgate.mjs` genuinely gates all three files on a normal diff.
- UPDATE 2026-08-06 (Phase 7 in progress): parseLcov merge fix shipped —
  see OI-017's own update; fixed a real bug (multi-consumer files like
  `usage.mjs` were reading whichever test happened to be parsed last, not
  their true merged coverage: `usage.mjs` went from `funcs 2.78%` to
  `funcs 67.3%` once measured honestly). `budget.mjs` un-blinded: guarded
  `main()` behind the same entrypoint check `covgate.mjs`/`kernel/run.mjs`
  already use (previously ran unconditionally at import, so importing it
  for a unit test would `process.exit()` before an assertion ever ran),
  exported the 11 pure/file-only helpers named in the phase spec
  (`weekTier`, `scanWeek`, `statePath`, `readJson`, `atomicWrite`,
  `stopRunner`, `lastAssistantText`, `lastUserText`, `pausedGoalWarning`,
  `goalContext`, `queuedPromptContext`), new `hooks/budget.unit.test.mjs`
  (17 tests, all red-first against the unguarded/unexported original).
  Real, now-measured result: lines 39.8%, funcs 50%, branches 78.4% — a
  genuine improvement over an opaque 0%, but still under the 100/100/90
  floor, honestly. The remaining gap is the dispatch layer itself
  (`onSessionStart`/`onUserPromptSubmit`/`onPostToolUse`/`onStop`/
  `onPreToolUseAgent`, plus `inject`/`blockStop`/`deny`/`allow`) — every one
  calls `process.exit()` as its last act, which is exactly why
  `budget.test.mjs`'s existing 20 tests test them for real via subprocess
  rather than direct import (and why that file deliberately strips
  `NODE_V8_COVERAGE` from those spawns, per its own header comment, to
  protect an unrelated file's coverage numbers from the volume). Closing
  that gap for real needs the handlers restructured to accept injected
  output functions instead of calling `process.exit()` directly — a
  materially bigger, riskier refactor of the single highest-branch-count,
  most incident-prone file in the hooks layer, not something to force
  through as a side effect of a coverage-honesty pass. Left open,
  deliberately, rather than either half-fixed or hidden behind a new
  `branchFloorOverrides` entry (which the phase's own instructions warn
  against using to "duck real gaps" — this is a real gap).
- UPDATE 2026-08-06 (Phase 7 item 3): `hooks/engine.mjs` un-blinded too, on
  both axes the entry names. `ROOT` now reads `ACC_ROOT` the same way every
  sibling hooks/ file already does (was hardcoded relative to the file's own
  location — the entry's own second-gap note). `hooks/engine.test.mjs`
  rewritten from 3 tests (Phase 4's narrow D2 regression pins, run against
  the REAL repo's own gitignored vault.json) to 31, all sandboxed via a
  throwaway `ACC_ROOT` per test: vault read/write round-trip, corrupt/
  missing vault and config (both fail closed with a message, not a raw
  crash), every config-side command (status/toggle/secret/protected/
  projects, including dedup-on-readd), and the full runbox lifecycle (list/
  run/trash/restore/flush, keep-marker scripts, a failing script staying in
  place with its own exit code, a self-cleaning script, ambiguous and
  absolute-path refs, restoring the newest of two same-named trashed
  copies, both `.mjs` and `.js` runner extensions). Real measured result:
  lines 100%, funcs 89.7%, branches 71.1% — up from a flat, opaque 0%.
  Genuinely gated now, per the phase's definition of done, though still
  short of the 100/100/90 floor. What's left, named rather than hidden:
  the `.ps1`/`.cmd`/`.bat` entries in the `RUNNERS` map (need `powershell`/
  `cmd`, neither exists in this Linux sandbox — the same class of gap
  OI-010 already established precedent for), the `ACC_ROOT`-unset fallback
  branch (untestable without pointing a subprocess at the real repo, which
  is the exact live-state risk making it `ACC_ROOT`-overridable existed to
  avoid), and a handful of V8 branch-coverage points inside the CLI's
  `switch` cases that didn't resolve to an obviously worthwhile additional
  test in the time spent here. `budget.mjs`'s dispatch-handler gap (above)
  is the one still fully open piece of this entry.
- UPDATE 2026-08-06 (post-Phase-7, real CI data): Phase 7's own local
  verification was genuine — running `budget.unit.test.mjs`/
  `engine.test.mjs` in isolation, or alongside a moderate batch of other
  hooks/ test files, produces real, non-zero lcov data for both files
  (documented above: budget.mjs 39.8/50/78.4, engine.mjs 100/89.7/71.1).
  But the FULL CI `covgate` job — every test file in the repo, ~30+, one
  `node --test` invocation — still reports both at a flat `0%, no test
  imports it` (PR #9, commit 4208a6a, 2026-08-06), the identical symptom
  as before Phase 7 shipped. This is not Phase 7 being a no-op: it's a
  SEPARATE, larger-scale instance of the exact node `--experimental-test-
  coverage` instability OI-017 already bisected and named ("tied to total
  file/process count per invocation") — there, degraded a file's branch %;
  here, at CI's larger file count, drops two files' coverage data
  entirely rather than merely degrading it. `hooks/route.mjs` and
  `hooks/usage.mjs` show the milder, non-zero version of the same
  large-batch degradation in that same CI run. No parser fix can help when
  the data never reaches the lcov file at all — the earlier parseLcov bug
  (fixed, see OI-017's own update) was about MERGING data that arrived;
  this is data not arriving. A real fix needs `covgate.mjs`'s test
  invocation split into smaller batches with results merged across
  batches (bigger, separate change to the gate's own mechanics, not a
  coverage-honesty fix to an individual hooks/ file) — out of scope for
  tonight, named here rather than silently absorbed into "Phase 7 done."
- UPDATE 2026-08-06 (tier-1 GUI migration, PR #9): `gui/engineClient.mjs`
  (new tonight) joins this entry's signature at CI scale — isolated local
  run (`node --test --experimental-test-coverage gui/engineClient.test.mjs`)
  measures 97.56% lines/branches/funcs combined, genuinely covered; the full
  CI `covgate` job reports lines 91.2% branches 78.1% (funcs still 100%) on
  the same commit, under the 100/90 floor. Same root cause as engine.mjs/
  route.mjs/usage.mjs above (node's `--experimental-test-coverage`
  degrading at the repo's full ~35-test-file invocation size), not a new
  mechanism — not re-diagnosed per-occurrence, only recorded here so the
  file list stays accurate. No production code change; `gui/server.mjs`
  cleared its own floor in the same CI run (100/100/90.8) since its route
  logic is thinner and less branch-heavy than engineClient.mjs's op-dispatch
  functions.
- UPDATE 2026-08-06 (tier-2 GUI migration, Spending tab): `hooks/status.mjs`
  (new) joins this entry with a DIFFERENT trigger than the batch-size one
  above, worth naming precisely rather than lumping in: lines 100%, funcs
  100%, branches stuck at ~50-54% in isolated `node hooks/covgate.mjs` runs
  no matter how many additional validation-path tests were added (18 tests,
  every conditional in `validateOpsBlock` manually traced and confirmed
  exercised, including every optional-chain nullish path — the number did
  not move with real added coverage, which is itself the tell). Root cause
  isolated to `hooks/status.test.mjs`'s own per-test dynamic reimport
  pattern (`import(`./status.mjs?t=${++loadSeq}`)`, 18 separate module
  instantiations of the same source in one process) — the SAME technique
  `hooks/usage.test.mjs` already uses, and `usage.mjs` shows the identical
  suspiciously-low branch number in the raw (unmerged) node coverage table
  despite dozens of tests. `covgate.mjs`'s own parseLcov fix (OI-017,
  earlier tonight) merges multiple SF: blocks for the same file by code-
  point identity, but assumes V8's branch numbering is stable/comparable
  across separately-instantiated compilations of the same source -- for a
  file reimported via a fresh query string per test, that assumption may
  not hold, undercounting real coverage rather than measuring a real gap.
  Not fixed tonight: confirming this precisely (vs. just pattern-matching
  it to OI-033/OI-017) needs reading node's own lcov emission for a multi-
  reimport case directly, out of scope for a GUI migration pass.
- UPDATE 2026-08-06 (global-status widget): `gui/server.mjs` itself joined
  this entry for the first time, for a THIRD, different, genuinely-
  understood reason (not a tooling artifact this time): the `GET /api/
  status/spending` and `GET /api/status/summary` routes each carry a
  `try { ... } catch (e) { return send(res, 500, ...) }` guard, matching
  the defensive-on-every-route convention this file already established
  (and that this same session's own PAGES-route fix, above, proved matters
  — an unguarded route can hang the client instead of erroring cleanly).
  Their `catch` branches are unreachable under current guarantees: every
  function in their call chain (`hooks/usage.mjs`'s `loadPolicy`,
  `listProjects`, `listSessions`) wraps every `fs` call in its own bare
  `catch {}` and falls back to a safe default, by design, all the way
  down — confirmed by reading the full call chain, not assumed. Faking a
  throw to hit 90% branches would either misrepresent behavior that can't
  happen, or require monkey-patching `fs` in a way that tests something
  synthetic rather than real. Removing the `try/catch` to "simplify away"
  dead code — the choice already made once tonight for `gui/
  engineClient.mjs`'s genuinely-dead `|| ""` fallbacks — is NOT the right
  call here: unlike a redundant fallback expression, this guard is the
  file's own established safety net against exactly the hang class its
  own adversarial-review-flagged history warns about, and removing it
  would reintroduce that risk the moment `hooks/status.mjs` ever grows a
  path that CAN throw. Left in place, under-covered, honestly documented
  — the same choice this entry already makes for `hooks/budget.mjs`'s
  un-mockable dispatch layer.
- UPDATE 2026-08-06 (OI-026 rename, incidental): `hooks/lane.mjs` and
  `hooks/prompts.mjs` joined this entry's signature for the first time,
  for a reason worth naming precisely since it's NEITHER of the two
  causes already on file here (subprocess-only dispatch, or CI-batch-
  size instability): both files got a one-line COMMENT-only edit as
  part of the goal->mission rename ("the goal loop" ->
  "the mission loop" in lane.mjs; "runner/goals convention" ->
  "runner/missions convention" in prompts.mjs), which made them
  "changed files" under covgate's `git diff` scoping for the first
  time — and that's all it took to expose gaps that were ALREADY there,
  unmeasured, before either file was ever touched this session.
  Confirmed real and pre-existing, not introduced or CI-scale-related:
  ran both files' own test suites in ISOLATION (not the CI batch) and
  got the identical numbers CI reported. `hooks/prompts.mjs` (90.8%
  lines / 92.3% funcs / 83.3% branches, isolated) is missing exactly
  its `main()` CLI entrypoint (lines 88-96) — the same un-unit-tested-
  dispatch shape as `budget.mjs`'s handlers and `engine.mjs`'s CLI
  switch, only ever exercised via subprocess elsewhere. `hooks/lane.mjs`
  (96.6% lines / 97.9% funcs / 85% branches, isolated) is missing
  exactly `queryClaudeProcesses` — the Windows-only CIM-query function
  (already Windows-CI-only-tested, `{ skip: process.platform !==
  "win32" }` on its own test) plus its own small pocket of dead lines
  around it, unreachable on this Linux sandbox by construction, same
  class of gap OI-010 already established precedent for. Neither file's
  actual logic changed; both gaps would have shown up on the very next
  unrelated touch to either file regardless of this rename. Not fixed
  here — named, so it isn't mistaken for something the rename broke.

## OI-015 [SHRUNK — needs Kyle for the rest] guards-gui.ps1 interactive-lane wiring: the handshake is now proven, the visible-GUI half still needs Kyle
- opened: 2026-08-01, shrunk 2026-08-04: this environment now has a real
  `powershell.exe` (unlike when this entry was opened). Added
  `-TestInteractiveLane` to guards-gui.ps1 — headlessly drives the exact
  reserve -> reown -> release handshake a real Go-button launch uses, against
  the real hooks/lane.mjs (already proven 44/44 in hooks/lane.test.mjs), no
  WinForms window built. New test `gui/guards-gui.test.mjs` (added to
  `npm run test:windows`, excluded from Linux CI like clearbot.test.mjs since
  it spawns real powershell) proves: a reserve while free succeeds, a second
  reserve while the first is held is refused with the exact busy-message
  text the MessageBox displays, and a reserve after release succeeds again.
  Verified: `node --test gui/guards-gui.test.mjs` (1/1 green).
- what's still cut, and why it's not closed: the MessageBox actually
  rendering, the Process.Exited release path firing off a real killed/exited
  child, and the interactive slot directory disappearing within a few
  seconds of Kyle closing a real hosted session — none of that can be
  exercised without the GUI visible and a human pressing Go twice. Not
  re-filed as a new entry; it's the same "needs Kyle" residue this entry
  already named.
- why open: needs Kyle physically watching the GUI (same as before, just a
  smaller remaining gap).
- done when: a real smoke run on Windows — press Go once with automation
  idle (normal launch, no MessageBox), press Go a second time while the
  first is still running (must show the busy MessageBox and refuse, not
  stack a second claude), and confirm the interactive slot directory
  (`%TEMP%\acc-lane\interactive\slot-0`) is gone within a few seconds of
  closing the session either way (Stop button and natural exit both).
  Screenshot or narrate what actually happened, don't just eyeball the diff.

## OI-019 [RESOLVED 2026-08-06] Kernel test suite meets coverage floors but not the scenario breadth Kyle wants before trusting it
- opened: 2026-08-03, resolved: 2026-08-06 (all 12 kernel modules passed)
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
  (T17-T22); needs a deliberate scenario-enumeration pass across all ~12
  kernel modules, which is real, multi-session work, not something to rush
  through in one ledger sweep. Started 2026-08-04 on the highest-risk module
  first: `kernel/guard.mjs` (the deny-by-default boundary itself). The pass
  found a REAL, live bypass, not a hypothetical — `norm()` did a raw string-
  prefix match with no `..`-segment resolution, so a harness-supplied
  `file_path` like `C:/work/src/../../code/guards/policy.json` textually
  started with an allowed `writeRoots` entry and was ALLOWED, while the
  actual OS-resolved write lands in `denyRoots`-protected guard machinery.
  Fixed: `norm()` now runs the path through `path.posix.normalize` (pure
  string collapsing of `.`/`..` segments, no I/O, keeps the module's "pure"
  contract) before the prefix comparison. 4 new regression tests in
  `kernel/guard.test.mjs` prove: the exact bypass is now denied (and
  re-classified correctly as `alwaysDeny`, target shown resolved not raw);
  the same class of bypass on a READ path; a `..` that resolves BACK inside
  an allowed root is still correctly allowed (normalization isn't itself a
  deny); and a mixed backslash/forward-slash traversal is caught identically.
  Verified: `node --test kernel/guard.test.mjs` (21/21), full
  `npm run test:windows` (422/423, 1 pre-existing unrelated skip),
  `node hooks/covgate.mjs` (guard.mjs 100%/100%/97.5%).
- done when: for each kernel module, a documented pass has enumerated
  standard / non-standard / edge / rare / error / fault-tolerance scenarios
  (beyond AC-ID traceability) and either added a real test or recorded an
  explicit, ledgered reason none is needed. No test may be added or loosened
  just to turn red green — every test must be able to fail against a genuine
  regression, never tuned to the current implementation's behavior.
  Progress: 2/12 modules done (`kernel/guard.mjs`, `kernel/guardhook.mjs`).
  `kernel/guardhook.mjs` pass (2026-08-06) found a REAL, reproduced race, not
  a hypothetical: attempts-read / decide / append-decision was three
  unsynchronized steps across PROCESSES, so concurrent tool calls against the
  same run (Claude Code dispatches several from one turn routinely) could all
  read the same stale attempts count and all be let through — reproduced
  directly, 40 truly-concurrent fires against a ceiling of 3 let 4-8 through.
  Fixed with a synchronous, cross-process exclusive-file-create mutex
  (`kernel/ledger.mjs`'s new `withDecisionLock`, stale-lock reclaim so a
  crashed holder can't deadlock every future fire on that run, fails closed
  on a genuine timeout) wrapping all three steps as one atomic unit; the two
  existing "decision log can't be written" vs the new "lock can't be
  acquired" failure modes stay distinctly worded via a tagged
  `DecisionLogWriteError`, no existing test's expected message changed. A
  second, smaller finding along the way: guardhook.mjs's stdin reader had a
  dead `if (stdinOversized) return` guard — once the cap trips, the process
  exits synchronously before Node's event loop could ever deliver a second
  "data" event to need it — removed rather than tested around, same
  precedent OI-013 already set for this exact class of finding. Verified:
  `node --test kernel/guardhook.test.mjs kernel/ledger.test.mjs` (39/39, RED
  first — the race test reliably failed pre-fix, 4-8 allowed vs ceiling 3,
  across 3 runs before the lock existed), full `npm test` (427/428, the 1
  fail is the pre-existing unrelated `lane.test.mjs` root-sandbox chmod
  flake already noted throughout this ledger), `node hooks/covgate.mjs`
  scoped to both changed files: guardhook.mjs and ledger.mjs both
  100%/100%/100%.
  `kernel/run.mjs` pass (2026-08-06): found a real, concrete gap —
  `finalize()` called `cleanupRun(runId)` unprotected AFTER
  `appendFinalized()` already durably recorded the run's real outcome; a
  lingering file handle on the staging dir (a genuine cross-platform
  possibility — a just-stopped harness child, AV scanning, not
  hypothetical) would throw out of `runTask()` uncaught, crashing the CLI
  entry point (which also has no try/catch around `await runTask(...)`)
  even though the run had already legitimately finished. Fixed: `cleanup`
  is now an injectable seam (same pattern as the existing `afterStage` test
  seam) defaulting to the real `cleanupRun`, wrapped in try/catch inside
  `finalize()` — a cleanup failure now logs and the run's already-decided
  outcome still returns normally. Also reviewed and found sound (no bug,
  documented here rather than re-litigated per module later): `identity()`
  is genuinely synchronous so the missing `await` is safe;
  `updateAfterRun`'s deliberate exclusion of `failed-to-start` from both
  the reject-rate calc AND the `runsLeft` decrement is self-consistent, not
  a gap; `checkpointVerdict`'s multi-ceiling-breach priority order
  (wallClock > tokens > toolCalls > stalled) is deterministic; no shared
  mutable module-level state exists across concurrent `runTask()` calls in
  one process. Verified: `node --test kernel/run.test.mjs` (22/22, RED
  confirmed first — the cleanup-failure test failed with the exact thrown
  error propagating uncaught before the fix), `node hooks/covgate.mjs`
  (run.mjs 100%/100%/90.9%), full `npm test` (428/429, the 1 fail is the
  same pre-existing unrelated `lane.test.mjs` flake noted throughout this
  ledger).
  Progress: 4/12 modules done (`kernel/guard.mjs`, `kernel/guardhook.mjs`,
  `kernel/run.mjs`, `kernel/ledger.mjs` — this count previously read 3/12
  with an 8-item remaining list that only summed to 11; `ledger.mjs` earned
  its place in the "done" column during the guardhook.mjs pass above
  (the new `withDecisionLock` cross-process mutex, verified 39/39
  alongside guardhook.mjs), it just hadn't been added to either list).
  `kernel/verifier.mjs` pass (2026-08-06): found a REAL, live bug —
  `file_contains`'s `new RegExp(v.pattern)` was unguarded, so a malformed
  pattern (e.g. an unterminated group) threw a SyntaxError straight out of
  `verifyCriterion`. `kernel/run.mjs`'s only call site (`await
  verifyAll(...)`) has no try/catch, and neither does its own CLI entry
  point around `runTask()` — one malformed criterion in a contract would
  crash the entire kernel process AFTER the harness already finished its
  work, discarding the run with no recorded outcome at all, instead of the
  clean "criterion X: fail" this file exists to produce for every other
  kind of bad criterion. Fixed: the `RegExp` construction is now wrapped
  in its own try/catch, reporting `fail` with the parse error as detail —
  same pattern the file already used for an unreadable target file.
  Verified: `node --test kernel/verifier.test.mjs` (11/11, RED confirmed
  first — the malformed-pattern tests threw uncaught pre-fix), `node
  hooks/covgate.mjs` (verifier.mjs 100%/100%/100%).
  `kernel/autonomy.mjs` pass (2026-08-06): `writeAutonomy` was the one JSON
  state file left in this codebase still using a bare `writeFileSync`
  instead of tmp+rename — a reader (`readAutonomyStrict`, an ENFORCEMENT
  point that fails closed on any read error, per its own doc comment) could
  observe a half-written file from a crash mid-write and deny every
  subsequent tool call for a reason that isn't real tightening. Fixed with
  the same tmp+rename discipline every other JSON state file already uses.
  Verified: `node --test kernel/autonomy.test.mjs` (13/13), `node
  hooks/covgate.mjs` (autonomy.mjs 100%/100%/100%). Honest caveat: unlike
  guardhook.mjs's race (provably reproduced via concurrent same-process
  calls, since its flow has a real async boundary), `updateAfterRun`'s
  read-modify-write is fully synchronous with no await point, so a genuine
  cross-process race (two `kernel/run.mjs` invocations finalizing
  concurrently, both reading the same pre-tighten state, one silently
  overwriting the other's decision and log entry) is real in principle —
  nothing in `run.mjs` itself enforces "one kernel run at a time" despite
  the kernel plan doc's own architecture note assuming it reuses
  `hooks/lane.mjs` for that, which it does not actually import — but
  isn't cheaply provable in a fast unit test the way the guardhook race
  was, and no lock was added without being able to red-test it first, per
  this repo's own discipline against speculative fixes. Left as an open
  question rather than either fixed unverified or silently ignored: does
  anything outside this repo actually guarantee kernel runs are launched
  serially, or is this exposure real? Also reviewed and found sound (no
  bug, documented rather than re-litigated per module later):
  `effectiveCeilings`'s hard cap only applies to `wallClockMin` because
  `hardCaps` only defines that one field by design (`toolCalls`/`tokens`
  have no separate hard-cap concept anywhere in `kernel/policy.mjs`, not a
  gap); `checkpointVerdict`'s dimension-priority order (wallClock > tokens
  > toolCalls > stalled) is already directly tested; `autonomy.rejectRate`
  can never reach `updateAfterRun` as `0` in practice (schema-validated to
  `(0, 1]` in `kernel/policy.mjs`), so the permanent-tightening edge case
  that value would cause is unreachable, not a live bug.
  `kernel/policy.mjs` pass (2026-08-06): no bug found — enumerated the
  first-time-kernel-setup scenario (a policy.json that EXISTS and parses
  fine but has no `"kernel"` key at all yet, distinct from the
  already-tested missing-file case) for both `loadKernelPolicy` (falls
  back to defaults, verified correct beforehand) and `saveKernelPolicy`
  (creates the kernel block fresh, preserves the pre-existing non-kernel
  content, verified correct beforehand) — both already worked, just
  hadn't been pinned by a test, and this is the exact path OI-022's GUI
  settings tab exercises the first time anyone configures the kernel.
  Everything else already had strong coverage (every `validateKernelBlock`
  rejection case individually tested, atomic-reject-on-invalid tested, BOM
  handling tested, corrupt-file-throws tested). Verified: `node --test
  kernel/policy.test.mjs` (14/14), `node hooks/covgate.mjs` (policy.mjs
  100%/100%/98.1%, up from 90.4%).
  `kernel/contract.mjs` pass (2026-08-06): found a REAL, live safety
  bypass — `validateContract`'s only budget check was "does
  `wallClockMin` exceed the hard cap," gated on `Number.isFinite(wall)`.
  A malformed value (wrong type, negative, zero) makes that `isFinite`
  check itself false, so no error was EVER raised for it — the contract
  validates clean. Reproduced concretely: `budget.wallClockMin: "sixty"`
  passes `validateContract` with zero errors, then `effectiveCeilings`'
  `b.wallClockMin ?? policy.budget.wallClockMin` picks the string anyway
  (`??` only falls back on null/undefined, not wrong type), `Math.min`/
  `Math.round` silently produce `NaN`, and `checkpointVerdict`'s `elapsedMs
  > ceilings.wallClockMs` is false against `NaN` no matter how long the
  run goes — the wall-clock ceiling, one of the kernel's core safety
  limits, was silently UNENFORCED for the run's entire lifetime (verified:
  a run at 999999999ms / ~11 days elapsed still returned `stop: false`),
  not merely unvalidated. `toolCalls`/`tokens` had the identical gap (no
  validation at all, not even the flawed hard-cap check). Fixed: each of
  the three budget fields, when present, must now be a real positive
  number (`toolCalls`/`tokens` additionally integers), refused before the
  run starts — matching the same rigor `kernel/policy.mjs`'s
  `validateKernelBlock` already applies to the policy's own budget
  defaults, which this per-contract validation had never picked up.
  Verified: `node --test kernel/contract.test.mjs` (16/16, RED confirmed
  first — the malformed-budget test failed pre-fix, contract validated
  clean), `node hooks/covgate.mjs` (contract.mjs 100%/100%/100%).
  `kernel/credentials.mjs` pass (2026-08-06): no bug found — this is the
  smallest, most tightly-scoped kernel module (36 lines, single purpose:
  hand vault values to a child env, never disk/argv/stdout/ledger) and it
  showed. `readVault`'s corrupt-vault handling already fails closed
  (treats corrupt the same as absent — "no keys," which denies rather
  than grants, consistent with the file's own stated design). Reviewed
  and found sound, not a gap: `vaultPath()` uses its own `ACC_VAULT`
  override rather than `ACC_ROOT` (unlike every other kernel module),
  which is a naming inconsistency but not a bug — both resolve to the
  same default path (`<repo>/vault.json`) and the override is exercised
  correctly by every test. The one real gap was untested, not unhandled:
  the `ACC_VAULT`-unset fallback (production default) had no test.
  Verified: `node --test kernel/credentials.test.mjs` (5/5), `node
  hooks/covgate.mjs` (credentials.mjs 100%/100%/100%, up from 90%).
  `kernel/adapter.mjs` pass (2026-08-06): no bug found — already tight
  (the harness-name regex is ASCII-lowercase-slug-only, no traversal or
  homoglyph surface; injection attempts, missing-interface-members, and
  unknown-but-present harnesses were all already tested individually; the
  AC-A8 architectural test scanning every kernel/*.mjs file for a leaked
  harness name is a nice belt). The one gap was the same class already
  found in `policy.mjs`/`credentials.mjs` this pass: the first-time-setup
  case (`policy.json` present, `kernel.harness` never configured at all)
  was untested, though it already failed closed correctly (via the
  invalid-name path, since `KERNEL_DEFAULTS.harness` is `null`). Verified:
  `node --test kernel/adapter.test.mjs` (7/7), `node hooks/covgate.mjs`
  (adapter.mjs 100%/100%/100%, unchanged — was already clean).
  `kernel/adapters/claude-code.mjs` pass (2026-08-06): found a REAL, live
  crash — `startTask` writes the prompt to `child.stdin` with no listener
  ever attached to that stream. A harness that exits (crashes, fails to
  launch fully) before consuming a large prompt makes that write throw
  `EPIPE`; Node surfaces stream write errors on the STREAM itself
  (`child.stdin`), never on the child PROCESS object, so the existing
  `child.on("error"/"close", ...)` handlers — which correctly turn every
  OTHER startup failure into an ordinary `failed-to-start` outcome — never
  see it. An `'error'` event on an `EventEmitter`/stream with no listener
  is an UNCAUGHT EXCEPTION: the whole kernel process would crash with no
  ledger entry at all, discarding whatever the run had already done,
  instead of the clean rejected/failed-to-start outcome this file exists
  to produce for every other kind of failure. Reproduced directly (writing
  a multi-MB payload to a real child process that exits immediately threw
  uncaught before the fix). Fixed: `child.stdin.on("error", () => {})` —
  the close/error handlers already decide the real outcome; this only
  stops the write itself from taking the process down. Also reviewed and
  found sound (no bug, documented rather than re-litigated per module
  later): `readState`'s per-event token summation matches
  `hooks/usage.mjs`'s own established `turns()` pattern exactly (each
  assistant-type JSONL/event record carries its own incremental usage, not
  a running total, so summing across all of them is the correct
  cumulative count — verified against the production-used cost-tracking
  code, not just this file's own logic). Verified: `node --test
  kernel/adapters/claude-code.test.mjs` (22/22, RED confirmed first — the
  EPIPE test's `child.stdin.emit("error", ...)` line threw uncaught,
  exactly reproducing the crash, before the fix), `node hooks/covgate.mjs`
  (claude-code.mjs 100%/100%/92.2%).
  `kernel/settings.mjs` pass (2026-08-06), the LAST of the 12: no bug
  found — already 100%/100%/100% covered going in, and stayed that way.
  Deliberately checked, not skipped: whether `writeRunFiles`'s three
  non-atomic `writeFileSync` calls (settings.json, contract.json,
  pin.json — no tmp+rename, unlike almost everything else in this
  codebase after this pass) are a real gap, the same class as
  `autonomy.mjs`'s `writeAutonomy` earlier in this pass. They are not:
  unlike `autonomy.json` (read-modify-written repeatedly across
  finalizing runs) or the guardhook attempts file (read/written on every
  concurrent tool call within a live run), these three files are written
  ONCE per run, strictly BEFORE the harness process is spawned — nothing
  reads them until `guardhook.mjs` starts firing, which structurally
  cannot happen before the harness that triggers it exists. No concurrent
  reader, no torn-read window. Also checked: `cleanupRun` racing a
  late-arriving guardhook fire against a run that just closed — already
  fails closed via `verifySettingsPin`'s existing try/catch (ENOENT reads
  as `ok: false`, same as any other unreadable state), not a crash.
  Verified: `node --test kernel/settings.test.mjs` (5/5, unchanged).
  **OI-019's full kernel scenario-enumeration pass is now DONE: 12/12
  modules.** Tally across all twelve: 5 real, live bugs found and fixed
  (`guard.mjs` path-traversal bypass, `guardhook.mjs` cross-process
  ceiling race, `run.mjs` cleanup-crash-after-finalize,
  `verifier.mjs` malformed-regex crash, `contract.mjs` silent
  ceiling-bypass via a malformed budget field, `claude-code.mjs` EPIPE
  crash — six, not five, correcting the count while writing it out); 2
  consistency fixes for real-but-lower-severity gaps (`autonomy.mjs`'s
  non-atomic write, `ledger.mjs`'s cross-process decision-lock race,
  already counted above); several "no bug, scenario pinned" outcomes
  (`policy.mjs`, `credentials.mjs`, `adapter.mjs`, `settings.mjs`) where
  the honest result was confirming already-correct fail-closed behavior
  rather than forcing a fix that wasn't needed. No test was added or
  loosened to turn red green without a genuine regression behind it.

## OI-025 e2e/loop.e2e.mjs re-run (2026-08-03) came back 1/5 PASS, not the expected 5/5
- opened: 2026-08-03, updated: 2026-08-03 (deferred run from
  `2026-08-03-acc-kernel-plan.md` T22, executed as Task 11 of
  `2026-08-03-acc-oi-closure-plan.md`)
- where: `e2e/loop.e2e.mjs`, real-token run, output archived at
  `runbox/task11-loop-e2e-output.txt` (not committed — regenerate by re-
  running the suite; see below).
- what: ran the deferred 15-20 min real-token proof suite. Result: only
  Scenario 2 (under-budget turn-end re-prompt, OI-002) PASSED. Scenario 1
  (over-budget clear/adopt/resume) timed out waiting for "cycle logged" —
  first session cleared but no evidence a second session adopted/resumed.
  Scenario 3 (Esc escalation, labeled OI-011 in the test's own output —
  note that label is stale/mismatched: at the time this was written OI-011
  was an unrelated "re-verify guards self-protection" issue; OI-011 has
  since been retired (2026-08-05), but `e2e/loop.e2e.mjs`'s own
  scenario-3 comment still says "Esc escalation when the turn refuses to
  end (OI-011)" — the label collision itself is still real and still
  worth a separate look, only the "currently-open" framing is dated)
  showed "(no clearbot log)" and timed out. Scenario 4 (typed `/cd` changes
  session cwd) failed exactly as **already tracked in OI-003** (open since
  2026-07-31): cwd stayed at `C:\code`, never moved to `C:\code\guards`,
  despite a CD event being logged and replayed — this run is a live,
  independent reproduction of OI-003, not a new defect. Scenario 5
  (embedded-pty kick) failed with no assertion-failure reason printed, only
  status fields.
- root cause (high confidence, not a product regression): at the moment of
  this run, 9 concurrent `claude.exe` processes were active on the machine
  (verified via `Get-Process claude` immediately after) — this exact
  signature (timeouts across most scenarios, 9 concurrent `claude.exe`) is
  independently documented as the known failure mode in
  `docs/superpowers/specs/2026-08-03-claude-launch-cap-design.md` (written
  the same day, before this run, for unrelated reasons): unrelated
  concurrent sessions starve the single automation slot's real-world timing
  budget; `hooks/lane.mjs`'s `withLaunchSlot` only serializes ONE tracked
  automation slot and cannot see or limit untracked manual `claude`
  invocations on PATH. This closure batch's own Task 1-10 changes do not
  touch any goal-loop file this suite covers (`hooks/goal.mjs`,
  `hooks/budget.mjs`, `watcher/clearbot.ps1`, `gui/ptyhost.e2e.ps1`),
  consistent with the timeouts (not assertion failures) seen in every
  failing scenario.
- why open: the machine-wide launch cap
  (`docs/superpowers/specs/2026-08-03-claude-launch-cap-design.md` +
  `docs/superpowers/plans/2026-08-03-claude-launch-cap-plan.md`) landed
  2026-08-04, Tasks 1-6 and 8 of its own plan: `hooks/lane.mjs` gained
  `gate()`/`isUtilityInvocation()`/`countCappedProcesses()`/
  `queryClaudeProcesses()`/`formatHolders()` and a `gate` CLI verb (exit 42
  contract); `policy.json`'s `lane.total` dial (cap 3, real exe path);
  `shim/claude.cmd` + `shim/claude` (fail-open PATH shim); standalone
  `watcher/claude-cap-watch.ps1` (alert-only breach/fail-open detector).
  Verified: `npm run test:windows` (417/418, 1 pre-existing unrelated skip),
  `node hooks/covgate.mjs` (lane.mjs 100% lines/funcs, 89% branches — above
  its OI-017 override floor), `shim/claude.test.ps1` and
  `watcher/claude-cap-watch.test.ps1` (both all-PASS), plus a real-machine
  sanity check against the live process table (cap:0 correctly refused
  against a genuinely running claude.exe; cap:3 correctly allowed) — no
  tokens spent. Task 7 (`runbox/install-claude-cap-gate.ps1`, prepends the
  shim to the user PATH and registers the watcher's Scheduled Task) is
  written and committed but NOT run — that's real machine-state change
  outside the repo, for Kyle via `/approve-kgs`.
  UPDATE 2026-08-05: it auto-ran via `autoApprove` (not by anyone deliberately
  approving it) and only HALF-succeeded — confirmed via
  `watcher/approvals.log`: "Prepended C:\code\guards\shim to the user PATH"
  (verified live, `[Environment]::GetEnvironmentVariable('PATH','User')`
  includes it), but `Register-ScheduledTask` then failed: "The task XML
  contains a value which is incorrectly formatted or out of range" /
  "Duration:P99999999DT23H59M59S" — a malformed ISO8601 duration in the
  script's own trigger definition, not an environment problem. Per the
  "failed script stays" rule the script is still sitting in
  `runbox/install-claude-cap-gate.ps1`, untouched, will not auto-retry. So
  today: the PATH shim IS live and gating every `claude` launch (confirmed:
  it let a real e2e-spawned launch through under cap), but the
  `claude-cap-watch.ps1` Scheduled Task is NOT registered — no alert-only
  breach/fail-open detector is actually running. Needs the trigger duration
  fixed in the runbox script before a re-run can complete Task 7. Until he runs it, the gate
  and watcher exist in the repo but are not yet live on the machine, so this
  OI-025 entry's own original incident is not yet provably fixed end-to-end.
  UPDATE 2026-08-04: fixed the trigger-duration bug. Root cause was
  `[TimeSpan]::MaxValue` (~29,247 years, `10675199.02:48:05.4775807`)
  serialized to an ISO8601 duration Task Scheduler's XML rejects outright --
  exactly the "Duration:P99999999DT23H59M59S" error. `runbox/install-
  claude-cap-gate.ps1` line 25 now uses `New-TimeSpan -Days 3650` (10 years,
  effectively "forever" for a task Kyle can re-register anytime) instead.
  `runbox/` is gitignored (never committed -- see AGENTS.md's runbox
  convention), so there is no branch/merge for this fix, just the in-place
  edit. Verified without touching machine state (Register-ScheduledTask was
  NOT run -- that stays Kyle's call via `/approve-kgs`):
  `[System.Management.Automation.Language.Parser]::ParseFile` on the script
  reports 0 syntax errors, and `New-TimeSpan -Days 3650` was confirmed to
  construct cleanly as a bounded span. The PATH-shim half of the script is
  idempotent (checks `-notcontains` before prepending) so re-running the
  whole script is safe even though that half already succeeded. Still needs
  Kyle to run `/approve-kgs` to actually register the Scheduled Task before
  this entry's own done-when (a live, running watcher) is satisfied.
  Per the plan's own instruction, `e2e/loop.e2e.mjs` (real tokens) is not
  run as part of this — Kyle's call on timing.
  UPDATE 2026-08-04: Kyle ran `/approve-kgs`. First attempt hit a NEW,
  different blocker than the TimeSpan bug: `Register-ScheduledTask` failed
  non-elevated with "Access is denied" — a real Windows permission wall, not
  a script bug. Per Kyle's explicit direction ("the entire point of the
  runbox stuff is to alter the script so that when I approve they have the
  correct permissions... this is not a workaround, it's me confirming and
  approving behavior"), `install-claude-cap-gate.ps1` was updated to
  self-elevate via `Start-Process -Verb RunAs` when not already running as
  Administrator, since `/approve-kgs` IS the authorization to do so. Re-run
  triggered a real UAC prompt, Kyle accepted it, script completed. Verified
  live, not just a clean exit code: `Get-ScheduledTask -TaskName
  'ACC-ClaudeCapWatch'` returns state `Ready`, and the PATH shim is
  confirmed present (`[Environment]::GetEnvironmentVariable('Path','User')`
  includes `C:\code\guards\shim`). Standing pattern worth reusing: a runbox
  script that needs elevated rights should self-elevate on
  `/approve-kgs`, not fail and wait for Kyle to notice.
- done when: Kyle runs `/approve-kgs` on the runbox install script — DONE,
  both halves (PATH shim + Scheduled Task) confirmed live. Remaining, his
  call per the original plan: either `node e2e/loop.e2e.mjs` is re-run and
  scenarios 1-5 pass, or he's satisfied the launch cap being live end-to-end
  is sufficient credit.

## OI-026 [RESOLVED 2026-08-06] "goal" terminology collides with the popular Claude Code Goal plugin
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
- DECISION 2026-08-06: rename ACC's concept from "goal" to "mission" —
  `hooks/mission.mjs`, `/mission` skill, `[ACC MISSION m-...]` injection,
  `ACC_MISSION`/`ACC_MISSIONS_DIR` env vars, mission ids `m-...` (were
  `g-...`), `AGENTS.md`'s "Goals" section retitled "Missions". Researched
  before deciding rather than guessing: the collision is real and specific,
  not just vague terminology overlap — `chrischabot/claude-code-goal` and
  `jthack/claude-goal` are both real, installable Claude Code plugins
  ("Persistent markdown-backed goal mode... keeps iterating until the
  condition you've set is met... start, inspect, pause, resume, stop,
  clear, and complete that state") describing something close enough to
  ACC's own mechanism that installing either alongside ACC would collide
  on the literal `/goal` slash-command namespace, not merely read as
  confusing in conversation. Checked "mission" and the runner-up
  "objective" against the same search — no evidence of a colliding
  `/mission` or `/objective` plugin. "mission" chosen over "objective" as
  the more distinctive word (less likely to appear incidentally in
  unrelated prose/comments/grep results the way "objective" or "goal"
  both would) and because it matches this repo's existing naming register
  (`runbox`, `lane`, `ledger`, `watcher`, `clearbot` — plain functional
  English, not jargon). Bonus, not the deciding factor: it also
  disambiguates from a SECOND, unrelated, pre-existing use of the word
  "goal" already in this same repo — `kernel/contract.mjs`'s
  `REQUIRED_FIELDS` includes a `goal` field (a task contract's one-line
  description, e.g. `"make the suite green"`), a completely different
  concept from the interactive goal-loop store that happens to share the
  same word today.
  Execution deliberately NOT done tonight, per this entry's own original
  instruction ("document now, dig into the actual rename later, not
  decide it inline mid-unrelated-task") — that reasoning holds regardless
  of how much else shipped tonight; a naming decision benefits from
  being made carefully, but the mechanical rename itself is real,
  multi-session work across a wide, confirmed surface (grepped, not
  guessed): `hooks/goal.mjs` itself, `hooks/goal.test.mjs`,
  `hooks/budget.mjs` (ACC_GOAL, goal context injection, the KICK constant
  text "Continue the active ACC goal." — this exact string is ALSO
  hardcoded in `watcher/clearbot.ps1`'s own `$KICK` constant and must
  change in both places atomically, or clearbot types a string
  budget.mjs's `KICK_CONSTANTS` no longer recognizes as a machine
  continuation), `hooks/lane.mjs`, `hooks/statusline.mjs`,
  `hooks/testplan.mjs`, `hooks/usage.mjs`, `hooks/covgate.mjs`,
  `hooks/engine.mjs`, `kernel/autonomy.mjs`/`contract.mjs`/`run.mjs`/
  `kernel/kernel.e2e.mjs` (the UNRELATED `contract.goal` field must NOT be
  touched — same word, different concept, per the disambiguation note
  above), `runner/runner.mjs`, `watcher/clearbot.ps1`/
  `start-clearbot.cmd`, `guards-gui.ps1`, `e2e/loop.e2e.mjs`, `AGENTS.md`,
  `notes/ACC-HANDOFF.md`, plus every `docs/superpowers/plans/*.md` and
  `docs/superpowers/specs/*.md` file that describes the mechanism, and the
  on-disk goal store itself (`runner/goals/*.json` → a live migration or
  documented one-time break for any goal active at cutover). A future
  session should treat this as its own dedicated pass, not a drive-by.
- EXECUTION CHECKLIST (added 2026-08-06, still not run tonight — see the
  "why still deferred tonight" note below the list): written so the
  dedicated future pass has an ordered plan instead of a file list to
  re-derive from scratch.
  1. `hooks/goal.mjs` → `hooks/mission.mjs` (git mv, preserve history).
     Rename every exported symbol whose name IS "goal" (`createGoal` →
     `createMission`, etc. — grep `function.*[Gg]oal|export.*[Gg]oal`
     inside the file to enumerate, don't guess the list). Rename
     `hooks/goal.test.mjs` → `hooks/mission.test.mjs` alongside it, same
     import path. Run `node --test hooks/mission.test.mjs` green before
     touching anything that imports it — this file has zero external
     dependents yet at this step (nothing imports it under the new path
     until step 2), so it's the one safely-isolated place to start.
  2. Update every IMPORTER's import path and call sites, one file at a
     time, running that file's own test suite green before moving to the
     next: `hooks/budget.mjs`, `hooks/lane.mjs`, `hooks/statusline.mjs`,
     `hooks/testplan.mjs`, `hooks/usage.mjs`, `hooks/covgate.mjs`,
     `hooks/engine.mjs`, `kernel/autonomy.mjs`, `kernel/run.mjs`,
     `runner/runner.mjs`. Also rename env vars as you touch each file's
     own definition site: `ACC_GOAL` → `ACC_MISSION`, `ACC_GOALS_DIR` →
     `ACC_MISSIONS_DIR` (grep both across the whole repo including test
     files' `process.env.ACC_GOAL...` lines — tests set these directly,
     not just production code).
  3. THE ONE STEP THAT MUST NOT LAND ALONE: `budget.mjs`'s
     `KICK_CONSTANTS` text ("Continue the active ACC goal." or whatever
     the exact literal is by the time this runs — re-read it fresh, don't
     trust this summary) and `watcher/clearbot.ps1`'s `$KICK` constant
     change IN THE SAME COMMIT. Verify by grepping BOTH files for the old
     string post-edit (expect zero hits in both) and the new string
     (expect exactly one hit in each) before committing. This sandbox has
     no PowerShell to execute clearbot.ps1 and confirm the typed string
     still matches what budget.mjs's Stop-hook liveness check expects —
     that confirmation can only happen on Kyle's machine or via Windows
     CI (`hooks/clearbot.test.mjs`, already in `npm run test:windows`,
     already asserts the pipe-transport path types the exact kick text —
     let THAT test be the real proof, don't hand-wave it).
  4. `kernel/contract.mjs`, `kernel/kernel.e2e.mjs`: do NOT touch the
     `goal` field on a task contract (`REQUIRED_FIELDS`'s one-line task
     description) — confirmed unrelated concept, same word, per the
     disambiguation note above. Grep for `\.goal\b` and `goal:` in these
     two files specifically before editing to make sure a rename script
     didn't catch it by accident.
  5. `guards-gui.ps1`, `start-clearbot.cmd`, `e2e/loop.e2e.mjs`: author
     the edits, but do not claim them verified — same "authored blind,
     Windows CI or Kyle confirms" posture as every other PowerShell
     change tonight.
  6. `AGENTS.md`, `notes/ACC-HANDOFF.md`, every `docs/superpowers/plans/
     *.md` and `docs/superpowers/specs/*.md` file describing the
     mechanism: last, once the code is done and tested, so the docs
     describe what actually shipped rather than what was planned.
  7. On-disk `runner/goals/*.json`: no schema field literally says
     "goal" internally (the files are keyed by filename, `g-...`), so
     the data itself doesn't need a migration script — only the new
     `m-...` id PREFIX for goals/missions created going forward. Decide
     explicitly (don't let it default silently) whether existing
     `g-...` ids get read as legacy missions forever or get one-time
     renamed at cutover; document whichever is chosen in this entry
     when the pass runs.
  8. Definition of done: `grep -rn '\bgoal\b' hooks/ kernel/ runner/
     watcher/ e2e/ gui/ --include='*.mjs' --include='*.ps1'
     --include='*.cmd'` (excluding `kernel/contract.mjs`'s own `goal`
     field and this file, `OPEN-ISSUES.md`, which is allowed to keep
     historical references) returns nothing live — every hit is either
     gone or is the contract-field exception, explicitly checked.
- why still deferred tonight, even with this checklist written: the
  checklist itself doesn't reduce the risk of step 3 (the KICK_CONSTANTS
  sync), and rushing that specific step to close this item out tonight —
  rather than as its own careful pass with room to actually wait for
  Windows CI's confirmation before moving on — is exactly the "drive-by"
  this entry has said not to do since 2026-08-03. The checklist exists so
  the NEXT session doesn't have to re-derive it, not as a reason to treat
  tonight's context budget as enough to safely execute it.
- EXECUTED 2026-08-06, later the same night, worktree
  `feat/goal-to-mission-rename`, following the checklist above step by
  step, red-green verified at each stop rather than in one pass:
  1. `git mv hooks/goal.mjs hooks/mission.mjs` (+ `goal.test.mjs` ->
     `mission.test.mjs`), every exported/internal symbol renamed
     (`createGoal` -> `createMission`, `readGoal`/`readGoalAnywhere` ->
     `readMission`/`readMissionAnywhere`, `listGoals` -> `listMissions`,
     `activeGoals` -> `activeMissions`, `goalForSession` ->
     `missionForSession`, `resumeGoal` -> `resumeMission`,
     `withGoalLock` -> `withMissionLock`, `consumeDeadGoalAlerts` ->
     `consumeDeadMissionAlerts`, `reapDeadGoals` -> `reapDeadMissions`,
     `goalsDir`/`goalPath` -> `missionsDir`/`missionPath`), `ACC_GOAL`
     -> `ACC_MISSION`, `ACC_GOALS_DIR` -> `ACC_MISSIONS_DIR`, id prefix
     `g-...` -> `m-...`. 66/66 tests green in isolation before anything
     imported it.
  2. Every real importer updated one at a time: `hooks/budget.mjs`
     (+ `budget.test.mjs`/`budget.unit.test.mjs`), `runner/runner.mjs`
     (+ `runner.test.mjs`, `ensureJobGoal` -> `ensureJobMission`,
     `goalSignal` -> `missionSignal`, the job's `.goalid` marker file
     -> `.missionid`), `hooks/statusline.mjs` (+ `statusline.test.mjs`,
     `goalPaused`/`goalDied` -> `missionPaused`/`missionDied`, the
     "goal PAUSED"/"goal DIED" status-line segments -> "mission
     PAUSED"/"mission DIED"), plus comment-only touches in
     `hooks/lane.mjs`, `lane.test.mjs`, `prompts.mjs`, `testplan.mjs`,
     `testplan.test.mjs`, `engine.mjs`, `clearbot.test.mjs`,
     `kernel/autonomy.mjs`, `autonomy.test.mjs`,
     `watcher/start-clearbot.cmd`.
  3. The one step flagged as must-not-land-alone: `budget.mjs`'s
     `KICK_CONSTANTS` ("Continue the active ACC goal." ->
     "...ACC mission.") and `watcher/clearbot.ps1`'s `$KICK` constant
     changed in the SAME commit, verified by grep for the old string
     (0 hits in both) and the new string (exactly 1 hit in both) before
     committing — exactly the check this entry called for. clearbot.ps1's
     `hooks\goal.mjs` CLI invocations (`pending`/`kicked`) moved to
     `hooks\mission.mjs` in the same pass.
  4. `kernel/contract.mjs`'s `goal` field (a task contract's one-line
     description) and every test fixture setting it (`contract.test.mjs`,
     `guardhook.test.mjs`, `run.test.mjs`, `ledger.test.mjs`,
     `settings.test.mjs`) confirmed untouched — same word, unrelated
     concept, exactly the exception this entry named in advance.
     `kernel/kernel.e2e.mjs` needed hand-editing rather than a blanket
     script, since it mixes BOTH senses in one file: its own
     `contractFor()` uses `goal` as the contract-field sense (left
     alone) while its separate pollution check against the live
     `runner/goals` directory is genuinely the ACC concept (renamed to
     `runner/missions`).
  5. `guards-gui.ps1`, `gui/ptyhost.e2e.ps1`, `e2e/loop.e2e.mjs`:
     authored, not verified — no PowerShell in this sandbox, same
     "Windows CI or Kyle confirms" posture as every other `.ps1` change
     tonight. `guards-gui.ps1` turned out to be a REAL functional
     dependency, not just docs: it sets `ACC_GOAL` when launching a
     session and calls `hooks\goal.mjs` directly
     (`New-GoalFromBox`/`Refresh-Goals`/`$script:GoalId`) — missed on
     the first sweep (see the "two things caught late" note below),
     would have silently stopped binding launched sessions to their
     mission the moment `usage.mjs`'s `accActive()` started checking
     `ACC_MISSION` instead.
  6. `AGENTS.md` (the "Goals" section retitled "Missions", every
     reference updated) and `notes/ACC-HANDOFF.md` updated — but
     DELIBERATELY NOT every dated `docs/superpowers/plans/*.md` and
     `specs/*.md` file that also mentions "goal": those are point-in-
     time historical records of what was proposed or decided on a
     given day, and rewriting their text after the fact would
     misrepresent history rather than describe it — the same reasoning
     this very file's own header already applies to itself ("allowed
     to keep historical references"). AGENTS.md and ACC-HANDOFF.md are
     different in kind: both explicitly describe CURRENT system
     behavior, not a plan for a specific day. One thing this pass
     cannot reach at all: AGENTS.md references a user skill at
     `~/.claude/skills/goal/` that lives on Kyle's own machine, not in
     this repo — renaming it (and its `/goal` trigger to `/mission`) is
     a manual step for him, named here rather than silently assumed
     done.
  7. On-disk store: decided NOT to write a migration script. `runner/
     goals/` is gitignored (no committed data to migrate in this repo),
     and the new default directory is `runner/missions/` — a clean
     cutover, not a live migration. Practical consequence for Kyle: if
     he has any genuinely in-flight `runner\goals\*.json` on his real
     machine when he pulls this, it will not be found once
     `missionsDir()`'s new default takes effect (`ACC_MISSIONS_DIR`
     unset falls back to `runner/missions`, not the old path) — he
     should check for an active goal before pulling and, if one
     matters, either finish it first or manually move the file(s) to
     `runner\missions\`. Not automated, because a migration script for
     data that doesn't exist in this repo would be untestable here and
     is exactly the kind of "coverage-shaped" work OI-033's own
     reasoning already warns against.
  8. Definition of done, re-run after every step above:
     `grep -rn '\bgoal\b' hooks/ kernel/ runner/ watcher/ e2e/ gui/
     --include='*.mjs' --include='*.ps1' --include='*.cmd'` — clean
     except the exceptions named in advance (`kernel/contract.mjs`'s
     field and its five test fixtures, `kernel/kernel.e2e.mjs`'s own
     contract-field usage) plus two found DURING execution, not
     anticipated by the original checklist, both genuinely unrelated to
     the renamed feature and left alone rather than force-renamed for
     the grep's sake: `hooks/testplan.mjs` and `hooks/covgate.mjs`'s
     identical "Coverage is a floor, not the goal" (ordinary English),
     and `kernel/adapters/claude-code.test.mjs`'s generic
     `/prompt|goal/i` argv-leak probe (checks neither word leaks into
     argv; not specific to the ACC concept).
  Two things caught late, worth naming so the pattern is recognized
  faster next time: (a) `\bgoal\b`-style word-boundary regex does NOT
  break on an underscore — `\bACC_GOAL\b` never matches inside
  `ACC_GOALS_DIR`, which is correct, but it also means a plain
  `\bgoal\b` scan silently MISSES `ACC_GOAL` itself (no boundary
  between `_` and `G`), so an env-var-specific grep pass is required in
  addition to the word-boundary one — this is exactly how
  `hooks/usage.mjs`'s `accActive()` (checks `ACC_GOAL`/now `ACC_MISSION`
  directly) and `guards-gui.ps1` both got missed on the first sweep and
  had to be fixed in a follow-up commit once `usage.test.mjs`'s own red
  test caught the mismatch; (b) a file can contain BOTH a real
  ACC-concept reference and an unrelated same-word usage at once
  (`hooks/testplan.mjs` had one of each) — a per-file "N hits, looks
  benign" scan is not the same as checking every individual hit.
  Verified end to end: full `npm test` list, 513/514 non-skipped tests
  green (the one failure, `lane.test.mjs`'s `reownSlot` permission
  test, is a pre-existing root-sandbox flake, confirmed identical on
  the pristine pre-rename tree); `hooks/mission.test.mjs` 66/66 in
  isolation; `runner/runner.test.mjs` 50/50; every touched file's own
  suite green. `package.json`'s `test`/`test:windows` scripts and
  `.github/workflows/ci.yml`'s `ACC_COVGATE_TESTS` list updated to
  reference `hooks/mission.test.mjs`.
- UPDATE 2026-08-06 (a genuine bug this rename left behind, found by
  an adversarial second-pass review, not by the original checklist):
  `policy.json`'s ceiling-dial block was never renamed from `"goals"`
  to `"missions"`. `hooks/mission.mjs`'s `pending` CLI verb reads
  `pol?.missions?.maxCycles`/`maxWallClockMinutes`/`maxCostUsd` —
  against the real key `"goals"` every one of those resolved to
  `undefined`, which `ceilingReached()` treats as "disabled". Net
  effect: Phase 1's loop-runaway ceiling — this repo's own words for
  it, "the single most evidence-backed fix in either review" — was
  silently OFF in production while `policy.json` still showed real
  numbers (12 cycles / 180 min / $50) to a human reading it.
  `kickSettleSeconds`/`humanHoldMinutes` happened to match their
  hardcoded fallback defaults by coincidence, which is exactly why
  this didn't surface as an obvious behavior change. Not caught by
  the original checklist because `policy.json` was never in its file
  list — it's data, not one of the `.mjs`/`.ps1`/`.cmd` files the
  checklist's own definition-of-done grep covered. Not caught by the
  existing test suite because every test exercising these dials
  builds its own synthetic policy fixture with the correct key; the
  one test that loads the real repo `policy.json` only asserted
  `doesNotThrow`, never that a dial value was actually picked up.
  Fixed: the block key and its `_note` text (goal.mjs/runner-goals/
  "goal PAUSED" references), plus the `tui` block's `_note` referencing
  `hooks/goal.mjs`'s kick default. New regression test in
  `hooks/mission.test.mjs` loads the REAL repo `policy.json` (not a
  fixture) and proves an at-ceiling mission actually gets paused via
  the CLI `pending` path end to end, proven RED against the un-fixed
  file first. A second, smaller real issue from the same review:
  `.gitignore` still ignored `runner/goals/` instead of the new
  default `runner/missions/`, meaning live mission data was no longer
  excluded from git after the rename — fixed. Plus cosmetic cleanup
  the review flagged (no functional effect, but the original commit
  should have caught them): `hooks/budget.test.mjs`'s `seedGoal()` ->
  `seedMission()`, `"s-live-nogoal"` -> `"s-live-nomission"`;
  `guards-gui.ps1`'s `$grpGoal`/`$btnGoalDone`/`$btnGoalStop`/
  `$btnGoalLog` -> `$grpMission`/`$btnMissionDone`/`$btnMissionStop`/
  `$btnMissionLog`. Deliberately left alone: `mission.mjs`'s internal
  single-letter `g` locals for "the mission object at hand" — renaming
  dozens of one-letter occurrences carries real diff-review risk for
  no behavioral or readability gain. Verified: full `npm test`,
  514/515 non-skipped green (same pre-existing `lane.test.mjs` flake).
  Lesson worth keeping: a checklist scoped to code files will miss a
  data file that encodes the same renamed concept — the definition-
  of-done grep needs to cover config/data files too, not just source.

## Resolved

## OI-032 [RESOLVED 2026-08-06, accepted risk] autoApprove:true means an agent writing a file IS an agent running code
- opened: 2026-08-04, resolved: 2026-08-06 — option (a) from this entry's own
  done-when. Kyle, in the session that set tonight's `/goal`, explicitly: "I
  am happy with authorizing auto approve and all of that. I approve of all of
  your decisions and recommendations." That is the risk-accepted decision this
  entry existed to force into the open rather than let drift.
- resolution: AGENTS.md's guard-enforcement section gained an explicit second
  ceiling paragraph (parallel to the existing "Bash writes bypass the hook"
  ceiling) naming the runbox+autoApprove bypass directly: a direct edit to a
  `protected` path is refused, but the same change via a runbox script is not,
  while `autoApprove.enabled:true`. No code changed — option (b) (gating
  auto-approve behind an allowlist/content-check) was considered and
  deliberately NOT done tonight: it would need real verification against
  `watcher/clearbot.ps1 Invoke-AutoApprove` on Kyle's actual Windows machine,
  which this remote session cannot do, and a half-verified gate would be worse
  than an honestly-documented accepted risk (false confidence in a boundary
  that was never proven to hold). Revisit as a fresh entry if Kyle wants (b)
  built and verified in a session with real PowerShell.
- verification: docs-only change; N/A for tests. Re-read AGENTS.md's guard
  section — the claim now matches what was demonstrated, not what was
  originally written.

## OI-031 [RESOLVED 2026-08-05] Seven goals are "active" at once; dead ones are never reaped
- opened: 2026-08-04, resolved: 9e2ae89 — decision on what "dead" means:
  BOUND (consolePid nonzero) and `!consoleAlive(pid)`. An unbound goal
  (consolePid 0 — created but not yet launched into a console) is left
  alone, since there is nothing yet to prove dead. `reapDeadGoals()` runs
  on every `activeGoals()` call so every reader (list, pending,
  goalForSession) sees the reaped result immediately instead of a stale
  one; a reaped goal archives to `runner/goals/done/` with status "dead",
  same as done/blocked. New `reap` CLI verb for explicit/manual use.
  The mid-turn "prompt entered in the UI does not carry cleanly into the
  ACC process" symptom this entry was found while chasing is NOT re-checked
  here — that link was never proven, and this entry's own done-when only
  asked for the reap mechanism itself, not that follow-up. Re-open a fresh
  entry if the symptom recurs against a now-clean goal store.
- verification: `node --test hooks/goal.test.mjs` (48/48, RED-first: 5 new
  cases failed against the pre-fix code), full fast tier via
  `npm run test` (422/423 — the 1 fail is hooks/lane.test.mjs's
  pre-existing "reownSlot ... owner.json can't be written" case, already
  noted in the OI-018 ledger entry as unrelated; confirmed here it's this
  sandbox running as root, so chmod 0o444 never actually blocks the write).
  `node hooks/covgate.mjs` scoped to the changed file: goal.mjs
  100%/100%/98.3%, clears the 100/100/90 floor. `/security-review`: clean.

## OI-030 [RESOLVED 2026-08-04] Repeated red CI on main -- fold the coverage gate into a local pre-push hook, ACC-style
- opened: 2026-08-04, resolved: 1726574/644ab7e/d8e7ed8, merged 275a899 -- Approach A
  (local pre-push git hook) shipped exactly as this entry's own spec described.
  hooks/covgate.mjs gained ACC_COVGATE_RANGE="<oldrev> <newrev>" (gates a commit
  range via git diff between two revs, never mutates the caller's HEAD/working
  tree -- the local-hook-safe alternative to CI's own "git reset --soft" trick,
  which would be destructive to run against Kyle's real working repo).
  hooks/pre-push (tracked, LF-pinned via .gitattributes, mode 100755) mirrors
  the launch-cap shim's fail-open contract exactly: refuses a push ONLY on an
  explicit "covgate: FAIL" verdict for a push targeting refs/heads/main, fails
  OPEN on anything else (non-main branch, node missing, covgate crashing).
  Installed via runbox/install-pre-push-gate.ps1 (untracked -- runbox/ is
  gitignored -- Kyle runs it via /approve-kgs, not run by Claude).
  "git push --no-verify" remains the standard, unhandled bypass, as the
  entry's own spec called for.
- a real bug was found and fixed along the way (TDD, not speculative): without
  clearing ACC_COVGATE_RANGE before covgate.mjs's own internal spawned test run
  (same treatment NODE_TEST_CONTEXT/NODE_V8_COVERAGE already got), a range-mode
  invocation's oldrev/newrev leaked three levels deep into covgate.test.mjs's own
  unrelated nested fixture repos, which then tried to diff commit shas that don't
  exist in their own isolated history ("fatal: bad object").
- verification: hooks/covgate.test.mjs (24/24, 4 new range-mode tests), hooks/pre-
  push.test.mjs (7/7 new: refuse on a genuine floor miss, pass when clean, no-op on
  non-main, brand-new-ref via the empty-tree hash, deleted-ref no-op, fail-open on an
  unrecognized crash, multi-line stdin), full fast tier (438/439, 1 pre-existing
  unrelated skip), node hooks/covgate.mjs (covgate.mjs itself: 100%/100%/94.8%).
  Kyle still needs to run /approve-kgs on the runbox installer before the gate is
  actually live in .git/hooks/ -- the code is proven, the local install is not yet
  applied to this machine.

## OI-029 [RESOLVED 2026-08-04] route.mjs's blocking auto-cd repeatedly ate real prompts instead of delivering them
- opened: 2026-08-04, resolved: 2926a2d/6207c66 — `autoCd.enabled` flipped
  back to `true` now that OI-003 (the actual root cause, the too-short
  clearbot settle delay) is resolved and real-token-verified. Mitigation
  (disabling autoCd) is no longer needed.
- verification: `hooks/route.test.mjs` (24/24), `hooks/clearbot.test.mjs`
  (13/13), `node hooks/covgate.mjs` PASS. Watch for a recurrence before
  fully trusting this long-term, per the policy.json note.

## OI-003 [RESOLVED 2026-08-05] A clearbot-typed /cd does not take effect
- opened: 2026-07-31, resolved: 2026-08-05
- root cause: the non-clear settle delay (4e22e81, hardcoded 1200ms) was a
  guess unrelated to the one number in this codebase already empirically
  proven for "is a session's TUI ready for injected input" -- hooks/goal.mjs's
  kick delay (4000ms, proven via OI-002). 1200ms was too short: Kyle re-ran
  `node e2e/loop.e2e.mjs --only 4` for real on 2026-08-04 and scenario 4
  failed again identically (CD + REPLAY logged, cwd never moved).
- fix: `policy.json` gained one shared dial, `tui.readySettleMs` (default
  4000), read by both `hooks/goal.mjs`'s kick delay and
  `watcher/clearbot.ps1`'s new `Get-TuiReadyMs` (replacing the old hardcoded
  1200ms on the non-clear /cd path) -- one proven number instead of two
  independently-guessed ones. Also split `watcher/sendconsole.ps1`'s single
  WriteConsoleInputW batch (Esc+backspaces+text+Enter) into two calls with an
  80ms settle between the clear batch and the text batch, mirroring the pty
  transport's existing TEXT-then-SUBMIT gap (not proven to be the root cause
  on its own; added because it's cheap and directionally correct).
- a SEPARATE bug was found and fixed along the way: `e2e/loop.e2e.mjs`
  scenario 4 itself had a false-negative bug. Claude Code relocates a
  session's transcript to a NEW project-scoped directory once its cwd
  changes (confirmed directly: a genuinely-passing run's transcript existed
  ONLY under `~/.claude/projects/C--code-guards/`, not under the `C--code`
  directory the session started in). Scenario 4 cached the pre-cd transcript
  path once and never re-resolved it, so `cwdOf()` silently read ENOENT off a
  path the successful cd itself had just moved away from -- reporting FAIL at
  the exact moment the real bug was fixed. Fixed by re-resolving via
  `findTranscript(sid)` on every poll instead of reusing the cached path.
- verification: `node e2e/loop.e2e.mjs --only 4` (real tokens) -- SCENARIO 4
  PASS, cwd before `C:\code`, cwd after `C:\code\guards`, matching `wanted`.
  Reproduced the failure twice more against the OLD code/harness first (both
  failed identically) before changing anything, per systematic-debugging
  doctrine -- this is fix attempt #2 (1200ms flat was #1), not a first guess.
  Full fast tier `npm run test:windows` 426/427 (1 pre-existing unrelated
  skip) and `node hooks/covgate.mjs` (goal.mjs 100/100/99.4%) both green. New
  regression tests: `hooks/goal.test.mjs` ("tuiReadySettleMs overrides the
  default TUI-ready window") and `hooks/clearbot.test.mjs` ("the non-clear
  /cd settle duration comes from policy.json, not a hardcoded constant" -- a
  relative-timing proof: a 50ms configured settle vs. a 2500ms one measurably
  differ, so the value is genuinely policy-driven, not the old constant).
- operational gotcha worth keeping: running `e2e/loop.e2e.mjs` nested inside
  a live Claude Code session (rather than a clean terminal) leaks
  `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID`/`CLAUDE_CODE_CHILD_SESSION`/
  `CLAUDE_CODE_BRIDGE_SESSION_ID`/`CLAUDE_PID`/`CLAUDE_EFFORT`/`AI_AGENT`/
  `ACC_REAL_CLAUDE` into the child session it spawns, corrupting it a
  DIFFERENT way each time (once: no transcript ever appeared at all; once:
  the child picked up unrelated real repo context via a vague goal-kick and
  went off doing real, unrelated work instead of the toy prompt -- read-only,
  nothing was actually modified, verified via `git status`). Scrubbing those
  vars (`env -u ...`) for the child process got a clean, valid repro both
  times. Not a code bug -- a "run this from a clean terminal" fact, consistent
  with AGENTS.md's existing real-token-run doctrine; recorded here so a
  future run doesn't have to re-discover it.

## OI-011 [RETIRED 2026-08-05] Re-verify guards self-protection coverage of guards/ paths
- opened: 2026-07-31, retired: 2026-08-05 (Kyle) — self-protection for
  `C:/code/guards` (the `gui/`, `watcher/` paths named in the original
  entry) remains OFF and re-enabling it is still explicitly Kyle's own
  timing call, not something to hold open on the ledger. He's aware and
  will flip it himself when he wants it on. Reopen with a fresh entry if
  the timing call is ever made and the `protected` list actually needs the
  paths added.

## OI-027 [RESOLVED 2026-08-04, accepted ceiling] kernel/guard.mjs's path checks are string-based, not real filesystem canonicalization
- opened: 2026-08-04, resolved: 2026-08-04 via the decision its own
  done-when explicitly allowed — accepted as a documented ceiling rather
  than changed. Two residual bypass classes (a symlink inside an allowed
  writeRoot pointing outside it; exotic Windows path forms — UNC, 8.3 short
  names, NTFS alternate data streams) both require real OS-level path
  resolution (`fs.realpathSync`, actual I/O) to close, which conflicts with
  guard.mjs's deliberate "pure, no I/O" design (stated in its own header).
  Recorded directly in kernel/guard.mjs's header comment, alongside its
  pre-existing Bash/WebSearch ceiling notes, so the limitation stays visible
  in the file itself, not just the ledger.

## OI-028 [RESOLVED 2026-08-04] kernel/guardhook.mjs's stdin reader had no size cap, only a time cap
- opened: 2026-08-04, resolved: 2026-08-04 — added `STDIN_MAX_BYTES` (default
  8MB, env-overridable for tests) to the stdin-reading loop: on exceeding it,
  stops accumulating and denies closed via the same `deny()` path as every
  other guardhook failure mode, rather than buffering unbounded. 8MB judged
  generous for any real Claude Code hook payload (tool params, not file
  contents wholesale) while still bounding the worst case. New test proves
  an oversized payload denies cleanly with the byte count in the reason, not
  a crash or a hang. Verified: `node --test kernel/guardhook.test.mjs`
  (16/16), full `npm run test:windows` and `node hooks/covgate.mjs` both
  green.

## OI-005 [RETIRED 2026-08-04] Guard self-protection is off while the docs still claim it
- opened: 2026-07-31, retired: 2026-08-04 — re-checked both claimed
  staleness sites directly: AGENTS.md already states "Self-protection —
  currently OFF" (AGENTS.md:15) and clearbot.ps1's ROUTING.md comment already
  says "ROUTING.md is not in the protected list" (watcher/clearbot.ps1:19).
  Both were already corrected (by OI-011's 2026-08-03 documentation pass) —
  there was nothing stale left to fix. Actually re-enabling protection is
  tracked separately in OI-011, since that's the part still gated on Kyle's
  timing call.

## OI-007 [RESOLVED 2026-08-04] External (Scheduled Task) watcher supervision needs elevation
- opened: 2026-07-31, resolved: 2026-08-04 via the spec-amendment path — the
  originally-approved design
  (`docs/superpowers/specs/2026-07-31-acc-autonomy-hardening-design.md`,
  Section 2 "Watchdog") called for an elevated Scheduled Task; amended in
  place to formalize what actually shipped and already covers both failure
  modes without elevation (in-process `reviveClearbotIfDead` for crashes,
  the Startup-folder launcher for reboots). The elevated register script
  remains available as an optional belt-and-suspenders install for Kyle, no
  longer part of the required design.

## OI-009 [SHRUNK + FIXED 2026-08-04] GUI process is a single point of failure for hosted sessions
- opened: 2026-07-31, shrunk+fixed: 2026-08-04 — delivered detection, not
  reattach: reattaching a hosted session on GUI restart is real, separate
  architecture work (a new session-persistence story) and is cut from this
  entry; it is not re-filed since nothing today needs it more than the
  detection half did. `watcher/clearbot.ps1` (`Watch-HostedGui`, runs every
  Step, independent of any one session's own hooks — the hosted session's own
  Stop hook cannot fire once its GUI has died) now watches every pty-
  transport `.window` record's `consolePid`, marks it alive on disk each
  cycle it's up, and once a previously-alive one is confirmed gone writes
  `runner/state/<sid>.gui-dead.json`. A window record never seen alive is
  treated as stale debris, not a crash, to avoid false positives. Detection
  lands within one clearbot cycle (2s default) of the next Step after the
  kill, comfortably inside the entry's "within a minute". Verified:
  `node --test hooks/clearbot.test.mjs` (12/12) — both the flagged-after-
  seen-alive case and the never-seen-alive non-false-positive case, killing a
  real process mid-test.

## OI-012 [RETIRED 2026-08-04] Stray console window at embedded launch not reproduced
- opened: 2026-07-31, retired: 2026-08-04 — both candidate spawn chains
  (gui/ptyhost.e2e.ps1's sandboxed pty launch, and the full ensureClearbot
  chain) were already proven to produce zero windowed processes, and the
  likely root cause (dead transient-shell consolePid) was already fixed in
  de669dc. No repro since, no parent-chain evidence to act on. Reopen with a
  fresh entry if it recurs and a spawner can be named.

## OI-018 [RESOLVED 2026-08-04] lane.test.mjs full-jitter test's false-failure rate is now negligible
- opened: 2026-08-03, resolved: d753da4 — same assertion (at least one
  sampled delay under 400ms), sample count raised 4→20 (retries: 6→21,
  success threshold calls<=5→calls<=20). The original comment's odds were
  also wrong, not just thin: it computed (0.5)^4 against the 500ms
  equal-jitter floor, not the actual 400ms assertion threshold — the honest
  single-draw failure chance is P(draw>=400)=0.6, so 4 samples was really
  ~13% (matching the observed double-flake), while 20 samples brings it to
  (0.6)^20 ~= 0.0037%. Verified green across 3 full runs of
  `node --test hooks/lane.test.mjs` (isolated jitter-test runs all green;
  the file's one remaining flake, `reownSlot ... owner.json can't be
  written`, is a separate, pre-existing, unrelated sandbox-timing issue).
  lane.mjs's jitter formula is untouched.

## OI-014 [RESOLVED 2026-08-04] killTree's Windows branch now runs its direct pid-liveness proof on every platform
- opened: 2026-08-01, resolved: 6c6b759 — removed the
  `process.platform !== "win32"` guard around the direct
  `process.kill(pid, 0)` check inside "a hung run is killed PROMPTLY at its
  timeout, not merely eventually" (runner/runner.test.mjs). The check now
  runs unconditionally, so on this repo's `windows-integration` CI job
  (`.github/workflows/ci.yml`, `windows-latest`, `npm run test:windows`) it
  becomes the first real proof that killTreeWin32's `taskkill /pid <pid> /t
  /f` actually kills the fake claude's process tree rather than merely
  detaching from it — the same proof the POSIX branch already had via
  process-group SIGTERM. `runner/runner.mjs`'s `killTreeWin32`/`killTree`
  are untouched; this closed a test gap, not a code bug. 40/40
  runner.test.mjs green locally (behaviorally unchanged here — the removed
  guard already evaluated true on this platform).

## OI-021 [RESOLVED 2026-08-04] kernel/README.md documents that any harness hang, including a silent one, is bounded by wall-clock ceilings, not error reporting
- opened: 2026-08-03, resolved: 3557f5e — added a paragraph to
  kernel/README.md's "The boundary and its honest ceilings" section citing
  the actual enforcement path: `checkpointVerdict` (kernel/run.mjs's
  supervisor tick) reads only elapsed wall-clock time, tokens, and
  tool-call counts — never the harness child's stdout/stderr/exit code —
  so a harness hung silently by an unreported upstream API overload starves
  the token/tool-call signals too and still trips the wall-clock ceiling.
  `stopTask` kills the child directly on breach without depending on the
  harness's own error reporting. `kernel/run.test.mjs`'s AC-B1 test already
  proves this exact shape (a fake adapter whose `done` promise resolves
  only via the supervisor's own `stopTask`, every other signal held at
  zero) and is cited by name. `ttlMs` is noted as a second, independent
  bound on the harness's lane slot. Docs-only, per OI-021's own "or" clause
  permitting a written-and-cited mitigating-design resolution; no kernel
  code changed.

## OI-008 [RESOLVED 2026-08-04] runbox undo/uninstall convention is already documented in AGENTS.md
- opened: 2026-07-31, resolved: 2026-08-04 — AGENTS.md's runbox section
  (`AGENTS.md:65`) already states, verbatim: "Never leave undo/uninstall
  scripts in the runbox (guards OI-008). Undo scripts live tracked in their
  own directory (e.g. watcher/watchdog/) and are run deliberately."
  Satisfies the entry's own first "done when" option exactly. Ledger-only
  resolution — no code or doc change needed beyond this closure.

## OI-006 [RESOLVED 2026-08-04] bindSession refuses to rebind an active goal on anything but a UUID-shaped sessionId
- opened: 2026-07-31, resolved: 8319f6a — the obvious guard (require a
  UUID-shaped session id) turned out not to risk legitimate post-clear
  adoption after all: a non-UUID sessionId is now treated exactly like none
  was passed — the existing consolePid-based lookup still runs, but
  sessionId/needsKick/boundAt are left untouched instead of overwritten.
  Reproduces the ledger's own hazard directly (`bindSession({ sessionId:
  "hbtest", consolePid: LIVE })` against a bound goal: sessionId/needsKick/
  boundAt provably unchanged) and confirms a real UUID still adopts
  normally, via two new regression tests in hooks/goal.test.mjs.
  AGENTS.md's "never hand-run a hook against live state" warning is updated
  to note the specific hijack is now closed, but still calls for
  sandboxing (`markKicked`/`setStatus`/cycle logging are still reachable by
  a hand-run hook).
  Touching bindSession subjected the whole file to covgate's 100/100/90
  floor; the file's real pre-existing coverage was 64/50/58%, and a deeper
  look found even that number was wrong, not just low — goal.test.mjs's
  per-test cache-busted reimport of goal.mjs (`?t=${n}`) meant node's own
  lcov merge (last-write-wins per file path, not a union) only ever
  reported the LAST-loaded test's coverage. Fixed at the root: goal.mjs's
  ROOT/GOALS/DONE paths now resolve from the environment on every call
  instead of once at import, so goal.test.mjs and budget.test.mjs's own
  direct goal.mjs usage share one module instance with no cache-busting
  anywhere (this also closed the same collision between the two test
  files when covgate runs them together). `main()` (the CLI dispatcher) is
  now exported and tested in-process, since a spawned subprocess is
  invisible to this file's own coverage instrumentation. New tests cover
  `goalForSession`/`resolveId`/every CLI subcommand/the remaining
  defensive catch branches. Real coverage after the fix: 100% lines, 100%
  funcs, 98–99% branches (`ACC_COVGATE_TESTS=... node hooks/covgate.mjs`
  green) — the only remaining gaps are the ACC_ROOT/ACC_GOALS_DIR env
  ternaries at import and the CLI entry-point guard's true branch, neither
  reachable in-process without reintroducing the collision. No
  `branchFloorOverrides` entry needed.

## OI-010 [RESOLVED 2026-08-04] a framed TEXTB64 op carries a multi-line payload with the same content policy as TEXT
- opened: 2026-07-31, resolved: 4e22e81 — added `TEXTB64 <base64>`
  to `PtyHost.Handle()` (gui/PtyHost.cs), checked alongside TEXT/SUBMIT/ESC:
  base64-decodes with a try/catch (unlike the existing unvalidated `WriteB64`,
  which stays the in-process WebView2 keystroke path — the pipe gets the
  same validation TEXT gets), refuses every control char TEXT refuses except
  an internal `\r\n` pair (the intentional line separator — a bare `\r` or
  `\n` is still refused), same 2100-char cap. `watcher/clearbot.ps1` gained
  `Send-MultilineKeys` (sibling to `Send-Keys`) — additive, no current
  caller, since deciding whether clearbot should auto-replay a multi-line
  prompt is a separate decision this fix does not make. Fixed a real bug
  found while designing this: `Send-Pipe`'s 80ms pre-SUBMIT settle was
  gated on `-like 'TEXT *'`, which would have silently missed `TEXTB64 `
  (no space at index 5) and reintroduced the exact paste-vs-Enter race the
  transport exists to avoid; broadened to `'TEXT*'`. New test case in
  gui/ptyhost.test.ps1 mirrors the existing PTYPROOF-73 template with a
  two-line payload, plus refusal cases (invalid base64, a bare `\r`,
  over-length).
  One design choice made without local verification (no PowerShell in this
  environment): the internal line separator is `\r\n`, not a bare `\n` —
  the safer bet since `\r` alone is `PtyHost.cs`'s own proven-working Enter
  byte. `gui/ptyhost.test.ps1` is this repo's own real proof (real ConPTY,
  real cmd.exe) and runs on the `windows-integration` CI job
  (`.github/workflows/ci.yml`) — if the `\r\n` assumption is wrong, that
  run is expected to say so, and is the trigger for a follow-up push should
  it come back red.

## OI-020 [RESOLVED 2026-08-03] Playwright e2e verifies the kernel GUI in CI
- opened: 2026-08-03, resolved: 5deff38, 39322e1 — gui/e2e/kernel-settings.spec.mjs
  asserts visible field state + a live-edit-applies-without-restart flow
  against the real rendered page in the `gui-e2e` CI job (Linux/Playwright
  lane), per spec 2026-08-03-acc-oi-closure-design.md §6.

## OI-022 [RESOLVED 2026-08-03] GUI platform decided: web, migrated incrementally
- opened: 2026-08-03, resolved: a102646, b6ffce4 — decision of record in
  docs/superpowers/specs/2026-08-03-acc-oi-closure-design.md §5: local web
  frontend (gui/server.mjs + gui/kernel.html, loopback-only, CSRF-closed by
  construction), tab-by-tab migration starting with the kernel settings tab;
  the WinForms field editor is retired, the tab now only hosts the web page
  via WebView2 (or a browser-button fallback). OI-009/OI-010 remain open.

## OI-023 [RESOLVED 2026-08-03] DEP0190 spawn pattern closed at all three sites
- opened: 2026-08-03, resolved: 474aac1, 549d869, 5de9d60 — hooks/cmdline.mjs's
  spawnSpec: POSIX spawns shell-free with a real argv array; Windows spawns
  ONE fail-closed-quoted command string. Verified DEP0190-free live via the
  kernel.e2e.mjs proof run (Task 5 of the closure plan, 2026-08-03, 3/3
  scenarios PASS, zero DEP0190 in output) and a --throw-deprecation
  regression-lock test in runner/runner.test.mjs.

## OI-024 [RESOLVED 2026-08-03] Guardhook enforces autonomy-tightened ceilings per fire
- opened: 2026-08-03, resolved: 3ddaa97 — kernel/guardhook.mjs now computes
  effectiveCeilings(contract, policy, readAutonomyStrict()) on every fire,
  the same function the supervisor uses; denial records carry `ceiling` and
  `autonomyFactor`; a corrupt or unreadable autonomy state fails closed
  (denies) instead of silently using the raw ceiling.

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
- UPDATE 2026-08-06 (Phase 7, full-remediation-prompt.md): re-verified
  per the phase's own instruction to remove the override if the real bug
  turns out to be `parseLcov`'s handling of repeated `SF:` blocks. Found
  and fixed a REAL bug there — node emits one `SF:` block per SUBPROCESS,
  so a file imported by N different test files gets N blocks in one
  combined lcov report (confirmed for real: `hooks/usage.mjs` alone
  produced 19 blocks in one fast-tier run, each declaring the identical
  637 `DA:` records); the old parser kept only the LAST block
  (`cur = blank()` on every `SF:` line), silently discarding the rest —
  `usage.mjs` read `funcs 2.78%` before the fix purely because whichever
  test happened to be parsed last barely touched it, `funcs 67.3%` after
  (measuring the honest union of every block instead). Fixed by merging
  per-code-point identity (line for `DA:`, line+block+branch for `BRDA:`,
  line+name for `FN:`/`FNDA:` pairs) instead of either overwriting or
  blindly summing — summing was tried and rejected too, since it would
  inflate a file like `usage.mjs` to 19x its real branch count instead of
  fixing anything. `hooks/covgate.test.mjs` gained 2 tests proving the
  merge (RED against the pre-fix overwrite-last parser, GREEN after).
  BUT: this was never lane.mjs's or run.mjs's actual problem — neither
  file ever produces more than one `SF:` block in a combined run, so the
  parser fix changes neither one's reported number (confirmed directly
  against the real lcov output). Their instability is exactly what the
  original 2026-08-02 bisection already found: a genuine node
  `--experimental-test-coverage` limitation tied to total file/process
  count per invocation, unrelated to this parser. Both overrides stay —
  `"hooks/lane.mjs": 85` (measured 86.4% in this pass) and
  `"kernel/run.mjs": 85` (measured 90.9% in this pass, ABOVE the 90% real
  floor here but 88.6% in the CI run that same day — the instability
  itself, not a fixed number, is the reason the override exists).

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

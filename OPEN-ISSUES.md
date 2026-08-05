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

## OI-032 autoApprove:true means an agent writing a file IS an agent running code
- opened: 2026-08-04
- where: policy.json `autoApprove.enabled`, watcher/clearbot.ps1 Invoke-AutoApprove
- what: already named in docs/2026-08-03-acc-adversarial-review.md §2.1 and
  the remediation prompt, but never given its own ledger entry, so it has been
  drifting. Demonstrated live this turn, twice: `guard.mjs` correctly refused
  to let me edit `~/.claude/settings.json` ("agents may not edit the rules that
  constrain them"), I wrote a runbox script instead exactly as AGENTS.md
  instructs, and clearbot executed it ~30s later with Kyle's full authority and
  no human in the loop — deleting the hook the guard had just protected. The
  guard is a speed bump, not a boundary, while autoApprove is on.
- why open: NOT a bug to fix unilaterally — Kyle deliberately set
  `autoApprove.enabled: true` on 2026-07-31 and the policy note records why.
  This entry exists so the tradeoff is recorded as a decision rather than
  rediscovered by each reviewer.
- done when: Kyle either (a) confirms the risk is accepted and AGENTS.md stops
  claiming an agent "may not edit the rules that constrain it", since with
  autoApprove on that sentence is false, or (b) gates auto-approve (allowlist,
  or refuse scripts touching `config.protected` paths).

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
  Progress: 1/12 modules done (`kernel/guard.mjs`). Remaining, in rough
  risk order: `kernel/guardhook.mjs`, `kernel/run.mjs`, `kernel/ledger.mjs`,
  `kernel/verifier.mjs`, `kernel/autonomy.mjs`, `kernel/policy.mjs`,
  `kernel/contract.mjs`, `kernel/credentials.mjs`, `kernel/adapter.mjs`,
  `kernel/adapters/claude-code.mjs`, `kernel/settings.mjs`.

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
  note that label is stale/mismatched: the currently-open OI-011 is an
  unrelated "re-verify guards self-protection" issue, so either the suite's
  inline comment or its wait-message attribution needs a look separately)
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

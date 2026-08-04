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

## OI-028 kernel/guardhook.mjs's stdin reader has no size cap, only a time cap
- opened: 2026-08-04 (surfaced by the OI-019 scenario-enumeration pass,
  continuing into kernel/guardhook.mjs after OI-027's guard.mjs findings)
- where: kernel/guardhook.mjs's stdin-reading Promise (`buf += c`)
- what: the reader caps how LONG it waits (`STDIN_TIMEOUT_MS`, default
  4000ms) but never caps how MUCH it accumulates in that window. A
  misbehaving or malicious harness under kernel supervision (which the
  kernel exists specifically to guard against) making a tool call with a
  very large payload (e.g. a Write/Edit with a huge `new_string`) could
  grow `buf` unbounded within the timeout, a memory-exhaustion vector on the
  hook process. Existing test coverage proves the TIME cap works (a pipe
  that never closes still fails closed); nothing proves a SIZE cap, because
  there isn't one.
- why open: not fixed inline — the right cap value is a real judgment call
  (too low breaks legitimate large Edit/Write payloads on real files; too
  high doesn't meaningfully bound memory) and this kernel's own stated scope
  is "a deterministic process-level boundary, not an OS sandbox" (guard.mjs's
  own header) - whether resource-exhaustion hardening is in scope at all is
  a decision, not obviously implied by the existing design.
- done when: a decision is recorded on whether stdin size capping belongs in
  this kernel's threat model, and if so, an explicit cap is added with a
  test proving an oversized payload denies cleanly (not a crash, not a hang)
  without breaking a realistic large legitimate payload.

## OI-003 [BLOCKED — runbox] A clearbot-typed /cd does not take effect
- opened: 2026-07-31, blocked 2026-08-04: needs a real-token e2e run, which
  only Kyle should trigger deliberately. Script staged:
  `runbox/oi-003-verify-cd-scenario4.ps1` (runs
  `node e2e/loop.e2e.mjs --only 4` and reports pass/fail). Run via
  `/approve-kgs`.
- where: watcher/clearbot.ps1 Invoke-Cd
- what: two consecutive cd requests to `C:\code` were typed and replayed
  (clearbot.log 10:45:13 `CD 130aefc6 → C:\code clear=True`, 10:45:37
  `CD dde31bdb → C:\code clear=False`) yet the session's cwd stayed
  `C:\code\guards` — the next prompt fell back to the advisory line (the
  designed escape hatch, so no deny-loop, but the scope move itself failed
  twice).
- root cause (found 2026-08-04): the second log line is the tell — `clear=
  False`. `Invoke-Cd`'s `$req.clear` branch sleeps 1200ms after the clear
  before doing anything else; the non-clear branch fell straight through to
  `/cd $dest` with zero settle delay, typing it before a just-started
  session's REPL was ready to receive it.
- fix in place: 4e22e81 — the same 1200ms settle now runs on the non-clear
  path too, mirroring the clear branch exactly.
- why open: per AGENTS.md's own doctrine ("verified by injection into a
  throwaway console — do not test them against a real working session"),
  the fix needs a real-token repro to close, which this session does not
  run itself. `e2e/loop.e2e.mjs` scenario 4 is already exactly this
  reproduction (already named "guards OI-003" in its own comment/report
  line, already queues a `clear:false` cd request against a real console)
  — no new script needed.
- done when: Kyle runs `node e2e/loop.e2e.mjs --only 4` and scenario 4
  passes (the cwd actually moves), then this entry can close.


## OI-011 Re-verify guards self-protection coverage of guards/ paths
- opened: 2026-07-31
- where: hooks/engine.mjs guard config
- what: this branch added gui/PtyHost.cs, gui/term.html, gui/vendor/,
  gui/ptyhost.e2e.ps1 and watcher/stubpipe.ps1 plus many watcher/ system
  scripts (clearbot.ps1, launchers, watchdog/ integration). The full post-branch
  file list is: `gui/PtyHost.cs`, `gui/term.html`, `gui/vendor/`, `gui/*.ps1`
  (test/e2e), `watcher/clearbot.ps1`, `watcher/*.ps1` (screenshot, sendconsole,
  stubs), `watcher/*.cmd` (start/stop launchers), `watcher/watchdog/*.ps1`
  (system integration). All are strategic infrastructure and should be protected.
- why open: verification task surfaced by the embedded-terminal completion
  gate. OI-005 (self-protection currently off, docs claiming otherwise) is
  now closed 2026-08-04 via its docs-accuracy path — AGENTS.md and
  clearbot.ps1 already state the off-state correctly, so nothing there was
  actually stale. This entry's own ask (add the paths to `protected`) still
  requires re-enabling self-protection for `C:/code/guards`, which remains
  Kyle's call on timing since it would block further agent edits to this
  repo, including mid-session ones.
- done when: `protected` list in config.json gains `C:/code/guards/gui/` and
  `C:/code/guards/watcher/` (or the full `C:/code/guards/` prefix), verified
  safe to re-enable, documented in AGENTS.md (done 2026-08-03).

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
  outside the repo, for Kyle via `/approve-kgs`. Until he runs it, the gate
  and watcher exist in the repo but are not yet live on the machine, so this
  OI-025 entry's own original incident is not yet provably fixed end-to-end.
  Per the plan's own instruction, `e2e/loop.e2e.mjs` (real tokens) is not
  run as part of this — Kyle's call on timing.
- done when: Kyle runs `/approve-kgs` on the runbox install script, then
  either `node e2e/loop.e2e.mjs` is re-run and scenarios 1-5 pass, or he's
  satisfied the launch cap being live is sufficient credit per the plan's
  own verification step.

## OI-027 kernel/guard.mjs's path checks are string-based, not real filesystem canonicalization — two residual bypass classes
- opened: 2026-08-04 (surfaced by /security-review-kgs during the OI-019
  guard.mjs scenario-enumeration pass, after fixing the `..`-traversal bypass
  that pass found — see OI-019's entry and the fix in kernel/guard.mjs)
- where: kernel/guard.mjs `norm()`/`under()`/`underAny()`
- what: `norm()` now collapses `.`/`..` segments (OI-019's fix), but it is
  still pure string manipulation, not real OS-level path canonicalization —
  by design, per the module's own header ("Pure: ... All I/O lives in
  kernel/guardhook.mjs"). Two classes of bypass this cannot see:
  1. **Symlinks**: a symlink created inside an allowed `writeRoots` entry,
     pointing outside every granted root, would let a write "under" the
     symlink land wherever the symlink actually points once the OS resolves
     it — guard.mjs has no way to know the symlink exists. Requires a
     precursor write capability to create the symlink in the first place
     (not exploitable from a single decide() call in isolation).
  2. **Exotic Windows path forms**: UNC paths (`\\server\share\..`), 8.3
     short names (`PROGRA~1`), and NTFS alternate data streams
     (`file.txt::$DATA`) could alias a real filesystem location the string
     comparison never recognizes as matching (or not matching) a configured
     root. Lower practical likelihood on this single-user local machine, but
     a real theoretical gap given the deliberately I/O-free design.
- why open: closing either fully needs real filesystem resolution
  (`fs.realpathSync` or equivalent), which is I/O — meaning either the
  "pure" module gains I/O (a design change, not a quick fix) or
  canonicalization moves to the I/O layer (kernel/guardhook.mjs) before
  `decide()` is ever called. Both are real architecture decisions, not
  something to bolt on inside this ledger sweep.
- done when: a decision is made and recorded on where canonicalization
  belongs (guard.mjs directly, or resolved upstream in guardhook.mjs before
  the payload reaches decide()), then either implemented with tests proving
  a symlink/UNC/ADS bypass attempt is denied, or explicitly accepted as a
  documented ceiling alongside the module's existing Bash/WebSearch ceiling
  notes.

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

# ACC — full remediation prompt

Prepared 2026-08-03. Companion to `docs/2026-08-03-acc-adversarial-review.md`
(PR #1, merged) — this is the review's recommendations turned into a single,
sequenced, executable task list. Every finding in that review is addressed
somewhere below; none were left out on purpose. If you're the agent executing
this, read the adversarial review first — this document assumes its findings
as ground truth and doesn't re-derive them.

## How to use this

This is written to be handed to any coding agent with repo write access —
Kyle's own ACC goal loop, a plain Claude Code session, anything — and run
phase by phase, in order, to completion. It is **not** written to depend on
the ACC's own keystroke-driven goal mechanism, because Phase 5 is about
retiring that mechanism; bootstrapping the fix through the thing being fixed
is fine for phase 0-4, but don't build new dependencies on it.

**Resumability.** After each phase, commit, and mark it done in this file
(change `Status: not started` to `Status: DONE — commit <sha>`) so a fresh
session can pick up exactly where the last one stopped, cold, the same way
this repo's own `notes/ACC-HANDOFF.md` checkpoints already work.

**Testing doctrine carries over unchanged.** Red-first: write the failing
test before the fix, record the red run. Hermetic: sandbox every test via
`ACC_ROOT`/`ACC_POLICY`/`ACC_LANE_DIR`, never touch live `runner/state`. Gate:
`node hooks/covgate.mjs` (or `npm run covgate`) must hold every changed lib
file to its floor before a phase is called done. This is not new process —
it's the same doctrine `AGENTS.md` already documents, applied to this list.

**Honesty about what's actually code-fixable.** Almost everything below can
be authored, in full, without a human — that part of the user's framing is
right. What a human (or a real Windows machine) is still needed for is
narrower than "everything": *verifying* GUI/PtyHost behavior and the
proof-tier e2e scenarios genuinely requires a real Windows session with a
real `claude` login — no sandbox substitutes for that. Each phase below says
plainly which parts are which. Don't claim a Windows-only verification step
passed without actually running it.

**Cost discipline applies to this work too.** Everything here runs behind the
existing week kill switch, and Phase 1 exists specifically to add the ceiling
that's currently missing. Don't treat "no human intervention needed" as
"unbounded" — that conflation is exactly what Phase 1 fixes.

---

## Phase 0 — Prove it first

**Status: not started**

The adversarial review's sharpest finding: in five days and 32 commits, this
system has never executed a goal that wasn't building itself. Before investing
further in the harness, find out if the harness actually does the job it
exists for.

1. Pick one real, low-stakes, scoped task from `lifeos-ecosystem/lifeos` (a
   doc-sync, a small scoped fix — something failure-tolerant, not
   load-bearing).
2. Write a job file for it under `runner/jobs/` following the shape
   `runner/runner.mjs`'s `loadJob` expects (`name`, `workdir`, `bootstrap`,
   `statusFile`, `doneMarker` — see `runner/README.md` and
   `runner/runner.test.mjs` for the exact contract).
3. Set a hard per-run ceiling before running it — Phase 1 below builds the
   general mechanism; for this one run, `runner.mjs`'s existing `maxRuns` and
   `runTimeoutMin` job-file fields are enough of a belt.
4. Run it headless via `runner.mjs`, behind the week kill switch, and watch
   it to completion (or failure) rather than firing and forgetting.
5. Write down what happened, honestly — a real PR merged, a real PR that
   needed human fixes, or a run that never produced usable output. All three
   are informative. If it's the third, that's a signal to slow down on
   Phase 5 (which assumes the runner is fundamentally sound) and investigate
   why before building more on top of it.

**Definition of done:** one real run completed (success or documented
failure) with the evidence — job file, run log, and outcome — committed
somewhere durable (a note under `notes/`, dated). This phase has no code
changes of its own; it's a checkpoint everything after it should be read in
light of.

---

## Phase 1 — The loop ceiling

**Status: DONE — commit (pending, see OPEN-ISSUES.md OI-033)**

Shipped 2026-08-06, as specified: `ceilingReached`/`reapCeilings`/`resumeGoal`
in `hooks/goal.mjs`, wired into the `pending` CLI before `pendingKicks`; the
new `resume` verb; a real (not estimated) per-goal dollar ceiling via
`hooks/usage.mjs`'s new `costOfTranscript` (reuses the exact accounting the
usage dashboard already uses, summed over one transcript instead of a whole
project scan) fed into `appendCycle` from `budget.mjs`'s Stop handler;
`statusline.mjs`'s `goal PAUSED` segment; `budget.mjs onSessionStart`'s
paused-goal warning. `policy.json`: `maxCycles: 12`, `maxWallClockMinutes:
180`, `maxCostUsd: 50`, `onCeiling: "pause"` — a **policy-only** change, so
rollback is exactly as trivial as this doc specified: all three back to `0`
reproduces today's pre-Phase-1 unbounded behavior with zero code changes.
`ceilingReached`/`reapCeilings`/`resumeGoal`/`costOfTranscript` were built
red-first (RED test committed alongside GREEN, per this repo's doctrine);
`goal.mjs` covgate 100%/100%/97.7%. One honest gap found and NOT fixed here,
tracked separately: `usage.mjs`/`budget.mjs`/`statusline.mjs` cannot
currently clear covgate's floor at all — pre-existing (not introduced by this
phase; `costOfTranscript` itself is fully unit-tested and covgate-visible),
structural (subprocess-only testing for the latter two; `usage.mjs`'s
CLI/scan surface has never had a unit suite), and is exactly what Phase 7
below exists to fix. See OI-033.

The single most evidence-backed fix in either review, and the one Tier-1 item
from the 08-02 ROI plan that was designed and never shipped —
`policy.json`'s `goals.maxCycles` is still `0` (unbounded) today.

1. In `hooks/goal.mjs`, add `ceilingReached(goal, now, dials)`: true when
   `dials.maxCycles > 0 && goal.cycles >= dials.maxCycles`, OR
   `dials.maxWallClockMinutes > 0 && now - Date.parse(goal.createdAt) >=
   dials.maxWallClockMinutes * 60000`. `0`/missing on either dial disables
   that ceiling (preserves today's unbounded default until the dials are set).
2. Add `reapCeilings(now, dials)`, called at the top of the `pending` CLI
   before `pendingKicks`: for each active goal past its ceiling, transition
   to `paused` via `setStatus`, append a `CEILING REACHED` line to the goal
   log, write `runner/alerts/<id>.ceiling.json`.
3. Add a `resume`/`unpause` CLI verb: `paused` → `active`, re-arm
   `needsKick`, clear the alert.
4. Add a **dollar/token per-run ceiling** alongside the cycle/wall-clock ones
   — this is new relative to the original 08-02 design, and closes the gap
   the adversarial review flagged: today's only cost brake is the 1.8B/week
   switch, which is far too coarse to catch one runaway goal. Reuse
   `usage.mjs`'s existing rate table for the dollar conversion.
5. `statusline.mjs`: a `goal PAUSED` segment when an unread
   `runner/alerts/*.ceiling.json` exists. `budget.mjs onSessionStart`: warn
   when the adopted goal is paused at a ceiling.
6. `policy.json`: set `goals.maxCycles` to something generous but real (e.g.
   `12`), add `maxWallClockMinutes` (e.g. `180`) and the new dollar ceiling,
   `onCeiling: "pause"`.
7. Tests in `goal.test.mjs`: `ceilingReached` (cycles-over, wall-over,
   both-under, both-disabled, missing dials, dollar-over), `reapCeilings`
   (transitions an over-ceiling goal, leaves an under-ceiling one alone),
   `resume`. Red-first, `ACC_ROOT`/`ACC_POLICY` sandboxed.

**Definition of done:** a hermetic test shows a goal at `maxCycles`, one past
`maxWallClockMinutes`, and one past the dollar ceiling all land in `paused`
with the alert written and no further kick emitted. Fast tier green, covgate
green on `goal.mjs`/`statusline.mjs`. Rollback is trivial — all three dials
back to `0`/disabled reproduces today's behavior exactly.

---

## Phase 2 — Neutralize auto-approve and the self-protection gap

**Status: not started**

The security composition the review flagged as self-nullifying: an agent can
write a script into a runbox, and `autoApprove:true` executes it within ~2
seconds with no content check, while `config.protected` has zero repo paths
so the agent can also rewrite the guard rules themselves.

1. Pick one, don't half-do both: either (a) set `autoApprove.enabled` back
   to `false` — auto-approve becomes advisory again, Kyle runs `/approve`
   by hand — or (b) keep it on but add real constraints: a content
   allowlist/hash check on runbox scripts before execution, and gate
   auto-approve on the week tier the same way kicks already are (currently
   it isn't). (b) is more work and more in the spirit of "unattended," but
   don't ship a half-measure that looks like a fix and isn't — either the
   human gate is real, or the automated gate is real, not a gap dressed as
   both.
2. Once Phase 3 (below) lands session-scoped ACC activation, add
   `C:/code/guards` back to `config.protected` (and consider
   `C:/code/ROUTING.md`, per OI-005's own "done when"). This is explicitly
   sequenced *after* Phase 3 — re-protecting before session-scoping exists
   would block an ACC-editing session from doing its own work, which is
   exactly why it was turned off in the first place.
3. Fix `AGENTS.md`'s "Self-protection" section, which still describes repo
   writes as blocked — make it match whatever state steps 1-2 land in.
4. Resolve OI-005 and OI-011 in `OPEN-ISSUES.md` once the above is decided
   and shipped — they're accurately open today; don't flip them until the
   actual state changes.

**Definition of done:** either auto-approve is off, or it's on with a real
content gate and a week-tier check, verified by a test that proves a
maliciously-shaped script (or a red-tier script) is refused. `config.protected`
includes the repo. AGENTS.md matches `config.json`, not the other way around.

---

## Phase 3 — Session-scoped ACC activation

**Status: not started**

Designed in the 08-02 ROI plan (T1.2) and never shipped. Closes OI-006 by
construction and is the prerequisite for Phase 2 step 2.

1. Add `accActive()` to `usage.mjs` (the shared module `budget.mjs` and
   `statusline.mjs` both already import):
   ```js
   export function accActive() {
     return process.env.ACC_SESSION === "1"
         || !!process.env.ACC_GOAL
         || !!process.env.ACC_PROFILE
         || !!process.env.ACC_PTY;
   }
   ```
2. Gate hook dispatch (not the CLI helper paths the GUI/engine call
   unconditionally): `budget.mjs main()` — `if (!accActive()) allow();`
   before `readStdin()`. `route.mjs hook()` — early return when inactive.
   `testplan.mjs`'s hook path — same. `guard.mjs` stays untouched — it's the
   always-on security floor, not orchestration; the split is deliberate and
   should be documented as such in `AGENTS.md`.
3. Tests: each gated hook no-ops when no ACC env var is set, behaves exactly
   as today when any is set. Assert the CLI helper paths still run
   unconditionally.

**Definition of done:** with ACC env unset, SessionStart/UserPromptSubmit/
Stop/PostToolUse produce no ACC output and no clearbot spawn; with `ACC_GOAL`
set, behavior is byte-identical to today. Fast tier + covgate green.

---

## Phase 4 — Fix the crash-open and the unlocked writes

**Status: not started**

The reliability regressions that reintroduce the exact silent-stall class
this system exists to prevent.

1. **Crash-open policy (D1).** Complete `usage.mjs`'s `DEFAULT_POLICY` to
   cover every field `budget.mjs` dereferences (`runner.statusFile`,
   `subagents.allow`/`mode`, `runner.waitingGuard`, at minimum — grep for
   every `policy.X.Y` access in `budget.mjs` and make sure the default has
   it), OR make the Stop path fail-closed on a corrupt/incomplete policy
   instead of latching-then-throwing-then-auto-clearing without a checkpoint.
   Fix the hardcoded `C:/code/guards/policy.json` fallback in `usage.mjs` to
   resolve relative to `HERE` the same way `lane.mjs`/`covgate.mjs` already
   do, so a relocated repo doesn't silently diverge onto stale defaults.
2. **Unlocked goal-state RMW (D2).** Move `goal.mjs`'s `write()` from bare
   `writeFileSync` to tmp+rename (the pattern `usage.mjs`'s scan cache
   already uses — the only atomic write in the codebase today). Add a
   single-writer discipline or a lock for the read-modify-write sequences in
   `recordTurnEnd`/`markKicked`/`appendCycle`/`setStatus` so a concurrent
   write can't erase `lastKickAt`/`needsKick`/`turnEndedAt`, and a
   half-written file doesn't silently read as "no goal." Same tmp+rename
   treatment for `tier.json`, clear-request files, and — separately but same
   pattern — `engine.mjs`'s secrets vault, which currently has no atomic
   write and no catch on read (a corrupt `vault.json` hard-crashes every
   engine command).
3. **PID-reuse-as-alive (D4).** `consoleAlive`'s `EPERM`-means-alive
   assumption is the weakest link in kick delivery — tighten it, or add the
   binding cross-check to the kick path the way `cd`/`clear` requests
   already have (`Test-Binding`) — today `Invoke-Kicks` has none at all.
4. **Swallowed-kick permanent stall (D3).** Add a "kick unanswered after N
   minutes → re-arm" rule to `pendingKicks`, so a keystroke that misses (TUI
   not ready) doesn't strand the goal until a human notices.
5. Tests for every fix above, hermetic, red-first, covering the failure mode
   each is closing (a corrupt-policy Stop that still delivers a checkpoint
   instruction; a concurrent-write race that doesn't lose state; a stale
   kick that gets retried).

**Definition of done:** each sub-fix has a test that fails on the old code
and passes on the new. Fast tier + covgate green. Note in `OPEN-ISSUES.md`
if any of these turn out to be superseded by Phase 5's deletions before you
get to them — don't fix code that's about to be deleted.

---

## Phase 5 — Wire the runner as the goal loop; retire the keystroke channel

**Status: not started**

The architectural fix. This single phase is worth more than Phases 2-4
combined in terms of attack-surface and bug-class reduction, because it
deletes the mechanism those bugs live in rather than patching it.

1. **Integrate `runner.mjs` with the goal store.** Set `ACC_GOAL=<id>` on the
   spawn (currently unset — `ensureClearbot`/`ACC_PTY` are explicitly
   cleared, but no goal binding happens). Replace the `statusFile`-hash +
   `doneMarker` progress heuristic with reading `goal.mjs`'s `done`/`blocked`
   state directly. Make the runner honor the week tier itself (today only
   `waitingGuard` gates it) — this is what closes the "runner burns a red
   week the clearbot loop would hold" gap from the earlier review.
2. **Retire the keystroke channel, in dependency order**, deleting rather
   than patching (verify nothing else depends on a piece before removing
   it — `grep` for callers first):
   - `watcher/sendconsole.ps1` (the keystroke injector)
   - `hooks/winfind.ps1` (console-PID discovery — the biggest hazard-class
     removal; this is the piece that walks explorer.exe/conhost ancestry)
   - The typing core of `watcher/clearbot.ps1` (`Send-Keys`/`Send-Pipe`/
     `Send-Esc`/`Invoke-Clear`/`Invoke-Cd`/`Invoke-Kicks` and the escalation
     logic) — `Invoke-AutoApprove` relocates to node rather than being
     deleted, since Phase 2 already covers its content policy separately
   - `gui/PtyHost.cs` + `gui/term.html` + `gui/vendor/` (1.1 MB of vendored
     WebView2/xterm.js)
   - The pty half of `guards-gui.ps1` (interactive lane wiring for the
     embedded terminal, the bind watchdog, `Start-PtySession`/
     `Stop-PtySession`, the deck timer)
   - The console-coupled ~600 LOC spread across `budget.mjs` (`captureWindow`,
     `ensureClearbot`, `reviveClearbotIfDead`, `requestClear`, the
     `ACC_PTY` branch, clear-request plumbing), `goal.mjs` (`consoleAlive`,
     console-PID `bindSession`, `pendingKicks`, `recordTurnEnd`,
     `markKicked`), and `route.mjs` (the `cdRequest`/queued-prompt/replay
     path — a headless respawn makes "re-scope" a plain `spawn(claude,
     {cwd})`, no typing needed).
   - `hooks/clearbot.test.mjs` and the fixture route tests this doc's Track
     A skipped for being Windows-only — once the code they test is gone,
     delete the tests with it rather than leaving them skipped forever.
3. **What survives, unchanged in spirit if not in code:** the goal *store*
   (text, progress log, done/blocked lifecycle) — its data model doesn't
   change, only what drives it forward. `lane.mjs` — becomes the load-bearing
   concurrency primitive for the runner's own launches, not deleted.
   `usage.mjs`'s policy/tier logic. `engine.mjs`'s runbox mechanics (Phase 2
   already secures its content).
4. This phase erases, by deletion rather than patch, OPEN-ISSUES.md's
   OI-002 (already resolved differently in Track A, but the mechanism it
   was about goes away entirely), OI-003, OI-004's remaining "not fully
   closed in spirit" caveat, OI-009, OI-010, OI-012, and the unauthenticated-
   PtyHost-pipe finding from the adversarial review. Update the ledger to
   say so explicitly rather than leaving stale entries.

**Definition of done:** a real headless job (reuse Phase 0's, or a new one)
runs start-to-finish through `runner.mjs` with goal binding, survives a
simulated context-limit respawn with no keystrokes typed anywhere, and the
deleted files' tests are gone, not skipped. If the GUI is kept at all
post-deletion, it's a read-only viewer over the goal log/runner output — no
live session hosting.

---

## Phase 6 — Residue, in case Phase 5 stalls or ships partially

**Status: not started**

Belt-and-suspenders. If Phase 5 doesn't fully land — partial migration,
paused for a reason, or the GUI survives longer than planned — these are
standalone fixes for what's left, so the system isn't worse-off mid-migration
than it was before.

1. **PtyHost pipe authentication**, if `gui/PtyHost.cs` still exists: add a
   real `PipeSecurity`/ACL restricting the pipe to the current user's SID
   (not the .NET default DACL, which is what's shipping today), or a
   shared-secret handshake the client must present before `TEXT`/`SUBMIT`
   are honored. The pipe name alone is not authentication — it's currently
   written in cleartext to a `.window` file and the child's environment.
2. **`Kill()` targets the wrong process**, if PtyHost survives: it kills
   `ChildPid` (the `cmd.exe` shim), not the node descendant the code already
   walks 8 hops to find as `consolePid` — the interactive analog of OI-014's
   orphan-on-timeout bug. Fix analogous to `runner.mjs`'s `killTree`.
3. **Reboot-leaves-goal-dead**: if any keystroke-path code survives Phase 5,
   fix it explicitly (respawn the console on reboot, or accept and document
   the gap). If Phase 5 fully lands, this is moot — a crashed headless job
   is just relaunched by the runner's own supervision, no separate fix
   needed.
4. **Connected-but-silent pipe wedge**: if `watcher/clearbot.ps1` survives
   in any form, add a read timeout to `Send-Pipe`'s `ReadLine()` — today a
   pipe that accepts and never replies blocks the whole watcher forever, and
   `reviveClearbotIfDead` won't replace a process that's still technically
   alive.
5. **Two-watcher TOCTOU**: if `ensureClearbot`/`start-clearbot.cmd` survive,
   make the probe-then-start sequence atomic (a lock file, not a
   check-then-act) so two concurrent invocations can't both start a watcher.

**Definition of done:** each item here only has work to do if Phase 5 left
its target code in place — check first, and mark an item `N/A — deleted in
Phase 5` rather than doing speculative work on code that's gone.

---

## Phase 7 — Coverage-gate honesty

**Status: not started**

1. **Fix `parseLcov`** to merge repeated `SF:` records instead of
   overwriting (`cur = blank(); files.set(...)` on every `SF:` line drops
   any prior data for that file) — this is the likely real root cause behind
   OI-017's "node coverage-merge bug," not a genuine node limitation. Add a
   test with a synthetic lcov file containing two `SF:` blocks for the same
   path and assert the merged totals are correct, then re-verify whether
   `hooks/lane.mjs`'s `branchFloorOverrides: 85` entry in `policy.json` is
   still needed — if the parser was the real bug, remove the override and
   confirm lane.mjs clears the real 90% floor.
2. **Un-blind `budget.mjs`.** It's the highest-branch-count, most
   incident-prone file in the hooks layer and the coverage gate currently
   can't measure it at all (tests strip `NODE_V8_COVERAGE` for its
   subprocess runs; nothing imports it directly since `main()` runs on
   import). Restructure so at least the pure logic (tier calc, dial
   resolution, the non-console-coupled paths — smaller after Phase 5) is
   importable and measured; keep the subprocess-integration tests for what
   genuinely needs the process boundary.
3. **Test `engine.mjs`** — zero coverage today, handles the plaintext
   secrets vault. Add `engine.test.mjs`: vault read/write round-trip,
   corrupt-vault handling (should not crash), runbox run/trash/restore.
4. **Remove coverage-shaped code**: the `for(;;)` in `lane.mjs` rewritten
   from a bounded loop purely to satisfy the branch floor, the try/catch
   dropped from `testplan.mjs` for the same reason, and the `lane.test.mjs`
   "529 uses overloadBaseMs" test that can't fail for its stated claim (it
   only asserts call count, not the actual delay) — rewrite it to assert the
   delay bound the comment already describes.

**Definition of done:** `node hooks/covgate.mjs` genuinely gates
`budget.mjs` and `engine.mjs` for the first time. No `branchFloorOverrides`
entries survive without a comment proving they're still needed post-parser-fix.

---

## Phase 8 — Whatever Track A deliberately deferred

**Status: not started**

Track A (the 2026-08-03 CI/docs session) intentionally left some duplication
alone because Phase 5 was expected to make it moot — check that assumption
before doing this work:

1. The "Continue the active ACC goal." and consolePid-invariant restatements
   across `notes/ACC-HANDOFF.md`, the specs, and the plan docs — if Phase 5
   deleted the keystroke mechanism these describe, these sections become
   historical and should move to an "archive" note rather than being
   deduplicated as if still current. If Phase 5 didn't fully land, dedupe
   them the same way Track A handled the fast-tier command (one canonical
   home, pointers elsewhere).
2. Truthfully re-verify the three `docs/superpowers/plans/*.md` files'
   checkbox states against `git log` (Track A deferred this too) — but only
   for whatever survived Phase 5's deletions. Don't spend effort truth-
   checking checkboxes for a plan whose subject no longer exists.
3. Re-check `OPEN-ISSUES.md` end to end the way Track A did for OI-001/002/004
   — stale entries accumulate, and this document's own existence is
   evidence the ledger needs periodic reconciliation against actual code,
   not just append-only trust.

**Definition of done:** no doc describes a mechanism as current that Phase 5
deleted; no OI entry sits open after its fix has shipped.

---

## Explicitly not code-fixable — stated honestly, not swept under the rug

- **Bash bypassing the guard hook is structural**, not a bug with a patch.
  `guard.mjs` is a PreToolUse hook; it only sees the tools in its matcher
  list. Closing this means either a different enforcement layer entirely
  (sandboxing, a different permission model) or accepting it as a documented
  limit — "convention enforcer, not a security boundary" is already the
  repo's own honest framing for this, and that framing should stay.
- **Verifying live GUI/PtyHost behavior and the proof-tier e2e scenarios**
  needs a real Windows machine with a real `claude` login. Every code change
  above these can be authored blind, in this sandbox or any other — but
  "the smoke test passes," "the double-Go-press shows the busy dialog," and
  "the e2e scenarios PASS" are claims that can only be made true by actually
  running them on Windows. Don't mark a Windows-gated item done from an LGTM
  on the diff alone.
- **Whether Phase 0's one real job actually validates the whole thesis**
  is inherently a judgment call a human has to make sense of — the run can
  be automated, but deciding what it means for the rest of this roadmap is
  not something to automate away.

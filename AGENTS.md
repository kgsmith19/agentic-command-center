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
2. **Self-protection** — currently **OFF**: `C:/code/guards` is not in the
   `protected` list (removed deliberately during the ACC build-out phase). Once
   the ACC goal closes, it should be re-added (`C:/code/guards/` in full, or
   specifically `C:/code/guards/gui/` and `C:/code/guards/watcher/`) to block
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

- `node C:/code/guards/hooks/engine.mjs vault-keys` — list available key names.
- `node C:/code/guards/hooks/engine.mjs apply <targetFile> <KEY...>` — upsert
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

`kernel/run.mjs <contract.json>` runs one AI coding harness at a time under a
deny-by-default boundary the harness cannot widen, verifies the real
end-state independently of what the harness claims, records every run in one
structured ledger (`node kernel/ledger.mjs query ...`), and tightens its own
ceilings after a run of failures — all separate from, and untouched by, the
interactive ConPTY/goal-loop path above. See `kernel/README.md` for the
contract shape, the harness-swap procedure (one config value plus one new
file under `kernel/adapters/`), and the honest guard ceilings.

## The regression, exactly

```
node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs hooks/clearbot.test.mjs hooks/lane.test.mjs hooks/testplan.test.mjs hooks/covgate.test.mjs hooks/prompts.test.mjs hooks/cmdline.test.mjs runner/runner.test.mjs kernel/adapter.test.mjs kernel/adapters/claude-code.test.mjs kernel/autonomy.test.mjs kernel/contract.test.mjs kernel/credentials.test.mjs kernel/guard.test.mjs kernel/guardhook.test.mjs kernel/ledger.test.mjs kernel/policy.test.mjs kernel/run.test.mjs kernel/settings.test.mjs kernel/verifier.test.mjs gui/server.test.mjs gui/guards-gui.test.mjs
    -> FAST TIER, hermetic (`npm run test:windows`). Run from C:\code\guards;
       never `node --test hooks/` (the runner grades the directory as one
       bogus failing test). `npm test` runs the portable subset of this same
       list (everything except hooks/clearbot.test.mjs and
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
node kernel/kernel.e2e.mjs
    -> PROOF TIER. Spawns a REAL claude twice via kernel/run.mjs and spends
       tokens, so run it deliberately. 1 an in-scope edit is allowed, made,
       and independently verified; 2 the same contract with writeRoots
       elsewhere is denied, the file stays untouched, and the run is
       rejected; a third check confirms no ACC goal-loop state leaks from a
       kernel run into the live repo.
powershell -File gui/ptyhost.test.ps1
    -> INTEGRATION. Acc.PtyHost against a real cmd.exe on a ConPTY - pipe
       protocol accepts/refuses, dispose kills the child. No claude, no GUI.
powershell -File C:/code/guards/guards-gui.ps1 -SmokeTest
powershell -File C:/code/guards/watcher/screenshot-gui.ps1 [-Advanced]
npm run e2e:gui
    -> GUI e2e. Playwright drives gui/kernel.html against gui/server.mjs in a
       sandbox; runs headless in CI (gui-e2e job).
```

**Never run a hook by hand against live state.** `bindSession` adopts a goal by
console PID, so piping a fake SessionStart into `budget.mjs` from a console
that owns a goal used to rebind that goal to whatever session id the payload
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
board task), the proof tier, and the goal loop all open real API streams, and
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
would stall the goal loop, which has no replay for it) injects the contract
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

## Goals — how a session survives its own context limit

A **goal** is a piece of work that outlives the session doing it. The GUI's GO
button creates one (`hooks/goal.mjs new --text-file`) and launches Claude with
`ACC_GOAL=<id>`; from then on the loop runs with no human in it:

`budget.mjs` Stop (over budget) → captures the closing checkpoint as the next
cycle's handoff → clearbot types `/clear` → the new session's SessionStart adopts
the goal and injects it → clearbot types `Continue the active ACC goal.`

Two decisions carry the whole design:

1. **A goal binds to the CONSOLE PID, not the session id.** A `/clear` ends the
   session id; the terminal process is the same throughout. Every session that
   starts in that console adopts the goal, which is what makes resumption survive
   the clear. Queued prompts (above) are keyed the same way for the same reason.
2. **Goal text never becomes keystrokes.** It reaches the model through
   SessionStart context; the only thing ever typed is a constant.

**ACC-hosted sessions run on a ConPTY inside the GUI** (spec
`docs/superpowers/specs/2026-07-31-acc-embedded-terminal-design.md`): the Go
button spawns claude via `Acc.PtyHost` (gui/PtyHost.cs), renders it in an
xterm.js/WebView2 Terminal tab, and records a `transport:"pty"` window with a
pipe name (`hooks/budget.mjs`, env `ACC_PTY`). clearbot then drives the session
with pipe writes (`TEXT`/`SUBMIT`/`ESC` — guaranteed Enter) instead of
keystroke injection; `sendconsole.ps1` remains the transport for external
sessions and the fallback when the pipe is dead. Without the WebView2 runtime
the Go button falls back to the legacy `cmd /k claude` console launch.

State: `runner\goals\<id>.json` plus a running `<id>.log.md`, archived to
`runner\goals\done\` on completion. **The loop only ends because the model ends
it** — `goal.mjs done <id>` or `goal.mjs blocked <id> --why "..."`, both stated
in full in the injected block. The week kill switch is the cost brake; a red week
holds all kicks. `goal.mjs pending` decides every condition that makes a kick
unsafe (active? console alive? binding settled? cooldown?) so there is one place
to audit, and `clearbot.ps1` stays a dumb executor.

Tests: `node --test hooks/goal.test.mjs` (20).

Two things keep the loop from stalling, added 2026-07-31 after it stalled
twice in one day. **Liveness:** a goal session that ends its turn UNDER the
ceiling gets no clear, so the Stop hook re-arms the kick instead
(`goal.mjs recordTurnEnd`), and `pendingKicks` decides when firing it is safe —
after `goals.kickSettleSeconds` (90), and not within `goals.humanHoldMinutes`
(10) of a prompt Kyle typed, so it stays quiet during a conversation and
self-heals when he walks away. A turn is "his" unless the last user message is
exactly one of clearbot's constants. Before this, a turn simply finishing ended
the loop — observed dead for 18 minutes.
**Supervision:** clearbot writes `watcher/clearbot.heartbeat` every cycle;
the statusline shows `bot DEAD` and SessionStart warns when it goes stale;
`budget.mjs reviveClearbotIfDead` restarts a stale watcher at every turn
boundary (honouring the kill switch), and a Startup-folder launcher covers
logon. The external Scheduled Task version is optional and needs an elevated
shell — `watcher/watchdog/` holds it and its undo scripts.

`/goal <condition>` (user skill `~\.claude\skills\goal\`) is ACC-native: it
logs `CONDITION: <text>` into the active goal's log via `goal.mjs log`, so the
directive rides the goal store and survives every `/clear` with the rest of
the handoff; `/goal clear` logs `CONDITION MET`. It never registers a session
Stop hook: a Stop-gate fights the budget gate (OI-011) — the loop continues BY
ending turns — so conditions live in goal state, not hooks. With no active
goal the condition is session-local only.

## Folder routing (Start work tab)

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
writes a `kind:"cd"` request into `runner\clear-requests`. The clearbot picks it
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
SessionStart and deletes it, and clearbot types the constant `Run the queued
prompt.` That channel needs a clear to ride on, so on the *first* scope of a
session — where there is no clear and therefore no SessionStart — an untypable
prompt still falls through to advice.

`clearbot.ps1` re-derives every check itself rather than trusting the request
file: the destination must be byte-identical to a route in `ROUTING.md` *and*
exist, and the replay must re-pass the printable-single-line test. Invariant 1
in that file is the authority on what may ever be typed — read it before
changing anything here.

Signals live in `ROUTING.md`, not in the code; edit that JSON block when a repo
is added. Tests: `node --test hooks/route.test.mjs` (21). The watcher's refusal
gates and the live `/cd` + replay sequence were verified by injection into a
throwaway console — do not test them against a real working session.

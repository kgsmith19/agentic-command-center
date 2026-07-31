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
2. **Self-protection** — writes to this repo and `~/.claude/settings.json` are
   blocked: an agent may not edit the rules that constrain it. Exception:
   runboxes (below).
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

## The regression, exactly

```
node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs
    -> 53 pass  (run from C:\code\guards; never `node --test hooks/` — the
       runner grades the directory as one bogus failing test)
powershell -File C:/code/guards/guards-gui.ps1 -SmokeTest
powershell -File C:/code/guards/watcher/screenshot-gui.ps1 [-Advanced]
```

The suites that touch runner state (`budget`, `route`) sandbox themselves via
`ACC_ROOT` + `ACC_POLICY`, because a test that reset the live `runner\state`
would delete the `.window` files running sessions depend on. `-SmokeTest`
builds the form without showing it and cannot see layout, so screenshot the
window whenever the GUI changes.

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

State: `runner\goals\<id>.json` plus a running `<id>.log.md`, archived to
`runner\goals\done\` on completion. **The loop only ends because the model ends
it** — `goal.mjs done <id>` or `goal.mjs blocked <id> --why "..."`, both stated
in full in the injected block. The week kill switch is the cost brake; a red week
holds all kicks. `goal.mjs pending` decides every condition that makes a kick
unsafe (active? console alive? binding settled? cooldown?) so there is one place
to audit, and `clearbot.ps1` stays a dumb executor.

Tests: `node --test hooks/goal.test.mjs` (14).

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

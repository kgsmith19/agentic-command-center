# guards

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

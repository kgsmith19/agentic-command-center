# Core workflows

Hand-maintained, unlike `INVENTORY.md`: a workflow is implicit in code
structure, not a structured ledger entry, so there is nothing to parse and
regenerate from. What keeps this honest instead: every file path in the
"Tests" column is checked to exist by `tools/workflows.test.mjs`, run in the
fast tier (`npm run test:windows`) — a stale citation fails the build rather
than rotting silently. `Tests: none` is written out explicitly, never a dash,
and every one of those is tracked by its own ledger entry.

Closes `guards#OI-036` (Kyle's Definition-of-Done condition 3, "Every core
workflow is mapped" — see `docs/dod-mapping.md`, sub-project A).

| Workflow | Trigger | Touches | Tests |
|---|---|---|---|
| Write protection (PreToolUse guard) | Any `Edit`/`Write`/`NotebookEdit`/`Read` tool call, every Claude Code project on this machine | `config.json` (secrets globs, protected paths, cell repo map), `vault.json` (read-blocked) | none — `guards#OI-037` |
| Secret handoff + runbox lifecycle | Agent runs `engine.mjs vault-keys`/`apply`; user runs `/approve` (or GUI "Claude's requests") to execute a runbox script | `vault.json`, `runbox/` (central + per-project `.guards/runbox`), `.trash/`, `watcher/approvals.log` | none — `guards#OI-038` |
| Standing order loop | GUI GO button creates a standing order; `budget.mjs` Stop (over budget) drives clear → adopt → kick | `runner/standing/`, `policy.json`, `watcher/clearbot.ps1` | `core/standing.test.mjs` (50), `hooks/budget.test.mjs` |
| Launch lane (concurrency serialization) | Any AUTOMATED `claude` spawn (slice-runner, proof tier, standing order loop) | `os.tmpdir()/acc-lane` slot state | `hooks/lane.test.mjs` (14) |
| Folder routing / auto-cd | Every `UserPromptSubmit` | `ROUTING.md`, `runner/clear-requests`, `runner/queued` | `hooks/route.test.mjs` (21) |
| Dial/hook coherence check | `node hooks/dialcheck.mjs` (manual or gate-integrated) | `policy.json` dials vs `~/.claude/settings.json` registrations | `hooks/dialcheck.test.mjs` (10) |
| Testing-contract injection | `UserPromptSubmit` on an implementation-planning prompt | injects contract text into context, no persistent state | `hooks/testplan.test.mjs` (11) |
| Coverage gate | `node hooks/covgate.mjs` (manual or pre-push) | changed lib files under `hooks/runner/kernel/gui/tools`, temp lcov output | `hooks/covgate.test.mjs` (26) |
| Kernel headless task runner | `kernel/run.mjs <contract.json>` | `kernel/ledger.mjs` (run record), `kernel/guard.mjs` (deny-by-default boundary), `kernel/verifier.mjs` (independent end-state check) | `kernel/run.test.mjs`, `kernel/guard.test.mjs` (21), `kernel/verifier.test.mjs`, `kernel/kernel.e2e.mjs` (proof tier) |
| Guardhook autonomy-ceiling enforcement | Every tool call inside a kernel run | `kernel/autonomy.mjs`, `kernel/policy.mjs` | `kernel/guardhook.test.mjs` |
| Embedded terminal / PTY session | GUI GO button (WebView2 available) | `Acc.PtyHost` (`gui/PtyHost.cs`), xterm.js Terminal tab, named pipe transport | `gui/ptyhost.test.ps1` (integration), `gui/ptyhost.e2e.ps1` (proof tier) |
| Process tab / token discipline | User GUI interaction (Process tab) | `policy.json` (context/week dials, subagent allowlist), `runner/stop/slice-runner.stop` | `hooks/usage.test.mjs`, `hooks/budget.test.mjs` |
| Watchdog / supervision (revive-if-dead) | Every turn boundary + machine logon | `watcher/clearbot.heartbeat`, Startup-folder launcher, statusline `bot DEAD` warning | `hooks/budget.test.mjs` ("a stale heartbeat... revives the watcher", "a fresh heartbeat leaves the watcher alone", "a deliberate stop is never overridden by the revive") |
| Claude launch cap (machine-wide) | Any `claude` invocation on PATH | `shim/claude.cmd` → `hooks/lane.mjs gate`, `watcher/claude-cap-watch.ps1` (alert-only Scheduled Task) | `watcher/claude-cap-watch.test.ps1`, `watcher/install-cap-watch-task.test.ps1`, `watcher/flash-probe.test.ps1` (+ `-Observe` proof tier) |

## Deliberately excluded

One-shot install/registration scripts (`watcher/watchdog/acc-watchdog-*.ps1`,
`runbox/install-*.ps1`) are not workflows in their own right — each is a
single manual action Kyle runs once via `/approve`, not a recurring system
loop. They are validated by the GUI's `-SmokeTest` path and their own
installer-spec tests where one exists (e.g.
`watcher/install-cap-watch-task.test.ps1`), not listed here as a separate
row.

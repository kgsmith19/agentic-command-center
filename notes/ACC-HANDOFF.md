# Agentic Command Center — handoff

The durable record of how ACC autonomy works and what it cost to learn. Folded
from `2026-07-31-acc-autonomy.md` (deleted) once the work landed. The
user-facing description lives in `AGENTS.md` (Goals, Folder routing, The
regression); this file is the part that would otherwise be relearned the hard
way.

## What ACC does now

One GUI screen. Type what you want done, pick the folder, press **GO**. That
creates a goal and launches Claude with `ACC_GOAL=<id>`. From there:

Stop hook over budget → the closing checkpoint is captured as the next cycle's
handoff → clearbot types `/clear` → the new session's SessionStart adopts the
goal (by console pid) and injects goal + progress-log tail → clearbot types
`Continue the active ACC goal.`

The loop is **unbounded** and ends only when the model runs `goal.mjs done` or
`goal.mjs blocked`. The week kill switch is the cost brake; a red week holds all
kicks. Runbox scripts are auto-approved (`policy.autoApprove.enabled`).

Kyle's decisions, not to be relitigated: unbounded auto-resume; resume from goal
+ checkpoint + progress log; one screen with everything else behind **Show
advanced**; auto-approve runbox scripts.

## The two invariants everything rests on

Canonical source: `watcher/clearbot.ps1`'s own header comment (its
`SAFETY INVARIANTS` block). Restated here for a fast handoff read — if the
two ever disagree, the code comment wins; update both together.

1. **Continuity is the CONSOLE PID, never the session id.** A `/clear` ends the
   session id; the terminal process is the same throughout. Goals and queued
   prompts are both keyed by console pid, which is the only reason either
   survives a clear.
2. **Nothing derived from user or goal text ever becomes keystrokes.** Text
   reaches the model through SessionStart context; the only things typed are the
   constants `Continue the active ACC goal.` and `Run the queued prompt.` This is
   what makes multi-line safe — there is no fragment that can be submitted by a
   stray Enter.

`goal.mjs pending` decides every condition that makes a kick unsafe (active?
console alive? binding settled? cooldown?) so there is exactly one place to
audit; `clearbot.ps1` is a dumb executor on purpose.

## Traps, each of which cost real time

- **Gate on what the mechanism consumes, not on what the diagnostic collects.**
  Auto-clear was silently dead for ~a day: `winfind.ps1` returned `ok:false`
  whenever `EnumWindows` found no visible window, and both `captureWindow()` and
  `requestClear()` gated on `hwnd` — but injection is `WriteConsoleInput`
  addressed by PID and never touches the hwnd. The right answer was being thrown
  away for want of a handle nothing used. It failed exactly like "no session to
  clear", with no error anywhere.
- **A test that runs a copy is not a test.** `test-budget.mjs` sat in the install
  payload folder and ran `runbox/acc-v1/budget.mjs` — the pre-install copy. Every
  "39 passed" graded a file no session had loaded since 2026-07-30. It now runs
  `hooks/budget.mjs` with `ACC_ROOT` pointed at a throwaway tree (the override
  exists because resetting the live `runner\state` would delete the `.window`
  files running sessions depend on — see trap 1 for how that ends). Stale copies
  are still in the payload folder: OI-012.
- **PowerShell 5.1 prepends a UTF-8 BOM when piping JSON to a hook.** `JSON.parse`
  fails, `readStdin()` returns `{}`, and the hook silently emits nothing — it
  looks precisely like a broken hook. Use the Bash tool for hook smoke tests.
  Same BOM family as the `guard.mjs` config trap.
- **WinForms applies docking in REVERSE z-order.** The `Fill` control must be at
  index 0 (`BringToFront`) or it lays out before the `Top` header and its first
  92 px hide behind it — group titles simply vanish. Do NOT `BringToFront()` the
  header afterwards.
- **`SetProcessDPIAware()` before `GetWindowRect`,** or you capture a zoomed crop
  of the corner instead of the window.
- **A running clearbot does not pick up edits to `clearbot.ps1` — restart it,**
  and check the process count afterwards: stop+start can leave two watchers
  running, which doubles every kick and every auto-approval.
- **`-SmokeTest` cannot see layout.** Screenshot the window on every GUI change:
  `watcher/screenshot-gui.ps1 [-Advanced]`. `-Advanced` finds the checkbox by its
  caption and sends `BM_CLICK`; it does not click coordinates, which drift with
  every layout edit.

## Where things live

```
hooks/goal.mjs        goal store: runner/goals/<id>.json + <id>.log.md
hooks/budget.mjs      SessionStart injection, Stop cycle capture, clear request
hooks/route.mjs       folder routing + the queued-prompt channel
watcher/clearbot.ps1  the only thing that types; invariant 1 is the authority
guards-gui.ps1        one screen; five tabs behind "Show advanced"
```

## Still open (status footer, updated 2026-07-31 cycle 3)

Guards ledger (`OPEN-ISSUES.md`, this repo): `OI-001` start-clearbot
self-match probe, `OI-002` goal loop stalls when a turn ends UNDER hardK
(observed live: cycle-2 sat dead 18 min), `OI-003` a clearbot-typed `/cd`
does not take.

Cross-repo ledger (`C:\code\OPEN-ISSUES.md`): `OI-011` Esc-escalation E2E
evidence still owed (latch fix + escalation code landed; cycle-1 death
cleared plainly, so the path is unexercised), `OI-006` disable script staged
in the runbox pending its run + a fresh-session latency check, `OI-008`
skill-shadow evidence, `OI-005` observation window to 2026-08-06.

Resolved 2026-07-31: routing doctor (OI-003 there), OI-007, OI-009, OI-012,
OI-013 — and the dials fix: context limits are single-source (Process-tab
dials) with statusline and budget resolving identically via
`usage.mjs applyProfile`.

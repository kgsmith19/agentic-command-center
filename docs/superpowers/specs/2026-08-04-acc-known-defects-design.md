# ACC known defects — design (sub-project B)

- date: 2026-08-04
- status: approved (Kyle, B1 approach chosen 2026-08-04)
- scope: the two defects Kyle named by hand, plus one config/reality
  divergence found while investigating them
- ledger: guards OI-031 (goal reaping), guards OI-029 (autoCd recurrence)

This is sub-project **B** of a nine-part decomposition of Kyle's 2026-08-04
"finish ACC" prompt. B was chosen to run first because both named defects are
broken core workflows, and both were root-caused by observation before any code
was proposed. Sub-project A (a complete, deduped, ranked inventory of every open
item across all five ledgers) runs next.

## Why the previous fix failed, and what that demands of this one

`4af8cd6` shipped a fix for the 60-second window flash. Its installer ended
with:

```
verified  : -WindowStyle Hidden is set; no console window will appear.
```

That check was `if ($liveArgs -notmatch '-WindowStyle\s+Hidden')` — a **regex
against the task's own arguments**. It asserted on configuration and reported
the result as behavior. The window kept appearing, because the window was never
PowerShell's to hide.

Every acceptance criterion below is therefore written against an **observable**,
not against a setting. No AC in this document is satisfied by reading back a
value we ourselves wrote.

## Evidence

### Defect 1 — a console window appears and vanishes every 60 seconds

Instrumented with a probe that baselines every visible top-level window, then
polls at 40 ms and reports any new window regardless of owning process. Three
consecutive task firings, all reproduced:

```
19:04:01.685  APPEARED  WindowsTerminal.exe  CASCADIA_HOSTING_WINDOW_CLASS  469 ms
19:05:01.555  APPEARED  WindowsTerminal.exe  CASCADIA_HOSTING_WINDOW_CLASS  608 ms
19:06:01.616  APPEARED  WindowsTerminal.exe  CASCADIA_HOSTING_WINDOW_CLASS  491 ms
19:06:01.779  APPEARED  powershell.exe       PseudoConsoleWindow             47 ms
              cmd="powershell.exe" -NoProfile ... -WindowStyle Hidden -File "...\claude-cap-watch.ps1"
```

Correlation: `Get-ScheduledTaskInfo ACC-ClaudeCapWatch` reports
`LastRunTime = 7:04:01 PM`, matching the first window to the second.

**Root cause.** `HKCU:\Console\%%Startup` has
`DelegationConsole = DelegationTerminal = {00000000-0000-0000-0000-000000000000}`
("let Windows decide"), which resolves to Windows Terminal on this build. When
the task starts `powershell.exe` in Kyle's interactive session, Windows creates
a console for it and hosts that console in a **separate, COM-activated**
`WindowsTerminal.exe` process (`-Embedding`). `-WindowStyle Hidden` is a
PowerShell *host* flag governing the window PowerShell owns; it has no authority
over a console-host window owned by a different process. The 19:06 sample shows
the second source too — the cap-watch process's own transient
`PseudoConsoleWindow`.

The previous measurement was not wrong about PowerShell's window. It was
scoped to the wrong process.

### Defect 2 — the prompt entered in the UI does not carry cleanly into ACC

`hooks/goal.mjs list` returns 6 goals with `status: "active"`, the oldest from
2026-07-31, every one bound to a console PID that is now dead. Nothing marks a
goal dead when its console dies, so the store only grows.

`watcher/clearbot.log` shows the system *detecting* those deaths and doing
nothing about them:

```
18:26:05  GUI-DEAD ... hosting GUI (pid 2768) is gone - hosted session lost
18:28:46  GUI-DEAD ... hosting GUI (pid 1620) is gone - hosted session lost
```

PIDs 2352 and 1620 appear both in those alerts and as `consolePid` on goals
still marked `active`. Detection exists; reaping does not.

**Root cause.** A console PID is treated as a console *identity*:

- `goal.mjs:200` (`bindSession`) — a session with no `ACC_GOAL` adopts a goal by
  `activeGoals().find(g => Number(g.consolePid) === Number(consolePid))`, i.e.
  the first filesystem match.
- `goal.mjs:129-137` (`consoleAlive`) — a bare `process.kill(pid, 0)` existence
  test.

Windows recycles PIDs. Once a stale goal's PID is reassigned, that goal looks
alive, becomes eligible for a kick, and clearbot types a constant into whatever
process now owns the PID. The comment directly above `consoleAlive` already
names this hazard verbatim — *"the pid may since have been reused by an
unrelated process"* — and the check below it does not defend against it.

Status on this machine right now: all six stale PIDs are dead, so the hazard is
**latent, not currently firing**. It is a construction defect, not an active
incident, and this document does not claim otherwise.

### Defect 3 — a dial that lies (found while investigating defect 2)

`watcher/clearbot.log`, tonight:

```
18:42:02  AUTO-APPROVE central:disable-route-hook.mjs -> OK
          "Disables the prompt-routing hook that blocks/re-scopes UserPromptSubmit."
```

`policy.json` still reads `autoCd.enabled: true`. The dial claims the routing
hook is on; the hook has been removed from `settings.json`. The dial's stated
consumer no longer exists.

This is the smallest possible instance of the requirement that every control
must reach its real consumer, so it is fixed here rather than deferred.

## Design

### B1 — run the launch-cap check with no desktop

Change `Get-CapWatchTaskSpec` to register the task with a **session 0**
principal: `-LogonType S4U`, `-RunLevel Limited`. S4U runs the task whether or
not Kyle is logged on, stores no password, and has no interactive desktop — so
no console host can be created for it and no window can appear, on any
`DelegationTerminal` setting, now or after a Windows update.

Consequences, accepted deliberately:

- The `NotifyIcon` balloon in `claude-cap-watch.ps1` cannot reach Kyle's
  desktop. It is already wrapped in a best-effort `try/catch` whose comment
  states the log line is the durable record either way, so no code change is
  required for it to degrade correctly. Kyle, 2026-08-04: *"The WinForms balloon
  is probably not a big deal. We can work out other enhancements later."*
  Surfacing cap alerts in the statusline or GUI is explicitly **out of scope**
  here and belongs to a later sub-project.
- The task remains standalone — its own script, its own trigger, importing no
  repo code. Kyle: *"I do like the idea of it being standalone as I'll likely
  use this for future things."*
- Registration still requires elevation and still self-elevates via
  `Start-Process -Verb RunAs`, per the standing rule in AGENTS.md.

The `-WindowStyle Hidden` argument stays. It is now belt-and-braces rather than
the mechanism, and removing it would be an unrelated change.

**Acceptance criteria**

| AC | Statement | Test |
|----|-----------|------|
| AC-1 | The registered task spec carries an S4U principal | `install-cap-watch-task.test.ps1`, pure `Get-CapWatchTaskSpec` assertion |
| AC-2 | Across ≥3 consecutive firings, **no** new visible top-level window appears from **any** process | `watcher/flash-probe.ps1` promoted to a tracked observational test |
| AC-3 | The check still runs on cadence and still writes `claude-cap-watch.state.json` | state file mtime advances across firings |
| AC-4 | Re-registration is idempotent and self-elevates when not already admin | existing installer behavior, unchanged |

AC-2 is the one that matters. It is written to fail against the current machine
state, and it would have failed against `4af8cd6` — which is what makes it a
regression test rather than a green-born one.

The installer's closing `verified` line is rewritten to state only what it
actually checked (that the principal is S4U), and to stop claiming a behavioral
outcome it never observed.

### B2 — console identity, and reaping the dead

Two changes, both in `hooks/goal.mjs`.

**Identity.** A console is identified by `(pid, processStartTime)`, not `pid`.
`createGoal`/`bindSession` record `consoleStartedAt` alongside `consolePid`;
`consoleAlive` returns true only when a process with that PID exists **and** its
start time matches the recorded one. A goal recorded before this change has no
`consoleStartedAt`; it is treated as unidentifiable and therefore not alive,
which reaps the existing six on first run.

**Reaping.** A goal whose console is not alive by the above test is archived to
`runner/goals/done/` with `status: "abandoned"`, distinct from `done` and
`blocked` so the ledger can tell "the model finished this" from "the console
went away." A grace window (`goals.reapGraceSeconds`, default 120) protects a
goal created moments ago whose console has not yet been recorded.

`OI-031` asks for a decision on what "dead" means. Recorded here as the
judgment call, made rather than escalated: **dead = the console PID is absent,
or present with a start time that does not match the one recorded at bind.** A
time-since-last-cycle rule was considered and rejected — a goal can legitimately
sit idle for hours while Kyle is away, and `humanHoldMinutes` already exists to
protect exactly that case.

**Acceptance criteria**

| AC | Statement | Test |
|----|-----------|------|
| AC-5 | `consoleAlive` is false for a PID that exists but whose start time differs from the recorded one | unit, real process, injected start time |
| AC-6 | `consoleAlive` is true for a live console whose start time matches | unit, real process |
| AC-7 | A goal with no `consoleStartedAt` is not alive (legacy reap) | unit |
| AC-8 | A goal whose console is not alive is archived with `status: "abandoned"` and leaves `activeGoals()` | unit |
| AC-9 | A goal created inside the grace window is never reaped | unit |
| AC-10 | `bindSession` never adopts a goal whose console identity does not match | unit — reproduces the wrong-goal adoption directly |
| AC-11 | `pendingKicks` returns nothing for a reaped goal | unit |

### B3 — make the dial match reality, and keep it that way

Two parts.

1. `policy.json` `autoCd.enabled` is set to `false` with a note recording that
   the `UserPromptSubmit` route hook was removed from `settings.json` at
   18:42 on 2026-08-04 and why. The hook is **not** re-registered here:
   it was disabled to stop prompts being eaten, and re-enabling it without
   fixing that root cause would reintroduce the symptom Kyle named first.
   Restoring it belongs to its own slice, after B2, once the goal store is
   trustworthy.
2. `hooks/route.mjs doctor` gains a check that fails when a policy dial claims a
   hook is enabled while that hook is absent from `settings.json`. This is the
   seed of the traceability harness (sub-project F) and is deliberately kept to
   the one dial we have a real divergence for, rather than generalized
   speculatively.

**Acceptance criteria**

| AC | Statement | Test |
|----|-----------|------|
| AC-12 | `doctor` exits non-zero when a dial claims enabled and the hook is absent | unit, sandboxed settings fixture |
| AC-13 | `doctor` exits zero when dial and hook agree, in both directions | unit |

## Out of scope

Named explicitly so it is not silently dropped:

- Restoring the `UserPromptSubmit` route hook (own slice, after B2).
- Surfacing cap-watch alerts in the statusline or GUI (later sub-project).
- Generalizing the dial/consumer check beyond `autoCd` (sub-project F).
- `OI-032` (`autoApprove` means an agent writing a file is an agent running
  code). Unchanged here, and worth stating plainly: both scripts that changed
  this machine tonight — `disable-route-hook.mjs` and
  `fix-capwatch-window-flash.ps1` — ran with no human approving them.

## Verification

Fast tier, then the coverage gate, then the observational probe:

```
npm run test:windows
node hooks/covgate.mjs
powershell -File watcher/install-cap-watch-task.test.ps1
powershell -File watcher/flash-probe.test.ps1      # AC-2, ~200s, observational
```

Tests are written RED first and the red run is recorded, per the testing
doctrine in AGENTS.md. AC-2 in particular must be demonstrated failing against
the current task registration before the S4U change lands.

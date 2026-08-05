# Emergency STOP and intervention controls — design (sub-project D)

- date: 2026-08-04
- status: approved (Kyle, 2026-08-04: "If the process is booted up via the start
  of the terminal session/agentic session then stop should kill that process
  too. If it's not related to that bootup it should not be killed that way at
  all… If there is some sort of execution or starting of the [autopilot] via the
  Agentic Command Center there should be a stop for it… If it's completely
  outside of it then not there at all.")
- scope: a prominent, unmistakable emergency STOP on the terminal page, plus
  pause / resume / redirect / interrupt
- standard: `2026-08-04-acc-standards-design.md` applies in full
- lands in: `agentic-command-center-ui` (after J step 9), driving
  `agentic-command-center`
- supersedes: the control-strip section of `2026-07-31-acc-terminal-control-deck-design.md`,
  which was designed for the WinForms host that `OI-022` retired

## The scoping rule

Kyle's answer is a **provenance** rule, not a name rule, and that distinction is
the whole design:

> STOP kills what this session started. Nothing else, ever.

Concretely: when the terminal session launches, ACC already spawns a pty child.
STOP kills the process tree rooted at that child. A `claude.exe` Kyle started by
hand in another window is not descended from it and is therefore untouchable by
this control — even though it is the same executable, doing the same thing.

Name-matching (`Get-Process claude`) is explicitly rejected. It is the failure
this rule exists to prevent, and this repo already carries a scar from it:
`OI-001` was a kill query that matched its own probe process.

**The mechanism already exists.** `guards-gui.ps1:1426` warns when a recorded
`consolePid` "does not descend from pty child", so descendancy is proven here,
not new. `killTree`, `killTreeWin32` and `killTreePosix` live in
`runner/runner.mjs` and `OI-014` already proves the Windows branch's
pid-liveness check on every platform. D wires existing, proven parts to a button.

### The session anchor

At launch the session records an **anchor**: the pty child's `(pid, startTime)`
— the same composite identity B2b establishes for standing orders, reused rather
than reinvented. The anchor is stored with the session.

STOP resolves the anchor, walks its descendants, and kills the tree. If the
anchor's start time no longer matches, the anchor is **stale** and STOP kills
nothing, reports "the session this control belonged to is already gone", and
offers to clear it. Killing a recycled PID is the exact hazard `OI-034` is about;
the emergency control is the last place to reintroduce it.

## What each control does

| Control | Kills | Effect on the standing order | Effect elsewhere |
|---|---|---|---|
| **STOP** | the session anchor's process tree | marked `interrupted` | none |
| **Interrupt** | nothing | unchanged | sends `Esc` — ends the current turn, keeps the session |
| **Pause** | nothing | `paused`; autopilot stops kicking *this* order | other sessions unaffected |
| **Resume** | nothing | back to `active` | |
| **Redirect** | nothing | condition text replaced, history kept | |
| **Stop autopilot** | the autopilot daemon | all orders keep their state | every session stops being kicked |

`interrupted` is a fourth standing-order status alongside `active`, `done`,
`blocked` and `abandoned`. It is distinct on purpose: a ledger that cannot tell
"Kyle hit the emergency stop" from "the console died" cannot tell an incident
from a tidy-up. Same reasoning that gave `abandoned` its own status in `OI-031`.

## Stop autopilot — and its honest limit

Per Kyle's conditional: autopilot **is** ACC-started, so it gets a control. The
GUI already launches it via `watcher/start-clearbot.cmd` and stops it via
`stop-clearbot.cmd` (a `clearbot.stop` sentinel file), so the control drives the
existing, working mechanism rather than a new kill path.

The honest limit, and the UI must say it rather than imply otherwise: if the
daemon was started **outside** ACC — by hand, or by a scheduled task — the
sentinel still stops the loop, but ACC did not start it and does not own its
lifecycle. In that case the control reports what it can and cannot do instead of
silently doing less than its label claims. Per Kyle: *"If it's completely outside
of it then not there at all."*

The control is placed in the **execution** region, not next to STOP. They are
different actions with different blast radii, and putting them together is how
someone hits the wrong one.

## Protection against accidental activation

The requirement is a genuine tension: unmistakable and reliable, protected
against accidents, *without* being slow in a real emergency.

**Press and hold, 600 ms**, with a ring filling around the button and a live
countdown announced to assistive technology. Chosen because:

- A stray click, a double-click, or a mis-aimed drag cannot satisfy it — those
  are all sub-100 ms events.
- It is a *single continuous gesture*, so in an emergency it is one action, not a
  click-then-find-the-dialog-then-click sequence. A modal is the wrong answer:
  under stress people dismiss modals reflexively.
- The ring gives continuous feedback and can be aborted by releasing early, which
  a confirm dialog cannot do without a second decision.

**Accessible equivalent, not an afterthought**: a press-and-hold gesture is a
barrier for motor impairments and for switch access. So focusing STOP and
pressing `Enter` opens a single-button confirm whose "STOP NOW" is default-
focused — two deliberate keypresses, no pointer, no hold. Both paths are ≤2
deliberate actions and both are tested.

Global keyboard shortcut: `Ctrl`+`Shift`+`.` held for the same 600 ms, working
even when focus is inside the terminal, because in an emergency the cursor is
usually in the terminal.

## What STOP records

An emergency control that leaves no record is untestable and unreviewable. Every
activation appends to the ledger: who, when, which anchor, the exact pid list
killed, each pid's confirmed post-kill state, and the standing order's id.
"Confirmed post-kill state" means a real liveness re-check per pid — the button
reports what actually died, not what it asked to die.

If any pid survives the kill, STOP reports **partial** and names the survivors.
Reporting success while a process still runs is the exact class of failure the
standing prohibitions forbid.

## Acceptance criteria

| AC | Statement | Test |
|----|-----------|------|
| AC-D1 | STOP kills every descendant of the session anchor | integration, real spawned tree ≥3 deep |
| AC-D2 | STOP does not kill an identical process that is not descended from the anchor | integration — a second `node` started outside the tree survives |
| AC-D3 | STOP never matches by process name or command line | unit + grep gate over the implementation |
| AC-D4 | A stale anchor (pid reused, start time differs) kills nothing and reports the session gone | integration, injected start time |
| AC-D5 | STOP reports `partial` and names survivors when a pid outlives the kill | integration, unkillable stub |
| AC-D6 | Every activation writes who/when/anchor/pid-list/post-kill state to the ledger | integration |
| AC-D7 | The standing order is marked `interrupted`, distinct from `abandoned` and `done` | unit |
| AC-D8 | A click, double-click, or <600 ms hold does not fire STOP | e2e, Playwright timing |
| AC-D9 | A 600 ms hold fires exactly once, even if held for 5 s | e2e |
| AC-D10 | Releasing early aborts and leaves the session running | e2e |
| AC-D11 | Keyboard path: focus + Enter + confirm fires STOP with no pointer | e2e, keyboard only |
| AC-D12 | `Ctrl`+`Shift`+`.` held fires STOP while focus is inside the terminal | e2e |
| AC-D13 | The hold countdown is announced to assistive technology | e2e, accessibility-tree assertion |
| AC-D14 | Pause stops kicks for that order only; another active order still gets kicked | integration, two orders |
| AC-D15 | Resume restores kicking without restarting the session | integration |
| AC-D16 | Redirect replaces the condition and preserves prior text in history | unit |
| AC-D17 | Interrupt sends `Esc` and the session survives | e2e, real pty |
| AC-D18 | Stop autopilot halts the daemon and leaves every standing order's status untouched | integration |
| AC-D19 | When autopilot was not ACC-started, the control says so instead of implying ownership | integration, daemon started out of band |
| AC-D20 | STOP is reachable and operable at 320 px width | e2e, responsive |
| AC-D21 | End to end: a real session running a real turn is stopped by a real hold, and the process tree is confirmed dead | e2e, real pty + real claude |

AC-D2 and AC-D21 are the pair that matter — one proves STOP is precise, the other
proves it actually works on the real thing.

## Out of scope

- A machine-wide "halt everything" control. Kyle's rule scopes STOP to what the
  session started; a machine-wide halt is a different action and no one has asked
  for it. Named here so it is not silently assumed.
- Killing the launch-cap scheduled task. It is standalone by design and not
  ACC-started.
- Restarting anything STOP killed. Recovery is a separate control and belongs to
  E's execution region.

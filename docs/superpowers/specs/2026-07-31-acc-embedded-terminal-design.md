# ACC Embedded Terminal (ConPTY host) — Design

Date: 2026-07-31
Status: Approved (Kyle, in-session)

## Problem

ACC's "Go" launch is not fully autonomous. The chain today: `guards-gui.ps1`
spawns `cmd /k claude`; the goal rides in as SessionStart context; clearbot
kicks the session by injecting `"Continue the active ACC goal."` keystrokes via
`watcher/sendconsole.ps1` (`WriteConsoleInputW`). Text and VK_RETURN go in **one
batch**, which the ink-based Claude Code TUI treats as a paste — the CR is
absorbed, the prompt text sits unsubmitted in the input box. Observed from the
very first launch. Keystroke injection is inherently fire-and-forget; we want
100% deterministic control.

## Decision

ACC owns the terminal. The GUI spawns `claude` on a Windows pseudoconsole
(ConPTY) and renders it in an embedded xterm.js terminal (WebView2). Submitting
a prompt becomes writing bytes to the pty input pipe — guaranteed, verifiable,
retryable — instead of hoping keystrokes land.

Rejected alternatives:
- **Fix injection timing only** — leaner but still open-loop keystrokes.
- **SetParent embedding** — visual only; fixes nothing (injection is
  PID-addressed and focus-free already).
- **Hand-rolled VT renderer** — owning a VT parser for a full-screen TUI is
  the highest-bloat path.
- **Headless + custom chat UI** — loses the real TUI, including permission
  prompts; breaks interactivity.

## Components

1. **`gui/term.html`** (~100 lines) — xterm.js page. Terminal div, fit-on-resize,
   `window.chrome.webview` bridge: `out` messages → `term.write`; xterm
   `onData` → `in` messages. xterm.js + CSS checked in under `gui/vendor/`
   (pinned version, no npm, no CDN).
2. **PTY host** — inline C# in `guards-gui.ps1` (~150 lines):
   `CreatePseudoConsole` + pipe pair; spawn `claude` with `ACC_GOAL` /
   `ACC_PROFILE` env (replaces the `cmd /k` ProcessStartInfo block at
   guards-gui.ps1:977); async output-pipe reader marshalled to WebView2;
   `Write(string)`; `Resize(cols, rows)`; process-exit event.
3. **Terminal area in the ACC form** — one WebView2 control, one embedded
   session at a time (matches the one-goal-at-a-time model). "Go" with a live
   session prompts to stop it first (reuse the confirm pattern at
   guards-gui.ps1:829). Window record `runner/state/<sessionId>.window` gains
   `transport: "pty"` alongside the existing `hwnd`/`consolePid` shape.
4. **Input pipe server** — the GUI serves `\\.\pipe\acc-term-<consolePid>` and
   forwards received text to pty stdin, enforcing the same refusals
   `sendconsole.ps1` enforces today: no control characters in text writes
   (a bare `\r` submit is its own message type), 2100-char cap. Content
   invariants (closed set of kick constants, OI-004) stay in clearbot,
   unchanged.
5. **Clearbot transport switch** (~30 lines) — everywhere it calls `Send-Keys`
   (clearbot.ps1:149, 154, 164, 169, 225, 261): if the session's window record
   says `transport: "pty"`, write to the named pipe (text message, ~50ms gap,
   then submit message); otherwise use `sendconsole.ps1` exactly as today.
   External (non-ACC) sessions keep working unchanged.

## Data flow (kick)

Go → goal saved → pty spawn with env → SessionStart binds goal + injects
context (unchanged) → goal.mjs `needsKick` (unchanged) → clearbot cycle sees
pty transport → pipe-writes the kick constant, then `\r` after ~50ms → hooks
observe the turn (existing `recordTurnEnd` / kick re-arm) → if no turn starts
within the settle window, the existing kick cooldown re-fires. Closed loop via
machinery that already exists; the transport is what becomes deterministic.

## Error handling

- **WebView2 runtime absent** → detect at startup, fall back to the current
  `cmd /k claude` launch (that code stays), one-line notice in the GUI.
- **claude exits in the pty** → exit banner in the terminal; existing
  watcher/goal resume logic decides relaunch; Go usable immediately.
- **GUI closes with a live session** → confirm prompt; closing kills the pty
  child. No orphan consoles.
- **Pipe write fails** → clearbot logs and falls back to `sendconsole.ps1`
  against the pty child's pid (it still has a console), so autonomy survives a
  GUI-side bug.

## Testing

- **Unit (fast tier)**: clearbot transport selection — pty record → pipe path;
  legacy record → sendconsole path; pipe failure → fallback. Pipe server
  refusals: control chars rejected, length cap, submit-as-separate-message.
- **Integration**: spawn the real pty host (no GUI) against a dummy console
  app; assert bytes written via the named pipe arrive on the child's stdin and
  a submit message yields a lone CR after the text.
- **E2E (proof tier)**: extend the real-claude harness (commit 6ad5d44) with
  the exact reported failure as a scenario: embedded launch, zero human input,
  assert the kick's turn actually starts (transcript grows). Regression-locks
  the bug.
- **Manual visual pass**: TUI colors/spinner/slash-menu render, typing works,
  resize reflows.

## Out of scope

Multiple simultaneous embedded sessions; theming beyond xterm defaults;
removing `sendconsole.ps1`/`winfind.ps1` (they remain the fallback transport).

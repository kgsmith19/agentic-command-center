# ACC Terminal Control Deck — design

Date: 2026-07-31. Extends `2026-07-31-acc-embedded-terminal-design.md` (the
ConPTY/xterm terminal, Tasks 1–6 of its plan are shipped). Approved by Kyle in
brainstorming: Option A (WinForms control deck), big resizable main window,
per-session automation pause.

## Goal

The Terminal tab becomes a place Kyle can *live in*: a much larger terminal,
with every Claude Code control he needs next to it, an always-obvious answer to
"who is driving right now — ACC or me?", and a one-click way to take over and
hand back. Dumby-proof is the bar: native controls, plain words, one banner.

Also in scope: the pty binding MISMATCH / stray console window bug observed on
launch (root-cause and fix — see "Binding bug" below), because the control deck
is worthless if clearbot's writes target the wrong session.

## 1. Window sizing

- `$form.FormBorderStyle = 'Sizable'`, `MaximizeBox = $true`,
  `WindowState = 'Maximized'` on open, `MinimumSize = 700×800` (today's size is
  the floor, so nothing existing can be squeezed).
- No per-tab reflow work: `$tabControl` is already `Dock='Fill'` and the
  WebView2 is `Dock='Fill'`, so the terminal absorbs all new space. Other tabs
  keep their absolute layouts and simply gain whitespace.
- Header: `$btnToggle` and `$chkAdv` get `Anchor = Top,Right` so they follow
  the right edge; the three status labels get `Anchor = Top,Left,Right`.

## 2. Terminal tab layout (top → bottom)

```
+----------------------------------------------------------------------+
| status strip:  goal g-2026… (active) | pty acc-term-ab12 | pid 70152 |
|                ctx band 14 | claude running                          |
+----------------------------------------------------------------------+
| [########  AUTO — ACC is driving. Click to take over.  ##########]   |   <- banner button
+----------------------------------------------------------------------+
| [Esc] [Ctrl+C] [Enter]   [/clear] [/compact]   [Start] [Stop]        |   <- control strip
+----------------------------------------------------------------------+
|                                                                      |
|                        xterm.js terminal (fills)                     |
|                                                                      |
+----------------------------------------------------------------------+
```

All WinForms, docked `Top` above the WebView2. The terminal keeps keyboard
focus; buttons are mouse-only affordances.

### Status strip

A single-line (wrapping to two) label refreshed by a 2s `Forms.Timer`, reading
only existing state — no new writers:

- goal id + state: `hooks/goal.mjs` store (same data the Process tab shows —
  reuse its reader).
- transport + pipe + child pid: the GUI's own `$script:pty` + `$script:bindPipe`
  and the matching `runner/state/<sid>.window` record once it appears
  (binding OK/MISMATCH/waiting is shown here, not just in a log).
- context band: `runner/state/<sid>.band` (`{"band":N}`) when present.
- session state: `claude running` / `exited — press Start`.

### Banner (the takeover control)

One full-width flat button, 40px tall, that IS the state display:

- **AUTO** — green background, text `AUTO — ACC is driving. Click to take over.`
- **PAUSED** — amber background, text `PAUSED — you have control. Click to
  resume automation.`

No pty session → gray, disabled, `No session — press Start.`

### Control strip

| Button  | Action (all direct `$script:pty` writes — same process, no pipe) |
|---------|------------------------------------------------------------------|
| Esc     | `WriteText("\x1b")`                                              |
| Ctrl+C  | `WriteText("\x03")`                                              |
| Enter   | `WriteText("\r")`                                                |
| /clear  | `\x1b`, 80ms, `/clear`, 80ms, `\r` (same text→pause→CR shape the pipe transport uses, so the TUI never sees a paste) |
| /compact| same shape with `/compact`                                       |
| Start   | exactly the existing Go-button pty spawn (extract that block into `Start-PtySession`; Go and Start call it). Disabled while running. |
| Stop    | confirm (`MessageBox` Yes/No), then `$script:pty.Dispose()`. Disabled when not running. |

All buttons work in both AUTO and PAUSED — they are Kyle's hands, not the
automation's. Buttons except Start are disabled when no pty is running.

## 3. Per-session pause (the automation gate)

- **State:** a marker file `runner/state/<pipeName>.pause` (e.g.
  `acc-term-ab12cd34ef56.pause`). The pipe name is unique per spawn and stable
  across `/clear` (it rides `ACC_PTY` on the claude process), and both the GUI
  and clearbot already know it. Created/deleted by the banner button only.
- **Clearbot honors it at the single choke point:** in `Send-Keys`, after
  `Get-TermPipe` resolves a pipe, check the marker: if present, return
  `@{ ok = $false; deferred = $true; out = 'paused' }` **without** touching the
  pipe and **without** falling back to keystrokes (pause means "hands off this
  session entirely", not "use the other transport"). Callers leave the request
  file in place, so the pending kick/clear fires on resume — resuming continues
  the goal loop with no extra machinery. Log one `PAUSED <sid>` line per
  skipped attempt (poll cadence is low; no throttling needed).
- Non-pty (external) sessions have no pause file and are untouched.
- GUI close / pty dispose deletes the session's `.pause` file so a stale marker
  can never pause a future session that happens to reuse nothing (file is
  keyed by pipe name, which is never reused, but cleanup keeps the state dir
  honest).

## 4. Binding bug — stray console + `pty binding MISMATCH`

Observed: launching the embedded session opened an extra command prompt window,
and the Step-3b watchdog logged `record consolePid 80480 does not descend from
pty child 70152`.

Evidence in hand: on this machine `claude` resolves through a native launcher —
an existing window record shows the chain `… claude.exe:84560 -> cmd.exe:81556`
— so the process that ends up running the session is not necessarily a
descendant of what `CreateProcessW` started, and something in that chain is
allocating a real console (the stray window).

This is a debugging task (systematic-debugging skill), not a pre-committed fix.
Root-cause first: reproduce the launch, capture the full process tree
(`Win32_Process` parent chain) and identify (a) which process allocated the new
console and (b) where the ancestry from the recorded `consolePid` actually
tops out. Candidate fixes, in preference order:

1. Resolve the launcher to the real entry (`node …\cli.js` or the true exe) and
   spawn that directly on the ConPTY, so the chain never detaches.
2. If the relaunch is inherent to `claude.exe`, bind by a stronger token
   instead of ancestry (e.g. match the record's `pipe` — which is already the
   spawn-unique key — and drop the descent walk to a diagnostic).
3. Make the watchdog walk robust to exited intermediates only if 1–2 both fail.

Acceptance: pty launch opens **zero** extra console windows; watchdog logs
`pty binding OK`; E2E scenario 5 passes; clearbot pipe writes land in the
hosted session (transcript evidence, per the plan's Gate 3).

## 5. Error handling

- Every button action wraps its pty call in `try/catch` → one-line message in
  the status strip (never a crash, never silent: the strip shows
  `write failed: <reason>`).
- Pause-file IO failures: creating/deleting the marker is a single
  `New-Item`/`Remove-Item`; on failure the banner does NOT flip (state shown =
  state on disk, always).
- Legacy/fallback launch (`$script:TermOk = $false`): the deck is hidden except
  a label `Embedded terminal unavailable — using external console.` Nothing
  else changes (existing fallback preserved byte-for-byte).

## 6. Testing

- `hooks/clearbot.test.mjs` (fast tier), new cases reusing the existing pty
  stubs: **paused** — pause marker present → no pipe lines, no keystrokes,
  request file still present after the run; **resumed** — marker removed →
  next run delivers `ESC/TEXT/SUBMIT` as today.
- `guards-gui.ps1 -SmokeTest`: form builds with deck controls; plus
  `watcher/screenshot-gui.ps1` screenshot showing the maximized window + deck.
- Button wiring is exercised in the plan's existing manual visual pass
  (Gate 4): Kyle clicks each control live.
- Binding fix: proven by E2E scenario 5 (already written) + zero-stray-console
  check in the manual pass.

## Out of scope

- Multi-session terminals (one hosted session at a time, unchanged).
- Controls inside term.html / HTML styling (Option B, rejected).
- Global automation kill switch (per-session pause only, per Kyle).
- Any change to the sendconsole fallback transport.

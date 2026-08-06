# ACC Terminal Control Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, main thread — this repo's ACC profile allows only Explore subagents; do NOT use subagent-driven-development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the pty binding bug (dead-shell consolePid + stray console window), make the GUI window large/resizable, and add a control deck to the Terminal tab (status strip, AUTO/PAUSED takeover banner, session-key and slash-command buttons, Start/Stop) with a per-session pause clearbot honors — then finish the embedded-terminal plan's remaining E2E/docs/review/gate work.

**Architecture:** `budget.mjs` records the first non-shell ancestor (the persistent claude process) as `consolePid` on the ACC_PTY path. The GUI grows a WinForms deck docked above the WebView2 terminal; all buttons write straight into `$script:pty` (same process). Pause is a marker file `runner/state/<pipeName>.pause` toggled by the GUI banner; clearbot checks it at the `Send-Keys`/`Send-Esc` choke point and sends nothing (no fallback either) while it exists — kicks re-arm naturally because `Invoke-Kicks` only marks `kicked` on a successful send.

**Tech Stack:** PowerShell 5.1 WinForms (`guards-gui.ps1`), Node 20+ hooks (`node --test` fast tier), `watcher/clearbot.ps1`, existing pty stack (`gui/PtyHost.cs`, `gui/term.html`), `e2e/loop.e2e.mjs` proof tier.

**Spec:** `docs/superpowers/specs/2026-07-31-acc-terminal-control-deck-design.md`
**Predecessor plan (Tasks 7–8 + gates still open there):** `docs/superpowers/plans/2026-07-31-acc-embedded-terminal.md`

**Checkbox-state notice (added 2026-08-06, Phase 8 of `docs/2026-08-03-full-remediation-prompt.md`):** every checkbox below is unchecked, but substantial-to-complete matching work already exists in the repo for most tasks in this plan (confirmed by cross-referencing `OPEN-ISSUES.md` and `git log`) — this plan predates the convention of checking boxes off as work lands, and was never gone back through to update them. Do not read an unchecked box here as "not done." `OPEN-ISSUES.md` and the current code are the source of truth for what actually shipped; this file records the ORIGINAL task breakdown, not live status.

## Global Constraints

- Fast tier must stay green and hooks must never run by hand against live state — see `AGENTS.md` § "The regression, exactly" for the current command (`npm run test:windows` on Windows / `npm test` portable) and the `ACC_ROOT`/`ACC_POLICY` sandboxing rule (guards OI-006).
- C# / PS 5.1 constraints unchanged: no `$"..."`, no `nameof`, no null-conditional in `Add-Type` C#; PS 5.1 has no `&&`/ternary.
- Pause must never affect non-pty (external keystroke) sessions.
- Legacy fallback launch stays byte-for-byte; with `$script:TermOk = $false` the deck shows only the unavailable label.
- Banner copy verbatim from spec: `AUTO — ACC is driving. Click to take over.` / `PAUSED — you have control. Click to resume automation.` / `No session — press Start.` (use `-` not em-dash in code to stay ASCII-safe in PS 5.1: `AUTO - ACC is driving. Click to take over.` etc.)
- After code: `/simplify` + `/security-review` over the branch diff (console/pipe injection is a mandatory trigger), then the predecessor plan's Completion Gate.

---

### Task 1: budget.mjs — record the persistent claude process, not the transient shell

The confirmed MISMATCH root cause. `budget.mjs:413` writes `consolePid: process.ppid`; the hook's parent is a bash intermediate that exits, leaving a dead pid in the window record (observed: 80480 GONE, claude.exe 70152 alive). Everything keyed on consolePid (clearbot liveness checks, kicks, goal binding) then misfires.

**Files:**
- Modify: `hooks/budget.mjs` (~line 409–418, the `ACC_PTY` short-circuit)
- Test: `hooks/budget.test.mjs`

**Interfaces:**
- Produces: exported pure function `ptyAnchorPid(chain)` — `chain` is `[{pid, name}, ...]` ordered hook-parent-first; returns the pid of the first entry whose `name` is not a known shell, else `chain[0].pid`, else `process.ppid`. Window record shape unchanged otherwise (`transport:"pty"`, `pipe`, `hwnd:0`, `title:"acc-pty"`).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing unit tests** (append to `hooks/budget.test.mjs`, next to the existing ACC_PTY test — import `ptyAnchorPid` the same way the file imports other budget exports; if it imports nothing yet, use `import { ptyAnchorPid } from "./budget.mjs";` guarded the way neighboring suites do):

```js
test("ptyAnchorPid skips transient shell ancestors and lands on claude", () => {
  const chain = [
    { pid: 111, name: "bash.exe" },
    { pid: 222, name: "bash.exe" },
    { pid: 333, name: "claude.exe" },
    { pid: 444, name: "cmd.exe" },
  ];
  assert.equal(ptyAnchorPid(chain), 333);
});

test("ptyAnchorPid anchors at the immediate parent when it is not a shell", () => {
  // The test-runner case: the hook's parent is node.exe (alive, persistent).
  const chain = [
    { pid: 555, name: "node.exe" },
    { pid: 666, name: "powershell.exe" },
    { pid: 777, name: "claude.exe" },
  ];
  assert.equal(ptyAnchorPid(chain), 555);
});

test("ptyAnchorPid falls back to the first ancestor when all are shells", () => {
  assert.equal(ptyAnchorPid([{ pid: 888, name: "cmd.exe" }]), 888);
});
```

Note the second test: the rule is "first NON-SHELL ancestor", not "first claude" — that is what keeps the existing integration test (`consolePid must be the hook's parent... the test runner`) green, because the runner is `node.exe`.

- [ ] **Step 2: Run — expect FAIL** (`ptyAnchorPid` not exported). Run: `node --test hooks/budget.test.mjs`

- [ ] **Step 3: Implement in `hooks/budget.mjs`.** Add near the other helpers:

```js
// The hook's immediate parent on Windows is a transient shell (node -> bash ->
// bash -> claude.exe); recording it as consolePid handed clearbot a pid that
// was dead minutes later (observed: 80480 GONE while claude.exe 70152 hosted
// the session). The persistent process across /clear is the claude process:
// the first ancestor that is not a shell wrapper.
const SHELL_NAMES = new Set([
  "bash.exe", "sh.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "conhost.exe",
]);

export function ptyAnchorPid(chain) {
  const hit = chain.find((p) => p && p.name && !SHELL_NAMES.has(String(p.name).toLowerCase()));
  if (hit) return hit.pid;
  return chain.length ? chain[0].pid : process.ppid;
}

// One Win32_Process snapshot, walked in JS (a query per hop would cost
// ~200ms each at SessionStart). Returns [] on any failure -> caller falls
// back to ppid.
function ancestorChain() {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command",
       "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name)\" }"],
      { encoding: "utf8", timeout: 15000, windowsHide: true }
    );
    const byPid = new Map();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(\d+) (\d+) (.+)$/);
      if (m) byPid.set(Number(m[1]), { ppid: Number(m[2]), name: m[3].trim() });
    }
    const chain = [];
    let pid = process.ppid;
    for (let i = 0; i < 8 && pid > 0 && byPid.has(pid); i++) {
      chain.push({ pid, name: byPid.get(pid).name });
      pid = byPid.get(pid).ppid;
    }
    return chain;
  } catch {
    return [];
  }
}
```

Then change the `ACC_PTY` branch (currently `consolePid: process.ppid`):

```js
if (process.env.ACC_PTY) {
  const chain = ancestorChain();
  win = { ok: true, hwnd: 0, consolePid: chain.length ? ptyAnchorPid(chain) : process.ppid,
          transport: "pty", pipe: process.env.ACC_PTY, title: "acc-pty" };
  try { fs.writeFileSync(statePath(p.session_id, "window"), JSON.stringify(win)); } catch {}
}
```

- [ ] **Step 4: Run the full fast tier — all green**, especially the existing `ACC_PTY` integration test (its parent is `node.exe`, a non-shell, so the recorded pid is still the runner's pid).

Run: `node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs hooks/clearbot.test.mjs`

- [ ] **Step 5: Commit**

```powershell
git add hooks/budget.mjs hooks/budget.test.mjs
git commit -m "fix: pty window record anchors consolePid at the persistent claude process, not the transient shell parent"
```

---

### Task 2: Root-cause and fix the stray console window

Evidence-driven (systematic-debugging): do NOT pre-commit to a fix. Suspects: `ensureClearbot`'s detached `cmd.exe` spawn (budget.mjs:80, fires at SessionStart) and the native `claude.exe` launcher.

**Files:**
- Possibly modify: `hooks/budget.mjs` (spawn flags) and/or `watcher/start-clearbot.cmd` and/or `guards-gui.ps1` spawn command line.
- No new test files; verification is the repro procedure below (documented in the commit message).

- [ ] **Step 1: Reproduce with a window snapshot.** Sandbox everything (OI-006). From `C:\code\guards`:

```powershell
$before = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object Id, ProcessName, MainWindowTitle
$acc = Join-Path $env:TEMP ('acc-stray-' + (Get-Random)); New-Item -ItemType Directory -Force "$acc\runner\state","$acc\runner\clear-requests","$acc\watcher" | Out-Null
$env:ACC_ROOT = $acc; $env:ACC_POLICY = 'C:\code\guards\policy.json'
$pidFile = Join-Path $acc 'pty.pid'
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','gui\ptyhost.e2e.ps1','-PipeName',('acc-term-stray-' + (Get-Random)),'-GoalId','g-stray','-Cwd',$acc,'-PidFile',$pidFile,'-TimeoutSeconds','60'
Start-Sleep -Seconds 30
$after = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object Id, ProcessName, MainWindowTitle
Compare-Object $before $after -Property Id, ProcessName, MainWindowTitle | Where-Object SideIndicator -eq '=>'
```

For every new windowed pid, walk its parent chain (`Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` repeatedly) and write down where it roots. If nothing appears, repeat with the real GUI launch (`powershell -File guards-gui.ps1`, press Go with a scratch goal) — the harness and the GUI differ only in WebView2, so a window that only appears under the GUI implicates the GUI's own spawn.

- [ ] **Step 2: Apply the matching fix.**
  - If the chain roots at `start-clearbot.cmd` / `ensureClearbot`: the hidden-window intent is being dropped somewhere in `node spawn(detached) -> cmd.exe -> powershell -> Start-Process`. Fix at the first layer that shows a window (e.g. add `-WindowStyle Hidden` to the probe powershell in `start-clearbot.cmd` line 11, or replace `cmd.exe /c` with a direct `powershell -WindowStyle Hidden -File watcher\clearbot-start-probe...` equivalent). Keep the self-exclusion probe semantics identical.
  - If the chain roots at `claude.exe` (launcher respawning outside the ConPTY): change the GUI spawn (`guards-gui.ps1:1003-1004`) to resolve and spawn the real target the launcher would exec (inspect what `claude.exe` spawns via the chain evidence; if it is `node <path>\cli.js`, spawn that command line on the pty instead). If the respawn is unavoidable, record the finding in OPEN-ISSUES with the evidence and mitigate visibility only — but Task 1 already makes the *binding* correct regardless, because the anchor is found by name, not ancestry from ChildPid... (note: the GUI watchdog still walks ancestry; if the evidence shows claude genuinely detaches from ChildPid, change the watchdog to compare the record's `pipe` (already spawn-unique) and demote the descent walk to a logged diagnostic rather than a WARN).
- [ ] **Step 3: Verify: re-run Step 1's snapshot — zero new console windows**, and the watchdog path (live GUI launch) logs `pty binding OK`. Paste both outputs into the commit message.
- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "fix: no stray console window on pty launch (root cause: <what the evidence showed>)"
```

---

### Task 3: Big resizable main window

**Files:**
- Modify: `guards-gui.ps1:77-80` (form properties) and `:92-117` (header anchors)

- [ ] **Step 1: Form properties.** Replace lines 77–79 (`$form.Size` stays as the restored size):

```powershell
$form.Size = New-Object System.Drawing.Size(700, 800)
$form.MinimumSize = New-Object System.Drawing.Size(700, 800)
$form.FormBorderStyle = 'Sizable'
$form.MaximizeBox = $true
$form.WindowState = 'Maximized'
```

- [ ] **Step 2: Header anchors** so the right-side controls follow the edge and labels stretch. After the five header controls are created (line ~119):

```powershell
$lblStatus.Anchor = 'Top,Left,Right'; $lblStatusSub.Anchor = 'Top,Left,Right'; $lblStatusAct.Anchor = 'Top,Left,Right'
$btnToggle.Anchor = 'Top,Right'; $chkAdv.Anchor = 'Top,Right'
```

- [ ] **Step 3: Smoke + screenshot.** Run: `powershell -File C:/code/guards/guards-gui.ps1 -SmokeTest` (expect pass), then `powershell -File C:/code/guards/watcher/screenshot-gui.ps1` and LOOK at the image: maximized window, header intact (toggle/checkbox at the right edge), tabs fill.
- [ ] **Step 4: Commit**

```powershell
git add guards-gui.ps1
git commit -m "feat: GUI opens maximized and resizable; header anchors follow the edge"
```

---

### Task 4: Terminal control deck (status strip, banner, buttons, Start/Stop)

**Files:**
- Modify: `guards-gui.ps1` — extract `Start-PtySession` from the Go handler (lines 991–1031), build the deck in the terminal-tab section (lines 1059–1110), extend the binding watchdog (lines 1115–1143) to surface state, extend form-close/pty-exit cleanup.

**Interfaces:**
- Consumes: `$script:pty` (Acc.PtyHost), `$script:bindPipe`, `$script:GoalId`, `$tabTerm`, `$script:TermOk`.
- Produces: `Start-PtySession -GoalId <id> -ProfileName <name> -Dir <path>` (used by Go and the deck's Start); pause marker `runner/state/<pipeName>.pause` (consumed by Task 5's clearbot check); `$script:bindState` string (`waiting`/`OK`/`MISMATCH`/`TIMEOUT`) shown in the strip.

- [ ] **Step 1: Extract `Start-PtySession`.** Define it above the Go handler (function definitions are resolved at call time, but keeping it adjacent to the terminal section reads better — place it right after the `$tabTerm` construction block, and have the Go handler call it):

```powershell
# One spawn path for Go and the deck's Start button. Returns $true on spawn.
function Start-PtySession([string]$GoalId, [string]$ProfileName, [string]$Dir) {
    if ($script:pty) {
        $a = [System.Windows.Forms.MessageBox]::Show(
            'A session is already running in the Terminal tab. Stop it and start the new one?',
            'Guards', [System.Windows.Forms.MessageBoxButtons]::YesNo)
        if ($a -ne [System.Windows.Forms.DialogResult]::Yes) { return $false }
        Stop-PtySession
    }
    $pipeName = 'acc-term-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
    ... # lines 1002-1030 verbatim (spawn, ServePipe, watchdog arm, tab select, env restore in finally)
    $script:lastStart = @{ goal = $GoalId; profile = $ProfileName; dir = $Dir }
    Update-Deck
    return $true
}

# Dispose + pause-marker cleanup in one place (Stop button, restart path, form close).
function Stop-PtySession {
    if ($script:pty) { $script:pty.Dispose(); $script:pty = $null }
    if ($script:bindPipe) {
        Remove-Item (Join-Path $PSScriptRoot ("runner\state\" + $script:bindPipe + ".pause")) -ErrorAction SilentlyContinue
    }
    Update-Deck
}
```

The Go handler's embedded branch (line 991) becomes `if ($script:TermOk -and $script:wv -and $script:wv.CoreWebView2) { if (-not (Start-PtySession -GoalId $goal.id -ProfileName $name -Dir $dir)) { return } } else { <legacy block unchanged> }`. The `$env:ACC_GOAL/$env:ACC_PROFILE/$env:ACC_PTY` set/spawn/restore moves inside `Start-PtySession` with `$GoalId`/`$ProfileName` in place of `$goal.id`/`$name`.

- [ ] **Step 2: Build the deck.** In the `if ($script:TermOk)` block of the terminal-tab section, before the WebView2 is added, insert (WinForms docking is reverse z-order — add the deck panel, then keep `$script:wv` added and call `$script:wv.BringToFront()` so Fill lays out after the Top deck):

```powershell
$deck = New-Object System.Windows.Forms.Panel
$deck.Dock = 'Top'; $deck.Height = 112

$lblTermStatus = New-Object System.Windows.Forms.Label
$lblTermStatus.Dock = 'Top'; $lblTermStatus.Height = 34
$lblTermStatus.Padding = New-Object System.Windows.Forms.Padding(8, 4, 8, 0)
$lblTermStatus.Text = 'No session - press Start.'

$btnBanner = New-Object System.Windows.Forms.Button
$btnBanner.Dock = 'Top'; $btnBanner.Height = 42
$btnBanner.FlatStyle = 'Flat'
$btnBanner.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)

$strip = New-Object System.Windows.Forms.FlowLayoutPanel
$strip.Dock = 'Top'; $strip.Height = 36
$strip.Padding = New-Object System.Windows.Forms.Padding(4, 2, 4, 2)

function New-DeckButton([string]$Text, [scriptblock]$OnClick) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text; $b.AutoSize = $true; $b.Margin = New-Object System.Windows.Forms.Padding(3, 0, 3, 0)
    $b.Add_Click($OnClick)
    $strip.Controls.Add($b)
    return $b
}

# Buttons write straight into the pty - same process, no pipe round trip.
function Send-TermBytes([string]$s) {
    try { if ($script:pty) { $script:pty.WriteText($s) } }
    catch { $lblTermStatus.Text = 'write failed: ' + $_.Exception.Message }
}
# Slash commands use the transport's proven shape: Esc, text, beat, CR - a CR
# glued to the text reads as a paste and the Enter is absorbed.
function Send-TermSlash([string]$cmd) {
    try {
        if (-not $script:pty) { return }
        $script:pty.WriteText([string][char]27); Start-Sleep -Milliseconds 80
        $script:pty.WriteText($cmd);            Start-Sleep -Milliseconds 80
        $script:pty.WriteText("`r")
    } catch { $lblTermStatus.Text = 'write failed: ' + $_.Exception.Message }
}

$btnTermEsc   = New-DeckButton 'Esc'      { Send-TermBytes ([string][char]27) }
$btnTermCtlC  = New-DeckButton 'Ctrl+C'   { Send-TermBytes ([string][char]3) }
$btnTermEnter = New-DeckButton 'Enter'    { Send-TermBytes "`r" }
$btnTermClear = New-DeckButton '/clear'   { Send-TermSlash '/clear' }
$btnTermCpct  = New-DeckButton '/compact' { Send-TermSlash '/compact' }
$btnTermStart = New-DeckButton 'Start'    {
    if ($script:lastStart) { [void](Start-PtySession -GoalId $script:lastStart.goal -ProfileName $script:lastStart.profile -Dir $script:lastStart.dir) }
}
$btnTermStop  = New-DeckButton 'Stop'     {
    $a = [System.Windows.Forms.MessageBox]::Show('Stop the running Claude session?', 'Guards',
        [System.Windows.Forms.MessageBoxButtons]::YesNo)
    if ($a -eq [System.Windows.Forms.DialogResult]::Yes) { Stop-PtySession }
}

$deck.Controls.Add($strip); $deck.Controls.Add($btnBanner); $deck.Controls.Add($lblTermStatus)
$tabTerm.Controls.Add($deck)
$script:wv.BringToFront()
```

(Controls added to `$deck` in reverse dock order: strip added first docks Top-most-recent — verify visually in Step 6; if the order renders inverted, add in the opposite sequence. The three-row target order top→bottom is: status label, banner, strip.)

- [ ] **Step 3: Pause toggle + deck refresh.**

```powershell
function Get-PausePath {
    if ($script:bindPipe) { return Join-Path $PSScriptRoot ("runner\state\" + $script:bindPipe + ".pause") }
    return $null
}
function Update-Deck {
    $running = [bool]$script:pty
    foreach ($b in @($btnTermEsc, $btnTermCtlC, $btnTermEnter, $btnTermClear, $btnTermCpct, $btnTermStop)) { $b.Enabled = $running }
    $btnTermStart.Enabled = (-not $running) -and [bool]$script:lastStart
    if (-not $running) {
        $btnBanner.Enabled = $false
        $btnBanner.Text = 'No session - press Start.'
        $btnBanner.BackColor = [System.Drawing.Color]::Gainsboro
        $btnBanner.ForeColor = [System.Drawing.Color]::DimGray
        return
    }
    $btnBanner.Enabled = $true
    $pp = Get-PausePath
    if ($pp -and (Test-Path $pp)) {
        $btnBanner.Text = 'PAUSED - you have control. Click to resume automation.'
        $btnBanner.BackColor = [System.Drawing.Color]::FromArgb(255, 193, 7)
        $btnBanner.ForeColor = [System.Drawing.Color]::Black
    } else {
        $btnBanner.Text = 'AUTO - ACC is driving. Click to take over.'
        $btnBanner.BackColor = [System.Drawing.Color]::FromArgb(40, 140, 70)
        $btnBanner.ForeColor = [System.Drawing.Color]::White
    }
}
$btnBanner.Add_Click({
    $pp = Get-PausePath
    if (-not $pp) { return }
    try {
        if (Test-Path $pp) { Remove-Item $pp -Force }
        else { New-Item -ItemType File -Path $pp -Force | Out-Null }
    } catch { $lblTermStatus.Text = 'pause toggle failed: ' + $_.Exception.Message }
    Update-Deck   # state shown = state on disk, always
})
```

- [ ] **Step 4: Status strip timer + watchdog surfacing.** Add `$script:bindState = 'waiting'` before the watchdog; in the watchdog tick set it (`'OK'` / `'MISMATCH'` / `'TIMEOUT'`) alongside the existing `Write-Host` lines. Then:

```powershell
$script:deckTimer = New-Object System.Windows.Forms.Timer
$script:deckTimer.Interval = 2000
$script:deckTimer.Add_Tick({
    if ($tabControl.SelectedTab -ne $tabTerm) { return }
    $parts = @()
    if ($script:GoalId) { $parts += ('goal ' + $script:GoalId) }
    if ($script:pty) {
        $parts += ('pty ' + $script:bindPipe + ' (' + $script:bindState + ')')
        $parts += ('pid ' + $script:pty.ChildPid)
        $parts += 'claude running'
        # Context band, via the window record that carries our pipe name.
        foreach ($f in (Get-ChildItem -Path (Join-Path $PSScriptRoot 'runner\state') -Filter '*.window' -ErrorAction SilentlyContinue)) {
            try { $w = Get-Content -Raw $f.FullName | ConvertFrom-Json } catch { continue }
            if ($w.pipe -eq $script:bindPipe) {
                $band = Join-Path $PSScriptRoot ('runner\state\' + ($f.BaseName) + '.band')
                if (Test-Path $band) {
                    try { $parts += ('ctx band ' + ((Get-Content -Raw $band | ConvertFrom-Json).band)) } catch {}
                }
                break
            }
        }
    } else { $parts += 'no session' }
    $lblTermStatus.Text = ($parts -join '  |  ')
    Update-Deck
})
$script:deckTimer.Start()
```

- [ ] **Step 5: Exit/close cleanup.** In the pty `onExit` action (line 1017–1020) add `Stop-PtySession`-equivalent cleanup — the pty is already null there, so just delete the pause marker and `Update-Deck` (extend the existing `[Action]` block: after `$script:pty = $null`, add the `Remove-Item` of `Get-PausePath` result and `Update-Deck`). In the form-close handler where `$script:pty.Dispose()` runs, call `Stop-PtySession` instead.

- [ ] **Step 6: TermOk-false path.** In the `else` of `if ($script:TermOk)` (terminal-tab section), add:

```powershell
$lblNoTerm = New-Object System.Windows.Forms.Label
$lblNoTerm.Dock = 'Top'; $lblNoTerm.Height = 40
$lblNoTerm.Padding = New-Object System.Windows.Forms.Padding(8, 10, 8, 0)
$lblNoTerm.Text = 'Embedded terminal unavailable - using external console.'
$tabTerm.Controls.Add($lblNoTerm)
```

- [ ] **Step 7: Smoke + screenshot + fallback check.** `powershell -File C:/code/guards/guards-gui.ps1 -SmokeTest` → pass. Temporarily rename `gui\vendor\webview2`, re-run `-SmokeTest` → still pass (fallback label path); restore. Screenshot via `watcher/screenshot-gui.ps1`; LOOK: deck rows in the right order, banner gray-disabled, buttons disabled except nothing (no lastStart yet).
- [ ] **Step 8: Commit**

```powershell
git add guards-gui.ps1
git commit -m "feat: terminal control deck - status strip, AUTO/PAUSED takeover banner, session keys, slash shortcuts, Start/Stop"
```

---

### Task 5: Clearbot honors the pause marker (TDD)

**Files:**
- Modify: `watcher/clearbot.ps1` (`Send-Keys` :158, `Send-Esc` :176)
- Test: `hooks/clearbot.test.mjs` (append to the pty-transport section, reusing `sandbox`/`startStub`/`startPipeStub`/`writePtyWindow`/`writeRequest`/`runOnce`/`typed` exactly as the neighboring tests do)

**Interfaces:**
- Consumes: pause marker `runner/state/<pipeName>.pause` (written by Task 4's banner).
- Produces: `Send-Keys`/`Send-Esc` return `@{ ok = $false; paused = $true; out = 'paused' }` without touching pipe OR keyboard when the marker exists; a `PAUSED` log line.

- [ ] **Step 1: Write the failing tests:**

```js
test("pty transport: a paused session gets nothing - no pipe writes, no keystrokes", () => {
  const root = sandbox();
  const stub = startStub();
  const pipeName = `acc-term-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const pipe = startPipeStub(pipeName);
  try {
    writePtyWindow(root, "s-paused", stub.pid, pipeName);
    fs.writeFileSync(path.join(root, "runner", "state", `${pipeName}.pause`), "");
    writeRequest(root, "s-paused", { consolePid: stub.pid });
    const out = runOnce(root);
    assert.match(out, /PAUSED/, "clearbot logs the pause");
    assert.deepEqual(pipe.linesNow(), [], "no pipe writes while paused");
    assert.equal(typed(stub, 1500).trim(), "", "no keystroke fallback while paused");
  } finally { pipe.close(); stub.kill(); }
});

test("pty transport: removing the pause marker resumes delivery", () => {
  const root = sandbox();
  const stub = startStub();
  const pipeName = `acc-term-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const pipe = startPipeStub(pipeName);
  try {
    writePtyWindow(root, "s-resume", stub.pid, pipeName);
    const marker = path.join(root, "runner", "state", `${pipeName}.pause`);
    fs.writeFileSync(marker, "");
    writeRequest(root, "s-resume", { consolePid: stub.pid });
    runOnce(root);                       // paused: consumed, nothing sent
    fs.unlinkSync(marker);
    writeRequest(root, "s-resume", { consolePid: stub.pid });  // the re-arm (Stop hook / kicks would do this)
    const out = runOnce(root);
    assert.match(out, /CLEARED/, "the clear lands after resume");
    assert.deepEqual(pipe.linesNow(), ["ESC", "TEXT /clear", "SUBMIT"], "full protocol after resume");
    assert.equal(typed(stub, 1500).trim(), "", "still zero keystrokes");
  } finally { pipe.close(); stub.kill(); }
});
```

Adapt only if `runOnce` throttling (`$lastFire` 60s per key) suppresses the second run — `$lastFire` is only set when `$did` is true, and the paused first run returns false, so the second run is not throttled. If assertion text differs from actual log wording, match the implementation's wording — the semantics (no pipe lines, no keystrokes, then delivery after unpause) are the fixed part.

- [ ] **Step 2: Run — expect the first test FAIL** (pipe receives the protocol despite the marker). Run: `node --test hooks/clearbot.test.mjs`

- [ ] **Step 3: Implement.** In `watcher/clearbot.ps1` add above `Send-Keys`:

```powershell
# Kyle's takeover switch (control-deck spec 2026-07-31): while the marker
# exists, the operator owns the session - clearbot sends NOTHING, on either
# transport. Kicks re-arm on their own (Invoke-Kicks only marks 'kicked' on a
# successful send), so resuming needs no extra machinery.
function Test-TermPaused([string]$Pipe) {
    return (Test-Path (Join-Path $Root ("runner\state\" + $Pipe + ".pause")))
}
```

Then in `Send-Keys` (line 159, after `$pipe = Get-TermPipe $cpid`):

```powershell
    if ($pipe -and (Test-TermPaused $pipe)) {
        Log "PAUSED ${cpid}: operator has control (pipe $pipe) - not sending"
        return @{ ok = $false; paused = $true; out = 'paused' }
    }
```

And identically in `Send-Esc` after its `$pipe = Get-TermPipe $cpid`.

- [ ] **Step 4: Run the full fast tier — all green.** The dead-pipe fallback test must still pass (no marker → unchanged path).

Run: `node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs hooks/clearbot.test.mjs`

- [ ] **Step 5: Commit**

```powershell
git add watcher/clearbot.ps1 hooks/clearbot.test.mjs
git commit -m "feat: clearbot honors the per-session pause marker - paused pty sessions get nothing on any transport"
```

---

### Task 6: Finish the embedded-terminal plan (E2E, docs, reviews, gates)

Execute the predecessor plan's open items exactly as written there — this task only sequences them and folds in the deck:

- [ ] **Step 1: E2E scenario 5** (predecessor Task 7 Steps 4–5): `node e2e/loop.e2e.mjs --only 5` → PASS (kick lands via `pty OK`, transcript gains `Continue the active ACC goal.` + an assistant turn). Then `node e2e/loop.e2e.mjs` → scenarios 1–4 PASS. This also re-proves Task 1's consolePid fix end-to-end (scenario 5 step 3 reads the window record).
- [ ] **Step 2: Commit the e2e work** per the predecessor plan's Task 7 Step 6.
- [ ] **Step 3: AGENTS.md** (predecessor Task 8 Step 1) — add `gui/ptyhost.test.ps1` + `--only 5` to the regression commands; a Goals-section paragraph on pty transport; ALSO one paragraph on the control deck + pause marker (`runner/state/<pipe>.pause`, honored at `Send-Keys`/`Send-Esc`).
- [ ] **Step 4: `/simplify` then `/security-review`** over the full branch diff; apply or ledger every finding; rerun the fast tier + `gui/ptyhost.test.ps1` + `-SmokeTest` after any fix.
- [ ] **Step 5: Completion Gate 1–3** of the predecessor plan (evidence per item, commands pasted).
- [ ] **Step 6: Gate 4 — STOP AND ASK KYLE** for the manual visual pass, now including the deck: banner toggles and clearbot actually skips while PAUSED (watch `watcher/clearbot.log`), buttons send, resize reflows, no stray console window. Record his verdict via `goal.mjs log`.
- [ ] **Step 7: Gates 5–7** — reviews already done in Step 4 (re-cite), ledger sweep (OPEN-ISSUES entries current), then `goal.mjs log <id> --text "CONDITION MET: ..."` and `goal.mjs done g-20260731-214442-istm` only when every gate shows evidence.

---

## Self-review notes

- **Spec coverage:** §1 window → Task 3; §2 layout/strip/banner/buttons → Task 4; §3 pause → Tasks 4 (writer) + 5 (reader); §4 binding bug → Tasks 1 (confirmed cause) + 2 (stray console, evidence-driven); §5 error handling → Task 4 Steps 2–3 (try/catch → status label) + Task 4 Step 6 (fallback label); §6 testing → Tasks 1/5 (fast tier), 3/4 (smoke+screenshot), 6 (e2e + manual). Out-of-scope respected.
- **Type consistency:** pause marker path `runner/state/<pipeName>.pause` identical in Tasks 4 and 5; `Start-PtySession`/`Stop-PtySession`/`Update-Deck`/`Get-PausePath` defined in Task 4 and used only there; `ptyAnchorPid(chain)` shape identical between Task 1 steps; `paused = $true` return key named identically in Task 5's interface and code.
- **Known adapt-points (deliberate):** exact log wording asserted in Task 5 tests follows the implementation; deck control add-order verified visually (WinForms reverse-dock quirk); Task 2 is evidence-driven by design.

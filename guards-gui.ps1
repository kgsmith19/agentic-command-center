# Guards Control — GUI over hooks/engine.mjs. The engine owns all state changes;
# this file only renders and shells out. PS 5.1 compatible.
param([switch]$SmokeTest, [string]$ShowTab, [switch]$TestInteractiveLane) # -ShowTab <tab caption>: open on the advanced tabs, selecting one by name (screenshot proof — no coordinates to drift); -TestInteractiveLane (OI-015): headlessly exercise the reserve/reown/release handshake against a real hooks/lane.mjs and exit, no form
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wp, string lp);' -Namespace Win32 -Name Cue

# Embedded terminal (spec 2026-07-31). $script:TermOk gates the whole feature:
# false -> the Go button uses the legacy cmd /k launch, nothing else changes.
$script:TermOk = $false
$script:pty = $null
try {
    $wvDir = Join-Path $PSScriptRoot 'gui\vendor\webview2'
    Add-Type -Path (Join-Path $wvDir 'Microsoft.Web.WebView2.Core.dll')
    Add-Type -Path (Join-Path $wvDir 'Microsoft.Web.WebView2.WinForms.dll')
    [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::SetLoaderDllFolderPath($wvDir)
    # Evergreen runtime present? This throws if not installed.
    [void][Microsoft.Web.WebView2.Core.CoreWebView2Environment]::GetAvailableBrowserVersionString()
    Add-Type -Path (Join-Path $PSScriptRoot 'gui\PtyHost.cs') -ReferencedAssemblies 'System','System.Core','System.Windows.Forms'
    $script:TermOk = $true
} catch {
    Write-Host "Embedded terminal unavailable ($($_.Exception.Message)); Go will use a plain console window."
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Engine = Join-Path $Root 'hooks\engine.mjs'
$Runbox = Join-Path $Root 'runbox'
if (-not (Test-Path $Runbox)) { New-Item -ItemType Directory -Path $Runbox | Out-Null }

function Invoke-Proc {
    param([string]$FileName, [string]$Arguments, [string]$StdIn)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FileName
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    if ($StdIn) { $p.StandardInput.Write($StdIn) }
    $p.StandardInput.Close()
    $out = $p.StandardOutput.ReadToEnd()
    $err = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return New-Object PSObject -Property @{ ExitCode = $p.ExitCode; Out = $out; Err = $err }
}

function Invoke-Engine {
    param([string[]]$EngineArgs, [string]$StdIn, [switch]$ShowErrors)
    $quoted = @('"' + $Engine + '"') + ($EngineArgs | ForEach-Object { '"' + ($_ -replace '"', '') + '"' })
    $r = Invoke-Proc -FileName 'node' -Arguments ($quoted -join ' ') -StdIn $StdIn
    if ($r.ExitCode -ne 0) {
        if ($ShowErrors) { [System.Windows.Forms.MessageBox]::Show($r.Err.Trim(), 'Something went wrong') | Out-Null }
        return $null
    }
    return $r.Out.Trim()
}

# engine run/restore stream progress on stdout even on failure — return both
function Invoke-EngineRaw {
    param([string[]]$EngineArgs)
    $quoted = @('"' + $Engine + '"') + ($EngineArgs | ForEach-Object { '"' + ($_ -replace '"', '') + '"' })
    return Invoke-Proc -FileName 'node' -Arguments ($quoted -join ' ')
}

function ConvertFrom-JsonArray([string]$Json) { # PS 5.1: '[]' parses to $null, one item to a scalar
    if (-not $Json) { return @() }
    $parsed = $Json | ConvertFrom-Json
    if ($null -eq $parsed) { return @() }
    return @($parsed)
}

# ---------- interactive lane (hooks/lane.mjs, hardened 2026-08-01) ----------
# guards-gui.ps1's Go button and Terminal-tab launches used to spawn `claude`
# with zero coordination — the OTHER lane (hooks/lane.mjs) only ever wrapped
# runner.mjs/e2e's automated launches. That gap is exactly what let an
# interactive session stack concurrently with automation (or another manual
# terminal) and die in transport. This wraps every GUI-initiated claude spawn
# in its own "interactive" lane category — isolated from automation's, so
# pressing Go never queues behind a long runner job — capped against ITSELF
# (a second GUI-launched session waits, same as the existing "already
# running?" prompt already implies), and visible to the shared circuit
# breaker (warns, never blocks — a human who clicked Go should not queue).
#
# Two-step handshake because the real child pid isn't known until AFTER
# spawn: reserve under our own $PID first (Enter-InteractiveLane), then hand
# the slot to the real claude/PtyHost pid once we have it
# (Complete-InteractiveLaneHandoff) — the slot then frees itself if that
# process dies even if Exit-InteractiveLane is never reached (e.g. a crash).
# Every call is best-effort and fails OPEN: if node or lane.mjs itself is
# broken, that must never be why Kyle can't launch a session — it only means
# this one layer of protection didn't apply for that launch.
$script:LaneCli = Join-Path $Root 'hooks\lane.mjs'
$script:LaneSlot = $null

function Invoke-LaneCli {
    param([string[]]$LaneArgs)
    try {
        $quoted = @('"' + $script:LaneCli + '"') + ($LaneArgs | ForEach-Object { '"' + ($_ -replace '"', '') + '"' })
        $r = Invoke-Proc -FileName 'node' -Arguments ($quoted -join ' ')
        if (-not $r.Out) { return $null }
        return $r.Out.Trim() | ConvertFrom-Json
    } catch {
        Write-Host "lane: CLI call failed ($($_.Exception.Message)) - proceeding without lane coordination for this launch."
        return $null
    }
}

# Reserves the interactive slot under our own process id (a placeholder — the
# GUI host outlives any one session) and returns the slot index, or $null if
# the tooling errored (fail-open) or the slot is genuinely busy (returns
# $null too, but with a status message set for the caller to show).
function Enter-InteractiveLane {
    param([ref]$BusyMessage)
    $r = Invoke-LaneCli -LaneArgs @('try-acquire', 'interactive', 'gui-go', "$PID", '3600000')
    if ($null -eq $r) { return $null } # tooling unavailable - fail open, no coordination this launch
    if (-not $r.ok) {
        $held = @($r.held) | ForEach-Object { "$($_.label) (pid $($_.pid))" }
        $BusyMessage.Value = "Another interactive claude launch is already using the lane: $($held -join ', '). Close it first, or wait for it to finish."
        return $null
    }
    return $r.slot
}

# Hands the reserved slot to the real child pid so it frees itself when THAT
# process exits, not when the GUI does. Silently no-ops if slot is $null
# (lane bypassed for this launch) — never throws into the spawn path.
function Complete-InteractiveLaneHandoff {
    param([int]$Slot, [int]$ChildPid)
    if ($null -eq $Slot) { return }
    Invoke-LaneCli -LaneArgs @('reown', 'interactive', "$Slot", "$ChildPid") | Out-Null
}

function Exit-InteractiveLane {
    param([int]$Slot)
    if ($null -eq $Slot) { return }
    Invoke-LaneCli -LaneArgs @('release', 'interactive', "$Slot") | Out-Null
}

# OI-015: this exercises the exact reserve -> reown -> release handshake every
# real Go-button launch drives, against the real hooks/lane.mjs (already
# proven 44/44 in hooks/lane.test.mjs) - only the CALLER side (this file) was
# unverified. No WinForms window is built or shown; -TestInteractiveLane exits
# before the "form" section below runs at all.
if ($TestInteractiveLane) {
    $busy1 = [ref]$null
    $slot1 = Enter-InteractiveLane -BusyMessage $busy1

    $busy2 = [ref]$null
    $slot2 = $null
    if ($null -ne $slot1) { $slot2 = Enter-InteractiveLane -BusyMessage $busy2 } # must be refused: lane already held

    if ($null -ne $slot1) { Complete-InteractiveLaneHandoff -Slot $slot1 -ChildPid $PID }
    if ($null -ne $slot1) { Exit-InteractiveLane -Slot $slot1 }

    $busy3 = [ref]$null
    $slot3 = Enter-InteractiveLane -BusyMessage $busy3 # must now succeed: released
    if ($null -ne $slot3) { Exit-InteractiveLane -Slot $slot3 }

    Write-Output ([ordered]@{
        slot1 = $slot1; busy1 = $busy1.Value
        slot2 = $slot2; busy2 = $busy2.Value
        slot3 = $slot3; busy3 = $busy3.Value
    } | ConvertTo-Json -Compress)
    exit 0
}

# ---------- form ----------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Agentic Command Center'
$form.Size = New-Object System.Drawing.Size(700, 800)
$form.MinimumSize = New-Object System.Drawing.Size(700, 800)
$form.FormBorderStyle = 'Sizable'
$form.MaximizeBox = $true
# Maximized by default: the Terminal tab is a working surface now, and every
# docked control (tabs, WebView2 terminal) absorbs the space for free.
$form.WindowState = 'Maximized'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$tabControl = New-Object System.Windows.Forms.TabControl
$tabControl.Dock = 'Fill'

# Always-visible status header, above the tabs. This is the first thing read, so
# it answers two questions only: is everything OK, and do I need to do anything.
$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Top'
$header.Height = 92
$header.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(15, 10)
$lblStatus.Size = New-Object System.Drawing.Size(470, 30)
$lblStatus.Font = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)

$lblStatusSub = New-Object System.Windows.Forms.Label
$lblStatusSub.Location = New-Object System.Drawing.Point(16, 42)
$lblStatusSub.Size = New-Object System.Drawing.Size(470, 18)
$lblStatusSub.ForeColor = [System.Drawing.Color]::FromArgb(90, 95, 100)

# The "what do I do about it" line. Never blank - when nothing is wrong it says so.
$lblStatusAct = New-Object System.Windows.Forms.Label
$lblStatusAct.Location = New-Object System.Drawing.Point(16, 62)
$lblStatusAct.Size = New-Object System.Drawing.Size(470, 20)
$lblStatusAct.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)

$btnToggle = New-Object System.Windows.Forms.Button
$btnToggle.Location = New-Object System.Drawing.Point(500, 16)
$btnToggle.Size = New-Object System.Drawing.Size(170, 40)
$btnToggle.FlatStyle = 'System'
# The only way to the five detail tabs. Off by default: the work screen is the
# product, everything else is maintenance.
$chkAdv = New-Object System.Windows.Forms.CheckBox
$chkAdv.Location = New-Object System.Drawing.Point(500, 62)
$chkAdv.Size = New-Object System.Drawing.Size(170, 22)
$chkAdv.Text = 'Show advanced'

$header.Controls.AddRange(@($lblStatus, $lblStatusSub, $lblStatusAct, $btnToggle, $chkAdv))
# Resizable window: labels stretch with the width, the toggle column rides the
# right edge instead of stranding at x=500.
foreach ($c in @($lblStatus, $lblStatusSub, $lblStatusAct)) { $c.Anchor = 'Top,Left,Right' }
foreach ($c in @($btnToggle, $chkAdv)) { $c.Anchor = 'Top,Right' }

$form.Controls.Add($tabControl)
$form.Controls.Add($header)
$tabControl.BringToFront()

function New-Tab([string]$title) {
    $t = New-Object System.Windows.Forms.TabPage
    $t.Text = $title
    $tabControl.TabPages.Add($t)
    return $t
}
function Add-Ctl($parent, $ctl, $x, $y, $w, $h) {
    $ctl.Location = New-Object System.Drawing.Point($x, $y)
    if ($w) { $ctl.Size = New-Object System.Drawing.Size($w, $h) }
    $parent.Controls.Add($ctl)
    return $ctl
}
function Set-Hint($textbox, $hint) { # gray example text inside an empty single-line box
    [void][Win32.Cue]::SendMessage($textbox.Handle, 0x1501, [IntPtr]1, $hint)
}
function Fill-List($listbox, $items, $emptyText) {
    $listbox.Items.Clear()
    if ($items -and @($items).Count -gt 0) {
        foreach ($x in $items) { $listbox.Items.Add($x) | Out-Null }
    } else {
        $listbox.Items.Add($emptyText) | Out-Null
    }
}
function Get-RealSelection($listbox) { # placeholder rows start with "(" and don't count
    $s = $listbox.SelectedItem
    if ($s -and -not ([string]$s).StartsWith('(')) { return [string]$s }
    return $null
}

$tip = New-Object System.Windows.Forms.ToolTip

# ---------- tab 1: What's blocked ----------
$tabG = New-Tab "What Claude cannot touch"

$grpSec = Add-Ctl $tabG (New-Object System.Windows.Forms.GroupBox) 15 10 650 150
$grpSec.Text = ' Secret files - Claude can NEVER read or change these '
$lstSecrets = Add-Ctl $grpSec (New-Object System.Windows.Forms.ListBox) 15 22 435 78
$txtSecret = Add-Ctl $grpSec (New-Object System.Windows.Forms.TextBox) 15 112 435 24
$btnSecAdd = Add-Ctl $grpSec (New-Object System.Windows.Forms.Button) 460 110 175 26
$btnSecAdd.Text = 'Block this pattern'
$btnSecRm = Add-Ctl $grpSec (New-Object System.Windows.Forms.Button) 460 22 175 26
$btnSecRm.Text = 'Un-block selected'

$grpProt = Add-Ctl $tabG (New-Object System.Windows.Forms.GroupBox) 15 168 650 150
$grpProt.Text = " Locked files - Claude can read these, but NEVER change them "
$lstProt = Add-Ctl $grpProt (New-Object System.Windows.Forms.ListBox) 15 22 435 78
$txtProt = Add-Ctl $grpProt (New-Object System.Windows.Forms.TextBox) 15 112 435 24
$btnProtAdd = Add-Ctl $grpProt (New-Object System.Windows.Forms.Button) 460 110 175 26
$btnProtAdd.Text = 'Lock this path'
$btnProtRm = Add-Ctl $grpProt (New-Object System.Windows.Forms.Button) 460 22 175 26
$btnProtRm.Text = 'Unlock selected'

$grpProj = Add-Ctl $tabG (New-Object System.Windows.Forms.GroupBox) 15 326 650 128
$grpProj.Text = ' Folders Claude is allowed to work in '
$lstProj = Add-Ctl $grpProj (New-Object System.Windows.Forms.ListBox) 15 22 435 92
$btnProjAdd = Add-Ctl $grpProj (New-Object System.Windows.Forms.Button) 460 22 175 26
$btnProjAdd.Text = 'Watch a folder...'
$btnProjRm = Add-Ctl $grpProj (New-Object System.Windows.Forms.Button) 460 54 175 26
$btnProjRm.Text = 'Stop watching selected'

$lblNote = Add-Ctl $tabG (New-Object System.Windows.Forms.Label) 15 462 650 40
$lblNote.Text = "Good to know: this blocks Claude's file tools. Claude's terminal commands can still get around it, so treat it as a strong convention, not a vault door."
$btnConfig = Add-Ctl $tabG (New-Object System.Windows.Forms.Button) 15 506 220 28
$btnConfig.Text = 'Advanced: open the settings file'
$btnRefreshG = Add-Ctl $tabG (New-Object System.Windows.Forms.Button) 245 506 110 28
$btnRefreshG.Text = 'Refresh'

# ---------- tab 2: Give Claude keys ----------
$tabV = New-Tab 'Passwords and keys'
$lblV1 = Add-Ctl $tabV (New-Object System.Windows.Forms.Label) 15 12 650 36
$lblV1.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$lblV1.Text = 'Hand Claude a password or API key WITHOUT pasting it into the chat.'
$lblV2 = Add-Ctl $tabV (New-Object System.Windows.Forms.Label) 15 50 650 22
$lblV2.Text = 'Step 1 — paste one per line, like:   API_KEY=abc123'
$txtVaultIn = Add-Ctl $tabV (New-Object System.Windows.Forms.TextBox) 15 74 650 140
$txtVaultIn.Multiline = $true
$txtVaultIn.ScrollBars = 'Vertical'
$txtVaultIn.Font = New-Object System.Drawing.Font('Consolas', 9)
$btnImport = Add-Ctl $tabV (New-Object System.Windows.Forms.Button) 15 222 200 30
$btnImport.Text = 'Step 2 — Save to vault'
$lblVK = Add-Ctl $tabV (New-Object System.Windows.Forms.Label) 15 268 650 22
$lblVK.Text = 'Keys Claude can use (names only — the values are never shown anywhere):'
$lstVault = Add-Ctl $tabV (New-Object System.Windows.Forms.ListBox) 15 292 435 210
$btnVaultRm = Add-Ctl $tabV (New-Object System.Windows.Forms.Button) 460 292 175 28
$btnVaultRm.Text = 'Delete selected key'
$lblV3 = Add-Ctl $tabV (New-Object System.Windows.Forms.Label) 15 515 650 40
$lblV3.Text = 'How Claude uses these: it asks for a key BY NAME and the value goes straight from the vault into the right config file. If Claude ever asks you to paste a secret into the chat, add it here instead.'

# ---------- tab 3: Claude's requests ----------
$tabR = New-Tab "Claude's requests"
$lblR = Add-Ctl $tabR (New-Object System.Windows.Forms.Label) 15 10 650 34
$lblR.Text = "When Claude is blocked from doing something, it leaves a small script here. Run it from chat by typing /approve, or here: pick one, read what it does on the right, then Run."
$lblFolder = Add-Ctl $tabR (New-Object System.Windows.Forms.Label) 15 52 48 20
$lblFolder.Text = 'Folder:'
$cboFolder = Add-Ctl $tabR (New-Object System.Windows.Forms.ComboBox) 65 49 175 24
$cboFolder.DropDownStyle = 'DropDownList'
$chkDeleted = Add-Ctl $tabR (New-Object System.Windows.Forms.CheckBox) 255 50 200 22
$chkDeleted.Text = 'Show deleted (undo lives here)'

$lstRunbox = Add-Ctl $tabR (New-Object System.Windows.Forms.ListBox) 15 80 245 190
$lblPrev = Add-Ctl $tabR (New-Object System.Windows.Forms.Label) 270 62 395 18
$lblPrev.Text = 'Exactly what the selected script will do:'
$txtPreview = Add-Ctl $tabR (New-Object System.Windows.Forms.TextBox) 270 80 395 190
$txtPreview.Multiline = $true
$txtPreview.ReadOnly = $true
$txtPreview.ScrollBars = 'Both'
$txtPreview.WordWrap = $false
$txtPreview.Font = New-Object System.Drawing.Font('Consolas', 9)

$btnRun = Add-Ctl $tabR (New-Object System.Windows.Forms.Button) 15 278 110 30
$btnRun.Text = 'Run selected'
$btnRDel = Add-Ctl $tabR (New-Object System.Windows.Forms.Button) 135 278 90 30
$btnRDel.Text = 'Delete'
$btnRestore = Add-Ctl $tabR (New-Object System.Windows.Forms.Button) 235 278 90 30
$btnRestore.Text = 'Restore'
$btnFlush = Add-Ctl $tabR (New-Object System.Windows.Forms.Button) 335 278 100 30
$btnFlush.Text = 'Empty trash'
$btnRFolder = Add-Ctl $tabR (New-Object System.Windows.Forms.Button) 445 278 105 30
$btnRFolder.Text = 'Open folder'
$btnRRefresh = Add-Ctl $tabR (New-Object System.Windows.Forms.Button) 560 278 80 30
$btnRRefresh.Text = 'Refresh'

$lblROut = Add-Ctl $tabR (New-Object System.Windows.Forms.Label) 15 316 200 18
$lblROut.Text = 'Result:'
$txtRunOut = Add-Ctl $tabR (New-Object System.Windows.Forms.TextBox) 15 336 650 205
$txtRunOut.Multiline = $true
$txtRunOut.ReadOnly = $true
$txtRunOut.ScrollBars = 'Both'
$txtRunOut.WordWrap = $false
$txtRunOut.Font = New-Object System.Drawing.Font('Consolas', 9)

# ---------- tab 4: Process (ACC-PROCESS-TAB) ----------
$tabP = New-Tab "This week's spending"
$lblP0 = Add-Ctl $tabP (New-Object System.Windows.Forms.Label) 15 10 650 18
$lblP0.Text = 'How much Claude has spent in the last 7 days, and the limits that keep it in check.'
$lblPTier = Add-Ctl $tabP (New-Object System.Windows.Forms.Label) 15 32 520 32
$lblPTier.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$btnPRefresh = Add-Ctl $tabP (New-Object System.Windows.Forms.Button) 545 34 120 28
$btnPRefresh.Text = 'Refresh'

# One sentence a non-technical reader can act on, under the big number.
$lblPSummary = Add-Ctl $tabP (New-Object System.Windows.Forms.Label) 16 66 650 20
$lblPSummary.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$lblPSummary.ForeColor = [System.Drawing.Color]::FromArgb(90, 95, 100)

# The raw console dump was the most intimidating thing on this screen and said
# nothing the summary above does not. Collapsed by default, one click away.
$chkTech = Add-Ctl $tabP (New-Object System.Windows.Forms.CheckBox) 15 488 300 20
$chkTech.Text = 'Show technical detail'
$chkTech.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$txtProcOut = Add-Ctl $tabP (New-Object System.Windows.Forms.TextBox) 15 512 650 116
$txtProcOut.Multiline = $true
$txtProcOut.ReadOnly = $true
$txtProcOut.ScrollBars = 'Both'
$txtProcOut.WordWrap = $false
$txtProcOut.Font = New-Object System.Drawing.Font('Consolas', 9)
$txtProcOut.Visible = $false
$chkTech.Add_CheckedChanged({ $txtProcOut.Visible = $chkTech.Checked })

$grpPol = Add-Ctl $tabP (New-Object System.Windows.Forms.GroupBox) 15 100 650 150
$grpPol.Text = ' Your limits '
$lblC1 = Add-Ctl $grpPol (New-Object System.Windows.Forms.Label) 15 26 150 20
$lblC1.Text = 'Warn a session at:'
$txtSoftK = Add-Ctl $grpPol (New-Object System.Windows.Forms.TextBox) 170 23 60 22
$lblC2 = Add-Ctl $grpPol (New-Object System.Windows.Forms.Label) 250 26 130 20
$lblC2.Text = 'Force it to save at:'
$txtHardK = Add-Ctl $grpPol (New-Object System.Windows.Forms.TextBox) 385 23 60 22
$lblC3 = Add-Ctl $grpPol (New-Object System.Windows.Forms.Label) 455 26 90 20
$lblC3.Text = 'Max helpers:'
$txtFinders = Add-Ctl $grpPol (New-Object System.Windows.Forms.TextBox) 550 23 45 22
$lblW1 = Add-Ctl $grpPol (New-Object System.Windows.Forms.Label) 15 56 150 20
$lblW1.Text = 'Warn me this week at:'
$txtAmber = Add-Ctl $grpPol (New-Object System.Windows.Forms.TextBox) 170 53 70 22
$lblW2 = Add-Ctl $grpPol (New-Object System.Windows.Forms.Label) 250 56 130 20
$lblW2.Text = 'STOP everything at:'
$txtRed = Add-Ctl $grpPol (New-Object System.Windows.Forms.TextBox) 385 53 70 22
$lblW3 = Add-Ctl $grpPol (New-Object System.Windows.Forms.Label) 463 56 185 20
$lblW3.Text = 'billions of tokens'
$lblA1 = Add-Ctl $grpPol (New-Object System.Windows.Forms.Label) 15 86 150 20
$lblA1.Text = 'Helpers Claude may use:'
$txtAllow = Add-Ctl $grpPol (New-Object System.Windows.Forms.TextBox) 170 83 325 22
$lblA2 = Add-Ctl $grpPol (New-Object System.Windows.Forms.Label) 505 86 130 20
$lblA2.Text = 'separate with commas'
$btnPolSave = Add-Ctl $grpPol (New-Object System.Windows.Forms.Button) 15 114 175 26
$btnPolSave.Text = 'Save my limits'
$btnPolOpen = Add-Ctl $grpPol (New-Object System.Windows.Forms.Button) 200 114 235 26
$btnPolOpen.Text = 'Advanced: open the settings file'

$grpRun = Add-Ctl $tabP (New-Object System.Windows.Forms.GroupBox) 15 258 650 118
$grpRun.Text = ' Emergency stop '
$lblKill = Add-Ctl $grpRun (New-Object System.Windows.Forms.Label) 15 24 620 22
$btnKill = Add-Ctl $grpRun (New-Object System.Windows.Forms.Button) 15 50 175 28
$btnKill.Text = 'STOP all automated work'
$btnUnstop = Add-Ctl $grpRun (New-Object System.Windows.Forms.Button) 200 50 220 28
$btnUnstop.Text = 'Resume work'
$btnFanout = Add-Ctl $grpRun (New-Object System.Windows.Forms.Button) 430 50 205 28
$btnFanout.Text = 'Allow extra helpers for 30 min'
$lblRunNote = Add-Ctl $grpRun (New-Object System.Windows.Forms.Label) 15 82 620 30
$lblRunNote.Text = 'STOP prevents new automated runs. It does not kill a session already running.'

# ---------- auto-clear watcher ----------
# Hooks cannot clear context, so an outside process types /clear as real
# keystrokes. If it is not running, auto-clear fails SILENTLY - hence a visible
# status light here rather than a CLI-only check.
$grpCB = Add-Ctl $tabP (New-Object System.Windows.Forms.GroupBox) 15 384 650 130
$grpCB.Text = ' Automatic cleanup '
$lblCB = Add-Ctl $grpCB (New-Object System.Windows.Forms.Label) 15 24 620 22
$btnCBStart = Add-Ctl $grpCB (New-Object System.Windows.Forms.Button) 15 50 175 28
$btnCBStart.Text = 'Turn cleanup ON'
$btnCBStop = Add-Ctl $grpCB (New-Object System.Windows.Forms.Button) 200 50 175 28
$btnCBStop.Text = 'Turn cleanup OFF'
$btnCBTest = Add-Ctl $grpCB (New-Object System.Windows.Forms.Button) 385 50 250 28
$btnCBTest.Text = 'Clean up my newest session now'
# The same watcher also runs pending runbox scripts when this is on, so Claude
# does not have to wait for a human /approve.
$chkAutoApprove = Add-Ctl $grpCB (New-Object System.Windows.Forms.CheckBox) 15 86 620 22
$chkAutoApprove.Text = 'Also run Claude''s requested scripts automatically (no /approve needed)'
# ---------- tab 5: Kernel (ACC-KERNEL-TAB) ----------
# Edits the policy.json "kernel" block ONLY — kernel/policy.mjs re-reads that
# file on every guardhook fire, so a save here applies to the very next tool
# call of a running kernel task, no restart (AC-U2). This is NOT a ledger
# viewer; run history stays a `node kernel/ledger.mjs query` job (spec §15).
$tabK = New-Tab 'Kernel'
# The kernel settings UI is a WEB page now (gui/kernel.html served by
# gui/server.mjs on 127.0.0.1) — the first tab migrated per spec
# docs/superpowers/specs/2026-08-03-acc-oi-closure-design.md §5-§6. This tab
# only HOSTS it (WebView2 when the runtime exists; a browser button always).
# The same page and API are what Playwright drives in CI (gui/e2e/).
$pnlKTop = New-Object System.Windows.Forms.Panel
$pnlKTop.Dock = 'Top'; $pnlKTop.Height = 36
$btnKOpen = New-Object System.Windows.Forms.Button
$btnKOpen.Text = 'Open in browser'; $btnKOpen.SetBounds(15, 5, 140, 26)
$lblKStatus = New-Object System.Windows.Forms.Label
$lblKStatus.SetBounds(170, 10, 480, 20)
$pnlKTop.Controls.Add($btnKOpen); $pnlKTop.Controls.Add($lblKStatus)
$tabK.Controls.Add($pnlKTop)

$script:kernelSrv = $null
$script:kernelUrl = $null
function Ensure-KernelServer {
    if ($script:kernelSrv -and -not $script:kernelSrv.HasExited) { return $true }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'node'
        $psi.Arguments = '"' + (Join-Path $Root 'gui\server.mjs') + '" --port 0'
        $psi.WorkingDirectory = $Root
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.CreateNoWindow = $true
        $script:kernelSrv = [System.Diagnostics.Process]::Start($psi)
        $line = $script:kernelSrv.StandardOutput.ReadLine()
        if ($line -notmatch '^LISTENING (\d+)$') { throw "unexpected server banner: $line" }
        $script:kernelUrl = "http://127.0.0.1:$($Matches[1])/kernel.html"
        $lblKStatus.Text = ''
        return $true
    } catch {
        $script:kernelUrl = $null
        $lblKStatus.Text = "kernel settings server failed to start: $($_.Exception.Message)"
        $lblKStatus.ForeColor = [System.Drawing.Color]::Firebrick
        return $false
    }
}
$btnKOpen.Add_Click({ if (Ensure-KernelServer) { Start-Process $script:kernelUrl } })

$script:kwvInit = $false
function Ensure-KernelWeb {
    if (-not (Ensure-KernelServer)) { return }
    if (-not $script:TermOk) { $lblKStatus.Text = 'WebView2 runtime missing - use the browser button.'; return }
    if ($script:kwvInit) { return }
    $script:kwvInit = $true
    $script:kwv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
    $script:kwv.Dock = [System.Windows.Forms.DockStyle]::Fill
    $tabK.Controls.Add($script:kwv)
    $script:kwv.BringToFront()
    $script:kwv.add_CoreWebView2InitializationCompleted({
        if ($script:kwv.CoreWebView2) { $script:kwv.CoreWebView2.Navigate($script:kernelUrl) }
    })
    # Same no-threadpool init dance as the Terminal tab (guards-gui.ps1:1382).
    $script:kwvEnvTask = $null
    $script:kwvTimer = New-Object System.Windows.Forms.Timer
    $script:kwvTimer.Interval = 100
    $script:kwvTimer.Add_Tick({
        if ($script:kwvEnvTask -and $script:kwvEnvTask.IsCompleted) {
            $script:kwvTimer.Stop()
            if (-not $script:kwvEnvTask.IsFaulted) {
                [void]$script:kwv.EnsureCoreWebView2Async($script:kwvEnvTask.Result)
            } else {
                $lblKStatus.Text = 'WebView2 init failed - use the browser button.'
            }
        }
    })
    $udf = Join-Path $env:LOCALAPPDATA 'acc-webview2'
    $script:kwvEnvTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, $udf, $null)
    $script:kwvTimer.Start()
}

# ---------- tab: Start work ----------
# The front door. ACC launches the session, so the folder and the rules are set
# BEFORE Claude starts, by the thing that owns them - instead of being asserted
# afterwards by a hook and hoped for. A session started here is known to ACC.
$tabS = New-Tab 'Start work'

$lblS0 = Add-Ctl $tabS (New-Object System.Windows.Forms.Label) 15 14 650 28
$lblS0.Text = 'Start a Claude Code session'
$lblS0.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)

$lblS0b = Add-Ctl $tabS (New-Object System.Windows.Forms.Label) 16 44 650 18
$lblS0b.Text = 'Say what you are working on, check the folder, press the green button. That is all.'
$lblS0b.ForeColor = [System.Drawing.Color]::FromArgb(90, 95, 100)

$grpS1 = Add-Ctl $tabS (New-Object System.Windows.Forms.GroupBox) 15 74 650 176
$grpS1.Text = ' Step 1 of 2   -   What are you working on, and where? '
$grpS1.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
# Multi-line on purpose: this box is the standing order, and one worth resuming rarely
# fits on one line. It never becomes keystrokes (see core/standing.mjs), so newlines
# in here are safe.
$txtTask = Add-Ctl $grpS1 (New-Object System.Windows.Forms.TextBox) 15 26 615 72
$txtTask.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$txtTask.Multiline = $true
$txtTask.ScrollBars = 'Vertical'
$txtTask.AcceptsReturn = $true
$cboWorkDir = Add-Ctl $grpS1 (New-Object System.Windows.Forms.ComboBox) 15 106 480 24
$cboWorkDir.DropDownStyle = 'DropDown'
$cboWorkDir.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$btnBrowseDir = Add-Ctl $grpS1 (New-Object System.Windows.Forms.Button) 505 105 125 26
$btnBrowseDir.Text = 'Browse...'
$btnBrowseDir.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$lblS1b = Add-Ctl $grpS1 (New-Object System.Windows.Forms.Label) 15 138 615 30
$lblS1b.Text = 'Say the whole job here - Claude keeps going at it across restarts until it is done. The folder fills itself in.'
$lblS1b.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$lblS1b.ForeColor = [System.Drawing.Color]::FromArgb(90, 95, 100)

$grpS2 = Add-Ctl $tabS (New-Object System.Windows.Forms.GroupBox) 15 258 650 136
$grpS2.Text = ' Step 2 of 2   -   How careful should it be? '
$grpS2.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$rbNormal = Add-Ctl $grpS2 (New-Object System.Windows.Forms.RadioButton) 15 22 615 22
$rbNormal.Text = 'Normal   -   recommended, use this unless you have a reason not to'
$rbNormal.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$rbNormal.Checked = $true
$rbHeavy = Add-Ctl $grpS2 (New-Object System.Windows.Forms.RadioButton) 15 50 615 22
$rbHeavy.Text = 'Heavy   -   more helpers. For long migrations and audits.'
$rbHeavy.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$lblS2b = Add-Ctl $grpS2 (New-Object System.Windows.Forms.Label) 15 78 615 26
$lblS2b.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$lblS2b.ForeColor = [System.Drawing.Color]::FromArgb(90, 95, 100)

$btnStartWork = Add-Ctl $tabS (New-Object System.Windows.Forms.Button) 15 404 650 56
$btnStartWork.Text = 'GO  -  START WORK ON THIS'
$btnStartWork.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$btnStartWork.BackColor = [System.Drawing.Color]::FromArgb(28, 125, 60)
$btnStartWork.ForeColor = [System.Drawing.Color]::White
$btnStartWork.FlatStyle = 'Flat'
$btnStartWork.FlatAppearance.BorderSize = 0

$lblStartOut = Add-Ctl $tabS (New-Object System.Windows.Forms.Label) 15 466 650 34
$lblStartOut.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)

# The live half of the screen. Once Go is pressed this is the only thing Kyle
# needs to look at: is it still going, how many restarts has it taken, and the
# two ways to end it.
$grpStanding = Add-Ctl $tabS (New-Object System.Windows.Forms.GroupBox) 15 504 650 96
$grpStanding.Text = ' What Claude is working on now '
$grpStanding.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$lblStanding = Add-Ctl $grpStanding (New-Object System.Windows.Forms.Label) 15 24 615 26
$lblStanding.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$btnStandingDone = Add-Ctl $grpStanding (New-Object System.Windows.Forms.Button) 15 54 200 28
$btnStandingDone.Text = 'Mark it finished'
$btnStandingStop = Add-Ctl $grpStanding (New-Object System.Windows.Forms.Button) 225 54 200 28
$btnStandingStop.Text = 'Stop restarting it'
$btnStandingLog = Add-Ctl $grpStanding (New-Object System.Windows.Forms.Button) 435 54 195 28
$btnStandingLog.Text = 'Open the progress log'

$lblS3 = Add-Ctl $tabS (New-Object System.Windows.Forms.Label) 15 606 650 40
$lblS3.Text = 'Sessions you start from a terminal still work exactly as before - they just use the standard limits instead of the profile you pick here.'
$lblS3.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$lblS3.ForeColor = [System.Drawing.Color]::FromArgb(90, 95, 100)

# ---------- state ----------
$script:ReqItems = @()   # objects shown in $lstRunbox, same order
$script:Projects = @()   # full paths from config "projects"

function Refresh-State {
    $json = Invoke-Engine -EngineArgs @('status') -ShowErrors
    if (-not $json) { return }
    $s = $json | ConvertFrom-Json
    if ($s.enabled) {
        $lblStatus.Text = 'Protection is ON'
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkGreen
        $lblStatusSub.Text = 'Claude cannot read secret files, change locked files, or cross project boundaries.'
        $header.BackColor = [System.Drawing.Color]::FromArgb(218, 240, 218)
        $btnToggle.Text = 'Turn protection OFF'
        $lblStatusAct.Text = 'Nothing to do. Say what you want done below and press Go.'
        $lblStatusAct.ForeColor = [System.Drawing.Color]::FromArgb(20, 90, 40)
    } else {
        $lblStatus.Text = 'Protection is OFF'
        $lblStatus.ForeColor = [System.Drawing.Color]::Firebrick
        $lblStatusSub.Text = 'All protections are off — Claude can read and change anything right now.'
        $header.BackColor = [System.Drawing.Color]::FromArgb(250, 228, 222)
        $btnToggle.Text = 'Turn protection ON'
        $lblStatusAct.Text = 'DO THIS: click "Turn protection ON" unless you turned it off on purpose.'
        $lblStatusAct.ForeColor = [System.Drawing.Color]::Firebrick
    }
    Fill-List $lstSecrets $s.secrets '(nothing blocked yet — type a pattern below and click "Block this pattern")'
    Fill-List $lstProt $s.protected '(nothing locked yet — type a path below and click "Lock this path")'
    Fill-List $lstProj $s.projects '(none — scripts only land in the central runbox. Click "Watch a folder...")'
    Fill-List $lstVault $s.vaultKeys '(no keys stored yet — paste some above and click "Save to vault")'
    $script:GuardsOn = [bool]$s.enabled
    $script:Projects = @($s.projects)
    # Feed the "Start work" folder picker from the folders already being watched,
    # so the common case is one click and never a typed path.
    if ($cboWorkDir) {
        $keep = $cboWorkDir.Text
        $cboWorkDir.Items.Clear()
        foreach ($proj in $script:Projects) { [void]$cboWorkDir.Items.Add($proj) }
        # With nothing watched yet the picker would be empty, which is a dead end
        # for a first-time user. Fall back to the code root that contains guards
        # and its immediate subfolders - derived, not hard-coded to one machine.
        if ($cboWorkDir.Items.Count -eq 0) {
            $codeRoot = Split-Path -Parent $Root
            if (Test-Path $codeRoot) {
                [void]$cboWorkDir.Items.Add($codeRoot)
                Get-ChildItem -Path $codeRoot -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -notmatch '^\.' } |
                    Select-Object -First 15 |
                    ForEach-Object { [void]$cboWorkDir.Items.Add($_.FullName) }
            }
        }
        if ($keep) { $cboWorkDir.Text = $keep }
        elseif ($cboWorkDir.Items.Count -gt 0) { $cboWorkDir.SelectedIndex = 0 }
    }

    $keepSel = [string]$cboFolder.SelectedItem
    $cboFolder.Items.Clear()
    [void]$cboFolder.Items.Add('All folders')
    [void]$cboFolder.Items.Add('central')
    foreach ($p in $script:Projects) { [void]$cboFolder.Items.Add((Split-Path $p -Leaf)) }
    $idx = $cboFolder.Items.IndexOf($keepSel)
    if ($idx -ge 0) { $cboFolder.SelectedIndex = $idx } else { $cboFolder.SelectedIndex = 0 }
}

function Refresh-Requests {
    $txtPreview.Text = ''
    $inTrash = $chkDeleted.Checked
    if ($inTrash) { $cmd = 'trash-list' } else { $cmd = 'list' }
    $json = Invoke-Engine -EngineArgs @($cmd, '--json')
    $items = ConvertFrom-JsonArray $json
    $sel = [string]$cboFolder.SelectedItem
    if ($sel -and $sel -ne 'All folders') { $items = @($items | Where-Object { $_.label -eq $sel }) }
    $script:ReqItems = $items
    $display = @($items | ForEach-Object {
        $when = ''
        try { $when = ' (' + ([datetime]$_.mtime).ToLocalTime().ToString('ddd HH:mm') + ')' } catch {}
        $_.label + ': ' + $_.name + $when
    })
    if ($inTrash) { $empty = '(trash is empty)' } else { $empty = "(empty — Claude hasn't left any scripts for you)" }
    Fill-List $lstRunbox $display $empty
    $btnRun.Enabled = -not $inTrash
    $btnRDel.Enabled = -not $inTrash
    $btnRestore.Enabled = $inTrash
    $btnFlush.Enabled = $inTrash
}

function Get-SelectedRequest {
    if ($lstRunbox.SelectedIndex -ge 0 -and $lstRunbox.SelectedIndex -lt @($script:ReqItems).Count) {
        return $script:ReqItems[$lstRunbox.SelectedIndex]
    }
    return $null
}

# ---------- events ----------
$btnToggle.Add_Click({
    if ($script:GuardsOn) {
        $a = [System.Windows.Forms.MessageBox]::Show(
            "Turn protection off?`n`nClaude will be able to read and change ANY file — including secrets — until you turn it back on.",
            'Turn protection off?', 'YesNo', 'Warning')
        if ($a -ne 'Yes') { return }
        Invoke-Engine -EngineArgs @('toggle', 'off') -ShowErrors | Out-Null
    } else {
        Invoke-Engine -EngineArgs @('toggle', 'on') -ShowErrors | Out-Null
    }
    Refresh-State
})
$btnSecAdd.Add_Click({
    if ($txtSecret.Text.Trim()) { Invoke-Engine -EngineArgs @('secret-add', $txtSecret.Text.Trim()) -ShowErrors | Out-Null; $txtSecret.Text = ''; Refresh-State }
})
$btnSecRm.Add_Click({
    $sel = Get-RealSelection $lstSecrets
    if ($sel) { Invoke-Engine -EngineArgs @('secret-rm', $sel) -ShowErrors | Out-Null; Refresh-State }
})
$btnProtAdd.Add_Click({
    if ($txtProt.Text.Trim()) { Invoke-Engine -EngineArgs @('protected-add', $txtProt.Text.Trim()) -ShowErrors | Out-Null; $txtProt.Text = ''; Refresh-State }
})
$btnProtRm.Add_Click({
    $sel = Get-RealSelection $lstProt
    if ($sel) { Invoke-Engine -EngineArgs @('protected-rm', $sel) -ShowErrors | Out-Null; Refresh-State }
})
$btnProjAdd.Add_Click({
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Pick a project folder. Claude gets a .guards drop-box inside it (never tracked in git).'
    if ($dlg.ShowDialog() -eq 'OK' -and $dlg.SelectedPath) {
        Invoke-Engine -EngineArgs @('projects-add', $dlg.SelectedPath) -ShowErrors | Out-Null
        Refresh-State
    }
})
$btnProjRm.Add_Click({
    $sel = Get-RealSelection $lstProj
    if ($sel) {
        Invoke-Engine -EngineArgs @('projects-rm', $sel) -ShowErrors | Out-Null
        Refresh-State
    }
})
$btnConfig.Add_Click({ Start-Process notepad (Join-Path $Root 'config.json') })
$btnRefreshG.Add_Click({ Refresh-State })

$btnImport.Add_Click({
    if (-not $txtVaultIn.Text.Trim()) {
        [System.Windows.Forms.MessageBox]::Show('Paste at least one KEY=VALUE line in the box first.', 'Nothing to save') | Out-Null
        return
    }
    $r = Invoke-Engine -EngineArgs @('vault-import') -StdIn $txtVaultIn.Text -ShowErrors
    if ($null -ne $r) {
        $txtVaultIn.Text = ''
        [System.Windows.Forms.MessageBox]::Show(($r -replace '^stored: ', 'Saved to vault: ') + "`n`nClaude can now use these by name.", 'Saved') | Out-Null
        Refresh-State
    }
})
$btnVaultRm.Add_Click({
    $sel = Get-RealSelection $lstVault
    if (-not $sel) { return }
    $a = [System.Windows.Forms.MessageBox]::Show("Claude will no longer be able to use '$sel'. Remove it?", 'Remove key?', 'YesNo', 'Question')
    if ($a -eq 'Yes') { Invoke-Engine -EngineArgs @('vault-rm', $sel) -ShowErrors | Out-Null; Refresh-State }
})

$lstRunbox.Add_SelectedIndexChanged({
    $it = Get-SelectedRequest
    if ($it) {
        try { $txtPreview.Text = (Get-Content (Join-Path $it.dir $it.name) -Raw -ErrorAction Stop) } catch { $txtPreview.Text = "(cannot read: $_)" }
    } else { $txtPreview.Text = '' }
})
$cboFolder.Add_SelectedIndexChanged({ Refresh-Requests })
$chkDeleted.Add_CheckedChanged({ Refresh-Requests })

$btnRun.Add_Click({
    $it = Get-SelectedRequest
    if (-not $it) { $txtRunOut.Text = 'First pick a script in the list on the left.'; return }
    $txtRunOut.Text = "running $($it.name) ...`r`n"
    $form.Refresh()
    $r = Invoke-EngineRaw -EngineArgs @('run', ($it.label + ':' + $it.name))
    if ($r.ExitCode -eq 0) { $head = "DONE (success)`r`n`r`n" } else { $head = "FAILED (exit code $($r.ExitCode))`r`n`r`n" }
    $txtRunOut.Text = $head + $r.Out + $r.Err
    Refresh-State
    Refresh-Requests
})
$btnRDel.Add_Click({
    $it = Get-SelectedRequest
    if (-not $it) { return }
    $r = Invoke-EngineRaw -EngineArgs @('trash', ($it.label + ':' + $it.name))
    $txtRunOut.Text = ($r.Out + $r.Err).Trim() + "`r`n(undo: tick 'Show deleted', pick it, click Restore)"
    Refresh-Requests
})
$btnRestore.Add_Click({
    $it = Get-SelectedRequest
    if (-not $it) { $txtRunOut.Text = "First pick a deleted script in the list."; return }
    $r = Invoke-EngineRaw -EngineArgs @('restore', ($it.label + ':' + $it.name))
    $txtRunOut.Text = ($r.Out + $r.Err).Trim()
    Refresh-Requests
})
$btnFlush.Add_Click({
    $n = @($script:ReqItems).Count
    if ($n -eq 0) { $txtRunOut.Text = 'Trash is already empty.'; return }
    $a = [System.Windows.Forms.MessageBox]::Show(
        "Permanently delete every archived script (all folders)? This cannot be undone.",
        'Empty trash?', 'YesNo', 'Warning')
    if ($a -ne 'Yes') { return }
    $r = Invoke-EngineRaw -EngineArgs @('flush', '--really')
    $txtRunOut.Text = ($r.Out + $r.Err).Trim()
    Refresh-Requests
})
$btnRFolder.Add_Click({
    $sel = [string]$cboFolder.SelectedItem
    $dir = $Runbox
    foreach ($p in $script:Projects) {
        if ((Split-Path $p -Leaf) -eq $sel) { $dir = Join-Path $p '.guards\runbox' }
    }
    Start-Process explorer $dir
})
$btnRRefresh.Add_Click({ Refresh-State; Refresh-Requests })

$txtSecret.Add_KeyDown({
    param($s, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) { $e.SuppressKeyPress = $true; $btnSecAdd.PerformClick() }
})
$txtProt.Add_KeyDown({
    param($s, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) { $e.SuppressKeyPress = $true; $btnProtAdd.PerformClick() }
})

$tabControl.Add_SelectedIndexChanged({
    if ($tabControl.SelectedTab -eq $tabR) { Refresh-Requests }
    if ($tabControl.SelectedTab -eq $tabP) { Refresh-Process }
    if ($tabControl.SelectedTab -eq $tabK) { Ensure-KernelWeb }
})

# tooltips + input hints
$tip.SetToolTip($btnToggle, 'Master switch for all guard protections')
$tip.SetToolTip($lstRunbox, 'Newest first. Select one to see its full contents on the right.')
$tip.SetToolTip($btnRDel, "Moves the script to the runbox trash — undo-able until you Empty trash")
$tip.SetToolTip($btnFlush, 'Permanently deletes everything in the trash. The only true delete in guards.')
$tip.SetToolTip($btnProjAdd, 'Adds <folder>\.guards\runbox where Claude can drop scripts for that project')
$tip.SetToolTip($btnConfig, 'Opens the raw settings file in Notepad — per-project boundary rules live here')
Set-Hint $txtSecret 'example: *.pfx   (blocks any file ending in .pfx, everywhere)'
Set-Hint $txtProt 'example: C:/code/myrepo/important-config.yaml'

Refresh-State
Refresh-Requests
# ---------- Process tab logic (ACC-PROCESS-TAB) ----------
$script:StopFile = Join-Path $Root 'runner\stop\slice-runner.stop'
$script:PolicyFile = Join-Path $Root 'policy.json'
$script:Usage = Join-Path $Root 'hooks\usage.mjs'
$script:Budget = Join-Path $Root 'hooks\budget.mjs'

function Invoke-Node([string]$Script, [string[]]$NodeArgs) {
    $quoted = @('"' + $Script + '"') + ($NodeArgs | ForEach-Object { '"' + ($_ -replace '"', '') + '"' })
    return Invoke-Proc -FileName 'node' -Arguments ($quoted -join ' ')
}

function Refresh-Clearbot {
    # The probe must exclude ITSELF: a naive '*clearbot.ps1*' match also matches
    # the checking process's own command line and always reports "running".
    $n = 0
    try {
        $me = $PID
        $n = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
               Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*clearbot.ps1*' }).Count
    } catch {}
    $killed = Test-Path (Join-Path $PSScriptRoot 'watcher\clearbot.stop')
    if ($killed) {
        $lblCB.Text = 'STOPPED - kill switch engaged; sessions will NOT auto-clear.'
        $lblCB.ForeColor = [System.Drawing.Color]::Firebrick
    } elseif ($n -gt 0) {
        $lblCB.Text = "Running ($n) - over-budget sessions get /clear typed for them."
        $lblCB.ForeColor = [System.Drawing.Color]::DarkGreen
    } else {
        $lblCB.Text = 'NOT RUNNING - auto-clear will silently do nothing. Start it.'
        $lblCB.ForeColor = [System.Drawing.Color]::Firebrick
    }
}

function Refresh-Process {
    $w = Invoke-Node $script:Usage @('week')
    $c = Invoke-Node $script:Usage @('check')
    $txtProcOut.Text = (($w.Out + $w.Err).TrimEnd() + "`r`n`r`n---- check ----`r`n" + ($c.Out + $c.Err).TrimEnd())
    # usage.mjs check emits machine JSON. Parse it - do NOT regex the raw text:
    # 'redTokens' contains the substring 'red', so the old -match test painted
    # the light Firebrick on EVERY tier, including green.
    $tierText = 'no usage data'
    $tierColor = [System.Drawing.Color]::DimGray
    try {
        $raw = ($c.Out).Trim()
        if (-not $raw) { $raw = ($c.Err).Trim() }
        $t = $raw | ConvertFrom-Json
        if ($t -and $t.tier) {
            $pct = [math]::Round([double]$t.pct, 1)
            $mTok = [math]::Round([double]$t.weekTokens / 1000000, 1)
            # Say what it MEANS, not what the tier is called. The percentage and
            # the raw token count go in the smaller line underneath.
            switch ($t.tier) {
                'red' {
                    $tierText = 'STOPPED - you hit your weekly limit'
                    $tierColor = [System.Drawing.Color]::Firebrick
                    $act = 'DO THIS: raise "STOP everything at" below, or wait for the week to roll over.'
                }
                'amber' {
                    $tierText = 'Getting expensive'
                    $tierColor = [System.Drawing.Color]::DarkGoldenrod
                    $act = 'Heads up: you are past your warning level for the week. Nothing is blocked yet.'
                }
                default {
                    $tierText = 'Spending is fine'
                    $tierColor = [System.Drawing.Color]::DarkGreen
                    $act = ''
                }
            }
            # Cost comes from the week report, which already prices every model.
            # These two numbers measure DIFFERENT windows and must not be blended
            # into one figure: the limit counts only usage since the limits took
            # effect, while the cost report is the true rolling 7 days. Stated as
            # two sentences so neither is read as the other.
            # Anchor on TOTAL - a bare '$' match grabs the FIRST row (main only),
            # which understated the real spend by ~40%.
            $dollars = ''
            $m = [regex]::Match(($w.Out + $w.Err), 'TOTAL[^\r\n]*?\$([\d,]+\.\d\d)')
            if ($m.Success) { $dollars = ('   Actual spend, last 7 days: about $' + $m.Groups[1].Value) }
            $lblPSummary.Text = ("Used {0}% of your weekly limit ({1}M tokens counted).{2}" -f $pct, $mTok, $dollars)
            if ($act -and $script:GuardsOn) {
                $lblStatusAct.Text = $act
                $lblStatusAct.ForeColor = $tierColor
            }
        }
    } catch { }
    $lblPTier.Text = $tierText
    $lblPTier.ForeColor = $tierColor

    try {
        $pol = (Read-PolicyText) | ConvertFrom-Json
        $txtSoftK.Text = [string]$pol.context.softK
        $txtHardK.Text = [string]$pol.context.hardK
        # Shown in BILLIONS - a raw 10-digit token count is unreadable at a glance.
        # Rounded to 2dp, so a non-round threshold can shift by up to ~5M tokens
        # on a save (verified: 1.2B/1.8B/0 round-trip EXACT; 999,999,999 -> 1.0B).
        # Immaterial against a billion-token limit, and only if you re-save.
        $txtAmber.Text = [string][math]::Round(([double]$pol.week.amberTokens / 1e9), 2)
        $txtRed.Text = [string][math]::Round(([double]$pol.week.redTokens / 1e9), 2)
        $txtFinders.Text = [string]$pol.review.maxFinders
        $txtAllow.Text = (@($pol.subagents.allow) -join ', ')
        # Set through the script-scope flag so the CheckedChanged handler can tell
        # a refresh apart from a click and does not write policy.json on every load.
        $script:AutoApproveLoading = $true
        $chkAutoApprove.Checked = [bool]$pol.autoApprove.enabled
        $script:AutoApproveLoading = $false
    } catch {
        $txtProcOut.Text = "cannot read policy.json: $_`r`n`r`n" + $txtProcOut.Text
    }

    Refresh-Clearbot

    if (Test-Path $script:StopFile) {
        $lblKill.Text = 'STOPPED - the runner will not start a new run until you clear this.'
        $lblKill.ForeColor = [System.Drawing.Color]::Firebrick
    } else {
        $lblKill.Text = 'Running normally - automated work is allowed to start.'
        $lblKill.ForeColor = [System.Drawing.Color]::DarkGreen
    }
}

function Read-PolicyText { return [System.IO.File]::ReadAllText($script:PolicyFile) }

$script:AutoApproveLoading = $false
$chkAutoApprove.Add_CheckedChanged({
    if ($script:AutoApproveLoading) { return }
    try {
        $pol = (Read-PolicyText) | ConvertFrom-Json
        $pol.autoApprove.enabled = [bool]$chkAutoApprove.Checked
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($script:PolicyFile, ($pol | ConvertTo-Json -Depth 10), $enc)
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Not saved: $_", 'Something went wrong') | Out-Null
    }
})

$btnPRefresh.Add_Click({ Refresh-Process })
$btnPolOpen.Add_Click({ Start-Process notepad $script:PolicyFile })
$btnPolSave.Add_Click({
    try {
        $pol = (Read-PolicyText) | ConvertFrom-Json
        $pol.context.softK = [int]$txtSoftK.Text
        $pol.context.hardK = [int]$txtHardK.Text
        # These two fields are entered in BILLIONS; policy.json stores raw tokens.
        $pol.week.amberTokens = [long]([double]$txtAmber.Text * 1e9)
        $pol.week.redTokens = [long]([double]$txtRed.Text * 1e9)
        $pol.review.maxFinders = [int]$txtFinders.Text
        $pol.subagents.allow = @($txtAllow.Text -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $json = $pol | ConvertTo-Json -Depth 10
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($script:PolicyFile, $json, $enc)
        [System.Windows.Forms.MessageBox]::Show('Saved. Hooks pick this up on the next fire - no restart.', 'Dials saved') | Out-Null
        Refresh-Process
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Not saved: $_", 'Something went wrong') | Out-Null
    }
})
$btnKill.Add_Click({
    $dir = Split-Path $script:StopFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($script:StopFile, "stopped from the Command Center`r`n", $enc)
    Refresh-Process
})
$btnUnstop.Add_Click({
    $r = Invoke-Node $script:Budget @('unstop')
    $txtProcOut.Text = ($r.Out + $r.Err).Trim() + "`r`n`r`n" + $txtProcOut.Text
    Refresh-Process
})
$btnFanout.Add_Click({
    $r = Invoke-Node $script:Budget @('fanout', '30')
    $txtProcOut.Text = ($r.Out + $r.Err).Trim() + "`r`n`r`n" + $txtProcOut.Text
})
$btnCBStart.Add_Click({
    $r = Invoke-Proc -FileName 'cmd.exe' -Arguments ('/c "' + (Join-Path $PSScriptRoot 'watcher\start-clearbot.cmd') + '"')
    $txtProcOut.Text = ($r.Out + $r.Err).Trim() + "`r`n`r`n" + $txtProcOut.Text
    Refresh-Clearbot
})
$btnCBStop.Add_Click({
    $r = Invoke-Proc -FileName 'cmd.exe' -Arguments ('/c "' + (Join-Path $PSScriptRoot 'watcher\stop-clearbot.cmd') + '"')
    $txtProcOut.Text = ($r.Out + $r.Err).Trim() + "`r`n`r`n" + $txtProcOut.Text
    Refresh-Clearbot
})
$btnCBTest.Add_Click({
    # Types /clear into the most recently started session for real - confirm first.
    $ans = [System.Windows.Forms.MessageBox]::Show(
        "This types /clear into the newest Claude Code session right now, ending its context." + [Environment]::NewLine +
        "Anything unsaved in that session's prompt is discarded. Continue?",
        'Clear the newest session', 'YesNo', 'Warning')
    if ($ans -ne 'Yes') { return }
    $r = Invoke-Node $script:Budget @('clear-now')
    $txtProcOut.Text = ($r.Out + $r.Err).Trim() + "`r`n`r`n" + $txtProcOut.Text
    Refresh-Clearbot
})

# ---------- Start work handlers ----------
function Get-SelectedProfile {
    if ($rbHeavy.Checked) { return 'Heavy' }
    return 'Normal'
}
function Refresh-ProfileNote {
    $name = Get-SelectedProfile
    $pol = $null
    try { $pol = (Read-PolicyText) | ConvertFrom-Json } catch { }
    if ($pol -and $pol.profiles -and $pol.profiles.$name) {
        # Limits always come from the Process-tab dials (single source of
        # truth, 2026-07-31); a profile only scopes helper agents.
        $a = @($pol.profiles.$name.subagents.allow)
        $helpers = if ($a.Count -eq 0) { 'no helper agents' } else { ($a -join ', ') }
        $lblS2b.Text = ("This session will be warned at {0}k and forced to save at {1}k (the Process-tab dials). Helpers allowed: {2}." -f $pol.context.softK, $pol.context.hardK, $helpers)
    } else {
        $lblS2b.Text = 'Using the standard limits.'
    }
}
$rbNormal.Add_CheckedChanged({ Refresh-ProfileNote })
$rbHeavy.Add_CheckedChanged({ Refresh-ProfileNote })

$btnBrowseDir.Add_Click({
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = 'Pick the folder Claude should work in'
    if ($d.ShowDialog() -eq 'OK') { $cboWorkDir.Text = $d.SelectedPath }
})

# Ask hooks/route.mjs which folder this task belongs in and preselect it.
# Advisory: it only moves the dropdown, and only when the router is confident.
# Any failure (no node, bad ROUTING.md) leaves the folder exactly as it was.
function Invoke-RouteSuggest {
    $task = $txtTask.Text.Trim()
    if (-not $task) { return }
    try {
        $raw = & node (Join-Path $PSScriptRoot 'hooks\route.mjs') '--text' $task 2>$null
        $r = $raw | ConvertFrom-Json
    } catch { return }
    if (-not $r -or -not $r.path) {
        $lblS1b.ForeColor = [System.Drawing.Color]::FromArgb(90, 95, 100)
        $lblS1b.Text = 'No clear folder match - leaving the folder as it is. Pick one yourself if you know it.'
        return
    }
    $cboWorkDir.Text = $r.path
    $lblS1b.ForeColor = [System.Drawing.Color]::FromArgb(20, 90, 40)
    $lblS1b.Text = ("Folder set to {0} - {1}. Change it if that is wrong." -f $r.label, $r.reason)
}

$txtTask.Add_Leave({ Invoke-RouteSuggest })

$script:StandingJs = Join-Path $PSScriptRoot 'core\standing.mjs'
$script:StandingId = ''

# Every Go creates a standing, so every session ACC starts is one it can resume.
# The text goes through a FILE: Invoke-Node strips double quotes and a command
# line cannot carry a newline, and this box is deliberately multi-line.
function New-StandingFromBox([string]$Text, [string]$Dir, [string]$Profile) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("acc-standing-" + [Guid]::NewGuid().ToString('N') + '.txt')
    try {
        [System.IO.File]::WriteAllText($tmp, $Text, (New-Object System.Text.UTF8Encoding($false)))
        $r = Invoke-Node $script:StandingJs @('new', '--text-file', $tmp, '--cwd', $Dir, '--profile', $Profile)
        if ($r.ExitCode -ne 0) { return $null }
        return ($r.Out.Trim() | ConvertFrom-Json)
    } catch { return $null } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}

function Refresh-Standing {
    $standingList = @()
    try {
        $r = Invoke-Node $script:StandingJs @('list')
        if ($r.ExitCode -eq 0) { $standingList = @(ConvertFrom-JsonArray ($r.Out.Trim())) }
    } catch { }
    $g = $null
    if ($script:StandingId) { $g = $standingList | Where-Object { $_.id -eq $script:StandingId } | Select-Object -First 1 }
    if (-not $g) { $g = $standingList | Select-Object -Last 1 }
    if (-not $g) {
        $script:StandingId = ''
        $lblStanding.ForeColor = [System.Drawing.Color]::FromArgb(90, 95, 100)
        $lblStanding.Text = 'Nothing running. Type the job above and press Go.'
        $btnStandingDone.Enabled = $false; $btnStandingStop.Enabled = $false; $btnStandingLog.Enabled = $false
        return
    }
    $script:StandingId = $g.id
    $first = ([string]$g.text -split "`n")[0].Trim()
    if ($first.Length -gt 60) { $first = $first.Substring(0, 57) + '...' }
    $restarts = [int]$g.cycles
    $when = if ($restarts -eq 0) { 'no restarts yet' } elseif ($restarts -eq 1) { '1 restart so far' } else { "$restarts restarts so far" }
    $lblStanding.ForeColor = [System.Drawing.Color]::FromArgb(20, 90, 40)
    $lblStanding.Text = ("Working: {0}  ({1})" -f $first, $when)
    $btnStandingDone.Enabled = $true; $btnStandingStop.Enabled = $true; $btnStandingLog.Enabled = $true
}

$btnStandingDone.Add_Click({
    if (-not $script:StandingId) { return }
    [void](Invoke-Node $script:StandingJs @('done', $script:StandingId, '--why', 'marked finished from the Command Center'))
    $script:StandingId = ''
    Refresh-Standing
})
$btnStandingStop.Add_Click({
    if (-not $script:StandingId) { return }
    [void](Invoke-Node $script:StandingJs @('paused', $script:StandingId))
    $script:StandingId = ''
    Refresh-Standing
})
$btnStandingLog.Add_Click({
    if (-not $script:StandingId) { return }
    $p = Join-Path $PSScriptRoot ("runner\standing\{0}.log.md" -f $script:StandingId)
    if (Test-Path $p) { Start-Process notepad.exe $p }
})

$btnStartWork.Add_Click({
    if ($txtTask.Focused) { Invoke-RouteSuggest }
    $task = $txtTask.Text.Trim()
    if (-not $task) {
        $lblStartOut.ForeColor = [System.Drawing.Color]::Firebrick
        $lblStartOut.Text = 'Say what the job is first (Step 1).'
        return
    }
    $dir = $cboWorkDir.Text.Trim()
    if (-not $dir) {
        $lblStartOut.ForeColor = [System.Drawing.Color]::Firebrick
        $lblStartOut.Text = 'Pick a folder first (Step 1).'
        return
    }
    if (-not (Test-Path $dir)) {
        $lblStartOut.ForeColor = [System.Drawing.Color]::Firebrick
        $lblStartOut.Text = "That folder does not exist: $dir"
        return
    }
    $name = Get-SelectedProfile
    $standing = New-StandingFromBox $task $dir $name
    if (-not $standing) {
        $lblStartOut.ForeColor = [System.Drawing.Color]::Firebrick
        $lblStartOut.Text = 'Could not save the standing - not starting. (Is node on PATH?)'
        return
    }
    try {
        if ($script:TermOk -and $script:wv -and $script:wv.CoreWebView2) {
            # Embedded launch: ACC owns the terminal (ConPTY + xterm.js), so
            # clearbot drives the session over the pty pipe - guaranteed Enter,
            # no keystroke injection.
            if (-not (Start-PtySession -StandingId $standing.id -ProfileName $name -Dir $dir)) { return }
        } else {
            # Legacy launch (no WebView2 runtime / embedded terminal unavailable).
            # UseShellExecute=$false is REQUIRED to pass ACC_PROFILE to the child.
            # cmd /k keeps the window open if 'claude' is not on PATH, so a failure
            # is visible to the user instead of a window that blinks and vanishes.
            #
            # Same interactive-lane reservation as Start-PtySession (2026-08-01
            # hardening): reserve under our own $PID, spawn, reown to the real
            # cmd.exe pid, release when it exits. This path has no ConPTY exit
            # callback to hook, so the release is wired to Process.Exited instead
            # — $script:LegacyLaneProc keeps the Process object (and its event
            # registration) alive past this click handler's own scope.
            $busyMsg = [ref]''
            $script:LegacyLaneSlot = Enter-InteractiveLane -BusyMessage $busyMsg
            if ($null -eq $script:LegacyLaneSlot -and $busyMsg.Value) {
                [System.Windows.Forms.MessageBox]::Show($busyMsg.Value, 'Guards') | Out-Null
                return
            }
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = 'cmd.exe'
            $psi.Arguments = '/k claude'
            $psi.WorkingDirectory = $dir
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $false
            $psi.EnvironmentVariables['ACC_PROFILE'] = $name
            # SessionStart reads this, binds the standing to that console, and injects the
            # text. It is the reason the work survives every later /clear.
            $psi.EnvironmentVariables['ACC_STANDING'] = $standing.id
            try {
                $p = [System.Diagnostics.Process]::Start($psi)
                Complete-InteractiveLaneHandoff -Slot $script:LegacyLaneSlot -ChildPid $p.Id
                $slotToFree = $script:LegacyLaneSlot
                $p.EnableRaisingEvents = $true
                $p.add_Exited({ Exit-InteractiveLane $slotToFree }.GetNewClosure())
                $script:LegacyLaneProc = $p
            } catch {
                if ($null -ne $script:LegacyLaneSlot) { Exit-InteractiveLane $script:LegacyLaneSlot }
                throw
            }
        }
        $script:StandingId = $standing.id
        $lblStartOut.ForeColor = [System.Drawing.Color]::FromArgb(20, 90, 40)
        $lblStartOut.Text = ("Started in {0} ({1}). It will keep restarting itself until the job is done." -f (Split-Path -Leaf $dir), $name)
        Refresh-Standing
    } catch {
        $lblStartOut.ForeColor = [System.Drawing.Color]::Firebrick
        $lblStartOut.Text = 'Could not start: ' + $_.Exception.Message
    }
})

# ---------- embedded terminal tab (spec 2026-07-31) ----------
# ACC hosts claude on a ConPTY (Acc.PtyHost) and renders it in xterm.js inside
# a WebView2 tab. clearbot then drives the session over the pty's named pipe
# instead of keystroke injection.
$tabTerm = New-Object System.Windows.Forms.TabPage
$tabTerm.Text = 'Terminal'
$script:wv = $null
$script:termCols = 120; $script:termRows = 30
$script:lastStart = $null
$script:bindState = 'waiting'
if ($script:TermOk) {
    # ---- control deck (spec 2026-07-31: control-deck design) ----
    # Docked Top, above the WebView2 terminal. Three rows, added in reverse
    # dock order (WinForms lays out the LAST-added Top control FIRST, i.e.
    # nearest the top edge): strip added first ends up lowest, banner middle,
    # status label highest - so the visual order top->bottom is status,
    # banner, strip.
    $deck = New-Object System.Windows.Forms.Panel
    $deck.Dock = 'Top'; $deck.Height = 112

    $lblTermStatus = New-Object System.Windows.Forms.Label
    $lblTermStatus.Dock = 'Top'; $lblTermStatus.Height = 34
    $lblTermStatus.Padding = New-Object System.Windows.Forms.Padding(8, 4, 8, 0)
    $lblTermStatus.Text = 'No session - press Start.'

    # The takeover control. Its text/color IS the automation state - no
    # separate indicator to fall out of sync with.
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
    # Slash commands use the transport's proven shape: Esc, text, a beat, then
    # a lone CR - a CR glued to the text reads as a paste and the Enter is
    # absorbed (the bug the pty transport exists to avoid).
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
        if ($script:lastStart) {
            [void](Start-PtySession -StandingId $script:lastStart.standing -ProfileName $script:lastStart.profile -Dir $script:lastStart.dir)
        }
    }
    $btnTermStop  = New-DeckButton 'Stop'     {
        $a = [System.Windows.Forms.MessageBox]::Show('Stop the running Claude session?', 'Guards',
            [System.Windows.Forms.MessageBoxButtons]::YesNo)
        if ($a -eq [System.Windows.Forms.DialogResult]::Yes) { Stop-PtySession }
    }

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
    # State shown = state on disk, always: the toggle never flips optimistically.
    $btnBanner.Add_Click({
        $pp = Get-PausePath
        if (-not $pp) { return }
        try {
            if (Test-Path $pp) { Remove-Item $pp -Force } else { New-Item -ItemType File -Path $pp -Force | Out-Null }
        } catch { $lblTermStatus.Text = 'pause toggle failed: ' + $_.Exception.Message }
        Update-Deck
    })

    $deck.Controls.Add($strip); $deck.Controls.Add($btnBanner); $deck.Controls.Add($lblTermStatus)
    $tabTerm.Controls.Add($deck)

    $script:wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
    $script:wv.Dock = [System.Windows.Forms.DockStyle]::Fill
    $tabTerm.Controls.Add($script:wv)
    $script:wv.BringToFront()
    $script:wv.add_CoreWebView2InitializationCompleted({
        if ($script:wv.CoreWebView2) {
            $script:wv.CoreWebView2.Navigate('file:///' + ((Join-Path $PSScriptRoot 'gui\term.html') -replace '\\', '/'))
            $script:wv.add_WebMessageReceived({
                param($s, $e)
                $m = $e.WebMessageAsJson | ConvertFrom-Json
                switch ($m.type) {
                    'in'     { if ($script:pty) { $script:pty.WriteB64($m.data) } }
                    'resize' {
                        # Remember the fitted size even before a session exists,
                        # so Start() opens the pty at the real terminal size.
                        $script:termCols = [int]$m.cols; $script:termRows = [int]$m.rows
                        if ($script:pty) { $script:pty.Resize([int16]$m.cols, [int16]$m.rows) }
                    }
                }
            })
        }
    })
    # WebView2 init must not run PS scriptblocks on threadpool threads (no
    # runspace there): poll the environment task from a UI timer instead.
    $script:wvEnvTask = $null
    $script:wvInitTimer = New-Object System.Windows.Forms.Timer
    $script:wvInitTimer.Interval = 100
    $script:wvInitTimer.Add_Tick({
        if ($script:wvEnvTask -and $script:wvEnvTask.IsCompleted) {
            $script:wvInitTimer.Stop()
            if (-not $script:wvEnvTask.IsFaulted) {
                [void]$script:wv.EnsureCoreWebView2Async($script:wvEnvTask.Result)
            } else {
                Write-Host "WebView2 init failed: $($script:wvEnvTask.Exception.InnerException.Message)"
                $script:TermOk = $false
            }
        }
    })
    $form.Add_Shown({
        $udf = Join-Path $env:LOCALAPPDATA 'acc-webview2'
        $script:wvEnvTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, $udf, $null)
        $script:wvInitTimer.Start()
    })
} else {
    # No WebView2 runtime / embedded terminal unavailable: the deck has no pty
    # to control, so it does not exist. Go still works via the legacy launch.
    $lblNoTerm = New-Object System.Windows.Forms.Label
    $lblNoTerm.Dock = 'Top'; $lblNoTerm.Height = 40
    $lblNoTerm.Padding = New-Object System.Windows.Forms.Padding(8, 10, 8, 0)
    $lblNoTerm.Text = 'Embedded terminal unavailable - using external console.'
    $tabTerm.Controls.Add($lblNoTerm)
}

# Binding watchdog (completion gate): budget.mjs must write a transport:"pty"
# window record for THIS spawn within 120s. consolePid is the claude node
# process - a DESCENDANT of the cmd-shim ChildPid, never assumed equal.
$script:bindTimer = New-Object System.Windows.Forms.Timer
$script:bindTimer.Interval = 3000
$script:bindTimer.Add_Tick({
    $hit = $null
    foreach ($f in (Get-ChildItem -Path (Join-Path $PSScriptRoot 'runner\state') -Filter '*.window' -ErrorAction SilentlyContinue)) {
        try { $w = Get-Content -Raw $f.FullName | ConvertFrom-Json } catch { continue }
        if ($w.transport -eq 'pty' -and $w.pipe -eq $script:bindPipe) { $hit = $w; break }
    }
    if ($hit) {
        $script:bindTimer.Stop()
        $p = [int]$hit.consolePid
        $anchor = if ($script:pty) { [int]$script:pty.ChildPid } else { -1 }
        $bound = $false
        for ($i = 0; $i -lt 8 -and $p -gt 0; $i++) {
            if ($p -eq $anchor) { $bound = $true; break }
            $row = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
            if (-not $row) { break }
            $p = [int]$row.ParentProcessId
        }
        if ($bound) {
            $script:bindState = 'OK'
            Write-Host ("pty binding OK: consolePid {0} descends from child {1}" -f $hit.consolePid, $anchor)
        } else {
            $script:bindState = 'MISMATCH'
            Write-Host ("WARN pty binding MISMATCH: record consolePid {0} does not descend from pty child {1} - clearbot writes may target the wrong session" -f $hit.consolePid, $anchor)
        }
    } elseif ([DateTime]::UtcNow -gt $script:bindDeadline) {
        $script:bindTimer.Stop()
        $script:bindState = 'TIMEOUT'
        Write-Host ("WARN pty binding TIMEOUT: no transport:pty window record for pipe {0} within 120s - SessionStart hook likely never fired" -f $script:bindPipe)
    }
})

# One spawn path for the Go button and the deck's Start button.
function Start-PtySession([string]$StandingId, [string]$ProfileName, [string]$Dir) {
    if ($script:pty) {
        $a = [System.Windows.Forms.MessageBox]::Show(
            'A session is already running in the Terminal tab. Stop it and start the new one?',
            'Guards', [System.Windows.Forms.MessageBoxButtons]::YesNo)
        if ($a -ne [System.Windows.Forms.DialogResult]::Yes) { return $false }
        Stop-PtySession
    }
    # Reserve the interactive lane slot BEFORE spawning (2026-08-01 hardening
    # — see the "interactive lane" section above). Busy means another
    # GUI-launched session already holds it; refuse rather than stack a
    # second concurrent claude API stream on top of it.
    $busyMsg = [ref]''
    $script:LaneSlot = Enter-InteractiveLane -BusyMessage $busyMsg
    if ($null -eq $script:LaneSlot -and $busyMsg.Value) {
        [System.Windows.Forms.MessageBox]::Show($busyMsg.Value, 'Guards') | Out-Null
        return $false
    }
    $pipeName = 'acc-term-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $claude = (Get-Command claude -ErrorAction Stop).Source
    $cmdline = if ($claude -match '\.(cmd|bat)$') { 'cmd.exe /c "' + $claude + '"' } else { '"' + $claude + '"' }
    # Acc.PtyHost spawns via CreateProcessW, which inherits OUR env: set, spawn,
    # restore. SessionStart reads ACC_STANDING to bind the standing and ACC_PTY to
    # record transport:"pty" + the pipe name.
    $env:ACC_STANDING = $StandingId; $env:ACC_PROFILE = $ProfileName; $env:ACC_PTY = $pipeName
    try {
        $script:pty = New-Object Acc.PtyHost
        $script:pty.Start($cmdline, $Dir, [int16]$script:termCols, [int16]$script:termRows, $form,
            [Action[string]]{ param($b64)
                if ($script:wv.CoreWebView2) {
                    $script:wv.CoreWebView2.PostWebMessageAsJson('{"type":"out","data":"' + $b64 + '"}')
                }
            },
            [Action]{
                if ($script:wv.CoreWebView2) { $script:wv.CoreWebView2.PostWebMessageAsJson('{"type":"exit"}') }
                $doneBindPipe = $script:bindPipe
                $script:pty = $null
                # Free the interactive lane slot the moment the real claude
                # process exits — null-guarded so Stop-PtySession's own
                # release (if it runs first) never double-frees a slot some
                # OTHER session has since taken.
                if ($null -ne $script:LaneSlot) { Exit-InteractiveLane $script:LaneSlot; $script:LaneSlot = $null }
                if ($doneBindPipe) {
                    Remove-Item (Join-Path $PSScriptRoot ("runner\state\" + $doneBindPipe + ".pause")) -ErrorAction SilentlyContinue
                }
                if (Get-Command Update-Deck -ErrorAction SilentlyContinue) { Update-Deck }
            })
        # Now that PtyHost has actually spawned claude, hand the reserved
        # slot to ITS pid — it now frees itself if that process dies even if
        # neither exit path above ever runs.
        Complete-InteractiveLaneHandoff -Slot $script:LaneSlot -ChildPid $script:pty.ChildPid
        $script:pty.ServePipe($pipeName)
        # Watchdog: confirm SessionStart actually bound this spawn.
        $script:bindPipe = $pipeName
        $script:bindState = 'waiting'
        $script:bindDeadline = [DateTime]::UtcNow.AddSeconds(120)
        $script:bindTimer.Start()
        # The terminal lives on the advanced tab strip; make it visible.
        if (-not $chkAdv.Checked) { $chkAdv.Checked = $true }
        $tabControl.SelectedTab = $tabTerm
    } catch {
        # Spawn itself failed before any child pid existed to reown to — the
        # slot is still held under our own placeholder pid; free it rather
        # than leaking it for up to an hour (the placeholder ttl).
        if ($null -ne $script:LaneSlot) { Exit-InteractiveLane $script:LaneSlot; $script:LaneSlot = $null }
        throw
    } finally {
        Remove-Item Env:ACC_STANDING, Env:ACC_PROFILE, Env:ACC_PTY -ErrorAction SilentlyContinue
    }
    $script:lastStart = @{ standing = $StandingId; profile = $ProfileName; dir = $Dir }
    if (Get-Command Update-Deck -ErrorAction SilentlyContinue) { Update-Deck }
    return $true
}

# Dispose + pause-marker cleanup in one place: the Stop button, a restart
# from Start-PtySession, and form close all funnel through here.
function Stop-PtySession {
    $p = $script:bindPipe
    if ($script:pty) { $script:pty.Dispose(); $script:pty = $null }
    if ($null -ne $script:LaneSlot) { Exit-InteractiveLane $script:LaneSlot; $script:LaneSlot = $null }
    if ($p) { Remove-Item (Join-Path $PSScriptRoot ("runner\state\" + $p + ".pause")) -ErrorAction SilentlyContinue }
    if (Get-Command Update-Deck -ErrorAction SilentlyContinue) { Update-Deck }
}

# Status strip refresh: standing id, transport/pipe/binding state, child pid,
# running/exited, context band - read-only, no new writers.
$script:deckTimer = New-Object System.Windows.Forms.Timer
$script:deckTimer.Interval = 2000
$script:deckTimer.Add_Tick({
    if (-not (Get-Variable -Name lblTermStatus -Scope Script -ErrorAction SilentlyContinue)) { return }
    if ($tabControl.SelectedTab -ne $tabTerm) { return }
    $parts = @()
    if ($script:StandingId) { $parts += ('standing ' + $script:StandingId) }
    if ($script:pty) {
        $parts += ('pty ' + $script:bindPipe + ' (' + $script:bindState + ')')
        $parts += ('pid ' + $script:pty.ChildPid)
        $parts += 'claude running'
        foreach ($f in (Get-ChildItem -Path (Join-Path $PSScriptRoot 'runner\state') -Filter '*.window' -ErrorAction SilentlyContinue)) {
            try { $w = Get-Content -Raw $f.FullName | ConvertFrom-Json } catch { continue }
            if ($w.pipe -eq $script:bindPipe) {
                $band = Join-Path $PSScriptRoot ('runner\state\' + $f.BaseName + '.band')
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

# ---------- readability pass ----------
# Section headers carry weight so the eye lands on structure first; only
# genuinely destructive buttons are red, so red keeps its meaning.
$hdrFont = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
foreach ($g in @($grpSec, $grpProt, $grpProj, $grpPol, $grpRun, $grpCB)) {
    if ($g) { $g.Font = $hdrFont }
}
# Child controls must not inherit the bold header font.
$bodyFont = New-Object System.Drawing.Font('Segoe UI', 9)
foreach ($g in @($grpSec, $grpProt, $grpProj, $grpPol, $grpRun, $grpCB)) {
    if ($g) { foreach ($ctl in $g.Controls) { $ctl.Font = $bodyFont } }
}
$dangerRed = [System.Drawing.Color]::Firebrick
foreach ($btn in @($btnSecRm, $btnProtRm, $btnProjRm, $btnVaultRm, $btnRDel, $btnFlush, $btnKill)) {
    if ($btn) { $btn.ForeColor = $dangerRed }
}
# The one button on the spending screen you press in an emergency.
if ($btnKill) { $btnKill.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold) }

# ---------- one screen ----------
# The work screen is not a sixth tab: it IS the window. The Start-work controls
# are built above exactly as before and moved here wholesale, so there is one
# copy of every control and one set of handlers - a duplicate work screen would
# drift from the tab within a week.
$pnlWork = New-Object System.Windows.Forms.Panel
$pnlWork.Dock = 'Fill'
foreach ($c in @($lblS0, $lblS0b, $grpS1, $grpS2, $btnStartWork, $lblStartOut, $grpStanding, $lblS3)) {
    $at = $c.Location
    $tabS.Controls.Remove($c)
    $pnlWork.Controls.Add($c)
    $c.Location = $at
}
$form.Controls.Add($pnlWork)
# WinForms docks in REVERSE z-order, so the Fill control must be at index 0 or it
# is laid out BEFORE the Top header and gets the full client - its first 92px
# then hide behind the header. (Cost one screenshot: the group titles vanished.)
$pnlWork.BringToFront()

# Tab order = how often you need them. Start work is no longer among them - it
# is the screen behind this control.
$ordered = @($tabP, $tabK, $tabG, $tabV, $tabR, $tabTerm)
$tabControl.TabPages.Clear()
foreach ($t in $ordered) { $tabControl.TabPages.Add($t) }
$tabControl.Visible = $false

$chkAdv.Add_CheckedChanged({
    $tabControl.Visible = $chkAdv.Checked
    $pnlWork.Visible = -not $chkAdv.Checked
    if ($chkAdv.Checked) { $tabControl.BringToFront() } else { $pnlWork.BringToFront() }
})

# The standing line has to move on its own: the thing that advances it is a session
# in another window, and Kyle is not going to press Refresh to find that out.
$standingTimer = New-Object System.Windows.Forms.Timer
$standingTimer.Interval = 5000
$standingTimer.Add_Tick({ if ($pnlWork.Visible) { Refresh-Standing } })
$form.Add_Shown({ $standingTimer.Start() })
$form.Add_FormClosed({
    $standingTimer.Stop(); $standingTimer.Dispose()
    if ($script:kernelSrv -and -not $script:kernelSrv.HasExited) { try { $script:kernelSrv.Kill() } catch {} }
})

# Closing the GUI kills any embedded session (the pty child lives in this
# process). Confirm first; Dispose -> Kill terminates the child tree.
$form.Add_FormClosing({
    param($s, $e)
    if ($script:pty) {
        $a = [System.Windows.Forms.MessageBox]::Show(
            'A Claude session is running in the Terminal tab and will be killed. Close anyway?',
            'Guards', [System.Windows.Forms.MessageBoxButtons]::YesNo)
        if ($a -ne [System.Windows.Forms.DialogResult]::Yes) { $e.Cancel = $true; return }
        Stop-PtySession
    }
})

Refresh-Process
Refresh-ProfileNote
Refresh-Standing
if ($ShowTab) {
    $chkAdv.Checked = $true
    $match = $tabControl.TabPages | Where-Object { $_.Text -eq $ShowTab } | Select-Object -First 1
    if ($match) { $tabControl.SelectedTab = $match }
}
if ($SmokeTest) {
    Write-Output "SMOKE OK status=$($lblStatus.Text) secrets=$($lstSecrets.Items.Count) protected=$($lstProt.Items.Count) projects=$($lstProj.Items.Count) vault=$($lstVault.Items.Count) runbox=$($lstRunbox.Items.Count) folders=$($cboFolder.Items.Count) tabs=$($tabControl.TabPages.Count) tab1=$($tabControl.TabPages[0].Text) workdirs=$($cboWorkDir.Items.Count) profile=$(Get-SelectedProfile) profnote=$($lblS2b.Text) tier=$($lblPTier.Text) summary=$($lblPSummary.Text) act=$($lblStatusAct.Text) clearbot=$($lblCB.Text) work=$($pnlWork.Controls.Count) adv=$($tabControl.Visible) standing=$($lblStanding.Text) autoapprove=$($chkAutoApprove.Checked)"
} else {
    [void]$form.ShowDialog()
}

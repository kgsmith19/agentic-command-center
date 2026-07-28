# Guards Control — GUI over hooks/engine.mjs. The engine owns all state changes;
# this file only renders and shells out. PS 5.1 compatible.
param([switch]$SmokeTest) # build the form and load state, but don't show the window
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wp, string lp);' -Namespace Win32 -Name Cue

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

# ---------- form ----------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Guards — control what Claude can touch'
$form.Size = New-Object System.Drawing.Size(700, 700)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$tabControl = New-Object System.Windows.Forms.TabControl
$tabControl.Dock = 'Fill'

# always-visible status header, above the tabs
$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Top'
$header.Height = 62
$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(15, 8)
$lblStatus.Size = New-Object System.Drawing.Size(470, 26)
$lblStatus.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$lblStatusSub = New-Object System.Windows.Forms.Label
$lblStatusSub.Location = New-Object System.Drawing.Point(16, 36)
$lblStatusSub.Size = New-Object System.Drawing.Size(470, 20)
$btnToggle = New-Object System.Windows.Forms.Button
$btnToggle.Location = New-Object System.Drawing.Point(500, 13)
$btnToggle.Size = New-Object System.Drawing.Size(170, 36)
$header.Controls.AddRange(@($lblStatus, $lblStatusSub, $btnToggle))

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
$tabG = New-Tab "What's blocked"

$grpSec = Add-Ctl $tabG (New-Object System.Windows.Forms.GroupBox) 15 10 650 150
$grpSec.Text = 'Secret files — Claude can NEVER read or change these'
$lstSecrets = Add-Ctl $grpSec (New-Object System.Windows.Forms.ListBox) 15 22 435 78
$txtSecret = Add-Ctl $grpSec (New-Object System.Windows.Forms.TextBox) 15 112 435 24
$btnSecAdd = Add-Ctl $grpSec (New-Object System.Windows.Forms.Button) 460 110 175 26
$btnSecAdd.Text = 'Block this pattern'
$btnSecRm = Add-Ctl $grpSec (New-Object System.Windows.Forms.Button) 460 22 175 26
$btnSecRm.Text = 'Un-block selected'

$grpProt = Add-Ctl $tabG (New-Object System.Windows.Forms.GroupBox) 15 168 650 150
$grpProt.Text = "Locked files — Claude can read these but NEVER change them"
$lstProt = Add-Ctl $grpProt (New-Object System.Windows.Forms.ListBox) 15 22 435 78
$txtProt = Add-Ctl $grpProt (New-Object System.Windows.Forms.TextBox) 15 112 435 24
$btnProtAdd = Add-Ctl $grpProt (New-Object System.Windows.Forms.Button) 460 110 175 26
$btnProtAdd.Text = 'Lock this path'
$btnProtRm = Add-Ctl $grpProt (New-Object System.Windows.Forms.Button) 460 22 175 26
$btnProtRm.Text = 'Unlock selected'

$grpProj = Add-Ctl $tabG (New-Object System.Windows.Forms.GroupBox) 15 326 650 128
$grpProj.Text = 'Watched folders — each gets its own script drop-box (.guards, never in git)'
$lstProj = Add-Ctl $grpProj (New-Object System.Windows.Forms.ListBox) 15 22 435 92
$btnProjAdd = Add-Ctl $grpProj (New-Object System.Windows.Forms.Button) 460 22 175 26
$btnProjAdd.Text = 'Watch a folder...'
$btnProjRm = Add-Ctl $grpProj (New-Object System.Windows.Forms.Button) 460 54 175 26
$btnProjRm.Text = 'Stop watching selected'

$lblNote = Add-Ctl $tabG (New-Object System.Windows.Forms.Label) 15 462 650 40
$lblNote.Text = "Good to know: this blocks Claude's file tools. Claude's terminal commands can still get around it, so treat it as a strong convention, not a vault door."
$btnConfig = Add-Ctl $tabG (New-Object System.Windows.Forms.Button) 15 506 220 28
$btnConfig.Text = 'Advanced settings (config.json)'
$btnRefreshG = Add-Ctl $tabG (New-Object System.Windows.Forms.Button) 245 506 110 28
$btnRefreshG.Text = 'Refresh'

# ---------- tab 2: Give Claude keys ----------
$tabV = New-Tab 'Give Claude keys'
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
    } else {
        $lblStatus.Text = 'Protection is OFF'
        $lblStatus.ForeColor = [System.Drawing.Color]::Firebrick
        $lblStatusSub.Text = 'All protections are off — Claude can read and change anything right now.'
        $header.BackColor = [System.Drawing.Color]::FromArgb(250, 228, 222)
        $btnToggle.Text = 'Turn protection ON'
    }
    Fill-List $lstSecrets $s.secrets '(nothing blocked yet — type a pattern below and click "Block this pattern")'
    Fill-List $lstProt $s.protected '(nothing locked yet — type a path below and click "Lock this path")'
    Fill-List $lstProj $s.projects '(none — scripts only land in the central runbox. Click "Watch a folder...")'
    Fill-List $lstVault $s.vaultKeys '(no keys stored yet — paste some above and click "Save to vault")'
    $script:GuardsOn = [bool]$s.enabled
    $script:Projects = @($s.projects)

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

$tabControl.Add_SelectedIndexChanged({ if ($tabControl.SelectedTab -eq $tabR) { Refresh-Requests } })

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
if ($SmokeTest) {
    Write-Output "SMOKE OK status=$($lblStatus.Text) secrets=$($lstSecrets.Items.Count) protected=$($lstProt.Items.Count) projects=$($lstProj.Items.Count) vault=$($lstVault.Items.Count) runbox=$($lstRunbox.Items.Count) folders=$($cboFolder.Items.Count)"
} else {
    [void]$form.ShowDialog()
}

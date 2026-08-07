# gui/ptyhost.e2e.ps1 - headless pty host for e2e scenario 5 (spec 2026-07-31).
# Spawns REAL claude on a ConPTY via Acc.PtyHost, serves the clearbot pipe,
# writes the child pid to -PidFile, then waits until the child exits or
# -TimeoutSeconds passes, disposing on the way out. No GUI, no WebView2 - the
# pty transport alone. ACC_ROOT / ACC_POLICY pass through from the caller's
# environment; ACC_DIRECTIVE / ACC_PTY are set here so SessionStart binds the directive
# and records the pty window (hooks/budget.mjs).
param(
    [Parameter(Mandatory)][string]$PipeName,
    [Parameter(Mandatory)][string]$DirectiveId,
    [Parameter(Mandatory)][string]$Cwd,
    [Parameter(Mandatory)][string]$PidFile,
    [int]$TimeoutSeconds = 600,
    [string]$Model = ''
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path (Join-Path $here 'PtyHost.cs') -ReferencedAssemblies 'System','System.Core','System.Windows.Forms'

$env:ACC_DIRECTIVE = $DirectiveId
$env:ACC_PTY = $PipeName
$env:ACC_PROFILE = ''

# Same resolution as the GUI's Go button: claude is usually a .cmd shim, so the
# ConPTY child is cmd.exe and the claude node process is its DESCENDANT.
$claude = (Get-Command claude -ErrorAction Stop).Source
$cmdline = if ($claude -match '\.(cmd|bat)$') { 'cmd.exe /c "' + $claude + '"' } else { '"' + $claude + '"' }
if ($Model) { $cmdline = $cmdline + ' --model ' + $Model }

$pty = New-Object Acc.PtyHost
try {
    $pty.Start($cmdline, $Cwd, 120, 30, $null, $null, $null)
    $pty.ServePipe($PipeName)
    Set-Content -Path $PidFile -Value $pty.ChildPid
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Get-Process -Id $pty.ChildPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 2
    }
} finally {
    $pty.Dispose()
}

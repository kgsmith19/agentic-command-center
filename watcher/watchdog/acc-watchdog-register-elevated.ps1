# OPTIONAL, ELEVATED: registers an "ACC autopilot watchdog" Scheduled Task that
# runs watcher\start-autopilot.cmd at logon and every 2 minutes.
#
# NOT INSTALLED BY DEFAULT, and not needed for the guarantee. Supervision is
# already covered without elevation:
#   - crash   -> hooks/budget.mjs revives a stale watcher at every turn boundary
#                (reviveAutopilotIfDead; proven live 2026-07-31: 0 running -> 1)
#   - reboot  -> the Startup-folder launcher (acc-watchdog-startup.ps1)
# This adds belt-and-braces external supervision for the case where a watcher
# dies while NO session is running and no logon happens.
#
# RUN FROM AN ELEVATED POWERSHELL. Unelevated it fails with
# "PermissionDenied ... HRESULT 0x80070005" (observed 2026-07-31) - task
# registration is admin-gated on this machine.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$name = 'ACC autopilot watchdog'
$cmd  = Join-Path $repoRoot 'watcher\start-autopilot.cmd'
if (-not (Test-Path $cmd)) { throw "missing $cmd" }
# A task registered under the pre-rename name still points at the old start
# script, which no longer exists. Left in place it would sit alongside the new
# task firing every 2 minutes and failing every time.
if (Get-ScheduledTask -TaskName 'ACC clearbot watchdog' -ErrorAction SilentlyContinue) {  # namegate-ok: the pre-rename task name is what must be found to remove it
    Unregister-ScheduledTask -TaskName 'ACC clearbot watchdog' -Confirm:$false  # namegate-ok: the pre-rename task name is what must be found to remove it
    Write-Host "removed stale task: ACC clearbot watchdog"  # namegate-ok: echoes the pre-rename task name it just removed
}

$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $cmd + '"')
$atLogon = New-ScheduledTaskTrigger -AtLogOn
# RepetitionDuration must be FINITE: [TimeSpan]::MaxValue does not serialise
# into valid task XML and the whole registration is rejected.
$repeat  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
             -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
# INTERACTIVE is required, not just convenient: autopilot injects keystrokes into
# consoles in the logged-on user's session, so a session-0 task would start a
# watcher that cannot reach any of them.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
               -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($atLogon, $repeat) `
    -Settings $settings -Principal $principal `
    -Description "Keeps the ACC clear-watcher alive (see $(Join-Path $repoRoot 'AGENTS.md'))" -Force | Out-Null

Write-Host "registered: $name"
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-List

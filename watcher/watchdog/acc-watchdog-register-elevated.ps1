# OPTIONAL, ELEVATED: registers an "ACC clearbot watchdog" Scheduled Task that
# runs watcher\start-clearbot.cmd at logon and every 2 minutes.
#
# NOT INSTALLED BY DEFAULT, and not needed for the guarantee. Supervision is
# already covered without elevation:
#   - crash   -> hooks/budget.mjs revives a stale watcher at every turn boundary
#                (reviveClearbotIfDead; proven live 2026-07-31: 0 running -> 1)
#   - reboot  -> the Startup-folder launcher (acc-watchdog-startup.ps1)
# This adds belt-and-braces external supervision for the case where a watcher
# dies while NO session is running and no logon happens.
#
# RUN FROM AN ELEVATED POWERSHELL. Unelevated it fails with
# "PermissionDenied ... HRESULT 0x80070005" (observed 2026-07-31) - task
# registration is admin-gated on this machine.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$name = 'ACC clearbot watchdog'
$cmd  = Join-Path $repoRoot 'watcher\start-clearbot.cmd'
if (-not (Test-Path $cmd)) { throw "missing $cmd" }

$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $cmd + '"')
$atLogon = New-ScheduledTaskTrigger -AtLogOn
# RepetitionDuration must be FINITE: [TimeSpan]::MaxValue does not serialise
# into valid task XML and the whole registration is rejected.
$repeat  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
             -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
# INTERACTIVE is required, not just convenient: clearbot injects keystrokes into
# consoles in the logged-on user's session, so a session-0 task would start a
# watcher that cannot reach any of them.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
               -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($atLogon, $repeat) `
    -Settings $settings -Principal $principal `
    -Description "Keeps the ACC clear-watcher alive (see $(Join-Path $repoRoot 'AGENTS.md'))" -Force | Out-Null

Write-Host "registered: $name"
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-List

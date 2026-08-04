# watcher/install-cap-watch-task.ps1 - registers (or re-registers) the
# ACC-ClaudeCapWatch Scheduled Task that runs watcher\claude-cap-watch.ps1
# every 60 seconds. Idempotent (-Force), self-elevates if needed.
#
# This is the CANONICAL definition of that task. It used to live only in
# runbox/install-claude-cap-gate.ps1, which is gitignored and was auto-archived
# into runbox/.trash once it succeeded (guards OI-025) - so the definition of a
# task running on Kyle's machine every minute survived nowhere runnable. It
# lives here now, tracked and unit-tested (install-cap-watch-task.test.ps1).
#
# Does NOT touch the PATH shim half of the old installer; that half succeeded
# and is idempotent where it lives.
$ErrorActionPreference = 'Stop'

# Pure - builds the task spec and nothing else, so the test can assert on it
# without registering anything. Everything below the dot-source guard is I/O.
function Get-CapWatchTaskSpec {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $scriptPath = Join-Path $RepoRoot 'watcher\claude-cap-watch.ps1'
    [pscustomobject]@{
        TaskName = 'ACC-ClaudeCapWatch'
        Execute  = 'powershell.exe'
        # Belt-and-braces only. This flag was ONCE believed to be what stopped
        # the 60s console flash; it is not, and the earlier measurement behind
        # that belief was scoped to the wrong process. See LogonType below for
        # the actual mechanism. Kept because removing it is an unrelated change.
        Argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
        RepetitionInterval = New-TimeSpan -Seconds 60
        # Finite on purpose: [TimeSpan]::MaxValue serialises to an ISO8601
        # duration ("P99999999DT23H59M59S") that Task Scheduler's XML rejects,
        # failing the whole registration (guards OI-025, twice).
        RepetitionDuration = New-TimeSpan -Days 3650
        # THE fix for the 60s window flash (Kyle, 2026-08-04). The task used to
        # run Interactive, so Windows gave its powershell.exe a console - and on
        # this machine DelegationConsole/DelegationTerminal are
        # {00000000-...} ("let Windows decide"), which hosts that console in a
        # SEPARATE, COM-activated WindowsTerminal.exe. -WindowStyle Hidden only
        # governs windows PowerShell itself owns, so it could never hide a
        # console host owned by another process. Measured across 3 consecutive
        # firings: CASCADIA_HOSTING_WINDOW_CLASS visible 469/608/491ms, plus the
        # cap-watch process's own PseudoConsoleWindow for 47ms.
        #
        # S4U = "run whether the user is logged on or not", storing no password.
        # It runs in session 0, which has no desktop, so no console host can be
        # created and no window can appear - independent of the delegation
        # setting, now or after a Windows update.
        #
        # Accepted cost: claude-cap-watch.ps1's NotifyIcon balloon can no longer
        # reach Kyle's desktop. It is already best-effort in a try/catch whose
        # own comment says the log line is the durable record, so it degrades
        # correctly with no code change. Kyle, 2026-08-04: "The WinForms balloon
        # is probably not a big deal."
        LogonType = 'S4U'
        # Limited, not Highest: elevation is needed to REGISTER this task, never
        # to run it. The check only enumerates processes and reads policy.json.
        RunLevel = 'Limited'
        ScriptPath = $scriptPath
    }
}

# Dot-sourced by the test -> functions only, no registration, no elevation.
if ($MyInvocation.InvocationName -eq '.') { return }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here
$spec = Get-CapWatchTaskSpec -RepoRoot $repoRoot
if (-not (Test-Path $spec.ScriptPath)) { throw "missing $($spec.ScriptPath)" }

# Task registration is admin-gated on this machine. Per AGENTS.md's runbox
# rule, approval to run this script IS approval to elevate: relaunch once,
# propagate the child's exit code, never silently continue unelevated.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host 'Not elevated - relaunching via UAC to register the scheduled task...'
    $child = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MyInvocation.MyCommand.Path)
    exit $child.ExitCode
}

$action = New-ScheduledTaskAction -Execute $spec.Execute -Argument $spec.Argument
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
            -RepetitionInterval $spec.RepetitionInterval -RepetitionDuration $spec.RepetitionDuration
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -MultipleInstances IgnoreNew
# Session 0, no desktop: see the LogonType comment in the spec above.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
               -LogonType $spec.LogonType -RunLevel $spec.RunLevel

Register-ScheduledTask -TaskName $spec.TaskName -Action $action -Trigger @($repeat, $atLogon) `
    -Settings $settings -Principal $principal `
    -Description 'ACC claude launch-cap health check, alert-only (C:\code\guards\watcher\claude-cap-watch.ps1)' `
    -Force | Out-Null

# Prove it landed the way we asked, rather than trusting a clean exit code.
#
# This block deliberately claims LESS than it used to. The previous version
# regex-matched the task's own arguments and then printed "no console window
# will appear" - asserting on configuration and reporting it as behaviour. The
# window kept appearing for another day. Whether a window actually appears is
# an OBSERVATION, and it belongs to watcher/flash-probe.test.ps1 (AC-2), not
# here. All this can honestly say is what it read back.
$live = Get-ScheduledTask -TaskName $spec.TaskName
$liveLogon = $live.Principal.LogonType
Write-Host "registered: $($spec.TaskName) [$($live.State)]"
Write-Host "arguments : $($live.Actions.Arguments)"
Write-Host "logontype : $liveLogon"
if ("$liveLogon" -ne $spec.LogonType) {
    Write-Error "registered task LogonType is '$liveLogon', expected '$($spec.LogonType)' - it would still run interactively and flash a console window"
    exit 1
}
Write-Host "read back : LogonType is $($spec.LogonType), so the task has no desktop to draw on."
Write-Host 'NOT verified here: that no window appears. Run watcher/flash-probe.test.ps1 to observe that.'

# watcher/flash-probe.test.ps1 - AC-2 for the 60s console flash.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File watcher/flash-probe.test.ps1
#       -> fast, hermetic: the pure classification rules only.
#   powershell ... -File watcher/flash-probe.test.ps1 -Observe
#       -> adds the real ~200s observation against the live scheduled task.
#
# The observation half is the one that matters, and it is the check guards did
# not have when it declared this bug fixed the first time.
param([switch]$Observe)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'flash-probe.ps1')

$fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:fail = 1 } }

# ---------------------------------------------------------------- pure rules
$run = Get-Date '2026-08-04T19:04:00'

Check 'a window owned by the cap-watch script is the flash, no timing needed' (
    Test-IsFlashWindow -WindowClass 'PseudoConsoleWindow' `
        -CommandLine 'powershell.exe -NoProfile -File "C:\code\guards\watcher\claude-cap-watch.ps1"')

# The exact window measured on 2026-08-04: owned by WindowsTerminal.exe, not by
# anything we configured. Attribution is by lockstep timing with the firing.
Check 'a console host appearing 1.7s after a firing is the flash' (
    Test-IsFlashWindow -WindowClass 'CASCADIA_HOSTING_WINDOW_CLASS' `
        -AppearedAt $run.AddMilliseconds(1685) -TaskLastRun $run)

Check 'a console host appearing 30s after a firing is NOT the flash (Kyle opened a terminal)' (
    -not (Test-IsFlashWindow -WindowClass 'CASCADIA_HOSTING_WINDOW_CLASS' `
        -AppearedAt $run.AddSeconds(30) -TaskLastRun $run))

Check 'a console host appearing BEFORE the firing is not attributed to it' (
    -not (Test-IsFlashWindow -WindowClass 'CASCADIA_HOSTING_WINDOW_CLASS' `
        -AppearedAt $run.AddSeconds(-5) -TaskLastRun $run))

# The GUI's WebView2 window turned up in the real 2026-08-04 probe run. A test
# that flagged it would be noise, and noise is how a real signal gets ignored.
Check 'an unrelated WebView2 window is not the flash' (
    -not (Test-IsFlashWindow -WindowClass 'Chrome_WidgetWin_1' `
        -CommandLine 'msedgewebview2.exe --embedded-browser-webview=1' `
        -AppearedAt $run.AddMilliseconds(500) -TaskLastRun $run))

Check 'a console host with no known firing time is not attributed' (
    -not (Test-IsFlashWindow -WindowClass 'CASCADIA_HOSTING_WINDOW_CLASS' -AppearedAt $run -TaskLastRun $null))

if (-not $Observe) {
    Write-Host ''
    Write-Host 'AC-2 (no window actually appears) NOT run. Re-run with -Observe to spend ~200s observing.'
    exit $fail
}

# ------------------------------------------------------- AC-2, observational
$taskName = 'ACC-ClaudeCapWatch'
$before = (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime
Write-Host "observing ~200s from $(Get-Date -Format HH:mm:ss) (task last ran $before)..."
# @() because PowerShell unrolls an empty List to $null, and "observed  windows"
# with a hole where the count should be is exactly the kind of sloppy reporting
# this file exists to replace.
$obs = @(Watch-NewWindow -Seconds 200 -TaskName $taskName)
$after = (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime

# Guard against a vacuous pass. A task that never fired produces no windows and
# would "prove" the bug fixed. Demand evidence it actually ran while we watched.
$firings = [int][math]::Floor((($after - $before).TotalSeconds / 60))
Check "the task actually fired while we watched (>=3 firings, saw $firings)" ($firings -ge 3)

$flashes = @($obs | Where-Object IsFlash)
foreach ($f in $flashes) {
    Write-Host ("  FLASH {0:HH:mm:ss.fff} class={1} pid={2} cmd={3}" -f $f.AppearedAt, $f.Class, $f.Pid, $f.CommandLine)
}
Check "no console window appears while the task fires (saw $($flashes.Count))" ($flashes.Count -eq 0)

Write-Host ("observed {0} new window(s) total, {1} attributable" -f $obs.Count, $flashes.Count)
exit $fail

# watcher/install-cap-watch-task.test.ps1 - unit tests for the ACC-ClaudeCapWatch
# task spec (pure; registers nothing, touches no machine state). Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File watcher/install-cap-watch-task.test.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-cap-watch-task.ps1')

$fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:fail = 1 } }

$spec = Get-CapWatchTaskSpec -RepoRoot 'C:\code\myrepo'

Check 'task name is the one already registered on the machine' ($spec.TaskName -eq 'ACC-ClaudeCapWatch')

# The regression Kyle reported: a console window popping up and vanishing every
# 60 seconds. The action runs in his interactive session on purpose (the balloon
# alert in claude-cap-watch.ps1 needs a desktop), so the window style is the
# only thing standing between him and a flash once a minute.
Check '-WindowStyle Hidden is present (no 60s console flash)' ($spec.Argument -match '-WindowStyle\s+Hidden')

Check 'runs the watcher script, quoted for spaces' ($spec.Argument -match '-File\s+"[^"]*claude-cap-watch\.ps1"')
Check 'no profile, bypassed execution policy' (($spec.Argument -match '-NoProfile') -and ($spec.Argument -match '-ExecutionPolicy\s+Bypass'))
Check 'script path points inside the given repo root' ($spec.ScriptPath -eq 'C:\code\myrepo\watcher\claude-cap-watch.ps1')

Check 'repeats every 60 seconds' ($spec.RepetitionInterval.TotalSeconds -eq 60)

# guards OI-025 bit twice on this: [TimeSpan]::MaxValue serialises to an
# ISO8601 duration ("P99999999DT23H59M59S") that Task Scheduler's XML rejects
# outright, so registration failed. Keep the duration long but bounded.
Check 'repetition duration is bounded, not TimeSpan::MaxValue' ($spec.RepetitionDuration -lt [TimeSpan]::MaxValue)
Check 'repetition duration is still effectively forever (>= 1 year)' ($spec.RepetitionDuration.TotalDays -ge 365)

# AC-1. The 60s flash survived -WindowStyle Hidden because the flashing window
# was never PowerShell's to hide: with DelegationTerminal unset ("let Windows
# decide"), the console for an interactive task is hosted by a SEPARATE,
# COM-activated WindowsTerminal.exe. Measured 2026-08-04 across 3 consecutive
# firings - CASCADIA_HOSTING_WINDOW_CLASS visible 469/608/491ms, plus the
# cap-watch process's own PseudoConsoleWindow for 47ms. S4U runs the task in
# session 0, which has no desktop, so no console host can exist to draw a
# window - true regardless of the terminal-delegation setting, now or after a
# Windows update. Design: docs/superpowers/specs/2026-08-04-acc-known-defects-design.md
Check 'principal logon type is S4U (session 0, no desktop -> no console host)' ($spec.LogonType -eq 'S4U')
Check 'principal run level stays Limited (elevation is for REGISTERING, not running)' ($spec.RunLevel -eq 'Limited')

exit $fail

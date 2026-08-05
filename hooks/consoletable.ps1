# OI-034 support for budget.mjs's SessionStart path. Returns
# { "<pid>": "<ISO-8601 UTC start time>" } for each pid in -Pids that
# currently exists and whose start time can be read.
#
# Unlike clearbot.ps1's per-cycle table (a full process enumeration, cheap when
# amortised over the watcher's continuous loop), SessionStart only needs to
# know about a handful of specific pids - the console it just resolved plus
# every currently-bound goal's console - so this checks exactly those, by id,
# rather than enumerating every process on the machine.
#
# A pid that does not exist, or whose StartTime cannot be read (AccessDenied),
# is simply absent from the result. That is exactly what consoleState's "pid
# absent from table" -> dead rule expects: it was checked, individually, and
# either it is gone or nothing can vouch for it.
param([string]$Pids = '')

$ErrorActionPreference = 'Stop'

$table = @{}
foreach ($raw in ($Pids -split ',')) {
    $id = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$id) -or $id -le 0) { continue }
    try {
        $p = Get-Process -Id $id -ErrorAction Stop
        $table[[string]$id] = $p.StartTime.ToUniversalTime().ToString('o')
    } catch { }
}
$json = $table | ConvertTo-Json -Compress
if (-not $json) { $json = '{}' }
Write-Output $json

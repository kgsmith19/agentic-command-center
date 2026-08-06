# Undo for acc-watchdog-startup.ps1: removes the ACC clear-watcher launcher from
# the current user's Startup folder, so it no longer starts at logon.
#
# The watcher can still be started by hand (watcher\start-autopilot.cmd or the
# Command Center button), and the hooks still revive a dead one at every turn
# boundary. This only removes the reboot/logon half of supervision.
$ErrorActionPreference = 'Stop'
# Both names on purpose. A machine that installed the launcher before the
# watcher was renamed still has 'ACC clearbot.cmd' in its Startup folder, and  # namegate-ok: names the pre-rename launcher this script removes
# that copy points at watcher\start-clearbot.cmd, which no longer exists - so  # namegate-ok: names the pre-rename start script that no longer exists
# it fails silently at every logon. Removing only the current name would leave
# that stale launcher behind forever.
$startup = [Environment]::GetFolderPath('Startup')
$found = $false
foreach ($name in @('ACC autopilot.cmd', 'ACC clearbot.cmd')) {  # namegate-ok: the pre-rename launcher name is what must be found to remove it
    $dest = Join-Path $startup $name
    if (Test-Path $dest) {
        Remove-Item $dest -Force
        Write-Host "removed: $dest"
        $found = $true
    }
}
if (-not $found) { Write-Host "not installed: $startup\ACC autopilot.cmd" }

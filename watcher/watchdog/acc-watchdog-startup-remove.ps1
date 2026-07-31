# Undo for acc-watchdog-startup.ps1: removes the ACC clear-watcher launcher from
# the current user's Startup folder, so it no longer starts at logon.
#
# The watcher can still be started by hand (watcher\start-clearbot.cmd or the
# Command Center button), and the hooks still revive a dead one at every turn
# boundary. This only removes the reboot/logon half of supervision.
$ErrorActionPreference = 'Stop'
$dest = Join-Path ([Environment]::GetFolderPath('Startup')) 'ACC clearbot.cmd'
if (Test-Path $dest) {
    Remove-Item $dest -Force
    Write-Host "removed: $dest"
} else {
    Write-Host "not installed: $dest"
}

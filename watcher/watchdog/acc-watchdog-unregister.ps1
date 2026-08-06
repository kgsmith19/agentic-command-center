# Removes the optional "ACC autopilot watchdog" Scheduled Task registered by
# acc-watchdog-register-elevated.ps1. Run from an elevated PowerShell, same as
# the registration.
#
# Harmless if it was never registered (the default). The non-elevated halves of
# supervision - turn-boundary revive in the hooks, and the Startup-folder
# launcher - are unaffected.
$ErrorActionPreference = 'Stop'
# Both names: a task registered before the watcher was renamed is still called
# "ACC clearbot watchdog" and still points at the old start script, so an  # namegate-ok: names the pre-rename task this script removes
# unregister that only knows the new name would leave it running and failing.
$found = $false
foreach ($name in @('ACC autopilot watchdog', 'ACC clearbot watchdog')) {  # namegate-ok: the pre-rename task name is what must be found to remove it
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "removed: $name"
        $found = $true
    }
}
if (-not $found) { Write-Host "not registered: ACC autopilot watchdog" }

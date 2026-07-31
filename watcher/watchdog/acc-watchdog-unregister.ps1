# Removes the optional "ACC clearbot watchdog" Scheduled Task registered by
# acc-watchdog-register-elevated.ps1. Run from an elevated PowerShell, same as
# the registration.
#
# Harmless if it was never registered (the default). The non-elevated halves of
# supervision - turn-boundary revive in the hooks, and the Startup-folder
# launcher - are unaffected.
$ErrorActionPreference = 'Stop'
$name = 'ACC clearbot watchdog'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "removed: $name"
} else {
    Write-Host "not registered: $name"
}

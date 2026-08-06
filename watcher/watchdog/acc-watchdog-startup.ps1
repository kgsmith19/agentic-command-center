# Makes the ACC clear-watcher start automatically at logon, by putting a small
# launcher in the current user's Startup folder. This is the reboot half of
# watcher supervision; the crash half is handled inside the hooks (budget.mjs
# revives a stale watcher at every turn boundary), so between them a dead
# watcher can no longer silently end ACC autonomy.
#
# No elevation needed, unlike the Scheduled Task version
# (acc-watchdog-register.ps1), which fails with 0x80070005 unless run from an
# elevated shell. It also runs in the INTERACTIVE session, which is required:
# autopilot types into consoles in the logged-on user's session.
#
# Undo: delete the file this prints, or run acc-watchdog-startup-remove.ps1.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$src = Join-Path $repoRoot 'watcher\start-autopilot.cmd'
if (-not (Test-Path $src)) { throw "missing $src" }

$startup = [Environment]::GetFolderPath('Startup')
$dest = Join-Path $startup 'ACC autopilot.cmd'
# A machine that installed this before the watcher was renamed still has the
# old launcher, and it calls a start script that no longer exists. Writing the
# new one without clearing it would leave two launchers, one permanently
# broken, both firing at logon.
$legacy = Join-Path $startup 'ACC clearbot.cmd'  # namegate-ok: the pre-rename launcher name is what must be found to remove it
if (Test-Path $legacy) { Remove-Item $legacy -Force; Write-Host "removed stale launcher: $legacy" }
$body = @"
@echo off
rem Starts the ACC clear-watcher at logon. Installed by
rem $PSCommandPath - safe to delete to opt out.
call "$src"
"@
Set-Content -Path $dest -Value $body -Encoding ascii

Write-Host "installed: $dest"
Write-Host "--- contents ---"
Get-Content $dest

# Makes the ACC clear-watcher start automatically at logon, by putting a small
# launcher in the current user's Startup folder. This is the reboot half of
# watcher supervision; the crash half is handled inside the hooks (budget.mjs
# revives a stale watcher at every turn boundary), so between them a dead
# watcher can no longer silently end ACC autonomy.
#
# No elevation needed, unlike the Scheduled Task version
# (acc-watchdog-register.ps1), which fails with 0x80070005 unless run from an
# elevated shell. It also runs in the INTERACTIVE session, which is required:
# clearbot types into consoles in the logged-on user's session.
#
# Undo: delete the file this prints, or run acc-watchdog-startup-remove.ps1.
$ErrorActionPreference = 'Stop'
$src = 'C:\code\guards\watcher\start-clearbot.cmd'
if (-not (Test-Path $src)) { throw "missing $src" }

$startup = [Environment]::GetFolderPath('Startup')
$dest = Join-Path $startup 'ACC clearbot.cmd'
$body = @"
@echo off
rem Starts the ACC clear-watcher at logon. Installed by
rem C:\code\guards\runbox\acc-watchdog-startup.ps1 - safe to delete to opt out.
call "$src"
"@
Set-Content -Path $dest -Value $body -Encoding ascii

Write-Host "installed: $dest"
Write-Host "--- contents ---"
Get-Content $dest

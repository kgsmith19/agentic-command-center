@echo off
rem Stops the ACC clear-watcher and engages the kill switch, so nothing can type
rem into a window until start-clearbot.cmd removes the stop file again.
setlocal
echo stopped %DATE% %TIME% > "%~dp0clearbot.stop"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*clearbot.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force };" ^
  "Write-Host 'clearbot stopped, kill switch engaged'"
endlocal

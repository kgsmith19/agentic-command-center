@echo off
rem Stops the ACC autopilot loop and engages the kill switch, so nothing can type
rem into a window until start-autopilot.cmd removes the stop file again.
rem
rem The query MUST exclude $PID and require the -File token: this script's own
rem powershell command line contains 'autopilot.ps1' (it is inside the filter
rem string), so the naive pattern enumerated ITSELF and could Stop-Process its
rem own probe before ever reaching the real watcher - Stop silently not
rem stopping. Same discrimination start-autopilot.cmd and budget.mjs
rem clearbot-status already use.
setlocal
echo stopped %DATE% %TIME% > "%~dp0autopilot.stop"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$me=$PID;" ^
  "$hits=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*autopilot.ps1*' });" ^
  "$hits | ForEach-Object { Stop-Process -Id $_.ProcessId -Force };" ^
  "Write-Host \"autopilot stopped ($($hits.Count) killed), kill switch engaged\""
endlocal

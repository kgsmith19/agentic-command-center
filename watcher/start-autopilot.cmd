@echo off
rem Starts the ACC autopilot loop in the background (hidden). Safe to run twice -
rem it exits if a real instance is already up. Stop it with stop-autopilot.cmd.
rem
rem NOTE: the "is it running" probe must exclude ITSELF. A naive
rem   CommandLine -like '*autopilot.ps1*'
rem matches the probe's own command line, so it always saw an instance and never
rem started anything (that bug shipped once - the watcher silently never ran).
rem Matching '-File*autopilot.ps1' plus a PID exclusion is what makes it honest.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$me=$PID;" ^
  "$n=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*autopilot.ps1*' }).Count;" ^
  "if ($n -gt 0) { Write-Host \"autopilot already running ($n)\"; exit 0 }" ^
  "Remove-Item '%~dp0autopilot.stop' -ErrorAction SilentlyContinue;" ^
  "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0autopilot.ps1';" ^
  "Start-Sleep -Seconds 2;" ^
  "$n2=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*autopilot.ps1*' }).Count;" ^
  "if ($n2 -gt 0) { Write-Host \"autopilot started ($n2 running)\" } else { Write-Host 'FAILED to start autopilot'; exit 1 }"
endlocal

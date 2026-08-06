@echo off
rem Starts the ACC clear-watcher in the background (hidden). Safe to run twice -
rem it exits if a real instance is already up. Stop it with stop-clearbot.cmd.
rem
rem NOTE: the "is it running" probe must exclude ITSELF. A naive
rem   CommandLine -like '*clearbot.ps1*'
rem matches the probe's own command line, so it always saw an instance and never
rem started anything (that bug shipped once - the watcher silently never ran).
rem Matching '-File*clearbot.ps1' plus a PID exclusion is what makes it honest.
rem
rem Phase 6 (full-remediation-prompt.md): the process-count probe below and the
rem Start-Process that follows it were a check-then-act race -- two
rem near-simultaneous invocations (e.g. two SessionStart hooks landing close
rem together) could both see "0 running" and both start a watcher, doubling
rem every kick and every auto-approval (ACC-HANDOFF.md already documents that
rem SYMPTOM as a trap; this is a root cause of it, not previously named). A
rem lock file (New-Item -ErrorAction Stop is atomic create-or-fail -- the same
rem exclusive-create mutex primitive kernel/ledger.mjs's withDecisionLock and
rem hooks/mission.mjs's withMissionLock already use) now makes the whole
rem probe-then-start sequence atomic across processes. A stale lock (left by a
rem start attempt that crashed before cleaning up) older than 30s is reclaimed
rem once rather than deadlocking every future start attempt forever. Losing
rem the race is not an error -- it means another invocation is already
rem handling it, same as the pre-existing "already running" early exit.
rem Not verified on Windows -- no Windows machine in this session; written
rem carefully per this repo's own precedent for changes made without local
rem verification (see OI-010's note).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$me=$PID; $lock=Join-Path '%~dp0' 'clearbot.startlock';" ^
  "try { New-Item -ItemType File -Path $lock -ErrorAction Stop | Out-Null }" ^
  "catch {" ^
  "  $stale=(Test-Path $lock) -and (((Get-Date) - (Get-Item $lock).LastWriteTime).TotalSeconds -gt 30);" ^
  "  if ($stale) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }" ^
  "  else { Write-Host 'another start is already in progress'; exit 0 };" ^
  "  try { New-Item -ItemType File -Path $lock -ErrorAction Stop | Out-Null }" ^
  "  catch { Write-Host 'another start is already in progress'; exit 0 }" ^
  "}" ^
  "try {" ^
  "  $n=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*clearbot.ps1*' }).Count;" ^
  "  if ($n -gt 0) { Write-Host \"clearbot already running ($n)\"; exit 0 }" ^
  "  Remove-Item '%~dp0clearbot.stop' -ErrorAction SilentlyContinue;" ^
  "  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0clearbot.ps1';" ^
  "  Start-Sleep -Seconds 2;" ^
  "  $n2=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*clearbot.ps1*' }).Count;" ^
  "  if ($n2 -gt 0) { Write-Host \"clearbot started ($n2 running)\" } else { Write-Host 'FAILED to start clearbot'; exit 1 }" ^
  "} finally { Remove-Item $lock -Force -ErrorAction SilentlyContinue }"
endlocal

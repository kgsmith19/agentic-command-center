# Test double for a Claude Code console (hooks/clearbot.test.mjs).
#
# It exists to give the injector something real to type into: it owns a genuine
# console, so AttachConsole + WriteConsoleInput behave exactly as they do
# against claude.exe, and every line it reads lands in -LogFile. That log is the
# assertion - "did clearbot type, and what" - and its EMPTINESS is the assertion
# for every refusal case.
#
# Writes its own PID to -PidFile at startup, because the launcher (cmd /c start)
# returns immediately and cannot report the console process it created.
#
# Always exits: on __STUBEXIT__ or after -TimeoutSeconds, so a failing test can
# never strand a process holding a console.
param(
    [Parameter(Mandatory=$true)][string]$LogFile,
    [Parameter(Mandatory=$true)][string]$PidFile,
    [int]$TimeoutSeconds = 90
)

New-Item -ItemType File -Path $LogFile -Force | Out-Null
Set-Content -Path $PidFile -Value $PID -Encoding ascii

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    # Poll rather than blocking in ReadLine, so the deadline is honoured even
    # when nothing is ever typed (the refusal cases, which is most of them).
    if ([Console]::KeyAvailable) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { continue }
        if ($line -eq '__STUBEXIT__') { break }
        Add-Content -Path $LogFile -Value $line -Encoding ascii
    } else {
        Start-Sleep -Milliseconds 40
    }
}

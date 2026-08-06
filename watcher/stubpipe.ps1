# Test stand-in for the ACC embedded terminal's pipe server (gui/PtyHost.cs
# ServePipe): serves \\.\pipe\<PipeName>, appends every received protocol line
# to -LogFile, replies OK, loops until -TimeoutSeconds or the caller kills the
# pid. A .NET server on purpose - the real server is .NET, and node's libuv
# pipes turned out not to interop with the .NET NamedPipeClientStream
# autopilot uses.
#
# Mirrors PtyHost.ServePipe's blocking WaitForConnection() exactly - do not
# reintroduce BeginWaitForConnection()+poll here. That shape (tried
# 2026-07-31) emulates async on a synchronous handle via a .NET background-
# thread compat shim that intermittently disconnects/reconnects the pipe
# internally: observed as the pipe flickering out of \\.\pipe\ enumeration
# every ~300ms while idle (zero connections made), and separately as a real
# client's connect racing that shim and getting "Pipe is broken" on write.
# A script-owned process has no reason to avoid a real blocking call the way
# PtyHost avoids blocking its UI thread (it runs the wait on its own Thread);
# this whole script already IS that thread. The cost: the final
# WaitForConnection() of a cycle can outlive -TimeoutSeconds if nothing ever
# connects, so callers must kill the pid on cleanup rather than rely on the
# timeout alone (every caller here already does).
param(
    [Parameter(Mandatory=$true)][string]$PipeName,
    [Parameter(Mandatory=$true)][string]$LogFile,
    [string]$PidFile = '',
    [string]$ReadyFile = '',
    [int]$TimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
# Like stubconsole.ps1: launched via `cmd /c start`, so the caller cannot see
# the pid - report it through a file.
if ($PidFile) { Set-Content -Path $PidFile -Value $PID -Encoding ascii }
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$reported = $false
while ((Get-Date) -lt $deadline) {
    $srv = New-Object System.IO.Pipes.NamedPipeServerStream($PipeName, [System.IO.Pipes.PipeDirection]::InOut, 1)
    # Signal readiness ourselves once the pipe object exists, rather than
    # making the caller enumerate \\.\pipe\ - that enumeration is not a
    # reliable liveness signal (see the note above) and a caller polling it
    # could see "never came up" even though this process and its pipe were
    # fine (observed 2026-07-31).
    if ($ReadyFile -and -not $reported) { Set-Content -Path $ReadyFile -Value '1' -Encoding ascii; $reported = $true }
    try {
        $srv.WaitForConnection()
        $rd = New-Object System.IO.StreamReader($srv)
        $wr = New-Object System.IO.StreamWriter($srv); $wr.AutoFlush = $true
        $line = $rd.ReadLine()
        if ($null -ne $line) {
            Add-Content -Path $LogFile -Value $line -Encoding ascii
            $wr.WriteLine('OK')
        }
    } catch {} finally { $srv.Dispose() }
}

# gui/ptyhost.test.ps1 - integration test for Acc.PtyHost. Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui/ptyhost.test.ps1
# Exits 0 on pass, 1 on failure. Spawns a real cmd.exe on a pseudoconsole.
#
# The checks run in a DETACHED child powershell on purpose: a parent that is
# itself nested under a ConPTY (agent harnesses, some terminal hosts) breaks
# child-to-pty binding on this Windows build - the child attaches to the
# parent's console and the pty sees only its 16-byte init. Proven 2026-07-31:
# identical code, boundToPty=False under the harness pty, True detached. The
# GUI runs detached from Explorer, so production is the detached case; the
# same caveat is why guards-gui.ps1 verifies binding after every spawn.
param([switch]$Worker, [string]$OutFile)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Worker) {
    $out = Join-Path $env:TEMP ("ptyhost-test-" + [Guid]::NewGuid().ToString('N') + ".txt")
    $p = Start-Process -WindowStyle Hidden -PassThru powershell -ArgumentList `
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MyInvocation.MyCommand.Path, '-Worker', '-OutFile', $out
    if (-not $p.WaitForExit(120000)) { $p.Kill(); Write-Host 'FAIL worker timed out'; exit 1 }
    if (Test-Path $out) { Get-Content $out | Write-Host } else { Write-Host 'FAIL worker left no output'; exit 1 }
    Remove-Item $out -ErrorAction SilentlyContinue
    exit $p.ExitCode
}

$lines = New-Object System.Collections.ArrayList
$fail = 0
function Check($name, $cond) {
    if ($cond) { [void]$lines.Add("PASS $name") } else { [void]$lines.Add("FAIL $name"); $script:fail = 1 }
}
function Send-Pipe([string]$PipeName, [string]$Op) {
    $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
    $c.Connect(3000)
    $w = New-Object System.IO.StreamWriter($c); $w.AutoFlush = $true
    $r = New-Object System.IO.StreamReader($c)
    $w.WriteLine($Op)
    $resp = $r.ReadLine()
    $c.Dispose()
    return $resp
}

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -Path (Join-Path $here 'PtyHost.cs') -ReferencedAssemblies 'System','System.Core','System.Windows.Forms'

    $pipe = 'acc-term-selftest-' + (Get-Random)
    $pty = New-Object Acc.PtyHost
    $pty.Start('cmd.exe', 'C:\', 80, 25, $null, $null, $null)
    Check 'child pid recorded' ($pty.ChildPid -gt 0 -and (Get-Process -Id $pty.ChildPid -ErrorAction SilentlyContinue))
    $pty.ServePipe($pipe)
    Start-Sleep -Milliseconds 800   # let cmd print its banner

    # The core promise: TEXT then SUBMIT actually executes the line.
    Check 'TEXT accepted'   ((Send-Pipe $pipe 'TEXT echo PTYPROOF-73') -eq 'OK')
    Start-Sleep -Milliseconds 80
    Check 'SUBMIT accepted' ((Send-Pipe $pipe 'SUBMIT') -eq 'OK')
    $deadline = (Get-Date).AddSeconds(10); $seen = $false
    while ((Get-Date) -lt $deadline -and -not $seen) {
        Start-Sleep -Milliseconds 250
        # cmd echoes the typed line AND prints the command output; the output
        # line is the proof the CR submitted. Count both, robust to wrapping.
        $seen = ([regex]::Matches($pty.Snapshot(), 'PTYPROOF-73').Count -ge 2)
    }
    Check 'submitted line executed (output appeared)' $seen

    # Refusals mirror sendconsole.ps1 (guards OI-004 self-defense).
    Check 'control char refused' ((Send-Pipe $pipe ("TEXT a`tb")) -like 'FAIL*')
    Check 'over-length refused'  ((Send-Pipe $pipe ('TEXT ' + ('x' * 2101))) -like 'FAIL*')
    Check 'unknown op refused'   ((Send-Pipe $pipe 'BOGUS') -like 'FAIL*')
    Check 'ESC accepted'         ((Send-Pipe $pipe 'ESC') -eq 'OK')

    # OI-010: the same promise as PTYPROOF-73 above, but for a payload the
    # line-based wire protocol cannot carry as TEXT at all. Two lines joined by
    # \n, base64'd; PtyHost converts \n to \r on the way to the console because
    # a carriage return is what Enter transmits. Both lines must EXECUTE, which
    # is what distinguishes a real multi-line submit from one long typed line.
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("echo PTYPROOF-A`necho PTYPROOF-B"))
    Check 'TEXTB64 accepted' ((Send-Pipe $pipe ('TEXTB64 ' + $b64)) -eq 'OK')
    Start-Sleep -Milliseconds 80
    Check 'TEXTB64 SUBMIT accepted' ((Send-Pipe $pipe 'SUBMIT') -eq 'OK')
    $deadline = (Get-Date).AddSeconds(10); $both = $false
    while ((Get-Date) -lt $deadline -and -not $both) {
        Start-Sleep -Milliseconds 250
        # Same >=2 rule as PTYPROOF-73 and for the same reason: cmd echoes the
        # typed line and then prints the output, so >=2 of EACH marker proves
        # both lines were submitted, not merely typed.
        $snap = $pty.Snapshot()
        $both = ([regex]::Matches($snap, 'PTYPROOF-A').Count -ge 2) -and ([regex]::Matches($snap, 'PTYPROOF-B').Count -ge 2)
    }
    Check 'both TEXTB64 lines executed' $both

    Check 'TEXTB64 bad base64 refused' ((Send-Pipe $pipe 'TEXTB64 not!base64') -like 'FAIL*')
    # \r is refused even though \n is allowed: the sender declares intent with
    # \n and PtyHost decides what reaches the console.
    Check 'TEXTB64 carriage return refused' `
        ((Send-Pipe $pipe ('TEXTB64 ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("a`r`nb")))) -like 'FAIL*')
    Check 'TEXTB64 control char refused' `
        ((Send-Pipe $pipe ('TEXTB64 ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("a`tb")))) -like 'FAIL*')
    Check 'TEXTB64 over-length refused' `
        ((Send-Pipe $pipe ('TEXTB64 ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('x' * 2101)))) -like 'FAIL*')
    # The length limit is on DECODED CHARS, not encoded bytes. A payload of
    # multi-byte characters encodes to several times its char count, so a bound
    # applied to the base64 string would refuse a legal payload and blame its
    # length — this is the case that catches that mistake. Accepted, not
    # executed: what matters is the verdict, and cmd.exe's codepage makes
    # rendering a poor thing to assert on.
    Check 'TEXTB64 multi-byte payload under the char limit accepted' `
        ((Send-Pipe $pipe ('TEXTB64 ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]([char]0x4E2D) * 2000)))) -eq 'OK')
    [void](Send-Pipe $pipe 'ESC')   # discard it rather than leave it on the line

    $pty.Resize(100, 40)   # must not throw
    $cpid = $pty.ChildPid
    $pty.Dispose()
    Start-Sleep -Milliseconds 500
    Check 'child killed on dispose' (-not (Get-Process -Id $cpid -ErrorAction SilentlyContinue))

    # Regression (2026-07-31): the child must see a real TTY. Without
    # STARTF_USESTDHANDLES + null handles in Start(), a host with redirected
    # stdio hands the child its useless pipe handle values, node sees a
    # non-TTY stdin, and claude refuses to run interactively ("--print
    # requires input") - the embedded terminal's e2e failed exactly there.
    $pty2 = New-Object Acc.PtyHost
    $pty2.Start('node -e "console.log(''ISATTY:'' + !!process.stdin.isTTY + !!process.stdout.isTTY)"', 'C:\', 80, 25, $null, $null, $null)
    $deadline = (Get-Date).AddSeconds(15); $tty = $false
    while ((Get-Date) -lt $deadline -and -not $tty) {
        Start-Sleep -Milliseconds 250
        $tty = $pty2.Snapshot() -match 'ISATTY:truetrue'
    }
    Check 'child stdin/stdout are a TTY (node isTTY)' $tty
    $pty2.Dispose()
} catch {
    [void]$lines.Add("FAIL exception: $($_ | Out-String)")
    $fail = 1
}

[System.IO.File]::WriteAllLines($OutFile, [string[]]$lines)
exit $fail

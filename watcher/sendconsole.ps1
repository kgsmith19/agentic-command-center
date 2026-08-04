# Injects keystrokes into another process's CONSOLE INPUT BUFFER.
#
# Why not SendKeys: SendKeys needs the target window to be foreground, and
# Windows refuses SetForegroundWindow from a background process (proven in
# testing - the watcher correctly aborted twice rather than type blind). The
# ALT-press + AttachThreadInput unlocks did not survive either.
#
# WriteConsoleInput is the right mechanism for a console app: it appends real
# KEY_EVENT records to the console the target is reading from, so it needs NO
# focus at all. That is strictly safer - it cannot steal focus from whatever Kyle
# is typing in, and it cannot leak keystrokes into the wrong window, because the
# console is addressed by PID rather than by whatever happens to be in front.
#
# Runs as a short-lived child process on purpose: AttachConsole requires calling
# FreeConsole first, which would cost the caller its own console.
param(
    [Parameter(Mandatory=$true)][int]$TargetPid,
    [Parameter(Mandatory=$false)][string]$Text = '',
    [switch]$NoEnter,
    # Empties the target's input line before typing. REQUIRED for the real clear:
    # injected text lands in whatever is already in the prompt box, so firing
    # "/clear" at a half-typed line would submit "half-typed/clear" instead.
    # Observed for real - an injected test string stayed in Kyle's input buffer.
    [switch]$ClearLineFirst,
    # Sends ONE Esc key event and nothing else - no text, no Enter. Interrupts
    # the running turn in the target TUI. Used only by clearbot's escalation
    # path (OI-011) when a typed /clear could not land because the over-budget
    # turn never ends. Esc cannot type, submit, or delete anything.
    [switch]$Esc
)

$ErrorActionPreference = 'Stop'

# -Text stopped being Mandatory when -Esc arrived; the old contract still holds
# for every caller that types.
if (-not $Esc -and [string]::IsNullOrEmpty($Text)) {
    Write-Output 'FAIL -Text is required unless -Esc'
    exit 1
}

# Self-defense (guards OI-004). The closed set of typeable strings is enforced
# by clearbot's invariant 1, one layer up - but THIS is the process that
# actually presses keys, so it refuses the two shapes that turn one injection
# into many: control characters (a newline SUBMITS, so a multi-line string is
# several prompts, which is OI-004's whole point) and absurd length. It does
# not judge content; that is the caller's job and stays there.
if ($Text -match '[\x00-\x1f\x7f]') {
    Write-Output 'FAIL unsafe -Text: control characters (a newline would submit)'
    exit 1
}
if ($Text.Length -gt 2100) {
    Write-Output ("FAIL unsafe -Text: {0} chars exceeds 2100" -f $Text.Length)
    exit 1
}

Add-Type -Namespace SC -Name Con -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct KEY_EVENT_RECORD {
    public int  bKeyDown;
    public ushort wRepeatCount;
    public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode;
    public ushort UnicodeChar;
    public uint dwControlKeyState;
}
[StructLayout(LayoutKind.Explicit)]
public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
}
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint len, out uint written);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
'@

function New-KeyRec([char]$ch, [uint16]$vk, [int]$down) {
    $r = New-Object SC.Con+INPUT_RECORD
    $r.EventType = 1              # KEY_EVENT
    $k = New-Object SC.Con+KEY_EVENT_RECORD
    $k.bKeyDown         = $down
    $k.wRepeatCount     = 1
    $k.wVirtualKeyCode  = $vk
    $k.wVirtualScanCode = 0
    $k.UnicodeChar      = [uint16][char]$ch
    $k.dwControlKeyState= 0
    $r.KeyEvent = $k
    return $r
}

# Everything after AttachConsole must stay SILENT: while attached, this script's
# stdout goes to the TARGET's console, so a stray Write-Output prints noise into
# Kyle's Claude Code terminal (observed - "OK wrote=256 records" showed up inside
# a target window). Messages are buffered and emitted only after detaching.
$msg = $null
function Emit($m, $code) {
    [void][SC.Con]::FreeConsole()      # detach FIRST, then it is safe to speak
    Write-Output $m
    exit $code
}

[void][SC.Con]::FreeConsole()
if (-not [SC.Con]::AttachConsole([uint32]$TargetPid)) {
    # not attached, so plain output is safe here
    Write-Output ("FAIL attach pid=$TargetPid err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    exit 1
}

# CONIN$ must be opened with read/write sharing to append to the live buffer.
# 3221225472 = 0xC0000000 (GENERIC_READ|GENERIC_WRITE); the hex literal parses as
# a NEGATIVE int in PS 5.1 and fails the uint32 marshal.
$h = [SC.Con]::CreateFileW('CONIN$', [uint32]3221225472, [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) {
    Emit ('FAIL CONIN$ err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) 1
}

if ($Esc) {
    # Interrupt only: ONE Esc down/up, then force the other switches into the
    # shape that guarantees no text and no Enter can follow it.
    $Text = ''; $NoEnter = $true; $ClearLineFirst = $false
}

function Write-Records([System.Collections.ArrayList]$Recs) {
    $arr = New-Object ('SC.Con+INPUT_RECORD[]') $Recs.Count
    for ($i = 0; $i -lt $Recs.Count; $i++) { $arr[$i] = $Recs[$i] }
    $written = 0
    $ok = [SC.Con]::WriteConsoleInputW($h, $arr, [uint32]$arr.Length, [ref]$written)
    return @{ ok = $ok; written = [int]$written; err = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
}

$totalWritten = 0

if ($Esc) {
    $escRecs = New-Object System.Collections.ArrayList
    [void]$escRecs.Add((New-KeyRec ([char]27) 27 1))    # VK_ESCAPE
    [void]$escRecs.Add((New-KeyRec ([char]27) 27 0))
    $r = Write-Records $escRecs
    $totalWritten += $r.written
    if (-not $r.ok) { [void][SC.Con]::CloseHandle($h); Emit "FAIL WriteConsoleInput err=$($r.err)" 1 }
}

if ($ClearLineFirst) {
    # Esc clears the input line in the Claude Code TUI and dismisses any open
    # slash-command menu. The backspaces are belt-and-braces for the case where
    # Esc is swallowed: on an already-empty prompt they are harmless no-ops.
    # Written as its OWN WriteConsoleInputW call, with a settle before the text
    # batch that follows. Raised alongside clearbot.ps1's pre-type settle
    # (guards OI-003, 2026-08-04) as a second, independent gap the old single-
    # call batching never covered: the clear and the text landing in the SAME
    # buffer write, zero beat between them, mirroring exactly the
    # TEXT-then-SUBMIT race the pty transport already guards against with its
    # own 80ms gap (clearbot.ps1 Send-Pipe). Not proven to be part of the root
    # cause on its own -- added because it is cheap and directionally correct,
    # not because it was isolated as the specific fix.
    $clearRecs = New-Object System.Collections.ArrayList
    [void]$clearRecs.Add((New-KeyRec ([char]27) 27 1))    # VK_ESCAPE
    [void]$clearRecs.Add((New-KeyRec ([char]27) 27 0))
    for ($b = 0; $b -lt 120; $b++) {
        [void]$clearRecs.Add((New-KeyRec ([char]8) 8 1))  # VK_BACK
        [void]$clearRecs.Add((New-KeyRec ([char]8) 8 0))
    }
    $r = Write-Records $clearRecs
    $totalWritten += $r.written
    if (-not $r.ok) { [void][SC.Con]::CloseHandle($h); Emit "FAIL WriteConsoleInput err=$($r.err)" 1 }
    Start-Sleep -Milliseconds 80
}

$textRecs = New-Object System.Collections.ArrayList
foreach ($c in $Text.ToCharArray()) {
    [void]$textRecs.Add((New-KeyRec $c 0 1))
    [void]$textRecs.Add((New-KeyRec $c 0 0))
}
if (-not $NoEnter) {
    [void]$textRecs.Add((New-KeyRec ([char]13) 13 1))   # VK_RETURN
    [void]$textRecs.Add((New-KeyRec ([char]13) 13 0))
}

$ok = $true
$err = 0
if ($textRecs.Count -gt 0) {
    $r = Write-Records $textRecs
    $totalWritten += $r.written
    $ok = $r.ok
    $err = $r.err
}
[void][SC.Con]::CloseHandle($h)

if ($ok) { Emit "OK wrote=$totalWritten records to pid=$TargetPid" 0 }
else     { Emit "FAIL WriteConsoleInput err=$err" 1 }

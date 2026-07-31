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

$recs = New-Object System.Collections.ArrayList

if ($Esc) {
    # Interrupt only: ONE Esc down/up, then force the other switches into the
    # shape that guarantees no text and no Enter can follow it.
    [void]$recs.Add((New-KeyRec ([char]27) 27 1))    # VK_ESCAPE
    [void]$recs.Add((New-KeyRec ([char]27) 27 0))
    $Text = ''; $NoEnter = $true; $ClearLineFirst = $false
}

if ($ClearLineFirst) {
    # Esc clears the input line in the Claude Code TUI and dismisses any open
    # slash-command menu. The backspaces are belt-and-braces for the case where
    # Esc is swallowed: on an already-empty prompt they are harmless no-ops.
    [void]$recs.Add((New-KeyRec ([char]27) 27 1))    # VK_ESCAPE
    [void]$recs.Add((New-KeyRec ([char]27) 27 0))
    for ($b = 0; $b -lt 120; $b++) {
        [void]$recs.Add((New-KeyRec ([char]8) 8 1))  # VK_BACK
        [void]$recs.Add((New-KeyRec ([char]8) 8 0))
    }
}

foreach ($c in $Text.ToCharArray()) {
    [void]$recs.Add((New-KeyRec $c 0 1))
    [void]$recs.Add((New-KeyRec $c 0 0))
}
if (-not $NoEnter) {
    [void]$recs.Add((New-KeyRec ([char]13) 13 1))   # VK_RETURN
    [void]$recs.Add((New-KeyRec ([char]13) 13 0))
}

$arr = New-Object ('SC.Con+INPUT_RECORD[]') $recs.Count
for ($i = 0; $i -lt $recs.Count; $i++) { $arr[$i] = $recs[$i] }
$written = 0
$ok = [SC.Con]::WriteConsoleInputW($h, $arr, [uint32]$arr.Length, [ref]$written)
$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
[void][SC.Con]::CloseHandle($h)

if ($ok) { Emit "OK wrote=$written records to pid=$TargetPid" 0 }
else     { Emit "FAIL WriteConsoleInput err=$err" 1 }

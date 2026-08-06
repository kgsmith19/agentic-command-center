# Identifies the terminal window hosting this Claude Code session, so the
# clear-watcher never has to guess which window to type into.
#
# Walks up the process tree from -FromPid, but does NOT simply take the first
# ancestor that owns a window: console hosts (cmd.exe under conhost) report
# MainWindowHandle = 0, so that naive rule walks straight past the terminal and
# lands on explorer.exe - the desktop shell. Typing into that would be a disaster.
#
# Instead: collect the ancestor chain, stop at the first known terminal host,
# refuse to cross explorer.exe/dwm, then find a real visible top-level window
# owned by any process in that set (including conhost children, which is where
# the window actually lives for classic consoles).
param([int]$FromPid = $PID)

$ErrorActionPreference = 'Stop'

$TERMINALS = @('windowsterminal.exe','wt.exe','conhost.exe','openconsole.exe',
               'cmd.exe','powershell.exe','pwsh.exe','alacritty.exe','wezterm-gui.exe')
$NEVER     = @('explorer.exe','dwm.exe','svchost.exe','winlogon.exe','services.exe','')

Add-Type -Namespace GW -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
public delegate bool EnumProc(IntPtr h, IntPtr p);
'@ -ErrorAction SilentlyContinue

function Out-Json($o) { $o | ConvertTo-Json -Compress; exit 0 }

try {
    # ---- 0. one process snapshot, indexed ----
    # This used to be one Get-CimInstance per hop plus one per candidate: 12+
    # WMI round trips, measured at 11.0 s from a deep chain, which overran the
    # 10 s SessionStart hook timeout on its own. A single -Property-narrowed
    # query and two in-memory indexes give identical answers. The snapshot is
    # taken once, so a process that exits mid-walk can no longer change the
    # chain halfway through.
    $procs  = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name -ErrorAction SilentlyContinue
    $byPid  = @{}
    $byParent = @{}
    foreach ($p in $procs) {
        $id = [int]$p.ProcessId
        $byPid[$id] = $p
        $pp = [int]$p.ParentProcessId
        if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = New-Object System.Collections.ArrayList }
        [void]$byParent[$pp].Add($p)
    }

    # ---- 1. ancestor chain, stopping at the terminal host ----
    $chain = @(); $cands = @{}; $seen = @{}; $cur = $FromPid; $stopped = $null
    $consolePid = 0
    for ($i = 0; $i -lt 12 -and $cur -and -not $seen[$cur]; $i++) {
        $seen[$cur] = $true
        $ci = $byPid[[int]$cur]
        if (-not $ci) { break }
        $nm = ([string]$ci.Name).ToLower()
        if ($NEVER -contains $nm) { break }          # never cross the shell
        $chain += ("{0}:{1}" -f $nm, $cur)
        $cands[$cur] = $nm
        # The console we must inject into is the one claude.exe reads stdin from.
        # Addressing it by PID is what lets the watcher type without stealing focus.
        if ($nm -eq 'claude.exe' -and $consolePid -eq 0) { $consolePid = $cur }
        if ($TERMINALS -contains $nm) { $stopped = $nm; if ($consolePid -eq 0) { $consolePid = $cur }; break }
        $cur = [int]$ci.ParentProcessId
    }
    if ($cands.Count -eq 0) { Out-Json @{ ok=$false; why='no usable ancestors'; chain=($chain -join ' -> ') } }

    # ---- 2. conhost children hold the window for classic consoles ----
    foreach ($p in @($cands.Keys)) {
        if (-not $byParent.ContainsKey([int]$p)) { continue }
        foreach ($c in $byParent[[int]$p]) {
            $cn = ([string]$c.Name).ToLower()
            if ($TERMINALS -contains $cn) { $cands[[int]$c.ProcessId] = $cn }
        }
    }

    # ---- 3. find a visible top-level window owned by one of them ----
    $hits = New-Object System.Collections.ArrayList
    $cb = [GW.Win+EnumProc]{
        param($h, $l)
        $wpid = 0; [void][GW.Win]::GetWindowThreadProcessId($h, [ref]$wpid)
        if ($cands.ContainsKey($wpid) -and [GW.Win]::IsWindowVisible($h)) {
            $sb = New-Object System.Text.StringBuilder 512
            [void][GW.Win]::GetWindowTextW($h, $sb, 512)
            [void]$hits.Add(@{ hwnd=[int64]$h; windowPid=$wpid; name=$cands[$wpid]; title=$sb.ToString() })
        }
        return $true
    }
    [void][GW.Win]::EnumWindows($cb, [IntPtr]::Zero)

    # A missing WINDOW is not a missing CONSOLE. Injection is WriteConsoleInput
    # addressed by pid (autopilot invariant 3) and never touches the hwnd, so a
    # resolved consolePid is already everything the watcher needs. Requiring a
    # window here is what silently killed auto-clear for every session whose
    # terminal EnumWindows could not see - it failed exactly like "no session".
    if ($hits.Count -eq 0) {
        if ($consolePid) {
            Out-Json @{ ok=$true; hwnd=0; windowPid=0; name='(none)'; consolePid=$consolePid
                        title=''; stoppedAt=$stopped; chain=($chain -join ' -> '); matches=0
                        why='no visible window; pid-addressed injection only' }
        }
        Out-Json @{ ok=$false; why='no visible window and no console pid on the chain'; chain=($chain -join ' -> ') }
    }

    # prefer a titled window; otherwise the first hit
    $best = @($hits | Sort-Object { if ($_.title) { 0 } else { 1 } })[0]
    Out-Json @{ ok=$true; hwnd=$best.hwnd; windowPid=$best.windowPid; name=$best.name
                consolePid=$consolePid; title=$best.title; stoppedAt=$stopped
                chain=($chain -join ' -> '); matches=$hits.Count }
} catch {
    Out-Json @{ ok=$false; error=$_.Exception.Message }
}

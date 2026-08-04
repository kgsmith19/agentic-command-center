# watcher/flash-probe.ps1 - observes whether ANY new top-level window appears
# while the ACC-ClaudeCapWatch task fires.
#
# This exists because guards' first fix for the 60s console flash asserted a
# regex against the scheduled task's own arguments and printed "no console
# window will appear". It had never looked at a window. The flash continued for
# another day. Configuration is not behaviour; this file only reports what it
# actually saw.
#
# Read-only: creates no windows, kills nothing, changes no machine state.
# Design: docs/superpowers/specs/2026-08-04-acc-known-defects-design.md
$ErrorActionPreference = 'Stop'

# Window classes used to host a console. A window of one of these appearing in
# lockstep with a task firing IS the flash, whichever process happens to own it
# - the whole point of the original bug is that the owner was NOT the process we
# configured. Measured on this machine: CASCADIA_HOSTING_WINDOW_CLASS (Windows
# Terminal, COM-activated) and PseudoConsoleWindow (the script's own powershell).
$script:ConsoleHostClasses = @(
    'CASCADIA_HOSTING_WINDOW_CLASS',
    'PseudoConsoleWindow',
    'ConsoleWindowClass'
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AccFlashProbe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
}
"@

# Pure: given one observation and the task's last-run time, is this window the
# flash we are hunting, or unrelated desktop noise? Kept side-effect free so the
# classification can be unit-tested without waiting three minutes for a task.
function Test-IsFlashWindow {
    param(
        [Parameter(Mandatory)][string]$WindowClass,
        [string]$CommandLine = '',
        [Nullable[datetime]]$AppearedAt = $null,
        [Nullable[datetime]]$TaskLastRun = $null,
        [int]$CorrelationMs = 3000
    )
    # Owned by the cap-watch script itself: unambiguous, no timing needed.
    if ($CommandLine -match 'claude-cap-watch\.ps1') { return $true }
    # A console host is only OUR flash if it appeared in lockstep with a firing.
    # Kyle opening a terminal by hand must never fail this test.
    if ($script:ConsoleHostClasses -contains $WindowClass) {
        if ($null -eq $AppearedAt -or $null -eq $TaskLastRun) { return $false }
        $delta = ($AppearedAt - $TaskLastRun).TotalMilliseconds
        return ($delta -ge 0 -and $delta -le $CorrelationMs)
    }
    return $false
}

function Get-VisibleWindow {
    $found = @{}
    $cb = [AccFlashProbe+EnumProc]{
        param($h, $l)
        if ([AccFlashProbe]::IsWindowVisible($h)) {
            $wpid = 0
            [void][AccFlashProbe]::GetWindowThreadProcessId($h, [ref]$wpid)
            $t = New-Object System.Text.StringBuilder 512
            [void][AccFlashProbe]::GetWindowTextW($h, $t, $t.Capacity)
            $c = New-Object System.Text.StringBuilder 256
            [void][AccFlashProbe]::GetClassNameW($h, $c, $c.Capacity)
            $found[[int64]$h] = [pscustomobject]@{ Pid = [int]$wpid; Title = $t.ToString(); Class = $c.ToString() }
        }
        return $true
    }
    [void][AccFlashProbe]::EnumWindows($cb, [IntPtr]::Zero)
    return $found
}

# Watches for $Seconds, returns every window that appeared and was not in the
# opening baseline. Each observation carries enough to classify it later.
function Watch-NewWindow {
    param([int]$Seconds = 190, [string]$TaskName = 'ACC-ClaudeCapWatch', [int]$PollMs = 40)
    $baseline = Get-VisibleWindow
    $seen = @{}
    $observations = [System.Collections.Generic.List[object]]::new()
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        foreach ($h in (Get-VisibleWindow).GetEnumerator()) {
            if ($baseline.ContainsKey($h.Key) -or $seen.ContainsKey($h.Key)) { continue }
            $seen[$h.Key] = $true
            $appearedAt = Get-Date
            $cmd = ''
            try {
                $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($h.Value.Pid)" -ErrorAction Stop
                if ($p) { $cmd = [string]$p.CommandLine }
            } catch { }
            $lastRun = $null
            try { $lastRun = (Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop).LastRunTime } catch { }
            $observations.Add([pscustomobject]@{
                AppearedAt  = $appearedAt
                Class       = $h.Value.Class
                Title       = $h.Value.Title
                Pid         = $h.Value.Pid
                CommandLine = $cmd
                TaskLastRun = $lastRun
                IsFlash     = (Test-IsFlashWindow -WindowClass $h.Value.Class -CommandLine $cmd `
                                 -AppearedAt $appearedAt -TaskLastRun $lastRun)
            })
        }
        Start-Sleep -Milliseconds $PollMs
    }
    return $observations
}

# Dot-sourced (by the test) -> functions only, no watching.
if ($MyInvocation.InvocationName -eq '.') { return }

$secs = if ($args.Count -ge 1) { [int]$args[0] } else { 190 }
Write-Host "watching $secs s for windows appearing in lockstep with ACC-ClaudeCapWatch..."
$obs = Watch-NewWindow -Seconds $secs
foreach ($o in $obs) {
    $tag = if ($o.IsFlash) { 'FLASH   ' } else { 'unrelated' }
    Write-Host ("{0} {1:HH:mm:ss.fff} class={2} pid={3} title='{4}'" -f $tag, $o.AppearedAt, $o.Class, $o.Pid, $o.Title)
}
Write-Host ("total {0} new window(s), {1} attributable to the cap-watch task" -f $obs.Count, @($obs | Where-Object IsFlash).Count)

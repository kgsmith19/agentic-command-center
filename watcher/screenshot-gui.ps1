# Launch the Command Center, wait for it to render, screenshot its window, close it.
param([string]$Out = "$PSScriptRoot\acc.png", [switch]$Advanced)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System;using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public struct R { public int L,T,Rt,B; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  // Find a child control by its caption. Coordinates would drift with every
  // layout edit; the caption is the thing a human would look for anyway.
  public static IntPtr ByText(IntPtr parent, string want) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) {
      var sb = new System.Text.StringBuilder(256);
      GetWindowTextW(h, sb, sb.Capacity);
      if (sb.ToString() == want) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[void][W]::SetProcessDPIAware()
$repoRoot = Split-Path -Parent $PSScriptRoot
$p = Start-Process powershell -ArgumentList '-NoProfile','-File',(Join-Path $repoRoot 'guards-gui.ps1') -PassThru
for ($i=0; $i -lt 40 -and $p.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 500; $p.Refresh() }
Start-Sleep -Seconds 2
$h = $p.MainWindowHandle
if ($h -eq 0) { Write-Output 'NO WINDOW'; $p.Kill(); exit 1 }
[void][W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 500
if ($Advanced) {
  # Tick 'Show advanced' with BM_CLICK on the control itself - no cursor, no
  # coordinates, and it fails loudly if the caption ever changes.
  $chk = [W]::ByText($h, 'Show advanced')
  if ($chk -eq [IntPtr]::Zero) { Write-Output 'NO ADVANCED CHECKBOX'; $p.Kill(); exit 1 }
  [void][W]::SendMessage($chk, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)  # BM_CLICK
  Start-Sleep -Milliseconds 800
}
$r = New-Object W+R
[void][W]::GetWindowRect($h, [ref]$r)
$w = $r.Rt - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$p.Kill()
Write-Output "SAVED $Out ${w}x${ht}"

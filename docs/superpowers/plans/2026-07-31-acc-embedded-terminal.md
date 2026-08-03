# ACC Embedded Terminal (ConPTY host) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, main thread — this repo's ACC profile allows only Explore subagents; do NOT use subagent-driven-development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ACC owns the claude terminal via ConPTY so kicks/clears/replays are deterministic pipe writes (guaranteed Enter), rendered in an embedded xterm.js/WebView2 terminal inside the Guards GUI.

**Architecture:** A C# `Acc.PtyHost` class (loaded by `guards-gui.ps1` via `Add-Type -Path`) spawns `claude` on a pseudoconsole, pumps output to an xterm.js page in a WebView2 tab, and serves a named-pipe line protocol (`TEXT`/`SUBMIT`/`ESC`) that clearbot uses instead of keystroke injection when a session's window record says `transport:"pty"`. `sendconsole.ps1` remains the fallback transport for external sessions and pipe failures.

**Tech Stack:** PowerShell 5.1 WinForms GUI, inline C# (.NET Framework, C#5-compatible — no string interpolation/nameof), ConPTY (`CreatePseudoConsole`), WebView2 (vendored SDK dlls, Evergreen runtime), xterm.js 5.5.0 + fit addon (vendored, no npm/CDN), Node 20+ hooks (`node --test` fast tier), `e2e/loop.e2e.mjs` proof tier.

**Spec:** `docs/superpowers/specs/2026-07-31-acc-embedded-terminal-design.md`

**Status (updated 2026-07-31, completion-gate session):** Tasks 1–3 are DONE and committed (`36ab311`, `0424bac`, `ebcbebe`). Tasks 4–8 remain. The **Completion Gate** section at the bottom is the exit criterion: run `node C:/code/guards/hooks/goal.mjs done <goal-id>` only after every gate item shows its listed evidence. Task 6 gained Step 3b (post-spawn binding watchdog) in this amendment.

## Global Constraints

- Fast tier must stay green and hooks must never run by hand against live state — see `AGENTS.md` § "The regression, exactly" for the current command (`npm run test:windows` on Windows / `npm test` portable) and the `ACC_ROOT`/`ACC_POLICY` sandboxing rule (guards OI-006).
- Pipe-server refusals mirror `sendconsole.ps1` exactly: reject control chars (`< 0x20` or `0x7f`) in TEXT payloads, reject payloads > 2100 chars. Content policy (the closed set of typeable constants, OI-004) stays in clearbot — the transport does not judge content.
- Goal text never becomes keystrokes OR pipe bytes; only clearbot's constants are ever transmitted (`/clear`, `/cd <route>`, `Continue the active ACC goal.`, `Run the queued prompt.`).
- C# must compile under PS 5.1's `Add-Type` (C# 5): no `$"..."`, no `nameof`, no null-conditional.
- All vendored assets are checked in pinned; no CDN, no npm install at runtime.
- GUI must keep working when WebView2 runtime is absent: fall back to the legacy `cmd /k claude` launch with a one-line notice.
- After the code is done: run the lean diff review (`/simplify`) and security review (`/security-review`) — this diff touches console/keystroke injection, which is an explicit `/security-review` trigger — apply or ledger every finding, run any pending `/approve` runbox scripts, and log anything not fixed to `OPEN-ISSUES.md`.

---

### Task 1: Vendor xterm.js and WebView2 SDK

**DONE — evidence:** commit `36ab311`; `gui/vendor/xterm/xterm.js`, `xterm.css`, `addon-fit.js`, `gui/vendor/webview2/Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`, `WebView2Loader.dll`, `gui/vendor/README.md` all present on the branch.

**Files:**
- Create: `gui/vendor/xterm/xterm.js`, `gui/vendor/xterm/xterm.css`, `gui/vendor/xterm/addon-fit.js`
- Create: `gui/vendor/webview2/Microsoft.Web.WebView2.Core.dll`, `gui/vendor/webview2/Microsoft.Web.WebView2.WinForms.dll`, `gui/vendor/webview2/WebView2Loader.dll`
- Create: `gui/vendor/README.md` (provenance: package names, exact versions, URLs)

**Interfaces:**
- Produces: script globals `Terminal` and `FitAddon.FitAddon` (xterm UMD builds) for Task 5's `term.html`; .NET types `Microsoft.Web.WebView2.WinForms.WebView2` and `Microsoft.Web.WebView2.Core.CoreWebView2Environment` for Task 6.

- [x] **Step 1: Download and extract pinned packages**

```powershell
Set-Location C:\code\guards
New-Item -ItemType Directory -Force gui\vendor\xterm, gui\vendor\webview2 | Out-Null
$t = Join-Path $env:TEMP 'acc-vendor'
Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $t | Out-Null

curl.exe -sL -o "$t\xterm.tgz" https://registry.npmjs.org/@xterm/xterm/-/xterm-5.5.0.tgz
New-Item -ItemType Directory -Force "$t\xterm" | Out-Null; tar -xzf "$t\xterm.tgz" -C "$t\xterm"
Copy-Item "$t\xterm\package\lib\xterm.js"  gui\vendor\xterm\xterm.js
Copy-Item "$t\xterm\package\css\xterm.css" gui\vendor\xterm\xterm.css

curl.exe -sL -o "$t\fit.tgz" https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.10.0.tgz
New-Item -ItemType Directory -Force "$t\fit" | Out-Null; tar -xzf "$t\fit.tgz" -C "$t\fit"
Copy-Item "$t\fit\package\lib\addon-fit.js" gui\vendor\xterm\addon-fit.js

curl.exe -sL -o "$t\wv2.zip" https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2903.40
Expand-Archive "$t\wv2.zip" "$t\wv2" -Force
Copy-Item "$t\wv2\lib\net45\Microsoft.Web.WebView2.Core.dll"     gui\vendor\webview2\
Copy-Item "$t\wv2\lib\net45\Microsoft.Web.WebView2.WinForms.dll" gui\vendor\webview2\
Copy-Item "$t\wv2\runtimes\win-x64\native\WebView2Loader.dll"    gui\vendor\webview2\
```

If a URL 404s, find the correct one on npmjs.com / nuget.org for those exact versions — do not silently pick a different major version.

- [x] **Step 2: Verify the assets load**

```powershell
if (-not (Select-String -Path gui\vendor\xterm\xterm.js -Pattern 'Terminal' -Quiet)) { throw 'xterm.js looks wrong' }
[Microsoft.Web.WebView2.Core.CoreWebView2Environment] 2>$null   # expected to fail BEFORE Add-Type
Add-Type -Path gui\vendor\webview2\Microsoft.Web.WebView2.Core.dll
Add-Type -Path gui\vendor\webview2\Microsoft.Web.WebView2.WinForms.dll
[Microsoft.Web.WebView2.Core.CoreWebView2Environment].FullName   # must print the type name
```

Expected: type name prints; no exception. (Native `WebView2Loader.dll` is exercised in Task 6.)

- [x] **Step 3: Write `gui/vendor/README.md`** — list each file, package, version, source URL, and why it is vendored (offline, pinned, no install step).

- [x] **Step 4: Commit** — `36ab311`

---

### Task 2: `Acc.PtyHost` — ConPTY spawn, output pump, pipe server

**DONE — evidence:** commit `0424bac`; `gui/PtyHost.cs` (class `Acc.PtyHost` at :23, `Start` :72, `Snapshot` :146, `ServePipe` :164, `Kill` :209, `Dispose` :215); integration test `gui/ptyhost.test.ps1`.

**Files:**
- Create: `gui/PtyHost.cs`
- Test: `gui/ptyhost.test.ps1` (integration — real `cmd.exe` child, no GUI)

**Interfaces:**
- Produces (used by Tasks 3, 6, 7):
  - `Acc.PtyHost.Start(string commandLine, string cwd, short cols, short rows, System.Windows.Forms.Control ui, Action<string> onOutputB64, Action onExit)` — `ui`/callbacks may be null (tests); with `ui` non-null callbacks are marshalled via `ui.BeginInvoke`.
  - `int ChildPid` — pid of the spawned child.
  - `void ServePipe(string pipeName)` — line protocol server on `\\.\pipe\<pipeName>`: request `"TEXT <payload>"` | `"SUBMIT"` | `"ESC"`, one request per connection, reply `"OK"` or `"FAIL <reason>"`. `SUBMIT` writes `\r`, `ESC` writes `\x1b`.
  - `void WriteB64(string b64)` / `void WriteText(string s)` / `void Resize(short cols, short rows)` / `string Snapshot()` (decoded output tail, ≤256 KB) / `void Kill()` / `Dispose()`.

- [x] **Step 1: Write the failing integration test**

```powershell
# gui/ptyhost.test.ps1 — integration test for Acc.PtyHost. Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui/ptyhost.test.ps1
# Exits 0 on pass, 1 on first failure. Spawns a real cmd.exe on a pseudoconsole.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path (Join-Path $here 'PtyHost.cs') -ReferencedAssemblies 'System','System.Core','System.Windows.Forms'

$fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:fail = 1 }
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
    # cmd echoes the typed line AND prints the command output; the output line
    # is the proof the CR submitted. Count both to be robust against wrapping.
    $seen = ([regex]::Matches($pty.Snapshot(), 'PTYPROOF-73').Count -ge 2)
}
Check 'submitted line executed (output appeared)' $seen

# Refusals mirror sendconsole.ps1 (guards OI-004 self-defense).
Check 'control char refused' ((Send-Pipe $pipe ("TEXT a`tb")) -like 'FAIL*')
Check 'over-length refused'  ((Send-Pipe $pipe ('TEXT ' + ('x' * 2101))) -like 'FAIL*')
Check 'unknown op refused'   ((Send-Pipe $pipe 'BOGUS') -like 'FAIL*')
Check 'ESC accepted'         ((Send-Pipe $pipe 'ESC') -eq 'OK')

$pty.Resize(100, 40)   # must not throw
$cpid = $pty.ChildPid
$pty.Dispose()
Start-Sleep -Milliseconds 500
Check 'child killed on dispose' (-not (Get-Process -Id $cpid -ErrorAction SilentlyContinue))

exit $fail
```

- [x] **Step 2: Run it — expect failure (PtyHost.cs missing)**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File gui/ptyhost.test.ps1`
Expected: throws at `Add-Type` — `Cannot find path ... PtyHost.cs`.

- [x] **Step 3: Write `gui/PtyHost.cs`**

```csharp
// ConPTY host for the ACC embedded terminal (spec: docs/superpowers/specs/
// 2026-07-31-acc-embedded-terminal-design.md).
//
// Why a pty and not keystroke injection: WriteConsoleInputW delivers text+CR in
// one batch, which the ink TUI reads as a PASTE, absorbing the CR - the kick
// text sat unsubmitted (observed on every ACC launch). Bytes written to a pty's
// input pipe are the terminal-owner's channel: a lone \r after the text is a
// real Enter, every time.
//
// The pipe server mirrors sendconsole.ps1's self-defense (guards OI-004): it
// refuses control characters and absurd length. It does not judge content -
// that stays in clearbot, one layer up.
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Acc
{
    public class PtyHost : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        struct COORD { public short X; public short Y; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX; public int dwY; public int dwXSize; public int dwYSize;
            public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
            public int dwFlags; public short wShowWindow; public short cbReserved2;
            public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CreatePipe(out IntPtr hRead, out IntPtr hWrite, IntPtr sa, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr hPC);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern int ResizePseudoConsole(IntPtr hPC, COORD size);
        [DllImport("kernel32.dll")]
        static extern void ClosePseudoConsole(IntPtr hPC);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
            uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr h, uint ms);

        const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        static readonly IntPtr ATTR_PSEUDOCONSOLE = (IntPtr)0x20016;

        IntPtr _hPC = IntPtr.Zero, _hProcess = IntPtr.Zero, _attrList = IntPtr.Zero;
        FileStream _in, _out;
        readonly object _writeLock = new object();
        readonly StringBuilder _snapshot = new StringBuilder();
        volatile bool _disposed;
        public int ChildPid;

        public void Start(string commandLine, string cwd, short cols, short rows,
                          System.Windows.Forms.Control ui, Action<string> onOutputB64, Action onExit)
        {
            IntPtr inRead, inWrite, outRead, outWrite;
            if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) throw Fail("CreatePipe(in)");
            if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) throw Fail("CreatePipe(out)");
            COORD size = new COORD(); size.X = cols; size.Y = rows;
            int hr = CreatePseudoConsole(size, inRead, outWrite, 0, out _hPC);
            if (hr != 0) throw new Exception("CreatePseudoConsole hr=" + hr);
            CloseHandle(inRead); CloseHandle(outWrite); // the pty owns those ends now

            STARTUPINFOEX siex = new STARTUPINFOEX();
            siex.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            IntPtr lsize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref lsize);
            _attrList = Marshal.AllocHGlobal(lsize);
            if (!InitializeProcThreadAttributeList(_attrList, 1, 0, ref lsize)) throw Fail("InitializeProcThreadAttributeList");
            if (!UpdateProcThreadAttribute(_attrList, 0, ATTR_PSEUDOCONSOLE, _hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                throw Fail("UpdateProcThreadAttribute");
            siex.lpAttributeList = _attrList;

            PROCESS_INFORMATION pi;
            if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false,
                EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref siex, out pi))
                throw Fail("CreateProcessW '" + commandLine + "'");
            _hProcess = pi.hProcess; CloseHandle(pi.hThread);
            ChildPid = pi.dwProcessId;

            _in = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write);
            _out = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read);

            Thread reader = new Thread(delegate ()
            {
                byte[] buf = new byte[4096];
                try
                {
                    int n;
                    while ((n = _out.Read(buf, 0, buf.Length)) > 0)
                    {
                        string b64 = Convert.ToBase64String(buf, 0, n);
                        lock (_snapshot)
                        {
                            _snapshot.Append(Encoding.UTF8.GetString(buf, 0, n));
                            if (_snapshot.Length > 262144) _snapshot.Remove(0, _snapshot.Length - 131072);
                        }
                        if (onOutputB64 != null) Post(ui, delegate () { onOutputB64(b64); });
                    }
                }
                catch (Exception) { } // the pipe breaking IS the exit path
            });
            reader.IsBackground = true; reader.Start();

            Thread waiter = new Thread(delegate ()
            {
                WaitForSingleObject(_hProcess, 0xFFFFFFFF);
                if (!_disposed && onExit != null) Post(ui, onExit);
            });
            waiter.IsBackground = true; waiter.Start();
        }

        static Exception Fail(string what)
        {
            return new Exception(what + " err=" + Marshal.GetLastWin32Error());
        }

        // PS scriptblock delegates need the runspace thread; BeginInvoke gets
        // them there. Null ui (tests) runs callbacks on the worker thread, so
        // tests must pass null callbacks and poll Snapshot() instead.
        static void Post(System.Windows.Forms.Control ui, Action a)
        {
            if (ui != null && ui.IsHandleCreated) { try { ui.BeginInvoke(a); } catch (Exception) { } }
            else a();
        }

        public string Snapshot() { lock (_snapshot) return _snapshot.ToString(); }

        public void WriteBytes(byte[] data)
        {
            lock (_writeLock) { _in.Write(data, 0, data.Length); _in.Flush(); }
        }
        public void WriteText(string text) { WriteBytes(Encoding.UTF8.GetBytes(text)); }
        public void WriteB64(string b64) { WriteBytes(Convert.FromBase64String(b64)); }

        public void Resize(short cols, short rows)
        {
            if (_hPC == IntPtr.Zero) return;
            COORD size = new COORD(); size.X = cols; size.Y = rows;
            ResizePseudoConsole(_hPC, size);
        }

        public void ServePipe(string pipeName)
        {
            Thread t = new Thread(delegate ()
            {
                while (!_disposed)
                {
                    try
                    {
                        using (NamedPipeServerStream srv = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1))
                        {
                            srv.WaitForConnection();
                            using (StreamReader rd = new StreamReader(srv, Encoding.UTF8, false, 4096, true))
                            using (StreamWriter wr = new StreamWriter(srv, new UTF8Encoding(false), 4096, true))
                            {
                                wr.AutoFlush = true;
                                string line = rd.ReadLine();
                                wr.WriteLine(Handle(line));
                                try { srv.WaitForPipeDrain(); } catch (Exception) { }
                            }
                        }
                    }
                    catch (Exception) { if (!_disposed) Thread.Sleep(200); }
                }
            });
            t.IsBackground = true; t.Start();
        }

        string Handle(string line)
        {
            if (_disposed || _in == null) return "FAIL pty not running";
            if (line == null) return "FAIL empty";
            if (line == "SUBMIT") { WriteText("\r"); return "OK"; }
            if (line == "ESC") { WriteText("\x1b"); return "OK"; }
            if (line.StartsWith("TEXT ", StringComparison.Ordinal))
            {
                string payload = line.Substring(5);
                foreach (char c in payload)
                    if (c < 0x20 || c == 0x7f) return "FAIL unsafe TEXT: control characters";
                if (payload.Length > 2100) return "FAIL unsafe TEXT: exceeds 2100 chars";
                WriteText(payload);
                return "OK";
            }
            return "FAIL unknown op";
        }

        public void Kill()
        {
            try { if (ChildPid != 0) System.Diagnostics.Process.GetProcessById(ChildPid).Kill(); }
            catch (Exception) { }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            Kill();
            if (_hPC != IntPtr.Zero) { ClosePseudoConsole(_hPC); _hPC = IntPtr.Zero; }
            try { if (_in != null) _in.Dispose(); } catch (Exception) { }
            try { if (_out != null) _out.Dispose(); } catch (Exception) { }
            if (_attrList != IntPtr.Zero) { Marshal.FreeHGlobal(_attrList); _attrList = IntPtr.Zero; }
            if (_hProcess != IntPtr.Zero) { CloseHandle(_hProcess); _hProcess = IntPtr.Zero; }
        }
    }
}
```

- [x] **Step 4: Run the test — expect all PASS, exit 0**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File gui/ptyhost.test.ps1`
Expected: every line `PASS ...`, exit code 0. If `CreatePseudoConsole` is not found: the machine is pre-1809 — stop and report; the design requires ConPTY.

- [x] **Step 5: Commit** — `0424bac`

---

### Task 3: Clearbot pty transport (single choke point in `Send-Keys`)

**DONE — evidence:** commit `ebcbebe`; `watcher/clearbot.ps1` (`Get-TermPipe` :117, `Send-Pipe` :139, `Send-Keys` pipe-first switch :158–179 including the ESC path); tests `hooks/clearbot.test.mjs:292` ("clear request goes to the pipe, zero keystrokes") and `:307` ("dead pipe falls back") — suite verified green 2026-07-31, 10 pass / 0 fail; test double `watcher/stubpipe.ps1`. Note: `Get-TermPipe` deliberately dropped the `Test-Path \\.\pipe\` liveness probe from the original Step 3 sketch — liveness is `Send-Pipe`'s own `Connect(2000)` (see comment at clearbot.ps1:125 and the resolved OPEN-ISSUES entry of 2026-07-31); do not "fix" it back.

**Files:**
- Modify: `watcher/clearbot.ps1` (the `Send-Keys` function — all call sites stay untouched; also the inline `sendconsole.ps1` escalation call near line 225 if it bypasses `Send-Keys`)
- Test: `hooks/clearbot.test.mjs` (add cases; existing 79 fast-tier tests must stay green)

**Interfaces:**
- Consumes: Task 2's pipe protocol (`TEXT <payload>` / `SUBMIT` / `ESC`, reply `OK`/`FAIL ...`), and window records `runner/state/<sid>.window` which Task 4 extends with `transport:"pty"` and `pipe:"acc-term-<suffix>"`.
- Produces: `Get-TermPipe([int]$ConsolePid)` → pipe name or `$null` (scans `$Root\runner\state\*.window` for `transport -eq 'pty' -and consolePid -eq $ConsolePid`, and verifies liveness with `Test-Path "\\.\pipe\<name>"`); `Send-Pipe([string]$PipeName, [string[]]$Ops)` → `@{ ok; out }`.

- [x] **Step 1: Write the failing tests** (append to `hooks/clearbot.test.mjs`, reusing its `sandbox()` / `startStub()` / `writeWindow()` helpers)

```js
// --- pty transport (spec 2026-07-31): when the window record says
// transport:"pty", clearbot writes the pipe protocol and types NOTHING.
import net from "node:net";

function startPipeStub(name) {
  // Records each protocol line; replies OK. One line per connection, like the
  // real server. net supports Windows named pipes natively.
  const lines = [];
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i >= 0) {
        lines.push(buf.slice(0, i).replace(/\r$/, ""));
        sock.write("OK\r\n");
      }
    });
  });
  server.listen(`\\\\.\\pipe\\${name}`);
  return { lines, close: () => server.close() };
}

function writePtyWindow(root, sid, consolePid, pipe) {
  fs.writeFileSync(
    path.join(root, "runner", "state", `${sid}.window`),
    JSON.stringify({ ok: true, hwnd: 0, consolePid, transport: "pty", pipe, title: "acc-pty" })
  );
}

test("pty transport: clear request goes to the pipe, zero keystrokes", async () => {
  const root = sandbox();
  const stub = startStub();                       // real console that must stay SILENT
  const pipeName = `acc-term-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const pipe = startPipeStub(pipeName);
  try {
    writePtyWindow(root, "sid-pty-1", stub.pid, pipeName);
    writeClearRequest(root, "sid-pty-1", stub.pid); // same helper the existing clear tests use
    runClearbotOnce(root);                          // same helper the existing tests use
    assert.deepEqual(pipe.lines, ["ESC", "TEXT /clear", "SUBMIT"]);
    assert.equal(fs.existsSync(stub.log) ? fs.readFileSync(stub.log, "utf8").trim() : "", "",
      "pty transport must not inject keystrokes");
  } finally { pipe.close(); stub.kill(); }
});

test("pty transport: dead pipe falls back to keystroke injection", async () => {
  const root = sandbox();
  const stub = startStub();
  try {
    // Record claims pty but nothing serves the pipe -> fallback must still land.
    writePtyWindow(root, "sid-pty-2", stub.pid, `acc-term-dead-${process.pid}`);
    writeClearRequest(root, "sid-pty-2", stub.pid);
    runClearbotOnce(root);
    const typed = fs.readFileSync(stub.log, "utf8");
    assert.match(typed, /\/clear/, "fallback injection must type /clear");
  } finally { stub.kill(); }
});
```

Adapt helper names (`writeClearRequest`, `runClearbotOnce`) to the file's actual existing helpers — read the current tests first and follow their exact request-file shape. Do not invent a parallel harness.

- [x] **Step 2: Run — expect the two new tests FAIL** (`pipe.lines` empty / keystrokes typed)

Run: `node --test hooks/clearbot.test.mjs`

- [x] **Step 3: Implement in `watcher/clearbot.ps1`**

Add near `Send-Keys`:

```powershell
# Transport lookup: a session ACC hosts on a pseudoconsole records
# transport:"pty" plus its pipe name (hooks/budget.mjs). Everything else
# keeps keystroke injection. Liveness is probed so a dead GUI degrades to
# the old path instead of stalling the loop.
function Get-TermPipe([int]$ConsolePid) {
    foreach ($f in (Get-ChildItem -Path (Join-Path $Root 'runner\state') -Filter '*.window' -ErrorAction SilentlyContinue)) {
        try { $w = Get-Content -Raw $f.FullName | ConvertFrom-Json } catch { continue }
        if ($w.transport -eq 'pty' -and [int]$w.consolePid -eq $ConsolePid -and $w.pipe) {
            if (Test-Path ("\\.\pipe\" + $w.pipe)) { return [string]$w.pipe }
        }
    }
    return $null
}

function Send-Pipe([string]$PipeName, [string[]]$Ops) {
    foreach ($op in $Ops) {
        try {
            $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
            $c.Connect(2000)
            $w = New-Object System.IO.StreamWriter($c); $w.AutoFlush = $true
            $r = New-Object System.IO.StreamReader($c)
            $w.WriteLine($op)
            $resp = $r.ReadLine()
            $c.Dispose()
            if ($resp -ne 'OK') { return @{ ok = $false; out = "$op -> $resp" } }
        } catch { return @{ ok = $false; out = "$op -> $($_.Exception.Message)" } }
        # A CR glued to the text is what broke keystroke injection (paste
        # heuristic). Give the TUI a beat between text and Enter.
        if ($op -like 'TEXT *') { Start-Sleep -Milliseconds 80 }
    }
    return @{ ok = $true; out = 'OK' }
}
```

Then make the existing `Send-Keys` the single switch — keep its current signature and its sendconsole body as the fallback:

```powershell
function Send-Keys([int]$TargetPid, [string]$Text, [switch]$ClearLineFirst, [switch]$Esc) {
    $pipe = Get-TermPipe $TargetPid
    if ($pipe) {
        if ($Esc) { $ops = @('ESC') }
        else {
            $ops = @()
            if ($ClearLineFirst) { $ops += 'ESC' }
            $ops += ("TEXT " + $Text)
            $ops += 'SUBMIT'
        }
        $r = Send-Pipe $pipe $ops
        if ($r.ok) { return @{ ok = $true; out = "pty $($r.out)" } }
        Log "WARN pty pipe '$pipe' failed ($($r.out)) - falling back to keystroke injection"
    }
    # ... existing sendconsole.ps1 invocation, byte-for-byte unchanged ...
}
```

If the escalation path near clearbot.ps1:225 shells `sendconsole.ps1` directly instead of calling `Send-Keys`, route it through `Send-Keys -Esc` so pty sessions get a pipe ESC.

- [x] **Step 4: Run the full fast tier — all green** (re-verified 2026-07-31: `hooks/clearbot.test.mjs` 10/10)

Run: `node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs hooks/clearbot.test.mjs`
Expected: previous count (79) + new tests, 0 fail.

- [x] **Step 5: Commit** — `ebcbebe` (includes `watcher/stubpipe.ps1` and the OPEN-ISSUES Resolved entry for the pipe-enumeration liveness bug)

---

### Task 4: Window record learns `transport:"pty"` (budget.mjs + runner scrub)

**Files:**
- Modify: `hooks/budget.mjs` (where the `.window` record is captured/written, around the existing capture at ~line 61 / `onSessionStart`)
- Modify: `runner/runner.mjs` (scrub `ACC_PTY` from spawned child env)
- Test: `hooks/budget.test.mjs` (add one case; suite sandboxes itself via `ACC_ROOT`/`ACC_POLICY` — follow its existing SessionStart-piping pattern)

**Interfaces:**
- Consumes: env var `ACC_PTY=<full pipe name>` set by the GUI (Task 6) on the spawned claude process.
- Produces: `.window` record shape `{ ok:true, hwnd:0, consolePid:<claude pid>, transport:"pty", pipe:"<ACC_PTY value>", title:"acc-pty" }` — consumed by Task 3's `Get-TermPipe` and by goal binding (consolePid semantics unchanged: it is the persistent claude process, which survives `/clear`).

- [x] **Step 1: Write the failing test** (in `hooks/budget.test.mjs`, using its existing sandbox + SessionStart fixture pattern — read the neighboring tests and mirror them):

```js
test("SessionStart with ACC_PTY records a pty window bound to the parent pid", () => {
  const root = sandboxRoot();               // the suite's existing helper
  const out = runHook("budget.mjs", sessionStartEvent({ session_id: "sid-pty" }), {
    env: { ...process.env, ACC_ROOT: root, ACC_POLICY: policyFile, ACC_PTY: "acc-term-cafe12" },
  });
  const win = JSON.parse(fs.readFileSync(path.join(root, "runner", "state", "sid-pty.window"), "utf8"));
  assert.equal(win.transport, "pty");
  assert.equal(win.pipe, "acc-term-cafe12");
  assert.equal(win.consolePid, process.pid, "consolePid must be the hook's PARENT (the claude process; here, the test runner)");
});
```

- [x] **Step 2: Run — expect FAIL** (`transport` undefined). Run: `node --test hooks/budget.test.mjs`

- [x] **Step 3: Implement in `hooks/budget.mjs`** — where the window capture currently shells `winfind.ps1`, short-circuit first:

```js
// An ACC-hosted pty session has no HWND to find: the GUI is the terminal.
// The persistent process across /clear (what "console pid" means to goal
// binding) is the claude process itself - this hook's parent.
if (process.env.ACC_PTY) {
  win = { ok: true, hwnd: 0, consolePid: process.ppid, transport: "pty",
          pipe: process.env.ACC_PTY, title: "acc-pty" };
} else {
  // existing winfind.ps1 path, unchanged
}
```

Keep every downstream consumer (goal binding by consolePid, queued prompts keyed by consolePid) untouched — the record shape is a superset.

- [x] **Step 4: Scrub inheritance in `runner/runner.mjs`** — wherever it builds the child env for spawned claude runs, add `delete env.ACC_PTY;` next to any existing ACC_* scrubbing. A runner child that inherited `ACC_PTY` would masquerade as the embedded session and route clearbot writes into the wrong terminal.

- [x] **Step 5: Run fast tier — all green** (same six-suite command). Also `node --test hooks/goal.test.mjs` alone to confirm goal binding is untouched.

- [x] **Step 6: Commit**

```powershell
git add hooks/budget.mjs hooks/budget.test.mjs runner/runner.mjs
git commit -m "feat: pty sessions record transport+pipe in the window record; runner scrubs ACC_PTY"
```

---

### Task 5: `gui/term.html` — the xterm page

**Files:**
- Create: `gui/term.html`

**Interfaces:**
- Consumes: `gui/vendor/xterm/*` (Task 1); host messages via `window.chrome.webview` — receives `{type:"out", data:<b64>}` and `{type:"exit"}`.
- Produces: posts `{type:"in", data:<b64 of UTF-8 keystrokes>}`, `{type:"resize", cols, rows}`, `{type:"ready"}` to the host (Task 6 handles them).

- [x] **Step 1: Write `gui/term.html`**

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ACC Terminal</title>
<link rel="stylesheet" href="vendor/xterm/xterm.css">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0c0c0c; overflow: hidden; }
  #term { height: 100%; }
</style>
</head>
<body>
<div id="term"></div>
<script src="vendor/xterm/xterm.js"></script>
<script src="vendor/xterm/addon-fit.js"></script>
<script>
  // Bridge protocol (spec 2026-07-31): host->page {type:'out',data:b64} |
  // {type:'exit'}; page->host {type:'in',data:b64} | {type:'resize',cols,rows}
  // | {type:'ready'}. Base64 both ways so multi-byte UTF-8 never splits.
  var term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 8000,
    theme: { background: '#0c0c0c' }
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));

  var enc = new TextEncoder();
  function b64FromString(s) {
    var bytes = enc.encode(s), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function bytesFromB64(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  term.onData(function (d) {
    window.chrome.webview.postMessage({ type: 'in', data: b64FromString(d) });
  });

  function sendSize() {
    fit.fit();
    window.chrome.webview.postMessage({ type: 'resize', cols: term.cols, rows: term.rows });
  }
  new ResizeObserver(sendSize).observe(document.getElementById('term'));

  window.chrome.webview.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'out') term.write(bytesFromB64(m.data));
    else if (m.type === 'exit') term.write('\r\n\x1b[31m[claude exited - press Go to relaunch]\x1b[0m\r\n');
  });

  sendSize();
  window.chrome.webview.postMessage({ type: 'ready' });
</script>
</body>
</html>
```

- [x] **Step 2: Sanity-check standalone** (deviated: browser extension refuses file:// — rendering is instead proven by Task 6 Step 5's WebView2 screenshot and Gate 4) — open in a plain browser where `chrome.webview` is undefined; it will throw on the first postMessage, so just verify the terminal *renders* (black page, blinking cursor) by temporarily guarding: this check is manual and quick — do not add permanent guards; inside WebView2 the bridge always exists.

- [x] **Step 3: Commit** — `0d37245`

---

### Task 6: GUI — Terminal tab, WebView2 wiring, pty launch, fallback

**Files:**
- Modify: `guards-gui.ps1` — (a) load `PtyHost.cs` + WebView2 dlls at startup, (b) add a Terminal tab with a WebView2 control, (c) rewire `btnStartWork.Add_Click` (currently the `cmd /k claude` ProcessStartInfo block at ~line 977) to pty launch with legacy fallback, (d) form-close confirm + dispose.

**Interfaces:**
- Consumes: `Acc.PtyHost` (Task 2), `gui/term.html` (Task 5), vendored dlls (Task 1).
- Produces: env `ACC_PTY=<pipe name>` + `ACC_GOAL`/`ACC_PROFILE` on the claude process (consumed by Task 4); a served pipe `acc-term-<12-hex>` (consumed by Task 3).

- [x] **Step 1: Startup loads (top of `guards-gui.ps1`, near existing Add-Types)**

```powershell
# Embedded terminal (spec 2026-07-31). $script:TermOk gates the whole feature:
# false -> the Go button uses the legacy cmd /k launch, nothing else changes.
$script:TermOk = $false
try {
    $wvDir = Join-Path $PSScriptRoot 'gui\vendor\webview2'
    Add-Type -Path (Join-Path $wvDir 'Microsoft.Web.WebView2.Core.dll')
    Add-Type -Path (Join-Path $wvDir 'Microsoft.Web.WebView2.WinForms.dll')
    [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::SetLoaderDllFolderPath($wvDir)
    # Evergreen runtime present? This throws if not installed.
    [void][Microsoft.Web.WebView2.Core.CoreWebView2Environment]::GetAvailableBrowserVersionString()
    Add-Type -Path (Join-Path $PSScriptRoot 'gui\PtyHost.cs') -ReferencedAssemblies 'System','System.Core','System.Windows.Forms'
    $script:TermOk = $true
} catch {
    Write-Host "Embedded terminal unavailable ($($_.Exception.Message)); Go will use a plain console window."
}
```

- [x] **Step 2: Terminal tab** — follow the file's existing tab-construction idiom (find how the 4 tabs are made and append a 5th):

```powershell
$tabTerm = New-Object System.Windows.Forms.TabPage
$tabTerm.Text = 'Terminal'
$script:wv = $null
if ($script:TermOk) {
    $script:wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
    $script:wv.Dock = [System.Windows.Forms.DockStyle]::Fill
    $tabTerm.Controls.Add($script:wv)
    $script:wv.add_CoreWebView2InitializationCompleted({
        if ($script:wv.CoreWebView2) {
            $script:wv.CoreWebView2.Navigate('file:///' + ((Join-Path $PSScriptRoot 'gui\term.html') -replace '\\', '/'))
            $script:wv.add_WebMessageReceived({
                param($s, $e)
                $m = $e.WebMessageAsJson | ConvertFrom-Json
                if (-not $script:pty) { return }
                switch ($m.type) {
                    'in'     { $script:pty.WriteB64($m.data) }
                    'resize' { $script:pty.Resize([int16]$m.cols, [int16]$m.rows) }
                }
            })
        }
    })
    $udf = Join-Path $env:LOCALAPPDATA 'acc-webview2'
    $envTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, $udf, $null)
    $envTask.ContinueWith({ param($t)
        $form.BeginInvoke([Action]{ [void]$script:wv.EnsureCoreWebView2Async($t.Result) })
    }) | Out-Null
}
$tabs.TabPages.Add($tabTerm)   # match the real container variable name in the file
```

Match real variable names (`$tabs`, `$form`) to the file — read the surrounding code first.

- [x] **Step 3: Rewire Go** — replace the body of the `cmd /k claude` block (keep the goal-creation code above it intact):

```powershell
if ($script:TermOk -and $script:wv -and $script:wv.CoreWebView2) {
    if ($script:pty) {
        $a = [System.Windows.Forms.MessageBox]::Show(
            'A session is already running in the Terminal tab. Stop it and start the new one?',
            'Guards', [System.Windows.Forms.MessageBoxButtons]::YesNo)
        if ($a -ne [System.Windows.Forms.DialogResult]::Yes) { return }
        $script:pty.Dispose(); $script:pty = $null
    }
    $pipeName = 'acc-term-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $claude = (Get-Command claude -ErrorAction Stop).Source
    $cmdline = if ($claude -match '\.(cmd|bat)$') { 'cmd.exe /c "' + $claude + '"' } else { '"' + $claude + '"' }
    # CreateProcessW inherits our env; set, spawn, restore.
    $env:ACC_GOAL = $goal.id; $env:ACC_PROFILE = $name; $env:ACC_PTY = $pipeName
    try {
        $script:pty = New-Object Acc.PtyHost
        $script:pty.Start($cmdline, $dir, 120, 30, $form,
            [Action[string]]{ param($b64)
                if ($script:wv.CoreWebView2) {
                    $script:wv.CoreWebView2.PostWebMessageAsJson('{"type":"out","data":"' + $b64 + '"}')
                }
            },
            [Action]{
                if ($script:wv.CoreWebView2) { $script:wv.CoreWebView2.PostWebMessageAsJson('{"type":"exit"}') }
                $script:pty = $null
            })
        $script:pty.ServePipe($pipeName)
        $tabs.SelectedTab = $tabTerm
    } finally {
        Remove-Item Env:ACC_GOAL, Env:ACC_PROFILE, Env:ACC_PTY -ErrorAction SilentlyContinue
    }
} else {
    # legacy launch, byte-for-byte the current ProcessStartInfo block
}
```

- [x] **Step 3b: Binding watchdog — verify the spawn actually bound** (completion-gate requirement). The `.window` record is written by `hooks/budget.mjs` when claude's SessionStart hook fires — *not* by the GUI. If the hook never fires (claude died at startup, wrong cwd, hook error) or binds a different process, clearbot's pipe writes go nowhere and the goal loop silently stalls. After every pty spawn, watch for the record and verify it belongs to this spawn.

  **Caveat — the pid is NOT `ChildPid`:** the ConPTY child is `cmd.exe /c claude.cmd` (a shim), so `PtyHost.ChildPid` is cmd's pid, while the record's `consolePid` is the *claude node process* — a **descendant** of `ChildPid` (it is the hook's `process.ppid`, the process that survives `/clear`). Assert descent, not equality.

  Add after `$script:pty.ServePipe($pipeName)` in Step 3 (inside the `try`):

```powershell
# Binding watchdog (gate item 1f): budget.mjs must write a transport:"pty"
# window record for THIS spawn within 120s. consolePid is the claude node
# process - a DESCENDANT of the cmd shim ChildPid, never assumed equal.
$script:bindPipe = $pipeName
$script:bindDeadline = [DateTime]::UtcNow.AddSeconds(120)
$script:bindTimer = New-Object System.Windows.Forms.Timer
$script:bindTimer.Interval = 3000
$script:bindTimer.add_Tick({
    $hit = $null
    foreach ($f in (Get-ChildItem -Path (Join-Path $PSScriptRoot 'runner\state') -Filter '*.window' -ErrorAction SilentlyContinue)) {
        try { $w = Get-Content -Raw $f.FullName | ConvertFrom-Json } catch { continue }
        if ($w.transport -eq 'pty' -and $w.pipe -eq $script:bindPipe) { $hit = $w; break }
    }
    if ($hit) {
        $script:bindTimer.Stop()
        $p = [int]$hit.consolePid; $anchor = if ($script:pty) { [int]$script:pty.ChildPid } else { -1 }
        $bound = $false
        for ($i = 0; $i -lt 8 -and $p -gt 0; $i++) {
            if ($p -eq $anchor) { $bound = $true; break }
            $row = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
            if (-not $row) { break }
            $p = [int]$row.ParentProcessId
        }
        if ($bound) { Write-Host ("pty binding OK: consolePid {0} descends from child {1}" -f $hit.consolePid, $anchor) }
        else { Write-Host ("WARN pty binding MISMATCH: record consolePid {0} does not descend from pty child {1} - clearbot writes may target the wrong session" -f $hit.consolePid, $anchor) }
    } elseif ([DateTime]::UtcNow -gt $script:bindDeadline) {
        $script:bindTimer.Stop()
        Write-Host ("WARN pty binding TIMEOUT: no transport:pty window record for pipe {0} within 120s - SessionStart hook likely never fired" -f $script:bindPipe)
    }
})
$script:bindTimer.Start()
```

  If the GUI has a log textbox/status area, route these three messages there instead of `Write-Host` — match the file's existing logging idiom. Objective check: covered end-to-end by E2E scenario 5 step 3 (record appears with the pipe name) and exercised live in Step 6's manual pass (expect the `pty binding OK` line).

- [x] **Step 4: Form close** — extend the existing close-confirm handler (pattern at ~line 829): if `$script:pty`, ask `'A Claude session is running in the Terminal tab and will be killed. Close anyway?'`; on Yes, `$script:pty.Dispose()`.

- [x] **Step 5: Smoke + screenshot**

```powershell
powershell -File C:/code/guards/guards-gui.ps1 -SmokeTest
powershell -File C:/code/guards/watcher/screenshot-gui.ps1
```

Expected: SmokeTest passes (form builds with the new tab); screenshot shows the Terminal tab. `-SmokeTest` cannot see layout — actually look at the screenshot.

- [ ] (deferred to Completion Gate 4, after E2E) **Step 6: Manual live pass (the visual bar: "still visually great")** — launch the GUI, press Go with a trivial goal in a scratch folder; verify in the Terminal tab: claude TUI renders (colors, spinner, slash-menu), typing works, resize reflows, and the kick submits *on its own* within ~2 minutes (watch `watcher/clearbot.log` for a `pty` send). Screenshot for the record.

- [x] **Step 7: Commit** — `8e3f1e5`

---

### Task 7: Proof-tier E2E — the reported failure, regression-locked

**Files:**
- Modify: `e2e/loop.e2e.mjs` (add scenario 5)
- Create: `gui/ptyhost.e2e.ps1` (headless pty harness the scenario shells)

**Interfaces:**
- Consumes: `Acc.PtyHost` (Task 2), clearbot pty transport (Task 3), budget.mjs pty record (Task 4). No GUI, no WebView2 — the pty and pipe server alone.

- [x] **Step 1: Read `e2e/loop.e2e.mjs` end to end** — scenarios 1–4 already sandbox an ACC root, launch real claude consoles, drive clearbot, and assert from transcripts. Scenario 5 must reuse its helpers and assertion style, not invent parallel ones. (Note its hard-won lesson in the 6ad5d44 commit message: a first prompt cannot be typed before the TUI accepts input — scenario 5 exists precisely to prove the pty transport doesn't have that failure.)

- [x] **Step 2: Write `gui/ptyhost.e2e.ps1`** (deviation: no `-Root` param — ACC_ROOT/ACC_POLICY pass through the environment, which the scenario sets) — headless host: parameters `-Root <sandboxAccRoot> -PipeName <name> -GoalId <id> -Cwd <dir> -PidFile <path> -TimeoutSeconds <n>`; sets `ACC_GOAL`/`ACC_PTY` (+ `ACC_ROOT`/`ACC_POLICY` passthrough from its own env), `Add-Type`s `PtyHost.cs`, starts real `claude` (same `Get-Command` resolution as Task 6), `ServePipe`, writes `ChildPid` to `-PidFile`, then sleeps until timeout or child exit, disposing on the way out. Null ui/callbacks; the scenario observes via transcripts and `clearbot.log`, not via `Snapshot()`.

- [x] **Step 3: Add scenario 5 to `e2e/loop.e2e.mjs`** — "embedded launch: the kick submits with zero human input":
  1. Sandbox ACC root (existing helper); create a goal via `goal.mjs new` whose text says to reply one word and run `goal.mjs done <id>`.
  2. Spawn `gui/ptyhost.e2e.ps1` with a fresh pipe name; wait for the pid file.
  3. Wait for the session's `.window` record to appear with `transport:"pty"` and the pipe name (proves Task 4 end-to-end).
  4. Run clearbot the way scenarios 1–4 do until `goal.mjs pending` yields the kick and clearbot sends it; assert `clearbot.log` shows a pty send (`pty OK`), not injection.
  5. THE assertion — the reported bug: the session's transcript (found the way scenario 1 finds transcripts) gains a user message that is exactly `Continue the active ACC goal.` **and** an assistant turn after it, within the scenario timeout. Text sitting unsubmitted produces no transcript entry — this is the objective, unambiguous discriminator.
  6. Teardown: kill the pty child via the pid file; remove sandbox.

- [ ] **Step 4: Run it deliberately** (spends real tokens): `node e2e/loop.e2e.mjs --only 5`
Expected: scenario 5 PASS. If the kick lands but no turn starts, bisect with `gui/ptyhost.test.ps1` (transport) vs. transcript (TUI) before touching timing constants.

- [ ] **Step 5: Run scenarios 1–4** to prove no regression in the injection path: `node e2e/loop.e2e.mjs`
Expected: 4 previous scenarios still PASS (they use non-pty windows and must be untouched by the transport switch).

- [ ] **Step 6: Commit**

```powershell
git add e2e/loop.e2e.mjs gui/ptyhost.e2e.ps1
git commit -m "test: e2e scenario 5 - embedded pty launch, kick submits with zero human input"
```

---

### Task 8: Docs, reviews, ledger

- [ ] **Step 1: Update `AGENTS.md`** — in "The regression, exactly" add `powershell -File gui/ptyhost.test.ps1` to the command list and `--only 5` to the e2e line; in the Goals section, one paragraph: ACC-hosted sessions run on a ConPTY inside the GUI (`transport:"pty"` window records, pipe protocol, sendconsole fallback), pointer to the spec.
- [ ] **Step 2: Lean diff review** — run the `/simplify` skill over the branch diff; apply its fixes (this is the "diff lean review" the goal condition requires).
- [ ] **Step 3: Security review** — run the `/security-review` skill (mandatory: this diff touches console/keystroke/pipe injection). Apply or explicitly ledger every finding.
- [ ] **Step 4: `/approve`** — if any runbox scripts are pending, surface them to Kyle per the runbox flow; run any he approves.
- [ ] **Step 5: Ledger** — anything surfaced-not-fixed goes to `OPEN-ISSUES.md` (repo root).
- [ ] **Step 6: Full verification sweep** — fast tier (six suites), `gui/ptyhost.test.ps1`, `-SmokeTest`, screenshot, e2e 1–5. Paste actual outputs into the final report.
- [ ] **Step 7: Commit docs + mark the goal condition met** (`goal.mjs log <id> --text "CONDITION MET: ..."`), then `goal.mjs done <id>` only after everything above is green.

---

## Completion Gate (added 2026-07-31 — blocks `goal.mjs done`)

Kyle's exit criterion, verbatim intent: *"Do not mark the goal complete until every item is objectively verified... Report file:line evidence per item."* Every item below names its command and its pass condition. The final report to Kyle lists, per item, the command run, the actual output (pasted, not paraphrased), and file:line evidence. `node C:/code/guards/hooks/goal.mjs done <goal-id>` runs only after all six show their evidence. Kyle has pre-approved runbox `/approve` scripts for this goal (2026-07-31): when a script lands in `runbox/`, tell him it's there and that he already approved it — he still has to type `/approve` himself.

- [ ] **Gate 1 — deliverables exist and are wired.** Report file:line for each:
  - (a) `gui/term.html` exists with the xterm bridge (`{type:'out'|'exit'}` in, `{type:'in'|'resize'|'ready'}` out) and a resize path (`fit.fit()` on `window.resize` + `ResizeObserver`).
  - (b) `guards-gui.ps1` builds a Terminal tab hosting a WebView2 control (Task 6 Step 2).
  - (c) WebView2-runtime-absent fallback: `$script:TermOk = $false` path reaches the legacy launch byte-for-byte (Task 6 Steps 1 and 3's `else`). Objective check: `-SmokeTest` passes even after temporarily renaming `gui\vendor\webview2` (restore after; state in the report that this was actually done, with output).
  - (d) The `cmd /k claude` ProcessStartInfo block (was guards-gui.ps1:977) is replaced by the pty spawn with `ACC_GOAL`/`ACC_PROFILE`/`ACC_PTY` env (Task 6 Step 3).
  - (e) Window record: `hooks/budget.mjs` writes `transport:"pty"` + `pipe` when `ACC_PTY` is set (Task 4), proven by its unit test.
  - (f) Binding verified after every spawn: Task 6 Step 3b watchdog present; descent-not-equality assertion as specified.
  - (g) Close-with-live-session confirm disposes the pty (Task 6 Step 4), and `Dispose` → `Kill` terminates the child tree (PtyHost.cs:209–223).
- [ ] **Gate 2 — unit + integration tiers green.** Commands and pass conditions:
  - `node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs hooks/clearbot.test.mjs` → 0 fail (this is the sendconsole/dead-pipe regression evidence for external sessions: "sendconsole itself refuses multi-line text", "pty transport: a dead pipe falls back to keystroke injection" must be in the pass list).
  - `powershell -NoProfile -ExecutionPolicy Bypass -File gui/ptyhost.test.ps1` → exit 0, all PASS.
  - `powershell -File C:/code/guards/guards-gui.ps1 -SmokeTest` → pass, plus `watcher/screenshot-gui.ps1` screenshot showing the Terminal tab.
- [ ] **Gate 3 — E2E, the reason this feature exists.** `node e2e/loop.e2e.mjs --only 5` → PASS: kick submitted via pipe, transcript gains the exact user message `Continue the active ACC goal.` **and** a following assistant turn, with zero human input and zero keystroke injection (clearbot.log shows a `pty` send; no injection lines for that sid). Then `node e2e/loop.e2e.mjs` → scenarios 1–4 also PASS (injection path unregressed). Paste the scenario summary lines.
- [ ] **Gate 4 — manual visual pass with Kyle. STOP AND ASK — do not self-certify rendering.** Launch the GUI, start a session, then tell Kyle it is ready and ask him to check: TUI colors, spinner animation, slash-command menu, typing echo, and resize reflow. Record his verdict verbatim (`goal.mjs log <id> --text "VISUAL PASS: <his words>"`). This gate is satisfied only by his reply, never by a screenshot self-check.
- [ ] **Gate 5 — reviews over the full branch diff** (`git diff main...acc-embedded-terminal` plus working tree): run `/simplify` (the lean diff review) and `/security-review`; apply fixes or ledger findings explicitly. Rerun Gate 2's commands after any fix.
- [ ] **Gate 6 — ledger, log not build.** Append to `C:\code\guards\OPEN-ISSUES.md` under `## Open`, following the existing entry format (`- opened / - where / - what / - why open / - done when`), next free IDs:
  - **OI-009 GUI process is a single point of failure for hosted sessions** — where: guards-gui.ps1 / gui/PtyHost.cs; what: an ACC-hosted claude lives inside the GUI process, so a GUI crash kills every hosted session with no heartbeat or restart; done when: a heartbeat/reattach-or-restart story exists.
  - **OI-010 Pipe TEXT protocol is single-line; multi-line replay still falls back** (OI-004 successor) — where: gui/PtyHost.cs ServePipe + watcher/clearbot.ps1 Send-Pipe; what: `TEXT` carries one line (control chars < 0x20 refused), so multi-line replay payloads cannot use the pty path and fall back; done when: a framed multi-line op exists with the same content policy.
  - **OI-011 Re-verify guards self-protection coverage of guards/ paths** (relates OI-005) — where: hooks/engine.mjs guard config; what: this branch added gui/PtyHost.cs, gui/term.html, gui/vendor/, watcher/stubpipe.ps1 — confirm the self-protection path list still covers what it claims after these additions; done when: coverage re-verified or the gap ledgered precisely.
  - Router misroute goes in **`C:\code\OPEN-ISSUES.md`** (it is about `C:\code\ROUTING.md`, not this repo — create the file from the template in guards' if absent): **guards-GUI vocabulary collides with lifeos-ui in routing signals** — what: a guards-GUI task routed to lifeos-ui on a "tie: lifeos-ui + guards" because signals like gui/window/terminal appear in both lists (observed 2026-07-31 on the ACC embedded-terminal completion-gate prompt); done when: signal lists disambiguate (e.g. guards-gui, conpty, xterm → guards) and the same prompt routes to guards.
- [ ] **Gate 7 — mark done.** All six above show evidence in the final report → `goal.mjs log <id> --text "CONDITION MET: completion gate 1-6 verified"` then `goal.mjs done <id>`.

---

## Self-review notes (already applied)

- **Spec coverage:** components 1–5 → Tasks 5, 2, 6, 2, 3; data flow → Task 7 scenario 5; error handling → Task 6 steps 1/3/4 + Task 3 fallback; testing section → Tasks 2/3/4/7 + Task 6 manual pass. Out-of-scope respected (no multi-session, sendconsole retained).
- **Type consistency:** pipe ops `TEXT/SUBMIT/ESC` and reply `OK`/`FAIL ...` are identical in Task 2 (server), Task 3 (client), Task 7 (harness); window record fields `transport`/`pipe`/`consolePid` identical in Tasks 3, 4, 7; `ACC_PTY` carries the full pipe name everywhere.
- **Known adapt-points (deliberate, not placeholders):** exact helper names inside `clearbot.test.mjs` / `budget.test.mjs` / `loop.e2e.mjs`, and GUI variable names (`$tabs`, `$form`) — the plan instructs reading and mirroring the real ones rather than guessing, per "follow existing patterns".

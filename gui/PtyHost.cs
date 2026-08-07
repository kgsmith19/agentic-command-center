// ConPTY host for the ACC embedded terminal. See
// docs/adr/ADR-0001-retire-conpty-keystroke-channel.md for the open question
// about this mechanism's future.
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
        const int STARTF_USESTDHANDLES = 0x00000100;
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
            // NULL std handles + USESTDHANDLES, deliberately: without this the
            // child copies the HOST's std handle values (pipes, when the GUI or
            // a test runner has redirected stdio), which are invalid in the
            // child and make node/claude see a non-TTY stdin and refuse to run
            // interactively ("--print requires input"). Forcing null makes a
            // console-subsystem child open fresh handles from its attached
            // console - the pseudoconsole.
            siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
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

        // Line protocol on \\.\pipe\<name>: "TEXT <payload>" | "SUBMIT" | "ESC".
        // One request per connection; reply "OK" or "FAIL <reason>".
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
            // TEXTB64 <base64>: OI-010. TEXT's line-based framing (ReadLine)
            // structurally cannot carry a raw newline, so a multi-line payload
            // travels as base64 instead -- decoded here, not via the existing
            // WriteB64 (that one is the in-process WebView2 keystroke path,
            // unvalidated by design; the pipe gets the same content policy as
            // TEXT). \r\n is the one allowed control sequence, as the intended
            // internal line separator -- everything else \r/\n does is refused,
            // same as a lone \r would be if it slipped through TEXT.
            if (line.StartsWith("TEXTB64 ", StringComparison.Ordinal))
            {
                string payload;
                try { payload = Encoding.UTF8.GetString(Convert.FromBase64String(line.Substring(8))); }
                catch (FormatException) { return "FAIL unsafe TEXTB64: invalid base64"; }
                for (int i = 0; i < payload.Length; i++)
                {
                    char c = payload[i];
                    if (c == '\r') { if (i + 1 >= payload.Length || payload[i + 1] != '\n') return "FAIL unsafe TEXTB64: control characters"; continue; }
                    if (c == '\n') { if (i == 0 || payload[i - 1] != '\r') return "FAIL unsafe TEXTB64: control characters"; continue; }
                    if (c < 0x20 || c == 0x7f) return "FAIL unsafe TEXTB64: control characters";
                }
                if (payload.Length > 2100) return "FAIL unsafe TEXTB64: exceeds 2100 chars";
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

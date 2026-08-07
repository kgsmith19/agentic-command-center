# Vendored assets — ACC embedded terminal

Checked in pinned so the GUI needs no CDN, npm, or install step at runtime.
See `docs/adr/ADR-0001-retire-conpty-keystroke-channel.md` for the open
architecture question around the embedded ConPTY terminal this vendors for.

| File | Package | Version | Source |
|---|---|---|---|
| `xterm/xterm.js` | `@xterm/xterm` (lib/xterm.js) | 5.5.0 | https://registry.npmjs.org/@xterm/xterm/-/xterm-5.5.0.tgz |
| `xterm/xterm.css` | `@xterm/xterm` (css/xterm.css) | 5.5.0 | same tarball |
| `xterm/addon-fit.js` | `@xterm/addon-fit` (lib/addon-fit.js) | 0.10.0 | https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.10.0.tgz |
| `webview2/Microsoft.Web.WebView2.Core.dll` | `Microsoft.Web.WebView2` (lib/net462) | 1.0.2903.40 | https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2903.40 |
| `webview2/Microsoft.Web.WebView2.WinForms.dll` | `Microsoft.Web.WebView2` (lib/net462) | 1.0.2903.40 | same package |
| `webview2/WebView2Loader.dll` | `Microsoft.Web.WebView2` (runtimes/win-x64/native) | 1.0.2903.40 | same package |

The WebView2 *SDK* is vendored; the WebView2 *runtime* (Evergreen) must be
installed on the machine — `guards-gui.ps1` probes for it at startup and falls
back to the plain-console launch when absent.

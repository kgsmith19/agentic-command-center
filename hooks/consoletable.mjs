// OI-034 support for budget.mjs's SessionStart path: builds the (pid ->
// startTime) table bindSession needs to prove console identity, without the
// full process enumeration clearbot.ps1 does every cycle.
//
// SessionStart only ever needs to know about a handful of specific pids - the
// console it just resolved, plus every currently-bound goal's console - so
// this checks exactly those, by id, via hooks/consoletable.ps1 (see that
// file's own header for why a per-pid check is enough here where it would not
// be for clearbot's continuous loop, and why enumerating everything would risk
// re-overrunning the SessionStart hook timeout winfind.ps1 already hit once).
//
// Dependencies are injected (activeGoals, execFileSync, here) so this is
// covgate-testable without shelling out to real PowerShell.
import path from "node:path";

export function buildConsoleTable(win, { activeGoals, execFileSync, here, timeoutMs = 8000 }) {
  try {
    const pids = new Set();
    if (win && win.consolePid) pids.add(Number(win.consolePid));
    for (const g of activeGoals()) if (g.consolePid) pids.add(Number(g.consolePid));
    if (!pids.size) return undefined;
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(here, "consoletable.ps1"),
        "-Pids",
        [...pids].join(","),
      ],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true }
    );
    return JSON.parse(String(out).trim());
  } catch {
    return undefined; // fail open: no table -> goal.mjs fails closed on its own
  }
}

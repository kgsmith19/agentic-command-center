// Fast-tier tests for watcher/clearbot.ps1 - the process that physically types.
//
// Until now it had ZERO automated tests, which was backwards: it is the part of
// the loop whose failure is silent and whose blast radius is a real keyboard.
//
// Each case drives `clearbot.ps1 -Once` against a throwaway ACC root and a stub
// console (watcher/stubconsole.ps1) whose received keystrokes land in a log
// file. Both directions are asserted: the valid request IS typed, and every
// refusal case types NOTHING. An assertion that only checked the log line would
// pass against a clearbot that logged REFUSE and typed anyway.
//
// Run: node --test hooks/clearbot.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// Every powershell/cmd child this suite spawns below inherits process.env
// unmodified (none pass an explicit `env:`), and clearbot.ps1 itself shells
// out to `node hooks/goal.mjs` / `usage.mjs` / `engine.mjs` repeatedly per
// -Once pass — so under `node hooks/covgate.mjs` (coverage-instrumented),
// every one of those nested node invocations would inherit and dump into
// the real run's live NODE_V8_COVERAGE directory WHILE it is still being
// read/merged, corrupting its report generation (found 2026-08-02: "Warning:
// Could not report code coverage. SyntaxError: Unexpected end of JSON
// input" on an otherwise fully green fast tier — see covgate.mjs's own
// matching fix for the mechanism). Cleared once here, not at each spawn.
delete process.env.NODE_V8_COVERAGE;

// clearbot resolves its tree from its own location ($Root = parent of the
// script), so the sandbox gets a COPY of the watcher scripts and the only state
// it can reach is the throwaway one.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-clearbot-"));
  for (const d of [["runner", "state"], ["runner", "clear-requests"], ["watcher"]])
    fs.mkdirSync(path.join(root, ...d), { recursive: true });
  fs.writeFileSync(
    path.join(root, "policy.json"),
    JSON.stringify({ context: { hardK: 50 }, autoApprove: { enabled: false } })
  );
  for (const f of ["clearbot.ps1", "sendconsole.ps1", "stubconsole.ps1"])
    fs.copyFileSync(path.join(REPO, "watcher", f), path.join(root, "watcher", f));
  return root;
}

// A real console for the injector to write into. Launched via `cmd /c start` so
// Windows gives it a genuine console; it reports its own pid through a file
// because start() cannot.
function startStub() {
  const id = `${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  const log = path.join(os.tmpdir(), `acc-stub-${id}.log`);
  const pidFile = path.join(os.tmpdir(), `acc-stub-${id}.pid`);
  spawn(
    "cmd.exe",
    ["/c", "start", "/min", "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
     "-File", path.join(REPO, "watcher", "stubconsole.ps1"),
     "-LogFile", log, "-PidFile", pidFile, "-TimeoutSeconds", "90"],
    { detached: true, stdio: "ignore" }
  ).unref();

  // Wait for the console to exist before anything tries to attach to it.
  const end = Date.now() + 20000;
  let pid = 0;
  while (Date.now() < end && !pid) {
    try { pid = Number(fs.readFileSync(pidFile, "utf8").trim()) || 0; } catch {}
    if (!pid) sleep(200);
  }
  if (!pid) throw new Error("stub console never reported a pid");
  sleep(600); // let the ReadLine loop reach its first poll
  return {
    pid,
    log,
    kill: () => { try { process.kill(pid); } catch {} },
  };
}

const sleep = (ms) =>
  execFileSync("powershell", ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`], { windowsHide: true });

function writeWindow(root, sid, consolePid) {
  fs.writeFileSync(
    path.join(root, "runner", "state", `${sid}.window`),
    JSON.stringify({ ok: true, hwnd: 0, consolePid, title: "stub" })
  );
}

function writeRequest(root, sid, req) {
  const name = req.kind === "cd" ? `${sid}.cd.json` : `${sid}.json`;
  fs.writeFileSync(
    path.join(root, "runner", "clear-requests", name),
    JSON.stringify({ sessionId: sid, kind: "clear", ctx: 60000, ...req })
  );
  return path.join(root, "runner", "clear-requests", name);
}

function runOnce(root, extraEnv = {}) {
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "watcher", "clearbot.ps1"), "-Once"],
      { encoding: "utf8", timeout: 90000, windowsHide: true, env: { ...process.env, ...extraEnv } }
    );
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");
  }
}

// What actually reached the console. Retried briefly: the stub polls, so the
// line can land a moment after clearbot returns.
function typed(stub, waitMs = 3000) {
  const end = Date.now() + waitMs;
  let out = "";
  while (Date.now() < end) {
    try { out = fs.readFileSync(stub.log, "utf8"); } catch {}
    if (out.trim()) return out;
    sleep(200);
  }
  return out;
}

test("a validly-bound clear request types /clear", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    writeWindow(root, "s-ok", stub.pid);
    writeRequest(root, "s-ok", { consolePid: stub.pid });
    const out = runOnce(root);
    assert.match(out, /CLEARED/, "clearbot reports the clear");
    assert.match(typed(stub), /\/clear/, "and /clear actually reached the console");
  } finally { stub.kill(); }
});

test("a request whose consolePid does not match the session's window is refused", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    writeWindow(root, "s-bad", stub.pid + 1); // the session recorded a DIFFERENT console
    writeRequest(root, "s-bad", { consolePid: stub.pid });
    const out = runOnce(root);
    assert.match(out, /REFUSE/);
    assert.equal(typed(stub, 1500).trim(), "", "nothing typed into a console it was not bound to");
  } finally { stub.kill(); }
});

test("a request with no window record at all is refused", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    writeRequest(root, "s-nowin", { consolePid: stub.pid });
    const out = runOnce(root);
    assert.match(out, /REFUSE/);
    assert.equal(typed(stub, 1500).trim(), "", "cannot verify means do not type");
  } finally { stub.kill(); }
});

test("an off-table cd destination is refused and never typed", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    writeWindow(root, "s-cd", stub.pid);
    writeRequest(root, "s-cd", { kind: "cd", consolePid: stub.pid, path: "C:\\Windows\\System32", replay: "hi" });
    const out = runOnce(root);
    assert.match(out, /REFUSE cd/);
    assert.equal(typed(stub, 1500).trim(), "", "an off-table path is never typed");
  } finally { stub.kill(); }
});

// guards OI-003: the non-clear /cd settle used to be a hardcoded 1200ms that
// failed a real-token repro; it now reads policy.json's tui.readySettleMs
// (watcher/clearbot.ps1 Get-TuiReadyMs), the same dial hooks/goal.mjs's kick
// delay falls back to. Get-AllowedPaths needs a real ROUTING.md match to let
// a cd through at all, so this is the one test in the file that also needs
// the ACC_ROUTING_MD override (mirrors hooks/route.mjs's own override) -
// $Root's real parent has no repo tree in a sandbox, so without it every /cd
// here would be refused as off-table regardless of path.
function cdSettleRun(readySettleMs) {
  const root = sandbox();
  const stub = startStub();
  const dest = root; // exists on disk (mkdtemp'd), and is its own ROUTING.md entry below
  const routingPath = path.join(root, "ROUTING.md");
  fs.writeFileSync(routingPath, "```json\n" + JSON.stringify({ routes: [{ path: dest, label: "sandbox" }] }) + "\n```\n");
  const pol = JSON.parse(fs.readFileSync(path.join(root, "policy.json"), "utf8"));
  pol.tui = { readySettleMs };
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify(pol));
  try {
    writeWindow(root, "s-cdsettle", stub.pid);
    writeRequest(root, "s-cdsettle", { kind: "cd", consolePid: stub.pid, path: dest, clear: false, replay: "" });
    const t0 = Date.now();
    const out = runOnce(root, { ACC_ROUTING_MD: routingPath });
    const elapsed = Date.now() - t0;
    assert.match(out, /CD .* -> /, "clearbot reports the cd");
    assert.ok(typed(stub).includes(`/cd ${dest}`), "and /cd actually reached the console");
    return elapsed;
  } finally { stub.kill(); }
}

test("OI-003: the non-clear /cd settle duration comes from policy.json, not a hardcoded constant", () => {
  // A relative comparison, not an absolute floor: PowerShell's own startup
  // overhead alone can exceed either configured value, so the only real
  // proof this is policy-driven (rather than still the old hardcoded
  // 1200ms) is that a much larger configured settle measurably costs more
  // wall-clock time than a much smaller one.
  const fast = cdSettleRun(50);
  const slow = cdSettleRun(2500);
  assert.ok(
    slow - fast > 1500,
    `a 2500ms settle should take noticeably longer than a 50ms one (fast=${fast}ms, slow=${slow}ms)`
  );
});

test("a stale request is discarded, not executed", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    writeWindow(root, "s-stale", stub.pid);
    const f = writeRequest(root, "s-stale", { consolePid: stub.pid });
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(f, old, old);
    const out = runOnce(root);
    assert.match(out, /STALE/);
    assert.equal(typed(stub, 1500).trim(), "", "an old request is discarded, never typed");
  } finally { stub.kill(); }
});

test("sendconsole itself refuses multi-line text", () => {
  const stub = startStub();
  try {
    let code = 0;
    try {
      execFileSync(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(REPO, "watcher", "sendconsole.ps1"),
         "-TargetPid", String(stub.pid), "-Text", "one\ntwo"],
        { encoding: "utf8", windowsHide: true }
      );
    } catch (e) { code = e.status; }
    assert.equal(code, 1, "exits 1");
    assert.equal(typed(stub, 1500).trim(), "", "a newline never becomes a second prompt");
  } finally { stub.kill(); }
});

// A runbox script that fails used to throw straight out of the cycle: under
// $ErrorActionPreference='Stop', `& node ... 2>&1` turns the child's stderr
// into a terminating error, so the FAILED line was never logged and the rest
// of Step was skipped. The stub engine below is a failing script's worth of
// behaviour without dragging the real engine into the sandbox.
function stubEngine(root, { exitCode }) {
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "hooks", "engine.mjs"),
    `const a = process.argv.slice(2);
if (a[0] === "list") {
  console.log(JSON.stringify([{ label: "central", name: "boom.ps1", keep: false, summary: "a script that fails" }]));
  process.exit(0);
}
if (a[0] === "run") {
  process.stderr.write("boom: this script failed\\n");
  process.exit(${exitCode});
}
process.exit(0);
`
  );
  const pol = JSON.parse(fs.readFileSync(path.join(root, "policy.json"), "utf8"));
  pol.autoApprove = { enabled: true };
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify(pol));
}

test("a failing auto-approve script is logged, and the cycle survives it", () => {
  const root = sandbox();
  stubEngine(root, { exitCode: 1 });
  const out = runOnce(root);
  assert.match(out, /AUTO-APPROVE running central:boom\.ps1/, "attempt is logged");
  assert.match(out, /FAILED/, "and so is the failure");
  assert.ok(
    fs.existsSync(path.join(root, "watcher", "clearbot.heartbeat")),
    "the cycle still completed rather than throwing out of Step"
  );
});

test("every cycle writes a heartbeat", () => {
  const root = sandbox();
  runOnce(root);
  const hb = path.join(root, "watcher", "clearbot.heartbeat");
  assert.ok(fs.existsSync(hb), "heartbeat written");
  assert.ok(Date.now() - fs.statSync(hb).mtimeMs < 30_000, "and it is fresh");
});

// --- pty transport (spec 2026-07-31) ---------------------------------------
// A session ACC hosts on a pseudoconsole records transport:"pty" + pipe in its
// window record; clearbot must then write the pipe protocol and type NOTHING.
// A pty record whose pipe is dead must fall back to keystroke injection.

function startPipeStub(name) {
  // Records each protocol line to a file; replies OK. One line per connection,
  // like the real server (gui/PtyHost.cs). A .NET (PowerShell) server on
  // purpose: the real server is .NET, and node's libuv pipes do not interop
  // with the .NET NamedPipeClientStream clearbot uses (connection accepted,
  // data never delivered - observed 2026-07-31).
  const id = `${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  const log = path.join(os.tmpdir(), `acc-pipestub-${id}.log`);
  const pidFile = path.join(os.tmpdir(), `acc-pipestub-${id}.pid`);
  const readyFile = path.join(os.tmpdir(), `acc-pipestub-${id}.ready`);
  // Launched via `cmd /c start` exactly like startStub above - the one spawn
  // shape proven to come up while the test runner's event loop is blocked in
  // the sleep() helper (a directly-spawned powershell never served its pipe).
  spawn(
    "cmd.exe",
    ["/c", "start", "/min", "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
     "-File", path.join(REPO, "watcher", "stubpipe.ps1"),
     "-PipeName", name, "-LogFile", log, "-PidFile", pidFile, "-ReadyFile", readyFile, "-TimeoutSeconds", "120"],
    { detached: true, stdio: "ignore" }
  ).unref();
  // Readiness comes from the server writing its own marker file, not from
  // enumerating \\.\pipe\ - that enumeration raced under load (present on one
  // poll, absent on the next), which made a live, working pipe stub look like
  // it "never came up" (observed 2026-07-31).
  const pipeUp = () => fs.existsSync(readyFile);
  const end = Date.now() + 20000;
  while (Date.now() < end && !pipeUp()) sleep(200);
  if (!pipeUp()) throw new Error("pipe stub never came up");
  return {
    linesNow: () => {
      try { return fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; }
    },
    close: () => {
      try { process.kill(Number(fs.readFileSync(pidFile, "utf8").trim())); } catch {}
      try { fs.unlinkSync(log); } catch {}
      try { fs.unlinkSync(pidFile); } catch {}
      try { fs.unlinkSync(readyFile); } catch {}
    },
  };
}

function writePtyWindow(root, sid, consolePid, pipe) {
  fs.writeFileSync(
    path.join(root, "runner", "state", `${sid}.window`),
    JSON.stringify({ ok: true, hwnd: 0, consolePid, transport: "pty", pipe, title: "acc-pty" })
  );
}

test("pty transport: a clear request goes to the pipe, zero keystrokes", () => {
  const root = sandbox();
  const stub = startStub(); // a real console that must stay SILENT
  const pipeName = `acc-term-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const pipe = startPipeStub(pipeName);
  try {
    writePtyWindow(root, "s-pty", stub.pid, pipeName);
    writeRequest(root, "s-pty", { consolePid: stub.pid });
    const out = runOnce(root);
    assert.match(out, /CLEARED/, "clearbot reports the clear");
    assert.deepEqual(pipe.linesNow(), ["ESC", "TEXT /clear", "SUBMIT"], "the pipe got the exact protocol");
    assert.equal(typed(stub, 1500).trim(), "", "pty transport must not inject keystrokes");
  } finally { pipe.close(); stub.kill(); }
});

test("pty transport: a dead pipe falls back to keystroke injection", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    // The record claims pty but nothing serves the pipe -> the clear must
    // still land through sendconsole.
    writePtyWindow(root, "s-ptydead", stub.pid, `acc-term-dead-${process.pid}`);
    writeRequest(root, "s-ptydead", { consolePid: stub.pid });
    const out = runOnce(root);
    assert.match(out, /CLEARED/, "the clear still happens");
    assert.match(typed(stub), /\/clear/, "via keystroke injection");
  } finally { stub.kill(); }
});

// --- OI-009: a hosted GUI dying is detected without needing any request ----
// The hosted session's own claude.exe lives inside the GUI's ConPTY, so a GUI
// crash kills the session too - there is no Stop hook left to notice. clearbot
// watches every pty window record on its own cycle, independent of requests.

test("OI-009: a pty window whose hosting process dies is flagged after having been seen alive", () => {
  const root = sandbox();
  const stub = startStub(); // stands in for the GUI's own consolePid
  try {
    writePtyWindow(root, "s-guidead", stub.pid, "acc-term-unused");
    runOnce(root); // cycle 1: process is alive, records the alive marker
    assert.ok(
      fs.existsSync(path.join(root, "runner", "state", "s-guidead.pty-alive")),
      "alive marker written while the hosting process is still up"
    );

    stub.kill();
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      try { process.kill(stub.pid, 0); } catch { break; } // ESRCH once it's actually gone
      sleep(200);
    }

    runOnce(root); // cycle 2: was alive, now isn't -> alert
    const alertPath = path.join(root, "runner", "state", "s-guidead.gui-dead.json");
    assert.ok(fs.existsSync(alertPath), "gui-dead alert written once the hosting process is confirmed gone");
    const alert = JSON.parse(fs.readFileSync(alertPath, "utf8"));
    assert.equal(alert.sessionId, "s-guidead");
    assert.equal(alert.consolePid, stub.pid);
  } finally { stub.kill(); }
});

test("OI-009: a pty window never confirmed alive is not falsely flagged as a dead GUI", () => {
  const root = sandbox();
  // A pid essentially guaranteed not to be a running process, and clearbot
  // never got a cycle where it WAS alive - this must read as stale debris
  // (or a race at session start), not a crash to alert on.
  writePtyWindow(root, "s-stale", 999999, "acc-term-unused");
  runOnce(root);
  assert.equal(
    fs.existsSync(path.join(root, "runner", "state", "s-stale.gui-dead.json")),
    false,
    "never having been seen alive must not itself trigger an alert"
  );
});

// OI-034, Task 5: clearbot builds the console table and pipes it to
// goal.mjs pending on stdin - a static-content contract, since exercising it
// live would mean asserting on the caller's own real process table.
test("clearbot pipes a console table into goal.mjs pending", () => {
  const ps = fs.readFileSync(path.join(REPO, "watcher", "clearbot.ps1"), "utf8");
  assert.match(ps, /ToUniversalTime\(\)\.ToString\('o'\)/, "start times must be ISO-8601 UTC");
  assert.match(ps, /\$json \| & node .*goal\.mjs.*'pending'/, "the table must reach goal.mjs on stdin");
});

test("clearbot no longer gates a kick on a bare Get-Process existence check", () => {
  const ps = fs.readFileSync(path.join(REPO, "watcher", "clearbot.ps1"), "utf8");
  const start = ps.indexOf("function Invoke-Kicks");
  const kicks = ps.slice(start, start + 2000);
  assert.doesNotMatch(
    kicks,
    /if \(-not \(Get-Process -Id \$cpid/,
    "existence is not identity - goal.mjs decides, per its own header"
  );
});

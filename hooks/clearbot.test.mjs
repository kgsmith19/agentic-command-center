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

function runOnce(root) {
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "watcher", "clearbot.ps1"), "-Once"],
      { encoding: "utf8", timeout: 90000, windowsHide: true }
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

test("every cycle writes a heartbeat", () => {
  const root = sandbox();
  runOnce(root);
  const hb = path.join(root, "watcher", "clearbot.heartbeat");
  assert.ok(fs.existsSync(hb), "heartbeat written");
  assert.ok(Date.now() - fs.statSync(hb).mtimeMs < 30_000, "and it is fresh");
});

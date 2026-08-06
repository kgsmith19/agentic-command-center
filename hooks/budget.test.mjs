// Tests for the Stop-gate precedence in hooks/budget.mjs (OI-011).
//
// The bug being pinned: onStop early-allowed whenever stop_hook_active was set,
// so after the forced checkpoint turn the latched path (clear request + standing order
// cycle) never ran - auto-clear deadlocked even with no other Stop hook, and a
// /standing order Stop hook that kept blocking pinned the session over the ceiling
// forever. Once the budget latch exists, budget must win on EVERY stop.
//
// The hook process.exit()s on every path, so each case runs it as a child
// process and asserts on stdout plus the files it leaves in a throwaway
// ACC_ROOT tree. Policy comes from a sandbox file via ACC_POLICY so live dial
// edits can never change what these tests mean.
//
// Run: node --test hooks/budget.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ptyAnchorPid } from "./usage.mjs";
// standing.mjs resolves its store from ACC_ROOT/ACC_STANDING_DIR on every call, not
// at import time (see hooks/standing.mjs), specifically so a single shared import
// works across many tests each pointed at their own sandbox -- important here
// beyond just tidiness: when covgate.mjs runs this file in the same node
// process as standing.test.mjs, a second, differently-parameterized import of
// standing.mjs would collide with standing.test.mjs's own coverage instance (node's
// lcov merge is last-write-wins per file path, not a union -- see OI-006).
import * as gm from "../core/standing.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "budget.mjs");

// Every execFileSync("node", [HOOK], ...) below spawns a SEPARATE budget.mjs
// process per test (dozens of them) with an env spread that would otherwise
// carry a live NODE_V8_COVERAGE straight through: --experimental-test-
// coverage auto-sets it on whichever process enables it first, and under
// `node hooks/covgate.mjs` that's the real, shared coverage run this file is
// part of. budget.mjs is not itself a gated file this session, so none of
// these dozens of incidental coverage dumps are wanted — left unfixed, their
// sheer volume in the shared directory measurably degraded an UNRELATED
// gated file's (hooks/lane.mjs) own merged branch coverage (found
// 2026-08-02: lane.mjs measured 91%+ branches in isolation, 87.9% once this
// file's subprocess spawns joined the same run — deterministic, reproduced
// with --test-concurrency=1, so not a race).
delete process.env.NODE_V8_COVERAGE;

// Small dials keep the fixture transcripts tiny; autoClear stays on because the
// clear-request file IS the assertion. Shape mirrors the live policy.json.
const POLICY = {
  context: { softK: 40, hardK: 50 },
  week: { amberTokens: 0, redTokens: 0, effectiveFrom: "" },
  subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: 6, exploreMaxReportLines: 80 },
  review: { fullLeanReview: "manual-only", localFullSuiteInReview: false, maxFinders: 3 },
  runner: { stopOnRed: true, statusFile: "SLICE-RUNNER.md", waitingGuard: true },
  autoClear: { enabled: true },
  standing: { autoResume: true, maxCycles: 0 },
};

// Real Claude Code session ids are UUIDs, and OI-006's bindSession guard now
// rejects anything else as a rebind source, so tests that seed a standing order via
// bindSession (and later look it up by that exact sessionId) need one.
const SID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function sandbox(policyExtra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-budget-"));
  fs.mkdirSync(path.join(root, "runner", "state"), { recursive: true });
  fs.mkdirSync(path.join(root, "cfg"), { recursive: true });
  const policyPath = path.join(root, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({ ...POLICY, ...(policyExtra || {}) }));
  return { root, policyPath };
}

// One assistant turn in transcript shape. contextOf() reads input + cache_read
// + cache_creation of the LAST assistant line.
function turn(ctxTokens, text) {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-31T12:00:00.000Z",
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: ctxTokens,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text }],
    },
  });
}

function writeTranscript(sb, sid, ctxTokens) {
  const f = path.join(sb.root, `${sid}.jsonl`);
  fs.writeFileSync(f, turn(ctxTokens, "checkpoint written, board updated") + "\n");
  return f;
}

// The window record autopilot would type into; without it requestClear refuses.
function seedWindow(sb, sid) {
  fs.writeFileSync(
    path.join(sb.root, "runner", "state", `${sid}.window`),
    JSON.stringify({ ok: true, hwnd: 111, consolePid: 4242, title: "test console" })
  );
}

function runStop(sb, { sid, transcript, active, profile }) {
  return execFileSync("node", [HOOK], {
    input: JSON.stringify({
      hook_event_name: "Stop",
      session_id: sid,
      transcript_path: transcript,
      stop_hook_active: !!active,
      cwd: sb.root,
    }),
    env: {
      ...process.env,
      ACC_ROOT: sb.root,
      ACC_POLICY: sb.policyPath,
      ACC_STANDING_DIR: "",
      ACC_PROFILE: profile || "",
      ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
      CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"),
      CLAUDE_CODE_RUNNER: "",
    },
    encoding: "utf8",
  });
}

const clearReq = (sb, sid) => path.join(sb.root, "runner", "clear-requests", `${sid}.json`);
const statePath = (sb, sid, suffix) => path.join(sb.root, "runner", "state", `${sid}.${suffix}`);

test("over hard, no latch: blocks once to force the checkpoint", () => {
  const sb = sandbox();
  const sid = "s-first";
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000);
  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.match(out, /"decision":"block"/);
  assert.ok(fs.existsSync(statePath(sb, sid, "budget")), "budget latch written");
  assert.ok(!fs.existsSync(clearReq(sb, sid)), "no clear request on the blocking stop");
});

test("latched + stop_hook_active: clear request still fires (the OI-011 deadlock)", () => {
  const sb = sandbox();
  const sid = "s-latched";
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000);
  runStop(sb, { sid, transcript: t, active: false }); // block + latch
  const out = runStop(sb, { sid, transcript: t, active: true });
  assert.match(out, /systemMessage/, "hand-off message reaches the operator");
  assert.ok(fs.existsSync(clearReq(sb, sid)), "clear request written despite stop_hook_active");
});

test("further over-budget stops re-request the clear; the standing order cycle is one-shot", async () => {
  const sb = sandbox();
  const sid = SID(1);
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000);

  // Seed a standing order in the sandbox tree and bind this session to it, the same way
  // SessionStart would. standing.mjs resolves its store from ACC_ROOT on every call.
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_STANDING_DIR = "";
  const g = gm.createStanding({ text: "finish the thing", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, standingId: g.id });

  runStop(sb, { sid, transcript: t, active: false }); // block + latch
  runStop(sb, { sid, transcript: t, active: true }); // latched stop 1
  assert.ok(fs.existsSync(clearReq(sb, sid)), "first latched stop requests the clear");
  fs.unlinkSync(clearReq(sb, sid)); // consumed, but the turn still is not dying
  const out = runStop(sb, { sid, transcript: t, active: true }); // latched stop 2
  assert.match(out, /systemMessage/);
  assert.ok(fs.existsSync(clearReq(sb, sid)), "request re-written for the stuck turn");
  assert.equal(gm.readStanding(g.id).cycles, 1, "cycle logged exactly once across latched stops");
});

test("under hard: stop passes silently", () => {
  const sb = sandbox();
  const sid = "s-under";
  const t = writeTranscript(sb, sid, 10000);
  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.equal(out.trim(), "");
});

// Single source of truth (2026-07-31): the Process-tab dials are the budget for
// every session. A profile may scope subagents but must not shadow the dials.
test("profile without a context block: the base dials still govern", () => {
  const sb = sandbox({
    profiles: { Normal: { subagents: { allow: ["Explore"], maxPerSession: 6 } } },
  });
  const sid = "s-prof-nocontext";
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000); // over base hardK 50
  const out = runStop(sb, { sid, transcript: t, active: false, profile: "Normal" });
  assert.match(out, /"decision":"block"/, "base hardK enforced despite ACC_PROFILE");
});

test("profile context (when present) still overrides for that session", () => {
  const sb = sandbox({
    profiles: { Big: { context: { softK: 70, hardK: 80 } } },
  });
  const sid = "s-prof-context";
  const t = writeTranscript(sb, sid, 60000); // over base 50, under profile 80
  const out = runStop(sb, { sid, transcript: t, active: false, profile: "Big" });
  assert.equal(out.trim(), "", "profile hardK 80 applied, 60k passes");
});

// --- liveness: an under-budget turn end must re-arm the kick ---------------
// The 2026-07-31 stall, pinned. A standing order session that simply finishes its turn
// well under the ceiling used to get nothing: no clear, no resume, dead air
// until a human typed. The Stop hook must report that turn end to the standing order
// store - silently, without changing its own output.

// The classifier reads the LAST USER message, so these transcripts need one.
function writeTranscriptWithUser(sb, sid, ctxTokens, userText) {
  const f = path.join(sb.root, `${sid}.jsonl`);
  const user = JSON.stringify({
    type: "user",
    timestamp: "2026-07-31T12:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: userText }] },
  });
  fs.writeFileSync(f, user + "\n" + turn(ctxTokens, "did the work") + "\n");
  return f;
}

// Seed a standing order in the sandbox and bind this session to it, as SessionStart does.
function seedStanding(sb, sid) {
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_STANDING_DIR = "";
  const g = gm.createStanding({ text: "keep going", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, standingId: g.id });
  gm.markKicked(g.id); // a kick already fired; needsKick is false
  return { gm, g };
}

test("under budget with an active standing order: the turn end re-arms the kick", async () => {
  const sb = sandbox();
  const sid = SID(2);
  const { gm, g } = await seedStanding(sb, sid);
  const t = writeTranscriptWithUser(sb, sid, 10000, "Continue the active ACC standing order.");

  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.equal(out.trim(), "", "still silent - liveness must not add output");

  const after = gm.readStanding(g.id);
  assert.equal(after.needsKick, true, "kick re-armed");
  assert.ok(after.turnEndedAt, "turn end stamped");
  assert.ok(!after.humanPromptAt, "the kick constant is a MACHINE turn");
});

test("a human-prompted turn end is classified as human", async () => {
  const sb = sandbox();
  const sid = SID(3);
  const { gm, g } = await seedStanding(sb, sid);
  const t = writeTranscriptWithUser(sb, sid, 10000, "actually, do this other thing first");

  runStop(sb, { sid, transcript: t, active: false });
  assert.ok(gm.readStanding(g.id).humanPromptAt, "human prompt stamped -> the kick backs off");
});

// --- self-healing watcher --------------------------------------------------
// A dead autopilot means no clear and no resume, and a standing order session cannot
// notice on its own. The Stop hook is the right place to check: it IS the turn
// boundary where a clear or a kick is about to be needed. The sandbox gets a
// FAKE start-autopilot.cmd, so these prove the decision without starting a real
// watcher.
function fakeStarter(sb) {
  const dir = path.join(sb.root, "watcher");
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, "STARTED");
  fs.writeFileSync(path.join(dir, "start-autopilot.cmd"), `@echo off\r\necho started > "${marker}"\r\n`);
  return marker;
}

function heartbeat(sb, ageMs) {
  const dir = path.join(sb.root, "watcher");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "autopilot.heartbeat");
  fs.writeFileSync(f, "alive");
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(f, when, when);
}

// A portable synchronous sleep — no shell-out, works identically on every OS.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ensureAutopilot spawns detached, so the marker lands a moment later — and a
// killed process disappears a moment later for the same reason. One poll.
function waitUntil(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    sleepMs(200);
  }
  return false;
}

const appears = (file, ms = 6000) => waitUntil(() => fs.existsSync(file), ms);

// ensureAutopilot() spawns cmd.exe directly (hooks/budget.mjs:80) — genuinely
// Windows-only functionality, not a portability gap. Same pattern already used
// by hooks/testplan.test.mjs for its POSIX-only chmod fault-injection case.
test("a stale heartbeat at a turn boundary revives the watcher", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const sid = "s-revive";
  const marker = fakeStarter(sb);
  heartbeat(sb, 120000);
  runStop(sb, { sid, transcript: writeTranscript(sb, sid, 10000), active: false });
  assert.ok(appears(marker), "start-autopilot was invoked");
});

test("a fresh heartbeat leaves the watcher alone", () => {
  const sb = sandbox();
  const sid = "s-norevive";
  const marker = fakeStarter(sb);
  heartbeat(sb, 2000);
  runStop(sb, { sid, transcript: writeTranscript(sb, sid, 10000), active: false });
  assert.equal(appears(marker, 2500), false, "a live watcher is not restarted");
});

// guards OI-050. The revive treats a stale heartbeat as dead, but
// start-autopilot.cmd treats "a matching process exists" as alive, so a HUNG
// watcher is invisible to the only check that gates the restart and the revive
// becomes a permanent no-op. Found live: a watcher running with a heartbeat
// frozen eleven hours earlier, re-declining the restart at every turn boundary.
// The stub sleeps and never writes a heartbeat, which is exactly what a wedged
// watcher looks like from the outside.
function wedgedWatcher(sb) {
  const dir = path.join(sb.root, "watcher");
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "autopilot.ps1");
  // Deliberately NOT `detached: true`: PowerShell launched with DETACHED_PROCESS
  // gets no console and exits 0 immediately, so a detached stub would be gone
  // before the assertion ran and every case below would pass for the wrong
  // reason (confirmed by measuring it, after the first draft did exactly that).
  fs.writeFileSync(script, `Start-Sleep -Seconds 300${os.EOL}`);
  const child = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { stdio: "ignore", windowsHide: true },
  );
  child.unref();
  return child.pid;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const gone = (pid, ms = 8000) => waitUntil(() => !alive(pid), ms);

test("a WEDGED watcher is cleared out, not mistaken for a live one", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const marker = fakeStarter(sb);
  const pid = wedgedWatcher(sb);
  try {
    assert.ok(alive(pid), "the stub watcher must really be running before the hook fires");
    heartbeat(sb, 120000); // running, but its heartbeat froze two minutes ago
    runStop(sb, { sid: "s-wedged", transcript: writeTranscript(sb, "s-wedged", 10000), active: false });
    assert.ok(gone(pid), "the hung watcher must be killed, or the restart below can never take");
    assert.ok(appears(marker), "and a fresh watcher started in its place");
    // The kill is what feeds the escalation; without this the two halves of
    // OI-050 are only tested against each other's assumptions.
    const log = path.join(sb.root, "watcher", "autopilot-wedges.jsonl");
    assert.ok(fs.existsSync(log), "a real wedge is recorded, not just silently repaired");
    const entries = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].pids, [pid], "and records which process was replaced");
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test("a HEALTHY watcher is never killed by the wedge check", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const marker = fakeStarter(sb);
  const pid = wedgedWatcher(sb); // same stub, but this time the heartbeat is fresh
  try {
    heartbeat(sb, 2000);
    runStop(sb, { sid: "s-healthy", transcript: writeTranscript(sb, "s-healthy", 10000), active: false });
    assert.equal(appears(marker, 2500), false, "a live watcher is not restarted");
    assert.ok(alive(pid), "and a live watcher is certainly not killed");
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test("the kill switch suppresses the wedge KILL, not just the restart", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const marker = fakeStarter(sb);
  const pid = wedgedWatcher(sb);
  try {
    fs.writeFileSync(path.join(sb.root, "watcher", "autopilot.stop"), "stopped on purpose");
    heartbeat(sb, 120000); // stale, so the wedge path would otherwise fire
    runStop(sb, { sid: "s-wedge-off", transcript: writeTranscript(sb, "s-wedge-off", 10000), active: false });
    assert.ok(alive(pid), "an engaged kill switch means do nothing at all, including do not kill");
    assert.equal(appears(marker, 2500), false, "and certainly do not restart");
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test("a deliberate stop is never overridden by the revive", () => {
  const sb = sandbox();
  const sid = "s-killswitch";
  const marker = fakeStarter(sb);
  fs.writeFileSync(path.join(sb.root, "watcher", "autopilot.stop"), "stopped on purpose");
  // no heartbeat at all = looks dead, but Kyle turned it off deliberately
  runStop(sb, { sid, transcript: writeTranscript(sb, sid, 10000), active: false });
  assert.equal(appears(marker, 2500), false, "the kill switch wins");
});

test("no standing order: an under-budget stop still does nothing at all", () => {
  const sb = sandbox();
  const sid = "s-live-nostanding";
  const t = writeTranscriptWithUser(sb, sid, 10000, "hello");
  assert.equal(runStop(sb, { sid, transcript: t, active: false }).trim(), "");
});

// --- pty window record (spec 2026-07-31): an ACC-hosted session has no HWND to
// find - the GUI is the terminal. It sets ACC_PTY=<pipe name>; the record must
// carry transport:"pty" + that pipe, and consolePid must be the hook's PARENT
// (the claude process, which survives /clear; here, this test process).
test("SessionStart with ACC_PTY records a pty window bound to the parent pid", () => {
  const sb = sandbox({ autoClear: { enabled: false } });
  const sid = "sid-pty";
  execFileSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: sb.root }),
    env: {
      ...process.env,
      ACC_ROOT: sb.root,
      ACC_POLICY: sb.policyPath,
      ACC_STANDING_DIR: "",
      ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
      CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"),
      CLAUDE_CODE_RUNNER: "",
      ACC_PTY: "acc-term-cafe12",
    },
    encoding: "utf8",
  });
  const win = JSON.parse(fs.readFileSync(statePath(sb, sid, "window"), "utf8"));
  assert.equal(win.transport, "pty");
  assert.equal(win.pipe, "acc-term-cafe12");
  assert.equal(win.consolePid, process.pid,
    "consolePid must be the hook's PARENT (the claude process; here, the test runner)");
});

// guards OI-031, wiring proof. reapDeadStanding() living in standing.mjs is worth
// nothing unless something actually calls it, and it has to run BEFORE
// adoption: bindSession falls back to "whatever active standing order owns this console
// pid", so a stale standing order whose pid was recycled is exactly what a fresh session
// picks up. Six such standing orders were live on 2026-08-04, the oldest from 07-31.
test("SessionStart reaps a stale standing order instead of adopting it (OI-031)", () => {
  const sb = sandbox({ autoClear: { enabled: false } });
  const sid = "sid-reap";

  process.env.ACC_ROOT = sb.root;
  process.env.ACC_STANDING_DIR = "";
  const stale = gm.createStanding({ text: "LAST WEEK'S WORK - must not be injected", cwd: sb.root });
  // Bound to a console that is long gone, then its pid recycled onto THIS
  // process - the exact collision that makes a fresh session adopt old work.
  // Must be a real UUID: OI-006's guard treats a non-UUID sessionId as inert, so
  // boundAt would stay empty, the standing order would count as never-bound, and the grace
  // window would (correctly) protect it - proving nothing about reaping.
  gm.bindSession({ sessionId: SID(70), consolePid: process.pid, standingId: stale.id });
  fs.writeFileSync(
    path.join(sb.root, "runner", "standing", `${stale.id}.json`),
    JSON.stringify({ ...gm.readStanding(stale.id), consolePid: 999999 })
  );

  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: sb.root }),
    env: {
      ...process.env,
      ACC_ROOT: sb.root,
      ACC_POLICY: sb.policyPath,
      ACC_STANDING_DIR: "",
      ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
      CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"),
      CLAUDE_CODE_RUNNER: "",
    },
    encoding: "utf8",
  });

  assert.equal(gm.readStanding(stale.id), null, "the stale standing order was reaped, not left active");
  assert.ok(!out.includes("LAST WEEK'S WORK"), "and its text was never injected into the new session");
});

// The anchor rule behind that record: the hook's immediate parent on a live
// launch is a transient shell (node -> bash -> bash -> claude.exe) that dies
// with the turn - recording it handed autopilot a dead pid (observed live:
// consolePid 80480 GONE while claude.exe 70152 hosted the session). The
// persistent process is the first NON-SHELL ancestor. Lives in usage.mjs
// because budget.mjs runs main() on import and cannot be imported by tests.
test("ptyAnchorPid skips transient shell ancestors and lands on claude", () => {
  const chain = [
    { pid: 111, name: "bash.exe" },
    { pid: 222, name: "bash.exe" },
    { pid: 333, name: "claude.exe" },
    { pid: 444, name: "cmd.exe" },
  ];
  assert.equal(ptyAnchorPid(chain), 333);
});

test("ptyAnchorPid anchors at the immediate parent when it is not a shell", () => {
  // The test-runner case: the hook's parent is node.exe (alive, persistent).
  const chain = [
    { pid: 555, name: "node.exe" },
    { pid: 666, name: "powershell.exe" },
    { pid: 777, name: "claude.exe" },
  ];
  assert.equal(ptyAnchorPid(chain), 555);
});

test("ptyAnchorPid falls back to the first ancestor when all are shells", () => {
  assert.equal(ptyAnchorPid([{ pid: 888, name: "cmd.exe" }]), 888);
});

// guards OI-050, second half. Killing a wedged watcher and restarting it is
// silent by construction: a watcher that hangs every few minutes gets replaced
// every few minutes and nothing ever says so. The eleven-hour outage that
// surfaced OI-050 had no alert attached to it at any point, and "the statusline
// shows it" only helps someone sitting there watching the statusline.
function runSessionStart(sb, sid) {
  return execFileSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: sb.root }),
    env: {
      ...process.env,
      ACC_ROOT: sb.root,
      ACC_POLICY: sb.policyPath,
      ACC_STANDING_DIR: "",
      ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
      CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"),
      CLAUDE_CODE_RUNNER: "",
    },
    encoding: "utf8",
  });
}

function seedWedges(sb, ageMsList) {
  const dir = path.join(sb.root, "watcher");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "autopilot-wedges.jsonl"),
    ageMsList.map((age) => JSON.stringify({ ts: Date.now() - age, pids: [1234] })).join("\n") + "\n",
  );
}

test("one wedge is just a restart: the ordinary dead-watcher warning", () => {
  const sb = sandbox();
  heartbeat(sb, 120000);
  seedWedges(sb, [60_000]);
  const out = runSessionStart(sb, "s-wedge-once");
  assert.match(out, /looks DEAD/, "still warns that it is down");
  assert.doesNotMatch(out, /wedged/i, "but a single restart is not an escalation");
});

test("a REPEATEDLY wedging watcher escalates, instead of being restarted in silence", () => {
  const sb = sandbox();
  heartbeat(sb, 120000);
  seedWedges(sb, [60_000, 120_000, 200_000]);
  const out = runSessionStart(sb, "s-wedge-many");
  assert.match(out, /wedged 3 times/i, "the count Kyle needs in order to act reaches him");
  assert.match(out, /restart/i, "and says restarting it is not fixing it");
});

test("wedges that have aged out of the window do not escalate forever", () => {
  const sb = sandbox();
  heartbeat(sb, 120000);
  seedWedges(sb, [3 * 3600_000, 4 * 3600_000, 5 * 3600_000]);
  const out = runSessionStart(sb, "s-wedge-old");
  assert.doesNotMatch(out, /wedged/i, "an escalation that never clears is one nobody reads");
});

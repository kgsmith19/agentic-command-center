// Tests for the Stop-gate precedence in hooks/budget.mjs (OI-011).
//
// The bug being pinned: onStop early-allowed whenever stop_hook_active was set,
// so after the forced checkpoint turn the latched path (clear request + goal
// cycle) never ran - auto-clear deadlocked even with no other Stop hook, and a
// /goal Stop hook that kept blocking pinned the session over the ceiling
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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ptyAnchorPid } from "./usage.mjs";
// goal.mjs resolves its store from ACC_ROOT/ACC_GOALS_DIR on every call, not
// at import time (see hooks/goal.mjs), specifically so a single shared import
// works across many tests each pointed at their own sandbox -- important here
// beyond just tidiness: when covgate.mjs runs this file in the same node
// process as goal.test.mjs, a second, differently-parameterized import of
// goal.mjs would collide with goal.test.mjs's own coverage instance (node's
// lcov merge is last-write-wins per file path, not a union -- see OI-006).
import * as gm from "./goal.mjs";

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
  goals: { autoResume: true, maxCycles: 0 },
};

// Real Claude Code session ids are UUIDs, and OI-006's bindSession guard now
// rejects anything else as a rebind source, so tests that seed a goal via
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

// The window record clearbot would type into; without it requestClear refuses.
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
      ACC_GOALS_DIR: "",
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

test("further over-budget stops re-request the clear; the goal cycle is one-shot", async () => {
  const sb = sandbox();
  const sid = SID(1);
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000);

  // Seed a goal in the sandbox tree and bind this session to it, the same way
  // SessionStart would. goal.mjs resolves its store from ACC_ROOT on every call.
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_GOALS_DIR = "";
  const g = gm.createGoal({ text: "finish the thing", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, goalId: g.id });

  runStop(sb, { sid, transcript: t, active: false }); // block + latch
  runStop(sb, { sid, transcript: t, active: true }); // latched stop 1
  assert.ok(fs.existsSync(clearReq(sb, sid)), "first latched stop requests the clear");
  fs.unlinkSync(clearReq(sb, sid)); // consumed, but the turn still is not dying
  const out = runStop(sb, { sid, transcript: t, active: true }); // latched stop 2
  assert.match(out, /systemMessage/);
  assert.ok(fs.existsSync(clearReq(sb, sid)), "request re-written for the stuck turn");
  assert.equal(gm.readGoal(g.id).cycles, 1, "cycle logged exactly once across latched stops");
});

test("Phase 1: the checkpoint stop accumulates the transcript's REAL cost onto the goal, not an estimate", async () => {
  const sb = sandbox();
  const sid = SID(90);
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000); // turn() writes input:60000, output:10, model claude-opus-5

  process.env.ACC_ROOT = sb.root;
  process.env.ACC_GOALS_DIR = "";
  const g = gm.createGoal({ text: "cost tracked", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, goalId: g.id });

  runStop(sb, { sid, transcript: t, active: false }); // block + latch
  runStop(sb, { sid, transcript: t, active: true }); // latched stop: appendCycle fires here

  // DEFAULT_POLICY.rates.opus = {in:15, out:75} (this sandbox's policy fixture
  // carries no rates block, so usage.mjs's defaults apply): (60000*15 +
  // 10*75) / 1e6 = 0.90075.
  assert.ok(
    Math.abs(gm.readGoal(g.id).totalCostUsd - 0.90075) < 1e-9,
    `expected ~0.90075, got ${gm.readGoal(g.id).totalCostUsd}`
  );
});

test("Phase 1: SessionStart warns instead of saying nothing when the adopted goal is paused at a ceiling", () => {
  const sb = sandbox();
  const sid = SID(91);
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_GOALS_DIR = "";
  const g = gm.createGoal({ text: "will hit a ceiling", cwd: sb.root });
  gm.bindSession({ sessionId: SID(92), consolePid: process.pid, goalId: g.id }); // any prior console
  gm.setStatus(g.id, "paused", "CEILING REACHED: cycles (5/5 cycles)");

  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: sb.root }),
    env: {
      ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath, ACC_GOALS_DIR: "",
      ACC_GOAL: g.id, ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
      CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"), CLAUDE_CODE_RUNNER: "1",
    },
    encoding: "utf8",
  });
  assert.match(out, new RegExp(`PAUSED at a ceiling`));
  assert.match(out, /CEILING REACHED: cycles/);
  assert.match(out, new RegExp(`resume ${g.id}`));
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
// The 2026-07-31 stall, pinned. A goal session that simply finishes its turn
// well under the ceiling used to get nothing: no clear, no resume, dead air
// until a human typed. The Stop hook must report that turn end to the goal
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

// Seed a goal in the sandbox and bind this session to it, as SessionStart does.
function seedGoal(sb, sid) {
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_GOALS_DIR = "";
  const g = gm.createGoal({ text: "keep going", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, goalId: g.id });
  gm.markKicked(g.id); // a kick already fired; needsKick is false
  return { gm, g };
}

test("under budget with an active goal: the turn end re-arms the kick", async () => {
  const sb = sandbox();
  const sid = SID(2);
  const { gm, g } = await seedGoal(sb, sid);
  const t = writeTranscriptWithUser(sb, sid, 10000, "Continue the active ACC goal.");

  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.equal(out.trim(), "", "still silent - liveness must not add output");

  const after = gm.readGoal(g.id);
  assert.equal(after.needsKick, true, "kick re-armed");
  assert.ok(after.turnEndedAt, "turn end stamped");
  assert.ok(!after.humanPromptAt, "the kick constant is a MACHINE turn");
});

test("a human-prompted turn end is classified as human", async () => {
  const sb = sandbox();
  const sid = SID(3);
  const { gm, g } = await seedGoal(sb, sid);
  const t = writeTranscriptWithUser(sb, sid, 10000, "actually, do this other thing first");

  runStop(sb, { sid, transcript: t, active: false });
  assert.ok(gm.readGoal(g.id).humanPromptAt, "human prompt stamped -> the kick backs off");
});

// --- self-healing watcher --------------------------------------------------
// A dead clearbot means no clear and no resume, and a goal session cannot
// notice on its own. The Stop hook is the right place to check: it IS the turn
// boundary where a clear or a kick is about to be needed. The sandbox gets a
// FAKE start-clearbot.cmd, so these prove the decision without starting a real
// watcher.
function fakeStarter(sb) {
  const dir = path.join(sb.root, "watcher");
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, "STARTED");
  fs.writeFileSync(path.join(dir, "start-clearbot.cmd"), `@echo off\r\necho started > "${marker}"\r\n`);
  return marker;
}

function heartbeat(sb, ageMs) {
  const dir = path.join(sb.root, "watcher");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "clearbot.heartbeat");
  fs.writeFileSync(f, "alive");
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(f, when, when);
}

// A portable synchronous sleep — no shell-out, works identically on every OS.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ensureClearbot spawns detached, so the marker lands a moment later.
function appears(file, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true;
    sleepMs(200);
  }
  return false;
}

// ensureClearbot() spawns cmd.exe directly (hooks/budget.mjs:80) — genuinely
// Windows-only functionality, not a portability gap. Same pattern already used
// by hooks/testplan.test.mjs for its POSIX-only chmod fault-injection case.
test("a stale heartbeat at a turn boundary revives the watcher", { skip: process.platform !== "win32" }, () => {
  const sb = sandbox();
  const sid = "s-revive";
  const marker = fakeStarter(sb);
  heartbeat(sb, 120000);
  runStop(sb, { sid, transcript: writeTranscript(sb, sid, 10000), active: false });
  assert.ok(appears(marker), "start-clearbot was invoked");
});

test("a fresh heartbeat leaves the watcher alone", () => {
  const sb = sandbox();
  const sid = "s-norevive";
  const marker = fakeStarter(sb);
  heartbeat(sb, 2000);
  runStop(sb, { sid, transcript: writeTranscript(sb, sid, 10000), active: false });
  assert.equal(appears(marker, 2500), false, "a live watcher is not restarted");
});

test("a deliberate stop is never overridden by the revive", () => {
  const sb = sandbox();
  const sid = "s-killswitch";
  const marker = fakeStarter(sb);
  fs.writeFileSync(path.join(sb.root, "watcher", "clearbot.stop"), "stopped on purpose");
  // no heartbeat at all = looks dead, but Kyle turned it off deliberately
  runStop(sb, { sid, transcript: writeTranscript(sb, sid, 10000), active: false });
  assert.equal(appears(marker, 2500), false, "the kill switch wins");
});

test("no goal: an under-budget stop still does nothing at all", () => {
  const sb = sandbox();
  const sid = "s-live-nogoal";
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
      ACC_GOALS_DIR: "",
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

// The anchor rule behind that record: the hook's immediate parent on a live
// launch is a transient shell (node -> bash -> bash -> claude.exe) that dies
// with the turn - recording it handed clearbot a dead pid (observed live:
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

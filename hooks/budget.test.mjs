// Tests for the Stop-gate precedence in hooks/budget.mjs (OI-011).
//
// The bug being pinned: onStop early-allowed whenever stop_hook_active was set,
// so after the forced checkpoint turn the latched path (clear request + mission
// cycle) never ran - auto-clear deadlocked even with no other Stop hook, and a
// /mission Stop hook that kept blocking pinned the session over the ceiling
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
// mission.mjs resolves its store from ACC_ROOT/ACC_MISSIONS_DIR on every call, not
// at import time (see hooks/mission.mjs), specifically so a single shared import
// works across many tests each pointed at their own sandbox -- important here
// beyond just tidiness: when covgate.mjs runs this file in the same node
// process as mission.test.mjs, a second, differently-parameterized import of
// mission.mjs would collide with mission.test.mjs's own coverage instance (node's
// lcov merge is last-write-wins per file path, not a union -- see OI-006).
import * as gm from "./mission.mjs";

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

// Phase 3 (full-remediation-prompt.md): every hook-dispatch test in this file
// models an ACC-launched session (that's what onSessionStart/onStop are FOR),
// so it must carry an ACC-active signal or accActive()'s new gate would
// early-allow before any of the behavior under test ever runs. runStop()'s
// env spreads ...process.env, so this one line covers every call site here.
// The dedicated "inactive" tests below explicitly override/clear this.
process.env.ACC_SESSION = "1";

// Small dials keep the fixture transcripts tiny; autoClear stays on because the
// clear-request file IS the assertion. Shape mirrors the live policy.json.
const POLICY = {
  context: { softK: 40, hardK: 50 },
  week: { amberTokens: 0, redTokens: 0, effectiveFrom: "" },
  subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: 6, exploreMaxReportLines: 80 },
  review: { fullLeanReview: "manual-only", localFullSuiteInReview: false, maxFinders: 3 },
  runner: { stopOnRed: true, statusFile: "SLICE-RUNNER.md", waitingGuard: true },
  autoClear: { enabled: true },
  missions: { autoResume: true, maxCycles: 0 },
};

// Real Claude Code session ids are UUIDs, and OI-006's bindSession guard now
// rejects anything else as a rebind source, so tests that seed a mission via
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
      ACC_MISSIONS_DIR: "",
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

test("further over-budget stops re-request the clear; the mission cycle is one-shot", async () => {
  const sb = sandbox();
  const sid = SID(1);
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000);

  // Seed a mission in the sandbox tree and bind this session to it, the same way
  // SessionStart would. mission.mjs resolves its store from ACC_ROOT on every call.
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_MISSIONS_DIR = "";
  const g = gm.createMission({ text: "finish the thing", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, missionId: g.id });

  runStop(sb, { sid, transcript: t, active: false }); // block + latch
  runStop(sb, { sid, transcript: t, active: true }); // latched stop 1
  assert.ok(fs.existsSync(clearReq(sb, sid)), "first latched stop requests the clear");
  fs.unlinkSync(clearReq(sb, sid)); // consumed, but the turn still is not dying
  const out = runStop(sb, { sid, transcript: t, active: true }); // latched stop 2
  assert.match(out, /systemMessage/);
  assert.ok(fs.existsSync(clearReq(sb, sid)), "request re-written for the stuck turn");
  assert.equal(gm.readMission(g.id).cycles, 1, "cycle logged exactly once across latched stops");
});

test("Phase 1: the checkpoint stop accumulates the transcript's REAL cost onto the mission, not an estimate", async () => {
  const sb = sandbox();
  const sid = SID(90);
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000); // turn() writes input:60000, output:10, model claude-opus-5

  process.env.ACC_ROOT = sb.root;
  process.env.ACC_MISSIONS_DIR = "";
  const g = gm.createMission({ text: "cost tracked", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, missionId: g.id });

  runStop(sb, { sid, transcript: t, active: false }); // block + latch
  runStop(sb, { sid, transcript: t, active: true }); // latched stop: appendCycle fires here

  // DEFAULT_POLICY.rates.opus = {in:15, out:75} (this sandbox's policy fixture
  // carries no rates block, so usage.mjs's defaults apply): (60000*15 +
  // 10*75) / 1e6 = 0.90075.
  assert.ok(
    Math.abs(gm.readMission(g.id).totalCostUsd - 0.90075) < 1e-9,
    `expected ~0.90075, got ${gm.readMission(g.id).totalCostUsd}`
  );
});

test("Full-repo review (2026-08-06) regression: a genuine appendCycle failure (real lock timeout) is traced to budget-errors.log, not fully swallowed", () => {
  // Corroborated MEDIUM finding: the checkpoint Stop handler wraps
  // missionForSession/costOfTranscript/appendCycle in a bare `catch {}`.
  // costOfTranscript never throws (documented), but appendCycle genuinely
  // can -- its withMissionLock throws when it can't acquire the mission's
  // lock within its timeout, real contention under real concurrent load.
  // The bare catch swallowed that completely: the mission's cycle/cost
  // ceiling silently went uncounted for the turn while the checkpoint/
  // clear immediately below fired as if nothing had gone wrong. Forces
  // the REAL throw path (not a mock) by pre-holding the mission's own
  // lock file, the same primitive OI-038 exercises, with a short timeout
  // so the test doesn't wait out the real 3s default.
  const sb = sandbox();
  const sid = SID(93);
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000);

  process.env.ACC_ROOT = sb.root;
  process.env.ACC_MISSIONS_DIR = "";
  const g = gm.createMission({ text: "will fail to account", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, missionId: g.id });

  const lockPath = path.join(sb.root, "runner", "missions", `${g.id}.json.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "held by another process");
  process.env.ACC_MISSION_LOCK_TIMEOUT_MS = "50";
  process.env.ACC_MISSION_LOCK_STALE_MS = "5000"; // comfortably longer than the timeout above
  try {
    runStop(sb, { sid, transcript: t, active: false }); // block + latch
    runStop(sb, { sid, transcript: t, active: true }); // latched stop: appendCycle genuinely throws here
  } finally {
    delete process.env.ACC_MISSION_LOCK_TIMEOUT_MS;
    delete process.env.ACC_MISSION_LOCK_STALE_MS;
    fs.rmSync(lockPath, { force: true });
  }

  assert.equal(gm.readMission(g.id).cycles, 0, "sanity: the cycle genuinely did not get counted");
  const errLog = path.join(sb.root, "runner", "logs", "budget-errors.log");
  assert.ok(fs.existsSync(errLog), "a swallowed cycle-accounting failure must be traced somewhere, not fully silent");
  const text = fs.readFileSync(errLog, "utf8");
  assert.match(text, new RegExp(g.id), "the trace must name which mission's accounting failed");
});

test("Phase 1: SessionStart warns instead of saying nothing when the adopted mission is paused at a ceiling", () => {
  const sb = sandbox();
  const sid = SID(91);
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_MISSIONS_DIR = "";
  const g = gm.createMission({ text: "will hit a ceiling", cwd: sb.root });
  gm.bindSession({ sessionId: SID(92), consolePid: process.pid, missionId: g.id }); // any prior console
  gm.setStatus(g.id, "paused", "CEILING REACHED: cycles (5/5 cycles)");

  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: sb.root }),
    env: {
      ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath, ACC_MISSIONS_DIR: "",
      ACC_MISSION: g.id, ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
      CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"), CLAUDE_CODE_RUNNER: "1",
    },
    encoding: "utf8",
  });
  assert.match(out, new RegExp(`PAUSED at a ceiling`));
  assert.match(out, /CEILING REACHED: cycles/);
  assert.match(out, new RegExp(`resume ${g.id}`));
});

// OI-034: unlike the paused-at-ceiling warning above (scoped to a specific
// mission via ACC_MISSION/consolePid), a dead-mission alert isn't scoped to THIS
// session at all -- its own console is gone, so any next SessionStart is
// the one that shows it, once, then it's gone (consumed, not merely read).
test("OI-034: SessionStart surfaces a reboot-orphaned mission's alert once, then clears it", () => {
  const sb = sandbox();
  const sid = SID(93);
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_MISSIONS_DIR = "";
  const g = gm.createMission({ text: "interrupted overnight", cwd: sb.root });
  gm.bindSession({ sessionId: SID(94), consolePid: 999999, missionId: g.id }); // a pid that is NOT alive
  gm.reapDeadMissions(); // writes the .dead.json alert as a side effect

  const env = {
    ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath, ACC_MISSIONS_DIR: "",
    ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
    CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"), CLAUDE_CODE_RUNNER: "1",
  };
  delete env.ACC_MISSION;

  const first = execFileSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: sb.root }),
    env, encoding: "utf8",
  });
  assert.match(first, new RegExp(`\\[ACC MISSION ${g.id}\\] DIED`));
  assert.match(first, /most likely a reboot or crash/);

  const second = execFileSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: SID(95), cwd: sb.root }),
    env, encoding: "utf8",
  });
  assert.doesNotMatch(second, /DIED/, "the alert must not repeat once shown");
});

test("Phase 4 D1: a valid-JSON-but-incomplete policy.json (missing runner/subagents/review) still delivers the checkpoint block, not a silently-consumed latch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-budget-crash-"));
  fs.mkdirSync(path.join(root, "runner", "state"), { recursive: true });
  fs.mkdirSync(path.join(root, "cfg"), { recursive: true });
  const policyPath = path.join(root, "policy.json");
  // A REALISTIC incomplete policy: valid JSON, only the context block present
  // -- e.g. a hand-edit that dropped a section, not a parse failure loadPolicy
  // already catches.
  fs.writeFileSync(policyPath, JSON.stringify({ context: { softK: 40, hardK: 50 } }));
  const sb = { root, policyPath };
  const sid = "s-incomplete-policy";
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000); // over hardK 50 -- reaches the block message, which dereferences policy.runner.statusFile
  // The REAL bug here is not a crash: main()'s top-level catch fails open
  // silently (empty stdout, exit 0) -- but the budget latch is written
  // BEFORE the throw, so the checkpoint instruction is lost FOREVER (the
  // latch guard skips re-blocking on every future Stop for this session).
  // "doesn't throw" alone would prove nothing; the hook must actually
  // deliver its intended block.
  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.match(out, /"decision":"block"/, "the checkpoint instruction must still reach the model, not be silently eaten");
  assert.doesNotMatch(out, /^$/, "empty output means the turn ended with NO checkpoint guidance at all");
});

test("under hard: stop passes silently", () => {
  const sb = sandbox();
  const sid = "s-under";
  const t = writeTranscript(sb, sid, 10000);
  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.equal(out.trim(), "");
});

test("Phase 3: with NO ACC-active env var, an over-budget stop produces no block at all", () => {
  const sb = sandbox();
  const sid = "s-inactive";
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000); // over hardK 50 -- would normally block
  const env = {
    ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath, ACC_MISSIONS_DIR: "",
    ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
    CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"), CLAUDE_CODE_RUNNER: "",
  };
  for (const k of ["ACC_SESSION", "ACC_MISSION", "ACC_PROFILE", "ACC_PTY"]) delete env[k];
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: sid, transcript_path: t, stop_hook_active: false, cwd: sb.root }),
    env, encoding: "utf8",
  });
  assert.equal(out.trim(), "", "no ACC session active -> budget.mjs must not block, latch, or inject anything");
  assert.equal(fs.existsSync(statePath(sb, sid, "budget")), false, "no latch written either");
});

test("Phase 3: CLI helpers (fanout/unstop/clear-now/clearbot-status) run unconditionally, with no ACC env set at all", () => {
  const sb = sandbox();
  const env = { ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath };
  for (const k of ["ACC_SESSION", "ACC_MISSION", "ACC_PROFILE", "ACC_PTY"]) delete env[k];
  const out = execFileSync("node", [HOOK, "fanout", "10"], { env, encoding: "utf8" });
  assert.match(out, /fan-out granted for 10 min/, "the CLI helper path must not be gated by accActive()");
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
// The 2026-07-31 stall, pinned. A mission session that simply finishes its turn
// well under the ceiling used to get nothing: no clear, no resume, dead air
// until a human typed. The Stop hook must report that turn end to the mission
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

// Seed a mission in the sandbox and bind this session to it, as SessionStart does.
function seedMission(sb, sid) {
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_MISSIONS_DIR = "";
  const g = gm.createMission({ text: "keep going", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, missionId: g.id });
  gm.markKicked(g.id); // a kick already fired; needsKick is false
  return { gm, g };
}

test("under budget with an active mission: the turn end re-arms the kick", async () => {
  const sb = sandbox();
  const sid = SID(2);
  const { gm, g } = await seedMission(sb, sid);
  const t = writeTranscriptWithUser(sb, sid, 10000, "Continue the active ACC mission.");

  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.equal(out.trim(), "", "still silent - liveness must not add output");

  const after = gm.readMission(g.id);
  assert.equal(after.needsKick, true, "kick re-armed");
  assert.ok(after.turnEndedAt, "turn end stamped");
  assert.ok(!after.humanPromptAt, "the kick constant is a MACHINE turn");
});

test("a human-prompted turn end is classified as human", async () => {
  const sb = sandbox();
  const sid = SID(3);
  const { gm, g } = await seedMission(sb, sid);
  const t = writeTranscriptWithUser(sb, sid, 10000, "actually, do this other thing first");

  runStop(sb, { sid, transcript: t, active: false });
  assert.ok(gm.readMission(g.id).humanPromptAt, "human prompt stamped -> the kick backs off");
});

// --- self-healing watcher --------------------------------------------------
// A dead clearbot means no clear and no resume, and a mission session cannot
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

test("no mission: an under-budget stop still does nothing at all", () => {
  const sb = sandbox();
  const sid = "s-live-nomission";
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
      ACC_MISSIONS_DIR: "",
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

// Lean-review finding (2026-08-06): the per-session subagent spawn cap
// (onPreToolUseAgent's reserveAgentSlot) was a plain read-modify-write on the
// ".agents" state file with nothing serializing it across PROCESSES -- the
// exact class of bug mission.mjs's withMissionLock already exists to close for
// appendCycle (see "concurrent appendCycle calls... never lose an update"
// above, same technique used here: separate node PROCESSES, since
// synchronous JS in one process cannot race itself). Two Agent tool calls
// dispatched in the same turn fire two separate budget.mjs processes; both
// could read the same stale n, both pass a cap check that should only pass
// once, and the persisted counter itself under-reports afterward, silently
// weakening every later check in the session too.
test("Phase: concurrent reserveAgentSlot calls against the SAME session, from separate PROCESSES, never over-grant the cap", async () => {
  const sb = sandbox();
  const sid = "s-agent-race";
  const cap = 3;
  const N = 30;
  // A bare "spawn N, race" gives no reliable overlap here: reserveAgentSlot's
  // whole critical section (read a tiny JSON file, compare, write it back) is
  // microseconds, dwarfed by each process's own spawn/import jitter (tens of
  // ms) -- true simultaneity in that narrow a window is rare by chance alone.
  // A barrier makes it deterministic: every child imports budget.mjs, THEN
  // busy-waits on a go-file this test writes only once all N have had time to
  // reach that wait, so all N actually call reserveAgentSlot within the same
  // few milliseconds -- proving the LOCK, not process-spawn luck, is what
  // keeps the count correct.
  const goFile = path.join(sb.root, "go-signal");
  const fireAsync = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", `
      import(${JSON.stringify("file://" + HOOK)}).then((m) => {
        const fs = require("fs");
        while (!fs.existsSync(${JSON.stringify(goFile)})) {}
        const r = m.reserveAgentSlot(${JSON.stringify(sid)}, ${cap});
        process.exit(r.allowed ? 0 : 1);
      });
    `], { env: { ...process.env, ACC_ROOT: sb.root } });
    child.on("close", (code) => resolve(code));
  });
  const promises = Array.from({ length: N }, fireAsync);
  await new Promise((r) => setTimeout(r, 400)); // let all N reach the busy-wait
  fs.writeFileSync(goFile, "go");
  const codes = await Promise.all(promises);
  const allowedCount = codes.filter((c) => c === 0).length;
  assert.equal(
    allowedCount, cap,
    `expected exactly cap (${cap}) of ${N} truly-concurrent reservations to be allowed, got ${allowedCount} -- the race over- or under-granted`
  );
  const persisted = JSON.parse(fs.readFileSync(statePath(sb, sid, "agents"), "utf8")).n;
  assert.equal(persisted, allowedCount, "the persisted counter must match how many were actually allowed, not undercount from a lost update");
});

// Full-repo review finding (2026-08-06): the PreToolUse dispatch checked
// p.tool_name against the literal string "Agent" to decide whether to route
// into onPreToolUseAgent (the subagent allowlist, per-session cap, and
// RED-tier kill switch). Claude Code's real subagent-launching tool is named
// "Task" (confirmed against Anthropic's own hooks documentation), not
// "Agent" -- so for every real subagent spawn, onPreToolUseAgent never ran
// at all: the dispatcher's own `if (tool_name !== "Agent") allow();` exits
// the process before onPreToolUseAgent is ever called. This is a silent
// fail-open on the ONE mechanism meant to stop unbounded subagent spend
// during a red week, exactly the "safety check that looks enforced but
// isn't" class of bug OI-026's policy.json fix already found once tonight.
// No prior test caught it because every existing subagent test called
// reserveAgentSlot() directly (see the race test above) rather than going
// through the real stdin/CLI dispatch path with a realistic tool_name.
// deny() (PreToolUse's block mechanism) exits 2 and writes its message to
// STDERR -- Claude Code's own hook protocol, not the Stop hook's separate
// stdout-JSON "decision":"block" shape used elsewhere in this file. Returns
// a consistent {blocked, message} regardless of which path fires, so the
// tests below assert on behavior, not on which of Node's two exit shapes
// (clean return vs. thrown ERR_TEST_FAILURE-wrapped exec error) happened.
function runPreToolUse(sb, { sessionId, toolName, subagentType }) {
  try {
    execFileSync("node", [HOOK], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: toolName,
        tool_input: { subagent_type: subagentType },
        cwd: sb.root,
      }),
      env: {
        ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath, ACC_MISSIONS_DIR: "",
        ACC_SCAN_CACHE: path.join(sb.root, "scan-cache.json"),
        CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"), CLAUDE_CODE_RUNNER: "1",
      },
      encoding: "utf8",
    });
    return { blocked: false, message: "" };
  } catch (e) {
    return { blocked: e.status === 2, message: String(e.stderr || "") };
  }
}

test("PreToolUse for a real Task (subagent) call is routed to subagent enforcement, not silently allowed", () => {
  const sb = sandbox({ subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: 6, exploreMaxReportLines: 80 } });
  const r = runPreToolUse(sb, { sessionId: "s-task-1", toolName: "Task", subagentType: "general-purpose" });
  // "general-purpose" is NOT on the allowlist ["Explore"] -- a real
  // dispatch into onPreToolUseAgent must deny it. An unpatched dispatcher
  // (tool_name !== "Task" -> allow()) exits 0 with no output at all.
  assert.equal(r.blocked, true, "a disallowed subagent type must be blocked when routed through the real dispatch");
  assert.match(r.message, /not on the allowlist/);
});

test("PreToolUse for a real Task call honors the per-session cap", () => {
  const sb = sandbox({ subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: 1, exploreMaxReportLines: 80 } });
  const first = runPreToolUse(sb, { sessionId: "s-task-cap", toolName: "Task", subagentType: "Explore" });
  assert.equal(first.blocked, false, "the first call is within cap");
  const second = runPreToolUse(sb, { sessionId: "s-task-cap", toolName: "Task", subagentType: "Explore" });
  assert.equal(second.blocked, true, "the second call exceeds maxPerSession:1 and must be blocked");
  assert.match(second.message, /cap reached/);
});

test("PreToolUse for a real Task call is blocked outright during a RED week", () => {
  const sb = sandbox({ week: { amberTokens: 100, redTokens: 200, effectiveFrom: "" }, subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: 6, exploreMaxReportLines: 80 } });
  const proj = path.join(sb.root, "cfg", "projects", "p");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "s-red.jsonl"), turn(250, "burn") + "\n"); // 250 >= redTokens:200
  const r = runPreToolUse(sb, { sessionId: "s-task-red", toolName: "Task", subagentType: "Explore" });
  assert.equal(r.blocked, true, "a red week must block a real Task/subagent spawn");
  assert.match(r.message, /KILL SWITCH/);
});

test("PreToolUse for a non-subagent tool (e.g. Bash) is allowed through without subagent checks", () => {
  const sb = sandbox({ subagents: { mode: "allowlist", allow: [], maxPerSession: 0, exploreMaxReportLines: 80 } });
  const r = runPreToolUse(sb, { sessionId: "s-bash", toolName: "Bash", subagentType: "" });
  assert.equal(r.blocked, false, "a non-subagent tool must never be blocked by subagent-only logic");
});

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "budget.mjs");

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
  const sid = "s-goal";
  seedWindow(sb, sid);
  const t = writeTranscript(sb, sid, 60000);

  // Seed a goal in the sandbox tree and bind this session to it, the same way
  // SessionStart would. goal.mjs resolves its store from ACC_ROOT at import.
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_GOALS_DIR = "";
  const gm = await import(`./goal.mjs?t=budget-${Math.floor(Math.random() * 1e9)}`);
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
async function seedGoal(sb, sid) {
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_GOALS_DIR = "";
  const gm = await import(`./goal.mjs?t=live-${Math.floor(Math.random() * 1e9)}`);
  const g = gm.createGoal({ text: "keep going", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, goalId: g.id });
  gm.markKicked(g.id); // a kick already fired; needsKick is false
  return { gm, g };
}

test("under budget with an active goal: the turn end re-arms the kick", async () => {
  const sb = sandbox();
  const sid = "s-live-machine";
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
  const sid = "s-live-human";
  const { gm, g } = await seedGoal(sb, sid);
  const t = writeTranscriptWithUser(sb, sid, 10000, "actually, do this other thing first");

  runStop(sb, { sid, transcript: t, active: false });
  assert.ok(gm.readGoal(g.id).humanPromptAt, "human prompt stamped -> the kick backs off");
});

test("no goal: an under-budget stop still does nothing at all", () => {
  const sb = sandbox();
  const sid = "s-live-nogoal";
  const t = writeTranscriptWithUser(sb, sid, 10000, "hello");
  assert.equal(runStop(sb, { sid, transcript: t, active: false }).trim(), "");
});

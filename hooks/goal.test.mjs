// Tests for the goal store (hooks/goal.mjs) - the thing that carries work across
// a /clear.
//
// The interesting behaviour is not "does it write a file". It is the set of
// conditions under which ACC is willing to TYPE INTO A CONSOLE unprompted, which
// is the only genuinely dangerous thing in the chain. So pendingKicks() gets
// tested against every reason it must refuse, not just the happy path.
//
// Run: node --test hooks/goal.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let loadSeq = 0;
async function loadGoal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-goal-"));
  process.env.ACC_GOALS_DIR = dir;
  const m = await import(`./goal.mjs?t=${++loadSeq}`);
  return { m, dir };
}

// A pid that is certainly alive (this test process) and one that is certainly
// not (0 is never a real console).
const LIVE = process.pid;

test("a goal survives as a file and starts unbound", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "ship the thing", cwd: "C:/code", profile: "Normal" });
  assert.match(g.id, /^g-\d{8}-/);
  assert.equal(g.status, "active");
  assert.equal(g.needsKick, false, "an unbound goal has no console to type into");
  assert.equal(m.readGoal(g.id).text, "ship the thing");
});

test("multi-line goal text round-trips intact (OI-004: text never becomes keystrokes)", async () => {
  const { m } = await loadGoal();
  const text = "line one\nline two\n\n- a bullet\n- another";
  const g = m.createGoal({ text });
  assert.equal(m.readGoal(g.id).text, text);
});

test("--text-file carries a multi-line goal the command line could not (GUI path)", async () => {
  const { m, dir } = await loadGoal();
  const text = "rebuild the screen\n\n- keep the tabs\n- one green button\n";
  const f = path.join(dir, "goal.txt");
  fs.writeFileSync(f, "﻿" + text, "utf8"); // PowerShell writes a BOM; it must not survive
  assert.equal(m.textFromArgs(["new", "--text-file", f]), text);
  assert.equal(m.textFromArgs(["new", "--text", "typed"]), "typed");
});

test("binding by ACC_GOAL arms a kick; re-binding the same session does not", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  const b1 = m.bindSession({ sessionId: "s1", consolePid: LIVE, goalId: g.id });
  assert.equal(b1.needsKick, true);
  assert.equal(b1.consolePid, LIVE);

  m.markKicked(g.id);
  const b2 = m.bindSession({ sessionId: "s1", consolePid: LIVE, goalId: g.id });
  assert.equal(b2.needsKick, false, "same session re-firing SessionStart must not re-kick");
});

test("a NEW session in the same console adopts the goal and arms a kick - this is the clear-survival path", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s1", consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);

  // No goalId this time: exactly what a post-/clear SessionStart looks like.
  const b = m.bindSession({ sessionId: "s2", consolePid: LIVE });
  assert.equal(b.id, g.id, "adopted by console pid, not session id");
  assert.equal(b.needsKick, true);
});

test("a session in a DIFFERENT console adopts nothing", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s1", consolePid: LIVE, goalId: g.id });
  assert.equal(m.bindSession({ sessionId: "s2", consolePid: LIVE + 1 }), null);
});

test("a finished goal is never adopted", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s1", consolePid: LIVE, goalId: g.id });
  m.setStatus(g.id, "done");
  assert.equal(m.bindSession({ sessionId: "s2", consolePid: LIVE }), null);
  assert.equal(m.bindSession({ sessionId: "s3", consolePid: LIVE, goalId: g.id }), null);
});

test("pendingKicks refuses: too soon after binding", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s1", consolePid: LIVE, goalId: g.id });
  assert.equal(m.pendingKicks(Date.now()).length, 0, "TUI is not ready the instant a session starts");
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 1);
});

test("pendingKicks refuses: dead console", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s1", consolePid: 0, goalId: g.id });
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0);
});

test("pendingKicks refuses: within the cooldown", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s1", consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  // Re-arm as a fresh session would, then ask immediately.
  m.bindSession({ sessionId: "s2", consolePid: LIVE });
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0, "cooldown outranks a fresh binding");
  assert.equal(m.pendingKicks(Date.now() + 70000).length, 1);
});

test("pendingKicks refuses: goal paused mid-flight", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s1", consolePid: LIVE, goalId: g.id });
  m.setStatus(g.id, "paused");
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0);
});

test("cycles append to the log and the tail is bounded", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.appendCycle(g.id, { sessionId: "s1", ctx: 152000, text: "did the first half" });
  const after = m.appendCycle(g.id, { sessionId: "s2", ctx: 151000, text: "x".repeat(9000) });
  assert.equal(after.cycles, 2);

  const tail = m.logTail(g.id, 1000);
  assert.ok(tail.length <= 1000 + 40, `tail was ${tail.length} chars`);
  assert.match(tail, /earlier progress trimmed/);
  assert.match(m.logTail(g.id, 100000), /did the first half/);
  assert.match(m.logTail(g.id, 100000), /ended at 152k/);
});

test("a done goal is archived out of the live directory", async () => {
  const { m, dir } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.setStatus(g.id, "done", "shipped");
  assert.equal(m.listGoals().length, 0, "live dir holds only work in flight");
  assert.ok(fs.existsSync(path.join(dir, "done", `${g.id}.json`)));
  assert.match(fs.readFileSync(path.join(dir, "done", `${g.id}.log.md`), "utf8"), /DONE/);
});

test("goal ids cannot escape the goals directory", async () => {
  const { m } = await loadGoal();
  assert.equal(m.readGoal("../../../etc/passwd"), null);
  assert.equal(m.setStatus("..\\..\\evil", "done"), null);
});

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

// --- hybrid re-kick rules (autonomy hardening, 2026-07-31) -----------------
// The loop stalled twice on 2026-07-31 because ONLY an over-budget stop could
// continue it: a goal session that ended its turn under the ceiling sat dead
// (18 minutes, once) until a human typed. These pin the rules that make an
// under-budget turn end resume by itself - and the rules that keep it quiet
// while Kyle is actually using that console.

test("recordTurnEnd re-arms the kick and stamps the turn end", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s1", consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id); // a kick already fired, as after a resume
  assert.equal(m.readGoal(g.id).needsKick, false);

  m.recordTurnEnd(g.id, { human: false });
  const after = m.readGoal(g.id);
  assert.equal(after.needsKick, true, "kick re-armed");
  assert.ok(after.turnEndedAt, "turnEndedAt stamped");
  assert.ok(!after.humanPromptAt, "the kick constant is a MACHINE turn");
});

test("a human-prompted turn end records the human timestamp", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s2", consolePid: LIVE, goalId: g.id });
  m.recordTurnEnd(g.id, { human: true });
  assert.ok(m.readGoal(g.id).humanPromptAt, "humanPromptAt stamped");
});

test("kick waits for the settle window, then fires", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s3", consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  m.recordTurnEnd(g.id, { human: false });
  const t0 = Date.parse(m.readGoal(g.id).turnEndedAt);

  const tooSoon = m.pendingKicks(t0 + 30_000, { kickSettleSeconds: 90 });
  assert.equal(tooSoon.find((k) => k.id === g.id), undefined, "30s < 90s settle");

  // Past settle AND past the 60s cooldown from markKicked.
  const ready = m.pendingKicks(t0 + 120_000, { kickSettleSeconds: 90 });
  assert.ok(ready.find((k) => k.id === g.id), "fires once settled");
});

test("a human prompt holds the kick off, and the hold expires", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s4", consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  m.recordTurnEnd(g.id, { human: true });
  const t0 = Date.parse(m.readGoal(g.id).humanPromptAt);

  const held = m.pendingKicks(t0 + 120_000, { kickSettleSeconds: 90, humanHoldMinutes: 10 });
  assert.equal(held.find((k) => k.id === g.id), undefined, "quiet while Kyle is engaged");

  const freed = m.pendingKicks(t0 + 11 * 60_000, { kickSettleSeconds: 90, humanHoldMinutes: 10 });
  assert.ok(freed.find((k) => k.id === g.id), "self-heals after the hold");
});

test("a finished goal is never kicked, however long you wait", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s5", consolePid: LIVE, goalId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  m.setStatus(g.id, "done", "finished");
  assert.equal(m.pendingKicks(Date.now() + 86_400_000).find((k) => k.id === g.id), undefined);
});

test("a dead console is never kicked, however long you wait", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: "s6", consolePid: 999999, goalId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  assert.equal(m.pendingKicks(Date.now() + 86_400_000).find((k) => k.id === g.id), undefined);
});

// Tests for the goal store (hooks/goal.mjs) - the thing that carries work across
// a /clear.
//
// The interesting behaviour is not "does it write a file". It is the set of
// conditions under which ACC is willing to TYPE INTO A CONSOLE unprompted, which
// is the only genuinely dangerous thing in the chain. So pendingKicks() gets
// tested against every reason it must refuse, not just the happy path.
//
// Run: node --test hooks/goal.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// goal.mjs captures ACC_GOALS_DIR into a module-load-time const, so isolating
// every test used to mean a fresh tmpdir + a cache-busted re-import
// (`?t=${n}`) per test. That broke coverage measurement: node's lcov
// reporter keys by file path with last-write-wins across those instances, so
// a full-suite run only ever reported the LAST test's coverage, not the
// union of all of them (proven directly: two tests run in different orders
// flip which lines show covered). Import once, isolate by wiping the same
// directory's contents between tests instead -- goal.mjs's own ensureDirs()
// (and listGoals'/readGoal's already-tested "directory doesn't exist yet"
// fallbacks) recreate what each test needs on demand.
const GOALS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acc-goal-"));
process.env.ACC_GOALS_DIR = GOALS_DIR;
const m = await import("./goal.mjs");

beforeEach(() => {
  fs.rmSync(GOALS_DIR, { recursive: true, force: true });
  fs.mkdirSync(GOALS_DIR, { recursive: true });
});

async function loadGoal() {
  return { m, dir: GOALS_DIR };
}

// A pid that is certainly alive (this test process) and one that is certainly
// not (0 is never a real console).
const LIVE = process.pid;

// Real Claude Code session ids are always UUIDs (OI-006's bindSession guard
// rejects anything else as a rebind source), so every id used to exercise
// the rebind/adoption path below must actually look like one.
const SID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
  const b1 = m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
  assert.equal(b1.needsKick, true);
  assert.equal(b1.consolePid, LIVE);

  m.markKicked(g.id);
  const b2 = m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
  assert.equal(b2.needsKick, false, "same session re-firing SessionStart must not re-kick");
});

test("a NEW session in the same console adopts the goal and arms a kick - this is the clear-survival path", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);

  // No goalId this time: exactly what a post-/clear SessionStart looks like.
  const b = m.bindSession({ sessionId: SID(2), consolePid: LIVE });
  assert.equal(b.id, g.id, "adopted by console pid, not session id");
  assert.equal(b.needsKick, true);
});

test("a session in a DIFFERENT console adopts nothing", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
  assert.equal(m.bindSession({ sessionId: SID(2), consolePid: LIVE + 1 }), null);
});

test("a finished goal is never adopted", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
  m.setStatus(g.id, "done");
  assert.equal(m.bindSession({ sessionId: SID(2), consolePid: LIVE }), null);
  assert.equal(m.bindSession({ sessionId: SID(3), consolePid: LIVE, goalId: g.id }), null);
});

test("pendingKicks refuses: too soon after binding", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
  assert.equal(m.pendingKicks(Date.now()).length, 0, "TUI is not ready the instant a session starts");
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 1);
});

test("pendingKicks: tuiReadySettleMs overrides the default TUI-ready window (guards OI-003)", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
  const t0 = Date.parse(m.readGoal(g.id).boundAt);

  // Below the default (4000ms) but the override says this is plenty.
  const early = m.pendingKicks(t0 + 500, { tuiReadySettleMs: 200 });
  assert.ok(early.find((k) => k.id === g.id), "an explicit override can be shorter than the default");

  // A stricter-than-default override still refuses before its own window.
  const strict = m.pendingKicks(t0 + 5000, { tuiReadySettleMs: 8000 });
  assert.equal(strict.find((k) => k.id === g.id), undefined, "an explicit override can be longer than the default");
});

test("pendingKicks refuses: dead console", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: 0, goalId: g.id });
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0);
});

test("pendingKicks refuses: within the cooldown", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  // Re-arm as a fresh session would, then ask immediately.
  m.bindSession({ sessionId: SID(2), consolePid: LIVE });
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0, "cooldown outranks a fresh binding");
  assert.equal(m.pendingKicks(Date.now() + 70000).length, 1);
});

test("pendingKicks refuses: goal paused mid-flight", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
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
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
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
  m.bindSession({ sessionId: SID(2), consolePid: LIVE, goalId: g.id });
  m.recordTurnEnd(g.id, { human: true });
  assert.ok(m.readGoal(g.id).humanPromptAt, "humanPromptAt stamped");
});

test("kick waits for the settle window, then fires", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(3), consolePid: LIVE, goalId: g.id });
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
  m.bindSession({ sessionId: SID(4), consolePid: LIVE, goalId: g.id });
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
  m.bindSession({ sessionId: SID(5), consolePid: LIVE, goalId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  m.setStatus(g.id, "done", "finished");
  assert.equal(m.pendingKicks(Date.now() + 86_400_000).find((k) => k.id === g.id), undefined);
});

test("a dead console is never kicked, however long you wait", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(6), consolePid: 999999, goalId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  assert.equal(m.pendingKicks(Date.now() + 86_400_000).find((k) => k.id === g.id), undefined);
});

// --- OI-031: a goal bound to a console that's since closed must not sit
// "active" forever -- it must be reaped (archived out of the live dir) so
// list/pending only ever see genuinely live goals. ---

test("OI-031: reapDeadGoals archives a goal whose bound console pid is gone", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(50), consolePid: 999999, goalId: g.id });
  const reaped = m.reapDeadGoals();
  assert.deepEqual(reaped, [g.id]);
  assert.equal(m.readGoal(g.id), null, "reaped goal is archived out of the live directory");
  assert.equal(m.listGoals().length, 0);
});

test("OI-031: reapDeadGoals leaves an unbound goal (consolePid 0) alone -- nothing yet to prove dead", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  assert.deepEqual(m.reapDeadGoals(), []);
  assert.equal(m.readGoal(g.id).status, "active");
});

test("OI-031: reapDeadGoals leaves a LIVE console's goal alone", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(51), consolePid: LIVE, goalId: g.id });
  assert.deepEqual(m.reapDeadGoals(), []);
  assert.equal(m.readGoal(g.id).status, "active");
});

test("OI-031: activeGoals()/list only ever show genuinely live goals -- a dead-console goal disappears on its own", async () => {
  const { m } = await loadGoal();
  const live = m.createGoal({ text: "still going" });
  m.bindSession({ sessionId: SID(52), consolePid: LIVE, goalId: live.id });
  const dead = m.createGoal({ text: "console closed days ago" });
  m.bindSession({ sessionId: SID(53), consolePid: 999999, goalId: dead.id });

  const active = m.activeGoals();
  assert.equal(active.length, 1);
  assert.equal(active[0].id, live.id);
  assert.equal(m.readGoal(dead.id), null, "the dead one was reaped as a side effect of listing");
});

test("CLI: main() 'reap' reports which goals it archived", () => {
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(54), consolePid: 999999, goalId: g.id });
  assert.deepEqual(JSON.parse(runMain(["reap"])), [g.id]);
});

// --- error paths and edge branches not reachable via the happy-path tests --

test("createGoal refuses empty/whitespace-only/absent text", () => {
  assert.throws(() => m.createGoal({ text: "   " }), /a goal needs text/);
  assert.throws(() => m.createGoal({}), /a goal needs text/, "text itself is undefined, not just blank");
});

test("bindSession discards an explicit goalId whose goal exists but is not active", () => {
  const g = m.createGoal({ text: "t" });
  m.setStatus(g.id, "paused"); // paused stays in the live dir (unlike done/blocked), so readGoal still finds it
  assert.equal(m.bindSession({ sessionId: SID(33), consolePid: LIVE, goalId: g.id }), null);
});

test("bindSession sets cwd only when the goal doesn't already have one", () => {
  const g = m.createGoal({ text: "t" }); // no cwd at creation
  const b = m.bindSession({ sessionId: SID(34), consolePid: LIVE, goalId: g.id, cwd: "C:/new" });
  assert.equal(b.cwd, "C:/new");
});

test("appendCycle on a nonexistent goal returns null; missing text/sessionId/ctx fall back cleanly", () => {
  assert.equal(m.appendCycle("g-doesnotexist", { text: "x" }), null);
  const g = m.createGoal({ text: "t" });
  const after = m.appendCycle(g.id, {});
  assert.equal(after.cycles, 1);
  assert.match(m.logTail(g.id, 10000), /_session \? ended at 0k_/);
  assert.match(m.logTail(g.id, 10000), /no closing summary captured/);
});

test("appendCycle swallows a log-write failure instead of throwing", () => {
  const g = m.createGoal({ text: "t" });
  fs.rmSync(m.logPath(g.id));
  fs.mkdirSync(m.logPath(g.id)); // appendFileSync against a directory throws EISDIR
  const after = m.appendCycle(g.id, { text: "x" });
  assert.equal(after.cycles, 1, "cycle count still advances even though the log write failed");
});

test("setStatus swallows a log-write failure and an archive failure instead of throwing", () => {
  const g1 = m.createGoal({ text: "t1" });
  fs.rmSync(m.logPath(g1.id));
  fs.mkdirSync(m.logPath(g1.id));
  const s1 = m.setStatus(g1.id, "done", "note"); // log-append fails; archiving is independent and still proceeds
  assert.equal(s1.status, "done");

  const g2 = m.createGoal({ text: "t2" });
  fs.rmSync(path.join(GOALS_DIR, "done"), { recursive: true, force: true });
  fs.writeFileSync(path.join(GOALS_DIR, "done"), "blocking file where the archive dir should be");
  const s2 = m.setStatus(g2.id, "done", "shipped");
  assert.equal(s2.status, "done", "the live record still updates even though archiving failed");
});

test("recordTurnEnd and markKicked return null for a nonexistent or non-active goal", () => {
  assert.equal(m.recordTurnEnd("g-doesnotexist", {}), null);
  assert.equal(m.markKicked("g-doesnotexist"), null);
  const g = m.createGoal({ text: "t" });
  m.setStatus(g.id, "paused");
  assert.equal(m.recordTurnEnd(g.id, {}), null, "a paused goal is not active");
});

test("CLI: main() 'log' swallows a log-write failure instead of throwing", () => {
  const g = m.createGoal({ text: "t" });
  fs.rmSync(m.logPath(g.id));
  fs.mkdirSync(m.logPath(g.id));
  assert.equal(runMain(["log", g.id, "--text", "x"]), `logged to ${m.logPath(g.id)}`);
});

// --- OI-006: a hand-run SessionStart cannot hijack a live goal's binding ---

test("OI-006: a non-UUID sessionId cannot hijack an active goal's binding", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(30), consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  const before = m.readGoal(g.id);

  // Exactly the reproduction from the ledger: a hand-run SessionStart payload
  // ("hbtest") aimed at a console that owns a real goal.
  const hijacked = m.bindSession({ sessionId: "hbtest", consolePid: LIVE });
  assert.equal(hijacked.id, g.id, "console-pid adoption still runs unchanged");
  assert.equal(hijacked.sessionId, before.sessionId, "the real session id must survive a garbage rebind attempt");
  assert.equal(hijacked.needsKick, false, "a garbage id must never arm a kick");
  assert.equal(hijacked.boundAt, before.boundAt, "boundAt must not be touched by a garbage rebind");
});

test("OI-006: a real UUID sessionId still adopts normally after a clear", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(31), consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);

  const adopted = m.bindSession({ sessionId: SID(32), consolePid: LIVE });
  assert.equal(adopted.id, g.id);
  assert.equal(adopted.sessionId, SID(32), "a real UUID rebinds normally");
  assert.equal(adopted.needsKick, true, "a genuinely new session arms a kick");
});

// --- direct unit coverage for the remaining exported helpers ---------------

test("goalForSession finds an active goal by exact sessionId, and refuses no id / no match", () => {
  assert.equal(m.goalForSession(""), null, "no sessionId given");
  assert.equal(m.goalForSession(SID(20)), null, "no goals exist yet");
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(20), consolePid: LIVE, goalId: g.id });
  assert.equal(m.goalForSession(SID(20)).id, g.id);
  assert.equal(m.goalForSession(SID(21)), null, "a different session matches nothing");
});

test("listGoals returns [] instead of throwing when the goals directory doesn't exist yet", () => {
  fs.rmSync(GOALS_DIR, { recursive: true, force: true });
  assert.deepEqual(m.listGoals(), []);
});

test("logTail returns '' instead of throwing when the log file doesn't exist", () => {
  assert.equal(m.logTail("g-doesnotexist"), "");
});

// --- the CLI dispatcher (main) -----------------------------------------
// Run in-process (not spawned) so coverage actually attributes to it: a
// spawned subprocess is invisible to this file's own coverage instrumentation
// (the same reason budget.mjs/statusline.mjs/engine.mjs/guard.mjs report no
// coverage row at all today -- their tests only ever spawn them).

function runMain(args) {
  const savedArgv = process.argv;
  const savedLog = console.log;
  const out = [];
  console.log = (...a) => out.push(a.map(String).join(" "));
  process.argv = [savedArgv[0], savedArgv[1], ...args];
  try {
    m.main();
  } finally {
    process.argv = savedArgv;
    console.log = savedLog;
  }
  return out.join("\n");
}

test("CLI: main() 'new' creates a goal via --text and prints it", () => {
  const printed = JSON.parse(runMain(["new", "--text", "cli goal"]));
  assert.equal(printed.text, "cli goal");
  assert.ok(m.readGoal(printed.id));
});

test("CLI: main() with no subcommand defaults to 'list', printing active goals as JSON", () => {
  const g = m.createGoal({ text: "t" });
  const printed = JSON.parse(runMain([]));
  assert.ok(printed.some((x) => x.id === g.id));
});

test("CLI: main() 'pending' prints pending kicks, reading policy.json dials when present and falling back when not", () => {
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(40), consolePid: LIVE, goalId: g.id });

  const savedPolicy = process.env.ACC_POLICY;
  try {
    delete process.env.ACC_POLICY; // resolves to the real repo policy.json -- exercises the try branch
    assert.doesNotThrow(() => JSON.parse(runMain(["pending"])));

    process.env.ACC_POLICY = path.join(GOALS_DIR, "does-not-exist.json"); // exercises the catch branch
    assert.doesNotThrow(() => JSON.parse(runMain(["pending"])));
  } finally {
    if (savedPolicy === undefined) delete process.env.ACC_POLICY;
    else process.env.ACC_POLICY = savedPolicy;
  }
});

test("CLI: main() 'kicked <id>' clears needsKick", () => {
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(41), consolePid: LIVE, goalId: g.id });
  assert.equal(m.readGoal(g.id).needsKick, true);
  runMain(["kicked", g.id]);
  assert.equal(m.readGoal(g.id).needsKick, false);
});

test("CLI: main() 'show' resolves an explicit id, the sole active goal, refuses to guess among several, and falls back to 'no active goal'", () => {
  assert.equal(runMain(["show"]), "no active goal", "no active goals at all");
  const g1 = m.createGoal({ text: "t1" });
  assert.equal(JSON.parse(runMain(["show", g1.id])).id, g1.id, "explicit positional id");
  assert.equal(JSON.parse(runMain(["show"])).id, g1.id, "resolveId falls back to the sole active goal");
  m.createGoal({ text: "t2" });
  assert.equal(runMain(["show"]), "no active goal", "resolveId refuses to guess among multiple active goals");
});

test("CLI: main() 'log' appends via --text or trailing positional words, and refuses with no resolvable goal", () => {
  assert.equal(runMain(["log", "whatever", "--text", "x"]), "no active goal", "no goal exists yet to log against");
  const g = m.createGoal({ text: "t" });
  runMain(["log", g.id, "--text", "explicit flag note"]);
  assert.match(m.logTail(g.id, 10000), /explicit flag note/);
  runMain(["log", g.id, "trailing", "positional", "words"]);
  assert.match(m.logTail(g.id, 10000), /trailing positional words/);
});

test("CLI: main() 'done'/'blocked'/'paused' set status via resolveId, and refuse without a resolvable id", () => {
  assert.equal(runMain(["done"]), "no active goal (pass the id)");

  const g1 = m.createGoal({ text: "t1" });
  assert.equal(runMain(["done", g1.id]), `goal ${g1.id} -> done`);
  assert.equal(m.readGoal(g1.id), null, "done archives the goal out of the live directory");

  const g2 = m.createGoal({ text: "t2" });
  assert.equal(runMain(["blocked", g2.id, "--why", "stuck"]), `goal ${g2.id} -> blocked`);
  assert.equal(m.readGoal(g2.id), null, "blocked also archives the goal out of the live directory");

  const g3 = m.createGoal({ text: "t3" });
  assert.equal(runMain(["paused", g3.id]), `goal ${g3.id} -> paused`);
  assert.equal(m.readGoal(g3.id).status, "paused");
});

test("CLI: main() prints usage for an unrecognized command", () => {
  assert.match(runMain(["frobnicate"]), /^usage: goal\.mjs/);
});

// ---------------------------------------------------------- Phase 1: ceilings

test("ceilingReached: cycles-over, wall-over, dollar-over, both-under, and every dial disabled (0/missing)", async () => {
  const { m } = await loadGoal();
  const now = Date.now();
  const created = (agoMin) => new Date(now - agoMin * 60000).toISOString();

  const overCycles = { cycles: 5, createdAt: created(1), totalCostUsd: 0 };
  assert.equal(m.ceilingReached(overCycles, now, { maxCycles: 5 }).reached, true);
  assert.equal(m.ceilingReached(overCycles, now, { maxCycles: 5 }).dimension, "cycles");

  const underCycles = { cycles: 4, createdAt: created(1), totalCostUsd: 0 };
  assert.equal(m.ceilingReached(underCycles, now, { maxCycles: 5 }).reached, false);

  const overWall = { cycles: 0, createdAt: created(200), totalCostUsd: 0 };
  assert.equal(m.ceilingReached(overWall, now, { maxWallClockMinutes: 180 }).reached, true);
  assert.equal(m.ceilingReached(overWall, now, { maxWallClockMinutes: 180 }).dimension, "wallClock");

  const underWall = { cycles: 0, createdAt: created(10), totalCostUsd: 0 };
  assert.equal(m.ceilingReached(underWall, now, { maxWallClockMinutes: 180 }).reached, false);

  const overCost = { cycles: 0, createdAt: created(1), totalCostUsd: 12.5 };
  assert.equal(m.ceilingReached(overCost, now, { maxCostUsd: 10 }).reached, true);
  assert.equal(m.ceilingReached(overCost, now, { maxCostUsd: 10 }).dimension, "cost");

  const underCost = { cycles: 0, createdAt: created(1), totalCostUsd: 2 };
  assert.equal(m.ceilingReached(underCost, now, { maxCostUsd: 10 }).reached, false);

  // Every dial 0/missing (today's unbounded default) never reports reached,
  // whatever the goal's own numbers are.
  const huge = { cycles: 999, createdAt: created(999999), totalCostUsd: 999999 };
  assert.equal(m.ceilingReached(huge, now, {}).reached, false);
  assert.equal(m.ceilingReached(huge, now, { maxCycles: 0, maxWallClockMinutes: 0, maxCostUsd: 0 }).reached, false);
});

test("reapCeilings: transitions an over-ceiling ACTIVE goal to paused with an alert file; leaves an under-ceiling one alone", async () => {
  const { m, dir } = await loadGoal();
  const alerts = path.join(dir, "alerts");
  process.env.ACC_ALERTS_DIR = alerts;
  try {
    const over = m.createGoal({ text: "runaway" });
    m.bindSession({ sessionId: SID(50), consolePid: LIVE, goalId: over.id });
    for (let i = 0; i < 5; i++) m.appendCycle(over.id, { sessionId: SID(50), ctx: 1000, text: "cycle" });
    assert.equal(m.readGoal(over.id).cycles, 5);

    const under = m.createGoal({ text: "fine" });
    m.bindSession({ sessionId: SID(51), consolePid: LIVE, goalId: under.id });

    const reaped = m.reapCeilings(Date.now(), { maxCycles: 5 });
    assert.deepEqual(reaped, [over.id]);
    assert.equal(m.readGoal(over.id).status, "paused");
    assert.match(m.readGoal(over.id).why, /CEILING REACHED.*cycles/);
    assert.equal(m.readGoal(under.id).status, "active", "a goal under every ceiling is untouched");

    const alertFile = path.join(alerts, `${over.id}.ceiling.json`);
    assert.ok(fs.existsSync(alertFile), "an alert file is written for the paused goal");
    const alert = JSON.parse(fs.readFileSync(alertFile, "utf8"));
    assert.equal(alert.id, over.id);
    assert.equal(alert.dimension, "cycles");

    // A paused goal must not be kickable — pendingKicks reads only activeGoals().
    // The still-active "fine" goal legitimately remains kickable, so assert
    // on membership, not on the whole list being empty.
    const kickable = m.pendingKicks(Date.now() + 999999).map((k) => k.id);
    assert.ok(!kickable.includes(over.id), "the paused goal must not appear in pendingKicks");
    assert.ok(kickable.includes(under.id), "the still-active goal remains kickable");
  } finally {
    delete process.env.ACC_ALERTS_DIR;
  }
});

test("reapCeilings does nothing when every dial is disabled (today's default, unchanged behavior)", async () => {
  const { m, dir } = await loadGoal();
  process.env.ACC_ALERTS_DIR = path.join(dir, "alerts");
  try {
    const g = m.createGoal({ text: "t" });
    m.bindSession({ sessionId: SID(52), consolePid: LIVE, goalId: g.id });
    for (let i = 0; i < 50; i++) m.appendCycle(g.id, { sessionId: SID(52), ctx: 1, text: "x" });
    assert.deepEqual(m.reapCeilings(Date.now(), {}), []);
    assert.equal(m.readGoal(g.id).status, "active");
  } finally {
    delete process.env.ACC_ALERTS_DIR;
  }
});

test("resumeGoal: paused -> active, re-arms needsKick, clears the alert file; refuses a non-paused goal", async () => {
  const { m, dir } = await loadGoal();
  const alerts = path.join(dir, "alerts");
  process.env.ACC_ALERTS_DIR = alerts;
  try {
    const g = m.createGoal({ text: "t" });
    m.bindSession({ sessionId: SID(53), consolePid: LIVE, goalId: g.id });
    m.reapCeilings(Date.now(), { maxCycles: 0 }); // no-op, dial disabled
    m.setStatus(g.id, "paused", "CEILING REACHED: cycles (test)");
    fs.mkdirSync(alerts, { recursive: true });
    fs.writeFileSync(path.join(alerts, `${g.id}.ceiling.json`), "{}");

    const resumed = m.resumeGoal(g.id);
    assert.equal(resumed.status, "active");
    assert.equal(resumed.needsKick, true);
    assert.equal(fs.existsSync(path.join(alerts, `${g.id}.ceiling.json`)), false, "the alert is cleared on resume");

    // An active (non-paused) goal cannot be "resumed" — refuse, don't corrupt it.
    assert.equal(m.resumeGoal(g.id), null);
    // A nonexistent id also refuses cleanly.
    assert.equal(m.resumeGoal("g-nope"), null);
  } finally {
    delete process.env.ACC_ALERTS_DIR;
  }
});

test("CLI: main() 'resume <id>' unpauses a goal; refuses without a resolvable id", () => {
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(54), consolePid: LIVE, goalId: g.id });
  m.setStatus(g.id, "paused", "test pause");
  assert.equal(runMain(["resume", g.id]), `goal ${g.id} -> active`);
  assert.equal(m.readGoal(g.id).status, "active");

  assert.equal(runMain(["resume", "g-nope"]), "goal g-nope could not be resumed (not paused, or does not exist)");
});

test("appendCycle accumulates totalCostUsd across cycles when a cost is passed, and tolerates none being passed", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.appendCycle(g.id, { sessionId: SID(55), ctx: 100, text: "c1", costUsd: 0.5 });
  assert.equal(m.readGoal(g.id).totalCostUsd, 0.5);
  m.appendCycle(g.id, { sessionId: SID(55), ctx: 200, text: "c2", costUsd: 1.25 });
  assert.equal(m.readGoal(g.id).totalCostUsd, 1.75);
  m.appendCycle(g.id, { sessionId: SID(55), ctx: 300, text: "c3" }); // no costUsd passed
  assert.equal(m.readGoal(g.id).totalCostUsd, 1.75, "an omitted cost does not corrupt the running total");
});

test("CLI: main() 'pending' calls reapCeilings before pendingKicks, using the same policy dials", () => {
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(56), consolePid: LIVE, goalId: g.id });
  for (let i = 0; i < 20; i++) m.appendCycle(g.id, { sessionId: SID(56), ctx: 1, text: "x" });

  const savedPolicy = process.env.ACC_POLICY;
  const savedAlerts = process.env.ACC_ALERTS_DIR;
  const polPath = path.join(GOALS_DIR, "pending-ceiling-policy.json");
  process.env.ACC_POLICY = polPath;
  process.env.ACC_ALERTS_DIR = path.join(GOALS_DIR, "alerts");
  fs.writeFileSync(polPath, JSON.stringify({ goals: { maxCycles: 3 } }));
  try {
    const printed = JSON.parse(runMain(["pending"]));
    assert.deepEqual(printed, [], "a goal reaped to paused by THIS SAME pending call must not be kicked");
    assert.equal(m.readGoal(g.id).status, "paused");
  } finally {
    if (savedPolicy === undefined) delete process.env.ACC_POLICY; else process.env.ACC_POLICY = savedPolicy;
    if (savedAlerts === undefined) delete process.env.ACC_ALERTS_DIR; else process.env.ACC_ALERTS_DIR = savedAlerts;
  }
});

test("a goal persists correctly after its directory is moved to a new location", async () => {
  const { m, dir } = await loadGoal();

  // Create a goal in the original directory
  const g = m.createGoal({ text: "portable goal", cwd: "C:/code" });
  const originalGoalJson = m.readGoal(g.id);
  assert.ok(originalGoalJson);
  assert.equal(originalGoalJson.text, "portable goal");

  // Move the entire goals directory to a new location
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-goal-moved-"));
  try {
    // Copy the original directory contents
    const moveDir = path.join(newDir, "moved-goals");
    fs.cpSync(dir, moveDir, { recursive: true });

    // Update the environment to point to the new location
    const savedGoalsDir = process.env.ACC_GOALS_DIR;
    process.env.ACC_GOALS_DIR = moveDir;

    // Verify the goal can still be read from the new location
    // goalsDir() resolves from the environment variable on every call
    const movedGoalJson = m.readGoal(g.id);
    assert.ok(movedGoalJson, "goal can be read from moved directory");
    assert.equal(movedGoalJson.text, "portable goal");
    assert.equal(movedGoalJson.id, g.id);

    // Verify listGoals also finds it in the new location
    const listedGoals = m.listGoals();
    assert.ok(listedGoals.some(goal => goal.id === g.id), "goal appears in list after directory move");

    // Restore the original directory reference
    process.env.ACC_GOALS_DIR = savedGoalsDir;
  } finally {
    fs.rmSync(newDir, { recursive: true, force: true });
  }
});

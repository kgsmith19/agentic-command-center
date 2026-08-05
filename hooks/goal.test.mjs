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

// OI-034: pendingKicks/reapDeadGoals/bindSession's pid-fallback all now require
// a console table proving identity, matching what autopilot's real cycle
// supplies. table() builds one; identify() also stamps it onto the bound goal,
// matching the order autopilot really runs in (stamp, then decide).
const ISO = "2026-08-01T00:00:00.000Z";
const table = (pid, iso = ISO) => ({ [String(pid)]: iso });
function identify(pid = LIVE, iso = ISO) {
  m.stampConsoles(table(pid, iso), { now: Date.now(), graceMs: 120000 });
  return table(pid, iso);
}

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
  const consoles = identify(LIVE);

  // No goalId this time: exactly what a post-/clear SessionStart looks like.
  const b = m.bindSession({ sessionId: SID(2), consolePid: LIVE, consoles });
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
  const consoles = identify(LIVE);
  assert.equal(m.pendingKicks(Date.now(), { consoles }).length, 0, "TUI is not ready the instant a session starts");
  assert.equal(m.pendingKicks(Date.now() + 10000, { consoles }).length, 1);
});

test("pendingKicks: tuiReadySettleMs overrides the default TUI-ready window (guards OI-003)", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
  const consoles = identify(LIVE);
  const t0 = Date.parse(m.readGoal(g.id).boundAt);

  // Below the default (4000ms) but the override says this is plenty.
  const early = m.pendingKicks(t0 + 500, { tuiReadySettleMs: 200, consoles });
  assert.ok(early.find((k) => k.id === g.id), "an explicit override can be shorter than the default");

  // A stricter-than-default override still refuses before its own window.
  const strict = m.pendingKicks(t0 + 5000, { tuiReadySettleMs: 8000, consoles });
  assert.equal(strict.find((k) => k.id === g.id), undefined, "an explicit override can be longer than the default");
});

test("pendingKicks refuses: dead console", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: 0, goalId: g.id });
  assert.equal(m.pendingKicks(Date.now() + 10000, { consoles: {} }).length, 0);
});

test("pendingKicks refuses: within the cooldown", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  const consoles = identify(LIVE);
  // Re-arm as a fresh session would, then ask immediately.
  m.bindSession({ sessionId: SID(2), consolePid: LIVE, consoles });
  assert.equal(m.pendingKicks(Date.now() + 10000, { consoles }).length, 0, "cooldown outranks a fresh binding");
  assert.equal(m.pendingKicks(Date.now() + 70000, { consoles }).length, 1);
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
  const consoles = identify(LIVE);
  const t0 = Date.parse(m.readGoal(g.id).turnEndedAt);

  const tooSoon = m.pendingKicks(t0 + 30_000, { kickSettleSeconds: 90, consoles });
  assert.equal(tooSoon.find((k) => k.id === g.id), undefined, "30s < 90s settle");

  // Past settle AND past the 60s cooldown from markKicked.
  const ready = m.pendingKicks(t0 + 120_000, { kickSettleSeconds: 90, consoles });
  assert.ok(ready.find((k) => k.id === g.id), "fires once settled");
});

test("a human prompt holds the kick off, and the hold expires", async () => {
  const { m } = await loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(4), consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  m.recordTurnEnd(g.id, { human: true });
  const consoles = identify(LIVE);
  const t0 = Date.parse(m.readGoal(g.id).humanPromptAt);

  const held = m.pendingKicks(t0 + 120_000, { kickSettleSeconds: 90, humanHoldMinutes: 10, consoles });
  assert.equal(held.find((k) => k.id === g.id), undefined, "quiet while Kyle is engaged");

  const freed = m.pendingKicks(t0 + 11 * 60_000, { kickSettleSeconds: 90, humanHoldMinutes: 10, consoles });
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
  const consoles = identify(LIVE);

  // Exactly the reproduction from the ledger: a hand-run SessionStart payload
  // ("hbtest") aimed at a console that owns a real goal.
  const hijacked = m.bindSession({ sessionId: "hbtest", consolePid: LIVE, consoles });
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
  const consoles = identify(LIVE);

  const adopted = m.bindSession({ sessionId: SID(32), consolePid: LIVE, consoles });
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

// ------------------------------------------------- reaping (guards OI-031)
// Six goals sat "active" from 2026-07-31 onward, every one bound to a console
// that had been gone for days, because nothing ever marked a goal dead when its
// console died. clearbot even LOGGED those deaths ("GUI-DEAD ... hosting GUI
// (pid 1620) is gone") and left the goals active. Detection without reaping.
const DEAD_PID = 999999;

test("OI-031: a goal whose console is gone is reaped and archived as abandoned", () => {
  const g = m.createGoal({ text: "stranded" });
  m.bindSession({ sessionId: SID(60), consolePid: DEAD_PID, goalId: g.id });

  const reaped = m.reapDeadGoals({ now: Date.now() + 3600_000, consoles: {} });

  assert.deepEqual(reaped, [g.id], "returns what it reaped so the caller can log it");
  assert.equal(m.readGoal(g.id), null, "archived out of the live directory");
  assert.ok(!m.activeGoals().some((x) => x.id === g.id), "gone from activeGoals()");
});

test("OI-031: 'abandoned' is distinct from done/blocked - the console died, the model did not finish", () => {
  const g = m.createGoal({ text: "stranded" });
  m.bindSession({ sessionId: SID(61), consolePid: DEAD_PID, goalId: g.id });
  m.reapDeadGoals({ now: Date.now() + 3600_000, consoles: {} });

  const archived = JSON.parse(
    fs.readFileSync(path.join(GOALS_DIR, "done", `${g.id}.json`), "utf8")
  );
  assert.equal(archived.status, "abandoned");
});

test("OI-031: a goal whose console is alive is never reaped", () => {
  const g = m.createGoal({ text: "working" });
  m.bindSession({ sessionId: SID(62), consolePid: LIVE, goalId: g.id });

  assert.deepEqual(m.reapDeadGoals({ now: Date.now() + 3600_000, consoles: table(LIVE) }), []);
  assert.equal(m.readGoal(g.id).status, "active");
});

// The GUI creates a goal and only then launches the console, so for a moment a
// brand-new goal legitimately has no live console. Reaping it there would kill
// the very launch it belongs to.
test("OI-031: a goal that has not been bound yet is protected by the grace window", () => {
  const g = m.createGoal({ text: "just launched" }); // no bindSession: console not up yet

  assert.deepEqual(m.reapDeadGoals({ now: Date.now(), graceMs: 120_000, consoles: {} }), []);
  assert.equal(m.readGoal(g.id).status, "active", "still active inside the grace window");

  // Once the window closes with no console ever having bound, the launch failed.
  assert.deepEqual(m.reapDeadGoals({ now: Date.now() + 120_001, graceMs: 120_000, consoles: {} }), [g.id]);
});

// A goal that HAS bound was attached to a console that provably existed at that
// moment, so a dead pid now means the console died - no grace applies.
test("OI-031: a bound goal whose console died is reaped immediately, grace notwithstanding", () => {
  const g = m.createGoal({ text: "console died" });
  m.bindSession({ sessionId: SID(63), consolePid: DEAD_PID, goalId: g.id });

  assert.deepEqual(m.reapDeadGoals({ now: Date.now(), graceMs: 120_000, consoles: {} }), [g.id]);
});

test("OI-031: a reaped goal is never kicked", () => {
  const g = m.createGoal({ text: "stranded" });
  m.bindSession({ sessionId: SID(64), consolePid: DEAD_PID, goalId: g.id });
  m.reapDeadGoals({ now: Date.now() + 3600_000, consoles: {} });

  assert.deepEqual(m.pendingKicks(Date.now() + 7200_000, { consoles: {} }), []);
});

// CLI 'reap' does not yet read a console table (Task 5 wires that in, the same
// way 'pending' reads one from stdin), so until then it is honestly fail-closed
// like reapDeadGoals is with no table: it destroys nothing on a guess.
test("CLI: main() 'reap' is fail-closed without a console table - it does not guess", () => {
  const g = m.createGoal({ text: "stranded" });
  m.bindSession({ sessionId: SID(65), consolePid: DEAD_PID, goalId: g.id });

  assert.equal(runMain(["reap"]), "reaped 0");
  assert.ok(m.readGoal(g.id), "nothing is reaped without proof the console is gone");
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

// OI-034: console identity is (pid, startTime), not pid alone.
test("a recycled pid is dead, not alive - the OI-034 mistarget, reproduced", () => {
  const goal = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  const consoles = { 4242: "2026-08-04T18:30:00.000Z" }; // same pid, new process
  assert.equal(m.consoleState(goal, consoles), "dead");
});

test("a live console whose start time matches is alive", () => {
  const goal = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  assert.equal(m.consoleState(goal, { 4242: "2026-08-04T10:00:00.000Z" }), "alive");
});

test("a pid absent from the table is dead", () => {
  const goal = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  assert.equal(m.consoleState(goal, { 999: "2026-08-04T10:00:00.000Z" }), "dead");
});

test("a pid present but not yet stamped is unknown, not a guess", () => {
  const goal = { consolePid: 4242 };
  assert.equal(m.consoleState(goal, { 4242: "2026-08-04T10:00:00.000Z" }), "unknown");
});

test("no table means unknown - never a guess in either direction", () => {
  const goal = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  assert.equal(m.consoleState(goal, undefined), "unknown");
});

test("a goal inside the grace window is stamped from the table on first sighting", () => {
  const g = m.createGoal({ text: "keep tests green", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: SID(70), consolePid: 4242, goalId: g.id });
  const stamped = m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  assert.deepEqual(stamped, [g.id]);
  assert.equal(m.readGoal(g.id).consoleStartedAt, "2026-08-04T10:00:00.000Z");
});

test("stamping is idempotent - an already stamped goal is left alone", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: SID(71), consolePid: 4242, goalId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const again = m.stampConsoles({ 4242: "2026-08-04T99:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  assert.deepEqual(again, []);
  assert.equal(m.readGoal(g.id).consoleStartedAt, "2026-08-04T10:00:00.000Z");
});

test("a goal older than the grace window is never stamped - legacy stays unidentifiable", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: SID(72), consolePid: 4242, goalId: g.id });
  const later = Date.now() + 10 * 60 * 1000;
  assert.deepEqual(
    m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: later, graceMs: 120000 }),
    []
  );
  assert.equal(m.readGoal(g.id).consoleStartedAt, undefined);
});

// OI-034, Task 3: reap/kick fail closed without proof of identity.
test("pendingKicks returns nothing without a console table - fail closed", () => {
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(73), consolePid: LIVE, goalId: g.id });
  assert.deepEqual(m.pendingKicks(Date.now() + 10000, {}), []);
});

test("pendingKicks skips a goal whose console was recycled", () => {
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(74), consolePid: 4242, goalId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const kicks = m.pendingKicks(Date.now() + 10000, { consoles: { 4242: "2026-08-04T18:30:00.000Z" } });
  assert.deepEqual(kicks.find((k) => k.id === g.id), undefined);
});

test("pendingKicks returns a goal whose console identity matches", () => {
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(75), consolePid: 4242, goalId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const kicks = m.pendingKicks(Date.now() + 10000, { consoles: { 4242: "2026-08-04T10:00:00.000Z" } });
  assert.ok(kicks.find((k) => k.id === g.id));
});

test("a recycled console is reaped as abandoned and leaves activeGoals", () => {
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(76), consolePid: 4242, goalId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const reaped = m.reapDeadGoals({
    now: Date.now() + 10 * 60 * 1000,
    graceMs: 120000,
    consoles: { 4242: "2026-08-04T18:30:00.000Z" },
  });
  assert.deepEqual(reaped, [g.id]);
  assert.equal(m.readGoal(g.id), null);
  assert.equal(m.activeGoals().find((x) => x.id === g.id), undefined);
});

test("reapDeadGoals with no table reaps nothing - it never destroys on a guess", () => {
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: SID(77), consolePid: 4242, goalId: g.id });
  assert.deepEqual(m.reapDeadGoals({ now: Date.now() + 10 * 60 * 1000, graceMs: 120000 }), []);
  assert.equal(m.readGoal(g.id).status, "active");
});

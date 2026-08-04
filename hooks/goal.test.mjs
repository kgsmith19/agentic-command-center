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
import { fileURLToPath } from "node:url";

// ONE module instance for the whole file, with the store redirected per test.
// This used to re-import goal.mjs under a fresh `?t=N` URL for every test,
// because the store path was resolved at module load. That made the suite's
// coverage meaningless: node reports exactly one instance per file rather than
// the union across them, so goal.mjs's number was read off whichever instance
// loaded last and showed functions as untested that provably ran (66% vs 36%
// for identical work, depending only on what the last instance did — measured
// 2026-08-04, same family as OI-017). goal.mjs now resolves its store per call,
// which is what lets this be a single import.
//
// It is imported AS THE ENTRY POINT: goal.mjs only runs main() when
// process.argv[1] is its own path, and that guard is real dispatch logic —
// every GUI, clearbot and model invocation passes through it. Setting argv
// before the import is what executes it in the same process as the rest of the
// suite, so the guard is exercised rather than assumed. `list` is the harmless
// default command.
const GOALCLI = fileURLToPath(new URL("./goal.mjs", import.meta.url));
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-goal-boot-"));
process.env.ACC_GOALS_DIR = bootDir;
const bootArgv = process.argv;
const bootLog = console.log;
const bootOut = [];
process.argv = [bootArgv[0], GOALCLI, "list"];
console.log = (...a) => bootOut.push(a.map(String).join(" "));
const goalMod = await import("./goal.mjs");
process.argv = bootArgv;
console.log = bootLog;

test("the module runs its CLI only when it IS the entry point", () => {
  assert.deepEqual(JSON.parse(bootOut.join("\n")), [], "importing as the entry point ran `list`");
});

function loadGoal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-goal-"));
  process.env.ACC_GOALS_DIR = dir;
  return { m: goalMod, dir };
}

// A pid that is certainly alive (this test process) and one that is certainly
// not (0 is never a real console).
const LIVE = process.pid;

// Stand-ins for what used to be "s1".."s6". They are UUID-shaped because
// bindSession now only adopts UUID-shaped session ids (OI-006) — a real
// Claude Code session_id always is one, and anything else is a hand-run
// payload that must not be able to overwrite a live goal's binding. Using
// short strings here would have quietly tested a path production never takes.
const S1 = "5e551011-0001-4000-8000-000000000001";
const S2 = "5e551011-0002-4000-8000-000000000002";
const S3 = "5e551011-0003-4000-8000-000000000003";
const S4 = "5e551011-0004-4000-8000-000000000004";
const S5 = "5e551011-0005-4000-8000-000000000005";
const S6 = "5e551011-0006-4000-8000-000000000006";

test("a goal survives as a file and starts unbound", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "ship the thing", cwd: "C:/code", profile: "Normal" });
  assert.match(g.id, /^g-\d{8}-/);
  assert.equal(g.status, "active");
  assert.equal(g.needsKick, false, "an unbound goal has no console to type into");
  assert.equal(m.readGoal(g.id).text, "ship the thing");
});

test("multi-line goal text round-trips intact (OI-004: text never becomes keystrokes)", async () => {
  const { m } = loadGoal();
  const text = "line one\nline two\n\n- a bullet\n- another";
  const g = m.createGoal({ text });
  assert.equal(m.readGoal(g.id).text, text);
});

test("--text-file carries a multi-line goal the command line could not (GUI path)", async () => {
  const { m, dir } = loadGoal();
  const text = "rebuild the screen\n\n- keep the tabs\n- one green button\n";
  const f = path.join(dir, "goal.txt");
  fs.writeFileSync(f, "﻿" + text, "utf8"); // PowerShell writes a BOM; it must not survive
  assert.equal(m.textFromArgs(["new", "--text-file", f]), text);
  assert.equal(m.textFromArgs(["new", "--text", "typed"]), "typed");
});

test("binding by ACC_GOAL arms a kick; re-binding the same session does not", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  const b1 = m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  assert.equal(b1.needsKick, true);
  assert.equal(b1.consolePid, LIVE);

  m.markKicked(g.id);
  const b2 = m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  assert.equal(b2.needsKick, false, "same session re-firing SessionStart must not re-kick");
});

test("a NEW session in the same console adopts the goal and arms a kick - this is the clear-survival path", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);

  // No goalId this time: exactly what a post-/clear SessionStart looks like.
  const b = m.bindSession({ sessionId: S2, consolePid: LIVE });
  assert.equal(b.id, g.id, "adopted by console pid, not session id");
  assert.equal(b.needsKick, true);
});

// OI-006, the exact incident: a smoke test piped a SessionStart payload with
// session_id:"hbtest" into the live hook from a console that owned a goal.
// Adoption is by console pid (that is what survives a /clear and must stay),
// so the goal was found — and its sessionId was overwritten with "hbtest",
// arming a kick that clearbot then typed into the real console. The real
// session's Stop hook could no longer find its own goal.
test("a non-UUID session id cannot steal a live binding (OI-006)", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  const before = m.readGoal(g.id);

  const b = m.bindSession({ sessionId: "hbtest", consolePid: LIVE });
  assert.equal(b.id, g.id, "the goal is still found — the guard is not 'stop adopting'");
  assert.equal(b.sessionId, S1, "the live session id survives the hand-run payload");
  assert.equal(b.needsKick, false, "no kick armed, so clearbot types nothing");
  assert.equal(b.boundAt, before.boundAt, "the binding timestamp is untouched");
  assert.equal(m.goalForSession(S1)?.id, g.id, "the real session can still find its own goal");
});

// The other half of the guard: it must not cost anything real. A genuine
// post-/clear SessionStart always carries a UUID, so it still adopts.
test("a UUID session id still adopts after a hand-run payload was refused (OI-006)", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  m.bindSession({ sessionId: "hbtest", consolePid: LIVE });

  const b = m.bindSession({ sessionId: S2.toUpperCase(), consolePid: LIVE });
  assert.equal(b.sessionId, S2.toUpperCase(), "UUIDs are matched case-insensitively");
  assert.equal(b.needsKick, true, "a real new session still arms its kick");
});

test("a session in a DIFFERENT console adopts nothing", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  assert.equal(m.bindSession({ sessionId: S2, consolePid: LIVE + 1 }), null);
});

test("a finished goal is never adopted", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  m.setStatus(g.id, "done");
  assert.equal(m.bindSession({ sessionId: S2, consolePid: LIVE }), null);
  assert.equal(m.bindSession({ sessionId: S3, consolePid: LIVE, goalId: g.id }), null);
});

test("pendingKicks refuses: too soon after binding", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  assert.equal(m.pendingKicks(Date.now()).length, 0, "TUI is not ready the instant a session starts");
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 1);
});

test("pendingKicks refuses: dead console", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S1, consolePid: 0, goalId: g.id });
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0);
});

test("pendingKicks refuses: within the cooldown", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  // Re-arm as a fresh session would, then ask immediately.
  m.bindSession({ sessionId: S2, consolePid: LIVE });
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0, "cooldown outranks a fresh binding");
  assert.equal(m.pendingKicks(Date.now() + 70000).length, 1);
});

test("pendingKicks refuses: goal paused mid-flight", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  m.setStatus(g.id, "paused");
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0);
});

test("cycles append to the log and the tail is bounded", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.appendCycle(g.id, { sessionId: S1, ctx: 152000, text: "did the first half" });
  const after = m.appendCycle(g.id, { sessionId: S2, ctx: 151000, text: "x".repeat(9000) });
  assert.equal(after.cycles, 2);

  const tail = m.logTail(g.id, 1000);
  assert.ok(tail.length <= 1000 + 40, `tail was ${tail.length} chars`);
  assert.match(tail, /earlier progress trimmed/);
  assert.match(m.logTail(g.id, 100000), /did the first half/);
  assert.match(m.logTail(g.id, 100000), /ended at 152k/);
});

test("a done goal is archived out of the live directory", async () => {
  const { m, dir } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.setStatus(g.id, "done", "shipped");
  assert.equal(m.listGoals().length, 0, "live dir holds only work in flight");
  assert.ok(fs.existsSync(path.join(dir, "done", `${g.id}.json`)));
  assert.match(fs.readFileSync(path.join(dir, "done", `${g.id}.log.md`), "utf8"), /DONE/);
});

test("goal ids cannot escape the goals directory", async () => {
  const { m } = loadGoal();
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
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id); // a kick already fired, as after a resume
  assert.equal(m.readGoal(g.id).needsKick, false);

  m.recordTurnEnd(g.id, { human: false });
  const after = m.readGoal(g.id);
  assert.equal(after.needsKick, true, "kick re-armed");
  assert.ok(after.turnEndedAt, "turnEndedAt stamped");
  assert.ok(!after.humanPromptAt, "the kick constant is a MACHINE turn");
});

test("a human-prompted turn end records the human timestamp", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S2, consolePid: LIVE, goalId: g.id });
  m.recordTurnEnd(g.id, { human: true });
  assert.ok(m.readGoal(g.id).humanPromptAt, "humanPromptAt stamped");
});

test("kick waits for the settle window, then fires", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S3, consolePid: LIVE, goalId: g.id });
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
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S4, consolePid: LIVE, goalId: g.id });
  m.markKicked(g.id);
  m.recordTurnEnd(g.id, { human: true });
  const t0 = Date.parse(m.readGoal(g.id).humanPromptAt);

  const held = m.pendingKicks(t0 + 120_000, { kickSettleSeconds: 90, humanHoldMinutes: 10 });
  assert.equal(held.find((k) => k.id === g.id), undefined, "quiet while Kyle is engaged");

  const freed = m.pendingKicks(t0 + 11 * 60_000, { kickSettleSeconds: 90, humanHoldMinutes: 10 });
  assert.ok(freed.find((k) => k.id === g.id), "self-heals after the hold");
});

test("a finished goal is never kicked, however long you wait", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S5, consolePid: LIVE, goalId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  m.setStatus(g.id, "done", "finished");
  assert.equal(m.pendingKicks(Date.now() + 86_400_000).find((k) => k.id === g.id), undefined);
});

test("a dead console is never kicked, however long you wait", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S6, consolePid: 999999, goalId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  assert.equal(m.pendingKicks(Date.now() + 86_400_000).find((k) => k.id === g.id), undefined);
});

// ============================================================ progress log
// appendCycle/logTail/setStatus are what a resumed session actually READS —
// the log is the only thing that crosses a /clear besides the goal text — and
// they had no tests at all until covgate forced the question (2026-08-04).

test("appendCycle counts the cycle and writes what the next session will read", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  const after = m.appendCycle(g.id, { sessionId: S1, ctx: 152_400, text: "did the first half" });
  assert.equal(after.cycles, 1);
  assert.equal(m.readGoal(g.id).cycles, 1, "the count is persisted, not just returned");
  const log = m.logTail(g.id);
  assert.match(log, /### Cycle 1 - /);
  assert.match(log, /did the first half/);
  assert.match(log, /ended at 152k/, "ctx is reported in k, rounded");
});

test("appendCycle on a missing goal is null, not a throw (fails open)", async () => {
  const { m } = loadGoal();
  assert.equal(m.appendCycle("g-nope", { sessionId: S1, ctx: 1, text: "x" }), null);
});

test("appendCycle bounds the body and says so when there is nothing to say", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.appendCycle(g.id, { ctx: 0, text: "x".repeat(9000) });
  const log = m.logTail(g.id, 100_000);
  // The longest RUN of x, not the total count: goal ids end in four base36
  // characters, so the header can contribute a stray "x" of its own and a
  // total-count assertion flakes roughly one run in eight.
  const longest = Math.max(...(log.match(/x+/g) || [""]).map((r) => r.length));
  assert.equal(longest, 4000, "body is capped at 4000 chars");
  assert.match(log, /_session \? ended at 0k_/, "a missing session id degrades to ?");

  m.appendCycle(g.id, { sessionId: S2, ctx: 1000, text: "   " });
  assert.match(m.logTail(g.id, 100_000), /_\(no closing summary captured\)_/);
});

test("logTail is bounded — an old goal's log cannot eat the context it protects", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.appendCycle(g.id, { sessionId: S1, ctx: 1000, text: "y".repeat(3999) });
  const tail = m.logTail(g.id, 500);
  assert.ok(tail.startsWith("...(earlier progress trimmed)..."), tail.slice(0, 60));
  assert.equal(tail.length, "...(earlier progress trimmed)...\n".length + 500);
});

test("logTail of a goal with no log file is empty, not a throw", async () => {
  const { m } = loadGoal();
  // createGoal always writes a log header, so the missing-file case is a goal
  // id that has no store entry at all — which is what a stale SessionStart
  // injection looks like after the goal was archived.
  assert.equal(m.logTail("g-nope"), "");
});

test("a goal with no text is refused outright", async () => {
  const { m } = loadGoal();
  assert.throws(() => m.createGoal({ text: "   " }), /a goal needs text/);
  assert.throws(() => m.createGoal({}), /a goal needs text/);
});

test("setStatus done archives the goal out of the live directory", async () => {
  const { m, dir } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.appendCycle(g.id, { sessionId: S1, ctx: 1000, text: "some progress" });
  const done = m.setStatus(g.id, "done", "shipped it");
  assert.equal(done.status, "done");
  assert.equal(done.needsKick, false);
  assert.equal(done.why, "shipped it");
  assert.equal(m.activeGoals().length, 0, "the live directory only holds work in flight");
  assert.ok(fs.existsSync(path.join(dir, "done", `${g.id}.json`)), "goal archived");
  const archivedLog = fs.readFileSync(path.join(dir, "done", `${g.id}.log.md`), "utf8");
  assert.match(archivedLog, /### DONE - /, "the closing reason is in the log, not just the json");
  assert.match(archivedLog, /shipped it/);
});

test("setStatus blocked archives too; paused stays live and just stops kicking", async () => {
  const { m, dir } = loadGoal();
  const blocked = m.createGoal({ text: "b" });
  m.setStatus(blocked.id, "blocked", "waiting on Kyle");
  assert.ok(fs.existsSync(path.join(dir, "done", `${blocked.id}.json`)));

  const paused = m.createGoal({ text: "p" });
  m.bindSession({ sessionId: S3, consolePid: LIVE, goalId: paused.id });
  const r = m.setStatus(paused.id, "paused");
  assert.equal(r.status, "paused");
  assert.equal(r.needsKick, false, "a paused goal is never kicked");
  assert.equal(r.why, undefined, "no reason given, none invented");
  assert.ok(fs.existsSync(path.join(dir, `${paused.id}.json`)), "paused work is not archived");
});

test("setStatus truncates a runaway reason and is null for a missing goal", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  assert.equal(m.setStatus(g.id, "paused", "w".repeat(900)).why.length, 500);
  assert.equal(m.setStatus("g-nope", "done", "x"), null);
});

// ================================================================ fail-open
// Every one of these is a corrupt/hostile store. The rule from the file header
// is that a broken goal store costs auto-resume and NOTHING else, so each must
// degrade to a falsy default rather than throw into a hook.

test("unreadable and malformed goal files are skipped, never thrown", async () => {
  const { m, dir } = loadGoal();
  const good = m.createGoal({ text: "real" });
  fs.writeFileSync(path.join(dir, "g-corrupt.json"), "{not json");
  fs.writeFileSync(path.join(dir, "g-noid.json"), JSON.stringify({ status: "active" }));
  const ids = m.activeGoals().map((g) => g.id);
  assert.deepEqual(ids, [good.id], "one good goal survives a directory of junk");
  assert.equal(m.readGoal("g-corrupt"), null);
});

test("a goals directory that does not exist reads as empty", async () => {
  const { m, dir } = loadGoal();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(m.activeGoals(), []);
  assert.equal(m.goalForSession(S1), null);
});

test("consoleAlive: this process is alive, pid 0 and an unused pid are not", async () => {
  const { m } = loadGoal();
  assert.equal(m.consoleAlive(LIVE), true);
  assert.equal(m.consoleAlive(0), false, "0 is never a real console");
  assert.equal(m.consoleAlive(null), false);
  assert.equal(m.consoleAlive(999999), false);
});

test("consoleAlive treats EPERM as alive — a console owned by another user still exists", async () => {
  const { m } = loadGoal();
  // pid 1 is init/System: it exists and is not ours, so the kill probe raises
  // EPERM rather than ESRCH. That is the branch that must answer "alive": a
  // goal must never be abandoned because its console outranks us.
  const real = process.kill;
  process.kill = () => { const e = new Error("denied"); e.code = "EPERM"; throw e; };
  try {
    assert.equal(m.consoleAlive(1), true);
  } finally {
    process.kill = real;
  }
});

test("goalForSession needs a session id and an ACTIVE goal", async () => {
  const { m } = loadGoal();
  const g = m.createGoal({ text: "t" });
  m.bindSession({ sessionId: S4, consolePid: LIVE, goalId: g.id });
  assert.equal(m.goalForSession(S4).id, g.id);
  assert.equal(m.goalForSession(""), null, "no session id, no lookup");
  m.setStatus(g.id, "done");
  assert.equal(m.goalForSession(S4), null, "a finished goal is not 'this session's goal'");
});

test("markKicked and recordTurnEnd on a missing goal are null, not a throw", async () => {
  const { m } = loadGoal();
  assert.equal(m.markKicked("g-nope"), null);
  assert.equal(m.recordTurnEnd("g-nope", { human: false }), null);
});

// ==================================================================== CLI
// main() is how the GUI, clearbot and the model itself all reach this store, so
// it is a real interface, not a convenience wrapper — and it was entirely
// untested until 2026-08-04. Driven as a subprocess because that is the only
// way to exercise argv parsing and the `is this module the entry point` guard.

// Driven IN-PROCESS rather than as a subprocess, which is not the obvious
// choice and is deliberate. goal.mjs only runs main() when it is the entry
// point, and it decides that by comparing process.argv[1] to its own path —
// fileURLToPath drops the ?cachebust query, so setting argv[1] and re-importing
// runs the CLI for real, argv parsing and entry guard included. Spawning `node
// hooks/goal.mjs` instead measures nothing useful here: node's own coverage
// merge degrades badly as the process count climbs (OI-017), and adding a
// subprocess per CLI case dropped goal.mjs's measured coverage from 65% to 47%
// while strictly ADDING executed code. Same interface exercised, honest number.
async function cli(dir, args, extraEnv = {}) {
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedEnv = { ACC_GOALS_DIR: process.env.ACC_GOALS_DIR, ACC_ROOT: process.env.ACC_ROOT, ACC_POLICY: process.env.ACC_POLICY };
  const out = [];
  process.env.ACC_GOALS_DIR = dir;
  process.env.ACC_ROOT = "";
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  process.argv = [savedArgv[0], GOALCLI, ...args];
  console.log = (...a) => out.push(a.map(String).join(" "));
  try {
    goalMod.main();
  } finally {
    process.argv = savedArgv;
    console.log = savedLog;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return out.join("\n").trim();
}

function cliDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acc-goalcli-"));
}

test("CLI: new prints the created goal, list prints the active set", async () => {
  const dir = cliDir();
  const created = JSON.parse(await cli(dir, ["new", "--text", "ship it", "--cwd", "C:/code", "--profile", "Big"]));
  assert.equal(created.text, "ship it");
  assert.equal(created.cwd, "C:/code");
  assert.equal(created.profile, "Big");

  const listed = JSON.parse(await cli(dir, ["list"]));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  // No subcommand at all defaults to list, so a bare invocation is harmless.
  assert.deepEqual(JSON.parse(await cli(dir, [])), listed);
});

test("CLI: new --text-file carries the multi-line goal a command line cannot", async () => {
  const dir = cliDir();
  const f = path.join(dir, "goal.txt");
  fs.writeFileSync(f, "\uFEFFline one\nline two\n", "utf8");
  const g = JSON.parse(await cli(dir, ["new", "--text-file", f]));
  assert.equal(g.text, "line one\nline two");
});

test("CLI: show/log/kicked resolve the single active goal without being told its id", async () => {
  const dir = cliDir();
  const g = JSON.parse(await cli(dir, ["new", "--text", "t"]));

  const shown = JSON.parse(await cli(dir, ["show"]));
  assert.equal(shown.id, g.id);
  assert.equal(JSON.parse(await cli(dir, ["show", g.id])).id, g.id, "an explicit id works too");

  assert.match(await cli(dir, ["log", "--text", "a note"]), /^logged to /);
  assert.match(await cli(dir, ["log", g.id, "free", "form", "words"]), /^logged to /);
  const logged = fs.readFileSync(path.join(dir, `${g.id}.log.md`), "utf8");
  assert.match(logged, /a note/);
  assert.match(logged, /free form words/, "trailing words are the note when --text is absent");

  await cli(dir, ["kicked", g.id]);
  assert.equal(JSON.parse(await cli(dir, ["show"])).needsKick, false);
});

test("CLI: with no active goal, show and log say so instead of failing", async () => {
  const dir = cliDir();
  assert.equal(await cli(dir, ["show"]), "no active goal");
  assert.equal(await cli(dir, ["log", "--text", "x"]), "no active goal");
  assert.equal(await cli(dir, ["done"]), "no active goal (pass the id)");
  // Ambiguity is refused the same way: two active goals mean no fallback.
  await cli(dir, ["new", "--text", "one"]);
  await cli(dir, ["new", "--text", "two"]);
  assert.equal(await cli(dir, ["show"]), "no active goal", "two actives is not a single active");
  await cli(dir, ["kicked"]); // resolves to "" and must not throw
});

test("CLI: done/blocked/paused set status, and unknown commands print usage", async () => {
  const dir = cliDir();
  const a = JSON.parse(await cli(dir, ["new", "--text", "a"]));
  assert.equal(await cli(dir, ["done", a.id, "--why", "shipped"]), `goal ${a.id} -> done`);

  const b = JSON.parse(await cli(dir, ["new", "--text", "b"]));
  assert.equal(await cli(dir, ["blocked", b.id, "--why", "needs Kyle"]), `goal ${b.id} -> blocked`);

  const c = JSON.parse(await cli(dir, ["new", "--text", "c"]));
  assert.equal(await cli(dir, ["paused", c.id]), `goal ${c.id} -> paused`);
  assert.equal(JSON.parse(await cli(dir, ["show", c.id])).status, "paused");

  assert.match(await cli(dir, ["nonsense"]), /^usage: goal\.mjs new /);
});

test("CLI: pending reads its dials from policy.json and falls open when it cannot", async () => {
  const dir = cliDir();
  const g = JSON.parse(await cli(dir, ["new", "--text", "t"]));
  // Bind + arm through the library so `pending` has something to decide about.
  process.env.ACC_GOALS_DIR = dir;
  const m = goalMod;
  m.bindSession({ sessionId: S1, consolePid: LIVE, goalId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  // Age the binding past KICK_DELAY_MS, which is a hard constant rather than a
  // policy dial — the subprocess uses the real clock, so the only way to be
  // past it without sleeping is to have bound in the past.
  const gf = path.join(dir, `${g.id}.json`);
  const stored = JSON.parse(fs.readFileSync(gf, "utf8"));
  stored.boundAt = new Date(Date.now() - 60_000).toISOString();
  stored.turnEndedAt = stored.boundAt;
  fs.writeFileSync(gf, JSON.stringify(stored));

  // Settle windows wide open: this goal is due.
  const pol = path.join(dir, "policy.json");
  fs.writeFileSync(pol, JSON.stringify({ goals: { kickSettleSeconds: 0, humanHoldMinutes: 0 } }));
  const due = JSON.parse(await cli(dir, ["pending"], { ACC_POLICY: pol }));
  assert.ok(due.find((k) => k.id === g.id), "policy dials are honoured");

  // Settle window far in the future: nothing is due yet.
  fs.writeFileSync(pol, JSON.stringify({ goals: { kickSettleSeconds: 86_400, humanHoldMinutes: 0 } }));
  assert.deepEqual(JSON.parse(await cli(dir, ["pending"], { ACC_POLICY: pol })), []);

  // An unreadable policy must not take the kick loop down with it — the
  // defaults apply and the command still answers (fail open).
  fs.writeFileSync(pol, "{not json");
  assert.ok(Array.isArray(JSON.parse(await cli(dir, ["pending"], { ACC_POLICY: pol }))));
});

test("the store resolves ACC_GOALS_DIR first, then ACC_ROOT, then the repo", () => {
  // Both budget.mjs and goal.mjs must honour ACC_ROOT or a test would split its
  // state across two trees — which is the whole reason the sandboxing works.
  const saved = { dir: process.env.ACC_GOALS_DIR, root: process.env.ACC_ROOT };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-goal-root-"));
  try {
    process.env.ACC_GOALS_DIR = path.join(root, "explicit");
    assert.equal(goalMod.GOALS(), path.join(root, "explicit"), "an explicit dir wins outright");

    delete process.env.ACC_GOALS_DIR;
    process.env.ACC_ROOT = root;
    assert.equal(goalMod.GOALS(), path.join(path.resolve(root), "runner", "goals"));

    delete process.env.ACC_ROOT;
    assert.equal(
      goalMod.GOALS(),
      path.join(path.dirname(path.dirname(GOALCLI)), "runner", "goals"),
      "with neither set it falls back to the repo the module lives in"
    );
  } finally {
    if (saved.dir === undefined) delete process.env.ACC_GOALS_DIR;
    else process.env.ACC_GOALS_DIR = saved.dir;
    if (saved.root === undefined) delete process.env.ACC_ROOT;
    else process.env.ACC_ROOT = saved.root;
  }
});

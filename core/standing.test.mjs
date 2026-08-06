// Tests for the standing store (core/standing.mjs) - the thing that carries work across
// a /clear.
//
// The interesting behaviour is not "does it write a file". It is the set of
// conditions under which ACC is willing to TYPE INTO A CONSOLE unprompted, which
// is the only genuinely dangerous thing in the chain. So pendingKicks() gets
// tested against every reason it must refuse, not just the happy path.
//
// Run: node --test core/standing.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// standing.mjs captures ACC_STANDING_DIR into a module-load-time const, so isolating
// every test used to mean a fresh tmpdir + a cache-busted re-import
// (`?t=${n}`) per test. That broke coverage measurement: node's lcov
// reporter keys by file path with last-write-wins across those instances, so
// a full-suite run only ever reported the LAST test's coverage, not the
// union of all of them (proven directly: two tests run in different orders
// flip which lines show covered). Import once, isolate by wiping the same
// directory's contents between tests instead -- standing.mjs's own ensureDirs()
// (and listStanding'/readStanding's already-tested "directory doesn't exist yet"
// fallbacks) recreate what each test needs on demand.
const STANDING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acc-standing-"));
process.env.ACC_STANDING_DIR = STANDING_DIR;
const m = await import("./standing.mjs");

beforeEach(() => {
  fs.rmSync(STANDING_DIR, { recursive: true, force: true });
  fs.mkdirSync(STANDING_DIR, { recursive: true });
});

async function loadStanding() {
  return { m, dir: STANDING_DIR };
}

// A pid that is certainly alive (this test process) and one that is certainly
// not (0 is never a real console).
const LIVE = process.pid;

// Real Claude Code session ids are always UUIDs (OI-006's bindSession guard
// rejects anything else as a rebind source), so every id used to exercise
// the rebind/adoption path below must actually look like one.
const SID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// OI-034: pendingKicks/reapDeadStanding/bindSession's pid-fallback all now require
// a console table proving identity, matching what autopilot's real cycle
// supplies. table() builds one; identify() also stamps it onto the bound standing,
// matching the order autopilot really runs in (stamp, then decide).
const ISO = "2026-08-01T00:00:00.000Z";
const table = (pid, iso = ISO) => ({ [String(pid)]: iso });
function identify(pid = LIVE, iso = ISO) {
  m.stampConsoles(table(pid, iso), { now: Date.now(), graceMs: 120000 });
  return table(pid, iso);
}

test("a standing survives as a file and starts unbound", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "ship the thing", cwd: "C:/code", profile: "Normal" });
  assert.match(g.id, /^so-\d{8}-/);
  assert.equal(g.status, "active");
  assert.equal(g.needsKick, false, "an unbound standing has no console to type into");
  assert.equal(m.readStanding(g.id).text, "ship the thing");
});

test("multi-line standing text round-trips intact (OI-004: text never becomes keystrokes)", async () => {
  const { m } = await loadStanding();
  const text = "line one\nline two\n\n- a bullet\n- another";
  const g = m.createStanding({ text });
  assert.equal(m.readStanding(g.id).text, text);
});

test("--text-file carries a multi-line standing the command line could not (GUI path)", async () => {
  const { m, dir } = await loadStanding();
  const text = "rebuild the screen\n\n- keep the tabs\n- one green button\n";
  const f = path.join(dir, "standing.txt");
  fs.writeFileSync(f, "﻿" + text, "utf8"); // PowerShell writes a BOM; it must not survive
  assert.equal(m.textFromArgs(["new", "--text-file", f]), text);
  assert.equal(m.textFromArgs(["new", "--text", "typed"]), "typed");
});

test("binding by ACC_STANDING arms a kick; re-binding the same session does not", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  const b1 = m.bindSession({ sessionId: SID(1), consolePid: LIVE, standingId: g.id });
  assert.equal(b1.needsKick, true);
  assert.equal(b1.consolePid, LIVE);

  m.markKicked(g.id);
  const b2 = m.bindSession({ sessionId: SID(1), consolePid: LIVE, standingId: g.id });
  assert.equal(b2.needsKick, false, "same session re-firing SessionStart must not re-kick");
});

test("a NEW session in the same console adopts the standing and arms a kick - this is the clear-survival path", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, standingId: g.id });
  m.markKicked(g.id);
  const consoles = identify(LIVE);

  // No standingId this time: exactly what a post-/clear SessionStart looks like.
  const b = m.bindSession({ sessionId: SID(2), consolePid: LIVE, consoles });
  assert.equal(b.id, g.id, "adopted by console pid, not session id");
  assert.equal(b.needsKick, true);
});

test("a session in a DIFFERENT console adopts nothing", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, standingId: g.id });
  assert.equal(m.bindSession({ sessionId: SID(2), consolePid: LIVE + 1 }), null);
});

test("a finished standing is never adopted", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, standingId: g.id });
  m.setStatus(g.id, "done");
  assert.equal(m.bindSession({ sessionId: SID(2), consolePid: LIVE }), null);
  assert.equal(m.bindSession({ sessionId: SID(3), consolePid: LIVE, standingId: g.id }), null);
});

test("pendingKicks refuses: too soon after binding", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, standingId: g.id });
  const consoles = identify(LIVE);
  assert.equal(m.pendingKicks(Date.now(), { consoles }).length, 0, "TUI is not ready the instant a session starts");
  assert.equal(m.pendingKicks(Date.now() + 10000, { consoles }).length, 1);
});

test("pendingKicks: tuiReadySettleMs overrides the default TUI-ready window (guards OI-003)", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, standingId: g.id });
  const consoles = identify(LIVE);
  const t0 = Date.parse(m.readStanding(g.id).boundAt);

  // Below the default (4000ms) but the override says this is plenty.
  const early = m.pendingKicks(t0 + 500, { tuiReadySettleMs: 200, consoles });
  assert.ok(early.find((k) => k.id === g.id), "an explicit override can be shorter than the default");

  // A stricter-than-default override still refuses before its own window.
  const strict = m.pendingKicks(t0 + 5000, { tuiReadySettleMs: 8000, consoles });
  assert.equal(strict.find((k) => k.id === g.id), undefined, "an explicit override can be longer than the default");
});

test("pendingKicks refuses: dead console", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: 0, standingId: g.id });
  assert.equal(m.pendingKicks(Date.now() + 10000, { consoles: {} }).length, 0);
});

test("pendingKicks refuses: within the cooldown", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, standingId: g.id });
  m.markKicked(g.id);
  const consoles = identify(LIVE);
  // Re-arm as a fresh session would, then ask immediately.
  m.bindSession({ sessionId: SID(2), consolePid: LIVE, consoles });
  assert.equal(m.pendingKicks(Date.now() + 10000, { consoles }).length, 0, "cooldown outranks a fresh binding");
  assert.equal(m.pendingKicks(Date.now() + 70000, { consoles }).length, 1);
});

test("pendingKicks refuses: standing paused mid-flight", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, standingId: g.id });
  m.setStatus(g.id, "paused");
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0);
});

test("cycles append to the log and the tail is bounded", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.appendCycle(g.id, { sessionId: "s1", ctx: 152000, text: "did the first half" });
  const after = m.appendCycle(g.id, { sessionId: "s2", ctx: 151000, text: "x".repeat(9000) });
  assert.equal(after.cycles, 2);

  const tail = m.logTail(g.id, 1000);
  assert.ok(tail.length <= 1000 + 40, `tail was ${tail.length} chars`);
  assert.match(tail, /earlier progress trimmed/);
  assert.match(m.logTail(g.id, 100000), /did the first half/);
  assert.match(m.logTail(g.id, 100000), /ended at 152k/);
});

test("a done standing is archived out of the live directory", async () => {
  const { m, dir } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.setStatus(g.id, "done", "shipped");
  assert.equal(m.listStanding().length, 0, "live dir holds only work in flight");
  assert.ok(fs.existsSync(path.join(dir, "done", `${g.id}.json`)));
  assert.match(fs.readFileSync(path.join(dir, "done", `${g.id}.log.md`), "utf8"), /DONE/);
});

test("standing ids cannot escape the standing orders directory", async () => {
  const { m } = await loadStanding();
  assert.equal(m.readStanding("../../../etc/passwd"), null);
  assert.equal(m.setStatus("..\\..\\evil", "done"), null);
});

// --- hybrid re-kick rules (autonomy hardening, 2026-07-31) -----------------
// The loop stalled twice on 2026-07-31 because ONLY an over-budget stop could
// continue it: a standing session that ended its turn under the ceiling sat dead
// (18 minutes, once) until a human typed. These pin the rules that make an
// under-budget turn end resume by itself - and the rules that keep it quiet
// while Kyle is actually using that console.

test("recordTurnEnd re-arms the kick and stamps the turn end", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, standingId: g.id });
  m.markKicked(g.id); // a kick already fired, as after a resume
  assert.equal(m.readStanding(g.id).needsKick, false);

  m.recordTurnEnd(g.id, { human: false });
  const after = m.readStanding(g.id);
  assert.equal(after.needsKick, true, "kick re-armed");
  assert.ok(after.turnEndedAt, "turnEndedAt stamped");
  assert.ok(!after.humanPromptAt, "the kick constant is a MACHINE turn");
});

test("a human-prompted turn end records the human timestamp", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(2), consolePid: LIVE, standingId: g.id });
  m.recordTurnEnd(g.id, { human: true });
  assert.ok(m.readStanding(g.id).humanPromptAt, "humanPromptAt stamped");
});

test("kick waits for the settle window, then fires", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(3), consolePid: LIVE, standingId: g.id });
  m.markKicked(g.id);
  m.recordTurnEnd(g.id, { human: false });
  const consoles = identify(LIVE);
  const t0 = Date.parse(m.readStanding(g.id).turnEndedAt);

  const tooSoon = m.pendingKicks(t0 + 30_000, { kickSettleSeconds: 90, consoles });
  assert.equal(tooSoon.find((k) => k.id === g.id), undefined, "30s < 90s settle");

  // Past settle AND past the 60s cooldown from markKicked.
  const ready = m.pendingKicks(t0 + 120_000, { kickSettleSeconds: 90, consoles });
  assert.ok(ready.find((k) => k.id === g.id), "fires once settled");
});

test("a human prompt holds the kick off, and the hold expires", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(4), consolePid: LIVE, standingId: g.id });
  m.markKicked(g.id);
  m.recordTurnEnd(g.id, { human: true });
  const consoles = identify(LIVE);
  const t0 = Date.parse(m.readStanding(g.id).humanPromptAt);

  const held = m.pendingKicks(t0 + 120_000, { kickSettleSeconds: 90, humanHoldMinutes: 10, consoles });
  assert.equal(held.find((k) => k.id === g.id), undefined, "quiet while Kyle is engaged");

  const freed = m.pendingKicks(t0 + 11 * 60_000, { kickSettleSeconds: 90, humanHoldMinutes: 10, consoles });
  assert.ok(freed.find((k) => k.id === g.id), "self-heals after the hold");
});

test("a finished standing is never kicked, however long you wait", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(5), consolePid: LIVE, standingId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  m.setStatus(g.id, "done", "finished");
  assert.equal(m.pendingKicks(Date.now() + 86_400_000).find((k) => k.id === g.id), undefined);
});

test("a dead console is never kicked, however long you wait", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(6), consolePid: 999999, standingId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  assert.equal(m.pendingKicks(Date.now() + 86_400_000).find((k) => k.id === g.id), undefined);
});

// --- error paths and edge branches not reachable via the happy-path tests --

test("createStanding refuses empty/whitespace-only/absent text", () => {
  assert.throws(() => m.createStanding({ text: "   " }), /a standing order needs text/);
  assert.throws(() => m.createStanding({}), /a standing order needs text/, "text itself is undefined, not just blank");
});

test("bindSession discards an explicit standingId whose standing exists but is not active", () => {
  const g = m.createStanding({ text: "t" });
  m.setStatus(g.id, "paused"); // paused stays in the live dir (unlike done/blocked), so readStanding still finds it
  assert.equal(m.bindSession({ sessionId: SID(33), consolePid: LIVE, standingId: g.id }), null);
});

test("bindSession sets cwd only when the standing doesn't already have one", () => {
  const g = m.createStanding({ text: "t" }); // no cwd at creation
  const b = m.bindSession({ sessionId: SID(34), consolePid: LIVE, standingId: g.id, cwd: "C:/new" });
  assert.equal(b.cwd, "C:/new");
});

test("appendCycle on a nonexistent standing returns null; missing text/sessionId/ctx fall back cleanly", () => {
  assert.equal(m.appendCycle("g-doesnotexist", { text: "x" }), null);
  const g = m.createStanding({ text: "t" });
  const after = m.appendCycle(g.id, {});
  assert.equal(after.cycles, 1);
  assert.match(m.logTail(g.id, 10000), /_session \? ended at 0k_/);
  assert.match(m.logTail(g.id, 10000), /no closing summary captured/);
});

test("appendCycle swallows a log-write failure instead of throwing", () => {
  const g = m.createStanding({ text: "t" });
  fs.rmSync(m.logPath(g.id));
  fs.mkdirSync(m.logPath(g.id)); // appendFileSync against a directory throws EISDIR
  const after = m.appendCycle(g.id, { text: "x" });
  assert.equal(after.cycles, 1, "cycle count still advances even though the log write failed");
});

test("setStatus swallows a log-write failure and an archive failure instead of throwing", () => {
  const g1 = m.createStanding({ text: "t1" });
  fs.rmSync(m.logPath(g1.id));
  fs.mkdirSync(m.logPath(g1.id));
  const s1 = m.setStatus(g1.id, "done", "note"); // log-append fails; archiving is independent and still proceeds
  assert.equal(s1.status, "done");

  const g2 = m.createStanding({ text: "t2" });
  fs.rmSync(path.join(STANDING_DIR, "done"), { recursive: true, force: true });
  fs.writeFileSync(path.join(STANDING_DIR, "done"), "blocking file where the archive dir should be");
  const s2 = m.setStatus(g2.id, "done", "shipped");
  assert.equal(s2.status, "done", "the live record still updates even though archiving failed");
});

test("recordTurnEnd and markKicked return null for a nonexistent or non-active standing", () => {
  assert.equal(m.recordTurnEnd("g-doesnotexist", {}), null);
  assert.equal(m.markKicked("g-doesnotexist"), null);
  const g = m.createStanding({ text: "t" });
  m.setStatus(g.id, "paused");
  assert.equal(m.recordTurnEnd(g.id, {}), null, "a paused standing is not active");
});

test("CLI: main() 'log' swallows a log-write failure instead of throwing", () => {
  const g = m.createStanding({ text: "t" });
  fs.rmSync(m.logPath(g.id));
  fs.mkdirSync(m.logPath(g.id));
  assert.equal(runMain(["log", g.id, "--text", "x"]), `logged to ${m.logPath(g.id)}`);
});

// --- OI-006: a hand-run SessionStart cannot hijack a live standing's binding ---

test("OI-006: a non-UUID sessionId cannot hijack an active standing's binding", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(30), consolePid: LIVE, standingId: g.id });
  m.markKicked(g.id);
  const before = m.readStanding(g.id);
  const consoles = identify(LIVE);

  // Exactly the reproduction from the ledger: a hand-run SessionStart payload
  // ("hbtest") aimed at a console that owns a real standing.
  const hijacked = m.bindSession({ sessionId: "hbtest", consolePid: LIVE, consoles });
  assert.equal(hijacked.id, g.id, "console-pid adoption still runs unchanged");
  assert.equal(hijacked.sessionId, before.sessionId, "the real session id must survive a garbage rebind attempt");
  assert.equal(hijacked.needsKick, false, "a garbage id must never arm a kick");
  assert.equal(hijacked.boundAt, before.boundAt, "boundAt must not be touched by a garbage rebind");
});

test("OI-006: a real UUID sessionId still adopts normally after a clear", async () => {
  const { m } = await loadStanding();
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(31), consolePid: LIVE, standingId: g.id });
  m.markKicked(g.id);
  const consoles = identify(LIVE);

  const adopted = m.bindSession({ sessionId: SID(32), consolePid: LIVE, consoles });
  assert.equal(adopted.id, g.id);
  assert.equal(adopted.sessionId, SID(32), "a real UUID rebinds normally");
  assert.equal(adopted.needsKick, true, "a genuinely new session arms a kick");
});

// --- direct unit coverage for the remaining exported helpers ---------------

test("standingForSession finds an active standing by exact sessionId, and refuses no id / no match", () => {
  assert.equal(m.standingForSession(""), null, "no sessionId given");
  assert.equal(m.standingForSession(SID(20)), null, "no standing orders exist yet");
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(20), consolePid: LIVE, standingId: g.id });
  assert.equal(m.standingForSession(SID(20)).id, g.id);
  assert.equal(m.standingForSession(SID(21)), null, "a different session matches nothing");
});

test("listStanding returns [] instead of throwing when the standing orders directory doesn't exist yet", () => {
  fs.rmSync(STANDING_DIR, { recursive: true, force: true });
  assert.deepEqual(m.listStanding(), []);
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

test("CLI: main() 'new' creates a standing via --text and prints it", () => {
  const printed = JSON.parse(runMain(["new", "--text", "cli standing"]));
  assert.equal(printed.text, "cli standing");
  assert.ok(m.readStanding(printed.id));
});

test("CLI: main() with no subcommand defaults to 'list', printing active standing orders as JSON", () => {
  const g = m.createStanding({ text: "t" });
  const printed = JSON.parse(runMain([]));
  assert.ok(printed.some((x) => x.id === g.id));
});

// 'pending' now reads the console table from stdin (OI-034, Task 5), so it can
// no longer be exercised via the in-process runMain() helper: a blocking
// readFileSync(0) with nothing behind it (or a stream node's test runner
// never closes) would hang the whole file rather than see EOF. execFileSync's
// `input` option always supplies and closes stdin, matching what
// autopilot.ps1 really does every cycle.
test("CLI: main() 'pending' prints pending kicks, reading policy.json dials when present and falling back when not", async () => {
  const { execFileSync } = await import("node:child_process");
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(40), consolePid: LIVE, standingId: g.id });

  const run = (extraEnv = {}) =>
    execFileSync(process.execPath, [path.resolve("core/standing.mjs"), "pending"], {
      input: JSON.stringify(table(LIVE)),
      encoding: "utf8",
      env: { ...process.env, ACC_STANDING_DIR: STANDING_DIR, ...extraEnv },
    });

  delete process.env.ACC_POLICY; // not inherited unless set below
  assert.doesNotThrow(() => JSON.parse(run()), "resolves to the real repo policy.json - exercises the try branch");
  assert.doesNotThrow(
    () => JSON.parse(run({ ACC_POLICY: path.join(STANDING_DIR, "does-not-exist.json") })),
    "missing policy.json falls back to defaults - exercises the catch branch"
  );
});

test("CLI: malformed stdin (not valid JSON) is treated as no console table, not a crash", async () => {
  const { execFileSync } = await import("node:child_process");
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(42), consolePid: LIVE, standingId: g.id });

  const out = execFileSync(process.execPath, [path.resolve("core/standing.mjs"), "pending"], {
    input: "not valid json{",
    encoding: "utf8",
    env: { ...process.env, ACC_STANDING_DIR: STANDING_DIR },
  });
  assert.deepEqual(JSON.parse(out), [], "no table -> pendingKicks fails closed, per its own header rule");
});

test("CLI: main() 'kicked <id>' clears needsKick", () => {
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(41), consolePid: LIVE, standingId: g.id });
  assert.equal(m.readStanding(g.id).needsKick, true);
  runMain(["kicked", g.id]);
  assert.equal(m.readStanding(g.id).needsKick, false);
});

test("CLI: main() 'show' resolves an explicit id, the sole active standing, refuses to guess among several, and falls back to 'no active standing order'", () => {
  assert.equal(runMain(["show"]), "no active standing order", "no active standing orders at all");
  const g1 = m.createStanding({ text: "t1" });
  assert.equal(JSON.parse(runMain(["show", g1.id])).id, g1.id, "explicit positional id");
  assert.equal(JSON.parse(runMain(["show"])).id, g1.id, "resolveId falls back to the sole active standing");
  m.createStanding({ text: "t2" });
  assert.equal(runMain(["show"]), "no active standing order", "resolveId refuses to guess among multiple active standing orders");
});

test("CLI: main() 'log' appends via --text or trailing positional words, and refuses with no resolvable standing", () => {
  assert.equal(runMain(["log", "whatever", "--text", "x"]), "no active standing order", "no standing exists yet to log against");
  const g = m.createStanding({ text: "t" });
  runMain(["log", g.id, "--text", "explicit flag note"]);
  assert.match(m.logTail(g.id, 10000), /explicit flag note/);
  runMain(["log", g.id, "trailing", "positional", "words"]);
  assert.match(m.logTail(g.id, 10000), /trailing positional words/);
});

test("CLI: main() 'done'/'blocked'/'paused' set status via resolveId, and refuse without a resolvable id", () => {
  assert.equal(runMain(["done"]), "no active standing order (pass the id)");

  const g1 = m.createStanding({ text: "t1" });
  assert.equal(runMain(["done", g1.id]), `standing ${g1.id} -> done`);
  assert.equal(m.readStanding(g1.id), null, "done archives the standing out of the live directory");

  const g2 = m.createStanding({ text: "t2" });
  assert.equal(runMain(["blocked", g2.id, "--why", "stuck"]), `standing ${g2.id} -> blocked`);
  assert.equal(m.readStanding(g2.id), null, "blocked also archives the standing out of the live directory");

  const g3 = m.createStanding({ text: "t3" });
  assert.equal(runMain(["paused", g3.id]), `standing ${g3.id} -> paused`);
  assert.equal(m.readStanding(g3.id).status, "paused");
});

test("CLI: main() prints usage for an unrecognized command", () => {
  assert.match(runMain(["frobnicate"]), /^usage: standing\.mjs/);
});

// ------------------------------------------------- reaping (guards OI-031)
// Six standing orders sat "active" from 2026-07-31 onward, every one bound to a console
// that had been gone for days, because nothing ever marked a standing dead when its
// console died. autopilot even LOGGED those deaths ("GUI-DEAD ... hosting GUI
// (pid 1620) is gone") and left the standing orders active. Detection without reaping.
const DEAD_PID = 999999;

test("OI-031: a standing whose console is gone is reaped and archived as abandoned", () => {
  const g = m.createStanding({ text: "stranded" });
  m.bindSession({ sessionId: SID(60), consolePid: DEAD_PID, standingId: g.id });

  const reaped = m.reapDeadStanding({ now: Date.now() + 3600_000, consoles: {} });

  assert.deepEqual(reaped, [g.id], "returns what it reaped so the caller can log it");
  assert.equal(m.readStanding(g.id), null, "archived out of the live directory");
  assert.ok(!m.activeStanding().some((x) => x.id === g.id), "gone from activeStanding()");
});

test("OI-031: 'abandoned' is distinct from done/blocked - the console died, the model did not finish", () => {
  const g = m.createStanding({ text: "stranded" });
  m.bindSession({ sessionId: SID(61), consolePid: DEAD_PID, standingId: g.id });
  m.reapDeadStanding({ now: Date.now() + 3600_000, consoles: {} });

  const archived = JSON.parse(
    fs.readFileSync(path.join(STANDING_DIR, "done", `${g.id}.json`), "utf8")
  );
  assert.equal(archived.status, "abandoned");
});

test("OI-031: a standing whose console is alive is never reaped", () => {
  const g = m.createStanding({ text: "working" });
  m.bindSession({ sessionId: SID(62), consolePid: LIVE, standingId: g.id });

  assert.deepEqual(m.reapDeadStanding({ now: Date.now() + 3600_000, consoles: table(LIVE) }), []);
  assert.equal(m.readStanding(g.id).status, "active");
});

// The GUI creates a standing and only then launches the console, so for a moment a
// brand-new standing legitimately has no live console. Reaping it there would kill
// the very launch it belongs to.
test("OI-031: a standing that has not been bound yet is protected by the grace window", () => {
  const g = m.createStanding({ text: "just launched" }); // no bindSession: console not up yet

  assert.deepEqual(m.reapDeadStanding({ now: Date.now(), graceMs: 120_000, consoles: {} }), []);
  assert.equal(m.readStanding(g.id).status, "active", "still active inside the grace window");

  // Once the window closes with no console ever having bound, the launch failed.
  assert.deepEqual(m.reapDeadStanding({ now: Date.now() + 120_001, graceMs: 120_000, consoles: {} }), [g.id]);
});

// A standing that HAS bound was attached to a console that provably existed at that
// moment, so a dead pid now means the console died - no grace applies.
test("OI-031: a bound standing whose console died is reaped immediately, grace notwithstanding", () => {
  const g = m.createStanding({ text: "console died" });
  m.bindSession({ sessionId: SID(63), consolePid: DEAD_PID, standingId: g.id });

  assert.deepEqual(m.reapDeadStanding({ now: Date.now(), graceMs: 120_000, consoles: {} }), [g.id]);
});

test("OI-031: a reaped standing is never kicked", () => {
  const g = m.createStanding({ text: "stranded" });
  m.bindSession({ sessionId: SID(64), consolePid: DEAD_PID, standingId: g.id });
  m.reapDeadStanding({ now: Date.now() + 3600_000, consoles: {} });

  assert.deepEqual(m.pendingKicks(Date.now() + 7200_000, { consoles: {} }), []);
});

// CLI 'reap' does not yet read a console table (Task 5 wires that in, the same
// way 'pending' reads one from stdin), so until then it is honestly fail-closed
// like reapDeadStanding is with no table: it destroys nothing on a guess.
// 'reap' reads the same stdin table as 'pending' (OI-034, Task 5), for the same
// reason it can no longer run through the in-process runMain() helper - see the
// comment on the 'pending' CLI test above.
async function runReap(input) {
  const { execFileSync } = await import("node:child_process");
  return execFileSync(process.execPath, [path.resolve("core/standing.mjs"), "reap"], {
    input,
    encoding: "utf8",
    env: { ...process.env, ACC_STANDING_DIR: STANDING_DIR },
  });
}

test("CLI: main() 'reap' is fail-closed with empty stdin - it does not guess", async () => {
  const g = m.createStanding({ text: "stranded" });
  m.bindSession({ sessionId: SID(65), consolePid: DEAD_PID, standingId: g.id });

  assert.equal((await runReap("")).trim(), "reaped 0");
  assert.ok(m.readStanding(g.id), "nothing is reaped without proof the console is gone");
});

test("CLI: main() 'reap' archives dead-console standing orders and names them, given a console table", async () => {
  const g = m.createStanding({ text: "stranded" });
  m.bindSession({ sessionId: SID(66), consolePid: DEAD_PID, standingId: g.id });

  // {} is a caller asserting "I enumerated every process and this pid was not
  // among them" - proof the console is gone, same as autopilot's real table.
  assert.equal((await runReap("{}")).trim(), `reaped 1: ${g.id}`);
  assert.equal(m.readStanding(g.id), null);
  assert.equal((await runReap("{}")).trim(), "reaped 0", "nothing left to reap");
});

test("a standing persists correctly after its directory is moved to a new location", async () => {
  const { m, dir } = await loadStanding();

  // Create a standing in the original directory
  const g = m.createStanding({ text: "portable standing", cwd: "C:/code" });
  const originalStandingJson = m.readStanding(g.id);
  assert.ok(originalStandingJson);
  assert.equal(originalStandingJson.text, "portable standing");

  // Move the entire standing orders directory to a new location
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-standing-moved-"));
  try {
    // Copy the original directory contents
    const moveDir = path.join(newDir, "moved-standing orders");
    fs.cpSync(dir, moveDir, { recursive: true });

    // Update the environment to point to the new location
    const savedStandingDir = process.env.ACC_STANDING_DIR;
    process.env.ACC_STANDING_DIR = moveDir;

    // Verify the standing can still be read from the new location
    // standingDir() resolves from the environment variable on every call
    const movedStandingJson = m.readStanding(g.id);
    assert.ok(movedStandingJson, "standing can be read from moved directory");
    assert.equal(movedStandingJson.text, "portable standing");
    assert.equal(movedStandingJson.id, g.id);

    // Verify listStanding also finds it in the new location
    const listedStanding = m.listStanding();
    assert.ok(listedStanding.some(standing => standing.id === g.id), "standing appears in list after directory move");

    // Restore the original directory reference
    process.env.ACC_STANDING_DIR = savedStandingDir;
  } finally {
    fs.rmSync(newDir, { recursive: true, force: true });
  }
});

// OI-034: console identity is (pid, startTime), not pid alone.
test("a recycled pid is dead, not alive - the OI-034 mistarget, reproduced", () => {
  const standing = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  const consoles = { 4242: "2026-08-04T18:30:00.000Z" }; // same pid, new process
  assert.equal(m.consoleState(standing, consoles), "dead");
});

test("a live console whose start time matches is alive", () => {
  const standing = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  assert.equal(m.consoleState(standing, { 4242: "2026-08-04T10:00:00.000Z" }), "alive");
});

test("a pid absent from the table is dead", () => {
  const standing = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  assert.equal(m.consoleState(standing, { 999: "2026-08-04T10:00:00.000Z" }), "dead");
});

test("a pid present but not yet stamped is unknown, not a guess", () => {
  const standing = { consolePid: 4242 };
  assert.equal(m.consoleState(standing, { 4242: "2026-08-04T10:00:00.000Z" }), "unknown");
});

test("no table means unknown - never a guess in either direction", () => {
  const standing = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  assert.equal(m.consoleState(standing, undefined), "unknown");
});

test("a standing inside the grace window is stamped from the table on first sighting", () => {
  const g = m.createStanding({ text: "keep tests green", cwd: "C:/code/example-project" });
  m.bindSession({ sessionId: SID(70), consolePid: 4242, standingId: g.id });
  const stamped = m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  assert.deepEqual(stamped, [g.id]);
  assert.equal(m.readStanding(g.id).consoleStartedAt, "2026-08-04T10:00:00.000Z");
});

test("stamping is idempotent - an already stamped standing is left alone", () => {
  const g = m.createStanding({ text: "t", cwd: "C:/code/example-project" });
  m.bindSession({ sessionId: SID(71), consolePid: 4242, standingId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const again = m.stampConsoles({ 4242: "2026-08-04T99:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  assert.deepEqual(again, []);
  assert.equal(m.readStanding(g.id).consoleStartedAt, "2026-08-04T10:00:00.000Z");
});

test("a standing older than the grace window is never stamped - legacy stays unidentifiable", () => {
  const g = m.createStanding({ text: "t", cwd: "C:/code/example-project" });
  m.bindSession({ sessionId: SID(72), consolePid: 4242, standingId: g.id });
  const later = Date.now() + 10 * 60 * 1000;
  assert.deepEqual(
    m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: later, graceMs: 120000 }),
    []
  );
  assert.equal(m.readStanding(g.id).consoleStartedAt, undefined);
});

// OI-034, Task 3: reap/kick fail closed without proof of identity.
test("pendingKicks returns nothing without a console table - fail closed", () => {
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(73), consolePid: LIVE, standingId: g.id });
  assert.deepEqual(m.pendingKicks(Date.now() + 10000, {}), []);
});

test("pendingKicks skips a standing whose console was recycled", () => {
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(74), consolePid: 4242, standingId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const kicks = m.pendingKicks(Date.now() + 10000, { consoles: { 4242: "2026-08-04T18:30:00.000Z" } });
  assert.deepEqual(kicks.find((k) => k.id === g.id), undefined);
});

test("pendingKicks returns a standing whose console identity matches", () => {
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(75), consolePid: 4242, standingId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const kicks = m.pendingKicks(Date.now() + 10000, { consoles: { 4242: "2026-08-04T10:00:00.000Z" } });
  assert.ok(kicks.find((k) => k.id === g.id));
});

test("a recycled console is reaped as abandoned and leaves activeStanding", () => {
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(76), consolePid: 4242, standingId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const reaped = m.reapDeadStanding({
    now: Date.now() + 10 * 60 * 1000,
    graceMs: 120000,
    consoles: { 4242: "2026-08-04T18:30:00.000Z" },
  });
  assert.deepEqual(reaped, [g.id]);
  assert.equal(m.readStanding(g.id), null);
  assert.equal(m.activeStanding().find((x) => x.id === g.id), undefined);
});

test("reapDeadStanding with no table reaps nothing - it never destroys on a guess", () => {
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(77), consolePid: 4242, standingId: g.id });
  assert.deepEqual(m.reapDeadStanding({ now: Date.now() + 10 * 60 * 1000, graceMs: 120000 }), []);
  assert.equal(m.readStanding(g.id).status, "active");
});

// OI-034, Task 4: bindSession's pid-fallback requires proof of identity too.
test("bindSession never adopts a standing whose console identity does not match", () => {
  const stale = m.createStanding({ text: "last week's task" });
  m.bindSession({ sessionId: SID(78), consolePid: 4242, standingId: stale.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });

  // A brand new session lands on the same pid, now owned by a different process.
  const adopted = m.bindSession({
    sessionId: SID(79),
    consolePid: 4242,
    consoles: { 4242: "2026-08-04T18:30:00.000Z" },
  });
  assert.equal(adopted, null, "must not inherit last week's task");
});

test("bindSession adopts by pid when the console identity matches", () => {
  const g = m.createStanding({ text: "t" });
  m.bindSession({ sessionId: SID(80), consolePid: 4242, standingId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const adopted = m.bindSession({
    sessionId: SID(81),
    consolePid: 4242,
    consoles: { 4242: "2026-08-04T10:00:00.000Z" },
  });
  assert.equal(adopted.id, g.id);
});

test("an explicit standingId still binds without a table", () => {
  const g = m.createStanding({ text: "t" });
  assert.equal(m.bindSession({ sessionId: SID(82), consolePid: 4242, standingId: g.id }).id, g.id);
});

// OI-034, Task 6: existence is not identity - the OS-query check is gone.
test("consoleAlive is gone - existence is not identity", () => {
  assert.equal(m.consoleAlive, undefined);
});

test("standing.mjs never queries the OS - purity is what keeps kick rules in one file", () => {
  const src = fs.readFileSync(path.resolve("core/standing.mjs"), "utf8");
  assert.doesNotMatch(src, /child_process/);
  assert.doesNotMatch(src, /process\.kill\(/);
});

test("a legacy [ACC GOAL g-...] injection is still understood, and warns", () => {
  const r = m.parseInjection("[ACC GOAL g-20260804-1-abcd] keep tests green");
  assert.equal(r.id, "so-20260804-1-abcd");
  assert.match(r.deprecation, /\[ACC GOAL\] is deprecated/); // namegate-ok: the retired injection format is the subject of this test
});

test("the current [ACC STANDING so-...] injection parses with no deprecation warning", () => {
  const r = m.parseInjection("[ACC STANDING so-20260804-1-abcd] keep tests green");
  assert.equal(r.id, "so-20260804-1-abcd");
  assert.equal(r.deprecation, null);
});

test("text with no recognizable marker parses to a null id and no deprecation", () => {
  const r = m.parseInjection("just some text");
  assert.equal(r.id, null);
  assert.equal(r.deprecation, null);
});

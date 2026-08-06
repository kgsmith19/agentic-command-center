// Tests for the mission store (hooks/mission.mjs) - the thing that carries work across
// a /clear.
//
// The interesting behaviour is not "does it write a file". It is the set of
// conditions under which ACC is willing to TYPE INTO A CONSOLE unprompted, which
// is the only genuinely dangerous thing in the chain. So pendingKicks() gets
// tested against every reason it must refuse, not just the happy path.
//
// Run: node --test hooks/mission.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// mission.mjs captures ACC_MISSIONS_DIR into a module-load-time const, so isolating
// every test used to mean a fresh tmpdir + a cache-busted re-import
// (`?t=${n}`) per test. That broke coverage measurement: node's lcov
// reporter keys by file path with last-write-wins across those instances, so
// a full-suite run only ever reported the LAST test's coverage, not the
// union of all of them (proven directly: two tests run in different orders
// flip which lines show covered). Import once, isolate by wiping the same
// directory's contents between tests instead -- mission.mjs's own ensureDirs()
// (and listMissions'/readMission's already-tested "directory doesn't exist yet"
// fallbacks) recreate what each test needs on demand.
const MISSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acc-mission-"));
process.env.ACC_MISSIONS_DIR = MISSIONS_DIR;
const m = await import("./mission.mjs");

beforeEach(() => {
  fs.rmSync(MISSIONS_DIR, { recursive: true, force: true });
  fs.mkdirSync(MISSIONS_DIR, { recursive: true });
});

async function loadMission() {
  return { m, dir: MISSIONS_DIR };
}

// A pid that is certainly alive (this test process) and one that is certainly
// not (0 is never a real console).
const LIVE = process.pid;

// Real Claude Code session ids are always UUIDs (OI-006's bindSession guard
// rejects anything else as a rebind source), so every id used to exercise
// the rebind/adoption path below must actually look like one.
const SID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("a mission survives as a file and starts unbound", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "ship the thing", cwd: "C:/code", profile: "Normal" });
  assert.match(g.id, /^m-\d{8}-/);
  assert.equal(g.status, "active");
  assert.equal(g.needsKick, false, "an unbound mission has no console to type into");
  assert.equal(m.readMission(g.id).text, "ship the thing");
});

test("readMissionAnywhere finds a live mission via the normal path, and an archived one via the done dir", async () => {
  const { m } = await loadMission();
  const active = m.createMission({ text: "still going" });
  assert.deepEqual(m.readMissionAnywhere(active.id), m.readMission(active.id));

  const archived = m.createMission({ text: "finished" });
  m.setStatus(archived.id, "done", "shipped");
  assert.equal(m.readMission(archived.id), null, "archived missions are gone from the live lookup");
  const found = m.readMissionAnywhere(archived.id);
  assert.ok(found, "but still findable via readMissionAnywhere");
  assert.equal(found.status, "done");
  assert.equal(found.text, "finished");

  assert.equal(m.readMissionAnywhere("m-never-existed"), null);
});

test("multi-line mission text round-trips intact (OI-004: text never becomes keystrokes)", async () => {
  const { m } = await loadMission();
  const text = "line one\nline two\n\n- a bullet\n- another";
  const g = m.createMission({ text });
  assert.equal(m.readMission(g.id).text, text);
});

test("--text-file carries a multi-line mission the command line could not (GUI path)", async () => {
  const { m, dir } = await loadMission();
  const text = "rebuild the screen\n\n- keep the tabs\n- one green button\n";
  const f = path.join(dir, "mission.txt");
  fs.writeFileSync(f, "﻿" + text, "utf8"); // PowerShell writes a BOM; it must not survive
  assert.equal(m.textFromArgs(["new", "--text-file", f]), text);
  assert.equal(m.textFromArgs(["new", "--text", "typed"]), "typed");
});

test("binding by ACC_MISSION arms a kick; re-binding the same session does not", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  const b1 = m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  assert.equal(b1.needsKick, true);
  assert.equal(b1.consolePid, LIVE);

  m.markKicked(g.id);
  const b2 = m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  assert.equal(b2.needsKick, false, "same session re-firing SessionStart must not re-kick");
});

test("a NEW session in the same console adopts the mission and arms a kick - this is the clear-survival path", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id);

  // No missionId this time: exactly what a post-/clear SessionStart looks like.
  const b = m.bindSession({ sessionId: SID(2), consolePid: LIVE });
  assert.equal(b.id, g.id, "adopted by console pid, not session id");
  assert.equal(b.needsKick, true);
});

test("a session in a DIFFERENT console adopts nothing", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  assert.equal(m.bindSession({ sessionId: SID(2), consolePid: LIVE + 1 }), null);
});

test("a finished mission is never adopted", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  m.setStatus(g.id, "done");
  assert.equal(m.bindSession({ sessionId: SID(2), consolePid: LIVE }), null);
  assert.equal(m.bindSession({ sessionId: SID(3), consolePid: LIVE, missionId: g.id }), null);
});

test("pendingKicks refuses: too soon after binding", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  assert.equal(m.pendingKicks(Date.now()).length, 0, "TUI is not ready the instant a session starts");
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 1);
});

test("pendingKicks: tuiReadySettleMs overrides the default TUI-ready window (guards OI-003)", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  const t0 = Date.parse(m.readMission(g.id).boundAt);

  // Below the default (4000ms) but the override says this is plenty.
  const early = m.pendingKicks(t0 + 500, { tuiReadySettleMs: 200 });
  assert.ok(early.find((k) => k.id === g.id), "an explicit override can be shorter than the default");

  // A stricter-than-default override still refuses before its own window.
  const strict = m.pendingKicks(t0 + 5000, { tuiReadySettleMs: 8000 });
  assert.equal(strict.find((k) => k.id === g.id), undefined, "an explicit override can be longer than the default");
});

test("pendingKicks refuses: dead console", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: 0, missionId: g.id });
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0);
});

// Full-repo review (2026-08-06): policy.json's missions.autoResume was pure
// documentation -- no production code ever read it. A human setting it to
// false, believing that disarms unattended resumption, got the loop anyway,
// bounded only by whichever ceiling happened to still be enabled. This is
// the master off-switch, not a ceiling, which makes silently ignoring it
// worse than a soft limit drifting: it's the control a human reaches for
// FIRST when they want the loop to stop.
test("pendingKicks refuses everything when autoResume is explicitly false, even an otherwise fully-eligible mission", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 1, "sanity: eligible without the dial");
  assert.equal(m.pendingKicks(Date.now() + 10000, { autoResume: false }).length, 0, "autoResume:false must suppress every kick, unconditionally");
});

test("pendingKicks still kicks normally when autoResume is true or omitted (default-on, no behavior change)", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  assert.equal(m.pendingKicks(Date.now() + 10000, { autoResume: true }).length, 1);
  assert.equal(m.pendingKicks(Date.now() + 10000, {}).length, 1, "omitted must mean on, matching every mission created before this dial existed");
});

test("pendingKicks refuses: within the cooldown", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id);
  // Re-arm as a fresh session would, then ask immediately.
  m.bindSession({ sessionId: SID(2), consolePid: LIVE });
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0, "cooldown outranks a fresh binding");
  assert.equal(m.pendingKicks(Date.now() + 70000).length, 1);
});

test("pendingKicks refuses: mission paused mid-flight", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  m.setStatus(g.id, "paused");
  assert.equal(m.pendingKicks(Date.now() + 10000).length, 0);
});

test("cycles append to the log and the tail is bounded", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.appendCycle(g.id, { sessionId: "s1", ctx: 152000, text: "did the first half" });
  const after = m.appendCycle(g.id, { sessionId: "s2", ctx: 151000, text: "x".repeat(9000) });
  assert.equal(after.cycles, 2);

  const tail = m.logTail(g.id, 1000);
  assert.ok(tail.length <= 1000 + 40, `tail was ${tail.length} chars`);
  assert.match(tail, /earlier progress trimmed/);
  assert.match(m.logTail(g.id, 100000), /did the first half/);
  assert.match(m.logTail(g.id, 100000), /ended at 152k/);
});

test("a done mission is archived out of the live directory", async () => {
  const { m, dir } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.setStatus(g.id, "done", "shipped");
  assert.equal(m.listMissions().length, 0, "live dir holds only work in flight");
  assert.ok(fs.existsSync(path.join(dir, "done", `${g.id}.json`)));
  assert.match(fs.readFileSync(path.join(dir, "done", `${g.id}.log.md`), "utf8"), /DONE/);
});

test("mission ids cannot escape the missions directory", async () => {
  const { m } = await loadMission();
  assert.equal(m.readMission("../../../etc/passwd"), null);
  assert.equal(m.setStatus("..\\..\\evil", "done"), null);
});

// --- hybrid re-kick rules (autonomy hardening, 2026-07-31) -----------------
// The loop stalled twice on 2026-07-31 because ONLY an over-budget stop could
// continue it: a mission session that ended its turn under the ceiling sat dead
// (18 minutes, once) until a human typed. These pin the rules that make an
// under-budget turn end resume by itself - and the rules that keep it quiet
// while Kyle is actually using that console.

test("recordTurnEnd re-arms the kick and stamps the turn end", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(1), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id); // a kick already fired, as after a resume
  assert.equal(m.readMission(g.id).needsKick, false);

  m.recordTurnEnd(g.id, { human: false });
  const after = m.readMission(g.id);
  assert.equal(after.needsKick, true, "kick re-armed");
  assert.ok(after.turnEndedAt, "turnEndedAt stamped");
  assert.ok(!after.humanPromptAt, "the kick constant is a MACHINE turn");
});

test("a human-prompted turn end records the human timestamp", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(2), consolePid: LIVE, missionId: g.id });
  m.recordTurnEnd(g.id, { human: true });
  assert.ok(m.readMission(g.id).humanPromptAt, "humanPromptAt stamped");
});

test("kick waits for the settle window, then fires", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(3), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id);
  m.recordTurnEnd(g.id, { human: false });
  const t0 = Date.parse(m.readMission(g.id).turnEndedAt);

  const tooSoon = m.pendingKicks(t0 + 30_000, { kickSettleSeconds: 90 });
  assert.equal(tooSoon.find((k) => k.id === g.id), undefined, "30s < 90s settle");

  // Past settle AND past the 60s cooldown from markKicked.
  const ready = m.pendingKicks(t0 + 120_000, { kickSettleSeconds: 90 });
  assert.ok(ready.find((k) => k.id === g.id), "fires once settled");
});

test("a human prompt holds the kick off, and the hold expires", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(4), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id);
  m.recordTurnEnd(g.id, { human: true });
  const t0 = Date.parse(m.readMission(g.id).humanPromptAt);

  const held = m.pendingKicks(t0 + 120_000, { kickSettleSeconds: 90, humanHoldMinutes: 10 });
  assert.equal(held.find((k) => k.id === g.id), undefined, "quiet while Kyle is engaged");

  const freed = m.pendingKicks(t0 + 11 * 60_000, { kickSettleSeconds: 90, humanHoldMinutes: 10 });
  assert.ok(freed.find((k) => k.id === g.id), "self-heals after the hold");
});

test("a finished mission is never kicked, however long you wait", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(5), consolePid: LIVE, missionId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  m.setStatus(g.id, "done", "finished");
  assert.equal(m.pendingKicks(Date.now() + 86_400_000).find((k) => k.id === g.id), undefined);
});

test("a dead console is never kicked, however long you wait", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(6), consolePid: 999999, missionId: g.id });
  m.recordTurnEnd(g.id, { human: false });
  assert.equal(m.pendingKicks(Date.now() + 86_400_000).find((k) => k.id === g.id), undefined);
});

// --- OI-031: a mission bound to a console that's since closed must not sit
// "active" forever -- it must be reaped (archived out of the live dir) so
// list/pending only ever see genuinely live missions. ---

test("OI-031: reapDeadMissions archives a mission whose bound console pid is gone", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(50), consolePid: 999999, missionId: g.id });
  const reaped = m.reapDeadMissions();
  assert.deepEqual(reaped, [g.id]);
  assert.equal(m.readMission(g.id), null, "reaped mission is archived out of the live directory");
  assert.equal(m.listMissions().length, 0);
});

test("OI-031: reapDeadMissions leaves an unbound mission (consolePid 0) alone -- nothing yet to prove dead", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  assert.deepEqual(m.reapDeadMissions(), []);
  assert.equal(m.readMission(g.id).status, "active");
});

test("OI-031: reapDeadMissions leaves a LIVE console's mission alone", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(51), consolePid: LIVE, missionId: g.id });
  assert.deepEqual(m.reapDeadMissions(), []);
  assert.equal(m.readMission(g.id).status, "active");
});

test("OI-031: activeMissions()/list only ever show genuinely live missions -- a dead-console mission disappears on its own", async () => {
  const { m } = await loadMission();
  const live = m.createMission({ text: "still going" });
  m.bindSession({ sessionId: SID(52), consolePid: LIVE, missionId: live.id });
  const dead = m.createMission({ text: "console closed days ago" });
  m.bindSession({ sessionId: SID(53), consolePid: 999999, missionId: dead.id });

  const active = m.activeMissions();
  assert.equal(active.length, 1);
  assert.equal(active[0].id, live.id);
  assert.equal(m.readMission(dead.id), null, "the dead one was reaped as a side effect of listing");
});

// OI-034: a reboot leaves a reaped mission totally silent. Not auto-resumed
// (deliberately — see the entry) but no longer silent: reaping now writes
// an alert, and hooks/budget.mjs's SessionStart consumes it once.
test("OI-034: reapDeadMissions writes a dead-mission alert file alongside archiving it", async () => {
  const { m, dir } = await loadMission();
  const alerts = path.join(dir, "alerts");
  process.env.ACC_ALERTS_DIR = alerts;
  try {
    const g = m.createMission({ text: "interrupted work" });
    m.bindSession({ sessionId: SID(54), consolePid: 999999, missionId: g.id });
    assert.deepEqual(m.reapDeadMissions(), [g.id]);

    const alertFile = path.join(alerts, `${g.id}.dead.json`);
    assert.ok(fs.existsSync(alertFile), "an alert file is written for the reaped mission");
    const alert = JSON.parse(fs.readFileSync(alertFile, "utf8"));
    assert.equal(alert.id, g.id);
    assert.equal(alert.text, "interrupted work");
    assert.match(alert.why, /console pid 999999 is gone/);
  } finally {
    delete process.env.ACC_ALERTS_DIR;
  }
});

test("OI-034: consumeDeadMissionAlerts reads and clears every alert; a second call finds nothing left", async () => {
  const { m, dir } = await loadMission();
  const alerts = path.join(dir, "alerts");
  process.env.ACC_ALERTS_DIR = alerts;
  try {
    const g1 = m.createMission({ text: "one" });
    m.bindSession({ sessionId: SID(55), consolePid: 999998, missionId: g1.id });
    const g2 = m.createMission({ text: "two" });
    m.bindSession({ sessionId: SID(56), consolePid: 999997, missionId: g2.id });
    m.reapDeadMissions();

    const consumed = m.consumeDeadMissionAlerts();
    assert.equal(consumed.length, 2);
    assert.deepEqual(consumed.map((a) => a.id).sort(), [g1.id, g2.id].sort());
    assert.deepEqual(fs.readdirSync(alerts).filter((f) => f.endsWith(".dead.json")), [], "every alert file is cleared");
    assert.deepEqual(m.consumeDeadMissionAlerts(), [], "nothing left to consume the second time");
  } finally {
    delete process.env.ACC_ALERTS_DIR;
  }
});

test("OI-034: consumeDeadMissionAlerts returns [] when the alerts dir does not exist at all", async () => {
  const { m, dir } = await loadMission();
  // A dedicated, never-touched subdirectory -- other tests in this file
  // that don't override ACC_ALERTS_DIR share the module's DEFAULT alerts
  // path, and (correctly, now that reapDeadMissions always alerts) leave real
  // .dead.json files there, so asserting "nothing exists yet" against that
  // shared default would be order-dependent on whatever ran earlier.
  process.env.ACC_ALERTS_DIR = path.join(dir, "alerts-never-touched");
  try {
    assert.deepEqual(m.consumeDeadMissionAlerts(), []);
  } finally {
    delete process.env.ACC_ALERTS_DIR;
  }
});

test("CLI: main() 'reap' reports which missions it archived", () => {
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(54), consolePid: 999999, missionId: g.id });
  assert.deepEqual(JSON.parse(runMain(["reap"])), [g.id]);
});

// --- error paths and edge branches not reachable via the happy-path tests --

test("createMission refuses empty/whitespace-only/absent text", () => {
  assert.throws(() => m.createMission({ text: "   " }), /a mission needs text/);
  assert.throws(() => m.createMission({}), /a mission needs text/, "text itself is undefined, not just blank");
});

test("bindSession discards an explicit missionId whose mission exists but is not active", () => {
  const g = m.createMission({ text: "t" });
  m.setStatus(g.id, "paused"); // paused stays in the live dir (unlike done/blocked), so readMission still finds it
  assert.equal(m.bindSession({ sessionId: SID(33), consolePid: LIVE, missionId: g.id }), null);
});

test("bindSession sets cwd only when the mission doesn't already have one", () => {
  const g = m.createMission({ text: "t" }); // no cwd at creation
  const b = m.bindSession({ sessionId: SID(34), consolePid: LIVE, missionId: g.id, cwd: "C:/new" });
  assert.equal(b.cwd, "C:/new");
});

test("appendCycle on a nonexistent mission returns null; missing text/sessionId/ctx fall back cleanly", () => {
  assert.equal(m.appendCycle("m-doesnotexist", { text: "x" }), null);
  const g = m.createMission({ text: "t" });
  const after = m.appendCycle(g.id, {});
  assert.equal(after.cycles, 1);
  assert.match(m.logTail(g.id, 10000), /_session \? ended at 0k_/);
  assert.match(m.logTail(g.id, 10000), /no closing summary captured/);
});

test("appendCycle swallows a log-write failure instead of throwing", () => {
  const g = m.createMission({ text: "t" });
  fs.rmSync(m.logPath(g.id));
  fs.mkdirSync(m.logPath(g.id)); // appendFileSync against a directory throws EISDIR
  const after = m.appendCycle(g.id, { text: "x" });
  assert.equal(after.cycles, 1, "cycle count still advances even though the log write failed");
});

test("setStatus swallows a log-write failure and an archive failure instead of throwing", () => {
  const g1 = m.createMission({ text: "t1" });
  fs.rmSync(m.logPath(g1.id));
  fs.mkdirSync(m.logPath(g1.id));
  const s1 = m.setStatus(g1.id, "done", "note"); // log-append fails; archiving is independent and still proceeds
  assert.equal(s1.status, "done");

  const g2 = m.createMission({ text: "t2" });
  fs.rmSync(path.join(MISSIONS_DIR, "done"), { recursive: true, force: true });
  fs.writeFileSync(path.join(MISSIONS_DIR, "done"), "blocking file where the archive dir should be");
  const s2 = m.setStatus(g2.id, "done", "shipped");
  assert.equal(s2.status, "done", "the live record still updates even though archiving failed");
});

test("recordTurnEnd and markKicked return null for a nonexistent or non-active mission", () => {
  assert.equal(m.recordTurnEnd("m-doesnotexist", {}), null);
  assert.equal(m.markKicked("m-doesnotexist"), null);
  const g = m.createMission({ text: "t" });
  m.setStatus(g.id, "paused");
  assert.equal(m.recordTurnEnd(g.id, {}), null, "a paused mission is not active");
});

test("CLI: main() 'log' swallows a log-write failure instead of throwing", () => {
  const g = m.createMission({ text: "t" });
  fs.rmSync(m.logPath(g.id));
  fs.mkdirSync(m.logPath(g.id));
  assert.equal(runMain(["log", g.id, "--text", "x"]), `logged to ${m.logPath(g.id)}`);
});

// --- OI-006: a hand-run SessionStart cannot hijack a live mission's binding ---

test("OI-006: a non-UUID sessionId cannot hijack an active mission's binding", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(30), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id);
  const before = m.readMission(g.id);

  // Exactly the reproduction from the ledger: a hand-run SessionStart payload
  // ("hbtest") aimed at a console that owns a real mission.
  const hijacked = m.bindSession({ sessionId: "hbtest", consolePid: LIVE });
  assert.equal(hijacked.id, g.id, "console-pid adoption still runs unchanged");
  assert.equal(hijacked.sessionId, before.sessionId, "the real session id must survive a garbage rebind attempt");
  assert.equal(hijacked.needsKick, false, "a garbage id must never arm a kick");
  assert.equal(hijacked.boundAt, before.boundAt, "boundAt must not be touched by a garbage rebind");
});

test("OI-006: a real UUID sessionId still adopts normally after a clear", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(31), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id);

  const adopted = m.bindSession({ sessionId: SID(32), consolePid: LIVE });
  assert.equal(adopted.id, g.id);
  assert.equal(adopted.sessionId, SID(32), "a real UUID rebinds normally");
  assert.equal(adopted.needsKick, true, "a genuinely new session arms a kick");
});

// --- direct unit coverage for the remaining exported helpers ---------------

test("missionForSession finds an active mission by exact sessionId, and refuses no id / no match", () => {
  assert.equal(m.missionForSession(""), null, "no sessionId given");
  assert.equal(m.missionForSession(SID(20)), null, "no missions exist yet");
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(20), consolePid: LIVE, missionId: g.id });
  assert.equal(m.missionForSession(SID(20)).id, g.id);
  assert.equal(m.missionForSession(SID(21)), null, "a different session matches nothing");
});

test("listMissions returns [] instead of throwing when the missions directory doesn't exist yet", () => {
  fs.rmSync(MISSIONS_DIR, { recursive: true, force: true });
  assert.deepEqual(m.listMissions(), []);
});

test("logTail returns '' instead of throwing when the log file doesn't exist", () => {
  assert.equal(m.logTail("m-doesnotexist"), "");
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

test("CLI: main() 'new' creates a mission via --text and prints it", () => {
  const printed = JSON.parse(runMain(["new", "--text", "cli mission"]));
  assert.equal(printed.text, "cli mission");
  assert.ok(m.readMission(printed.id));
});

test("CLI: main() with no subcommand defaults to 'list', printing active missions as JSON", () => {
  const g = m.createMission({ text: "t" });
  const printed = JSON.parse(runMain([]));
  assert.ok(printed.some((x) => x.id === g.id));
});

test("CLI: main() 'pending' prints pending kicks, reading policy.json dials when present and falling back when not", () => {
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(40), consolePid: LIVE, missionId: g.id });

  const savedPolicy = process.env.ACC_POLICY;
  try {
    delete process.env.ACC_POLICY; // resolves to the real repo policy.json -- exercises the try branch
    assert.doesNotThrow(() => JSON.parse(runMain(["pending"])));

    process.env.ACC_POLICY = path.join(MISSIONS_DIR, "does-not-exist.json"); // exercises the catch branch
    assert.doesNotThrow(() => JSON.parse(runMain(["pending"])));
  } finally {
    if (savedPolicy === undefined) delete process.env.ACC_POLICY;
    else process.env.ACC_POLICY = savedPolicy;
  }
});

test("CLI: main() 'pending' honors a real policy.json's missions.autoResume:false end to end", () => {
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(41), consolePid: LIVE, missionId: g.id });
  // Back-date boundAt past the TUI-ready-settle window (see the identical
  // technique and comment a few hundred lines below, "stale kick" test) --
  // without this, pendingKicks' own settle filter rejects the mission for
  // an UNRELATED reason (bound only milliseconds ago), which would make
  // this test pass even without wiring autoResume at all. Caught for real:
  // an earlier version of this test asserted an empty result and passed
  // for exactly that wrong reason.
  const raw = JSON.parse(fs.readFileSync(path.join(MISSIONS_DIR, `${g.id}.json`), "utf8"));
  raw.boundAt = new Date(Date.now() - 10_000).toISOString();
  fs.writeFileSync(path.join(MISSIONS_DIR, `${g.id}.json`), JSON.stringify(raw, null, 2) + "\n");

  const savedPolicy = process.env.ACC_POLICY;
  const polPath = path.join(MISSIONS_DIR, "autoresume-policy.json");
  try {
    process.env.ACC_POLICY = polPath;
    fs.writeFileSync(polPath, JSON.stringify({ missions: { autoResume: true, maxCycles: 0 } }));
    assert.equal(JSON.parse(runMain(["pending"])).length, 1, "sanity: kickable with autoResume:true and settle satisfied");

    fs.writeFileSync(polPath, JSON.stringify({ missions: { autoResume: false, maxCycles: 0 } }));
    assert.deepEqual(JSON.parse(runMain(["pending"])), [], "a human's autoResume:false must actually stop the kick, not just be displayed");
  } finally {
    if (savedPolicy === undefined) delete process.env.ACC_POLICY;
    else process.env.ACC_POLICY = savedPolicy;
  }
});

// OI-026 rename regression: the real repo policy.json must key its ceiling
// dials under "missions" (matching hooks/mission.mjs's own `pol?.missions?.*`
// reads at the 'pending' CLI verb), not the pre-rename "goals". A stale key
// name means every real-world call silently reads `undefined` for maxCycles/
// maxWallClockMinutes/maxCostUsd, which ceilingReached() treats as "disabled"
// -- Phase 1's loop-runaway ceiling (full-remediation-prompt.md, "the single
// most evidence-backed fix in either review") would be silently OFF in
// production while policy.json still shows real numbers to a human reading
// it. Proven end to end, not just by inspecting the JSON key: a mission at
// the real repo's configured maxCycles must actually get paused by 'pending'
// against the REAL policy.json (ACC_POLICY unset, root() resolves to this
// repo's own policy.json -- see the test above's own comment).
test("OI-026 regression: the real repo policy.json's ceiling dials are keyed 'missions' and actually pause an at-ceiling mission via CLI 'pending'", () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const real = JSON.parse(fs.readFileSync(path.join(repoRoot, "policy.json"), "utf8"));
  const dials = real.missions;
  assert.ok(dials, "policy.json must have a top-level \"missions\" block (not a stale \"goals\" key)");
  assert.ok(Number(dials.maxCycles) > 0, "missions.maxCycles must be a real, positive ceiling");

  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(41), consolePid: LIVE, missionId: g.id });
  for (let i = 0; i < Number(dials.maxCycles); i++) m.appendCycle(g.id, { sessionId: SID(41), text: "cycle" });

  const savedPolicy = process.env.ACC_POLICY;
  try {
    delete process.env.ACC_POLICY; // resolves to the real repo policy.json, exactly like production
    runMain(["pending"]);
  } finally {
    if (savedPolicy === undefined) delete process.env.ACC_POLICY;
    else process.env.ACC_POLICY = savedPolicy;
  }
  const after = m.readMissionAnywhere(g.id);
  assert.equal(after.status, "paused", "an at-ceiling mission must be paused by the real repo's own policy.json dials, not stay active");
});

test("CLI: main() 'kicked <id>' clears needsKick", () => {
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(41), consolePid: LIVE, missionId: g.id });
  assert.equal(m.readMission(g.id).needsKick, true);
  runMain(["kicked", g.id]);
  assert.equal(m.readMission(g.id).needsKick, false);
});

test("CLI: main() 'show' resolves an explicit id, the sole active mission, refuses to guess among several, and falls back to 'no active mission'", () => {
  assert.equal(runMain(["show"]), "no active mission", "no active missions at all");
  const g1 = m.createMission({ text: "t1" });
  assert.equal(JSON.parse(runMain(["show", g1.id])).id, g1.id, "explicit positional id");
  assert.equal(JSON.parse(runMain(["show"])).id, g1.id, "resolveId falls back to the sole active mission");
  m.createMission({ text: "t2" });
  assert.equal(runMain(["show"]), "no active mission", "resolveId refuses to guess among multiple active missions");
});

test("CLI: main() 'log' appends via --text or trailing positional words, and refuses with no resolvable mission", () => {
  assert.equal(runMain(["log", "whatever", "--text", "x"]), "no active mission", "no mission exists yet to log against");
  const g = m.createMission({ text: "t" });
  runMain(["log", g.id, "--text", "explicit flag note"]);
  assert.match(m.logTail(g.id, 10000), /explicit flag note/);
  runMain(["log", g.id, "trailing", "positional", "words"]);
  assert.match(m.logTail(g.id, 10000), /trailing positional words/);
});

test("CLI: main() 'done'/'blocked'/'paused' set status via resolveId, and refuse without a resolvable id", () => {
  assert.equal(runMain(["done"]), "no active mission (pass the id)");

  const g1 = m.createMission({ text: "t1" });
  assert.equal(runMain(["done", g1.id]), `mission ${g1.id} -> done`);
  assert.equal(m.readMission(g1.id), null, "done archives the mission out of the live directory");

  const g2 = m.createMission({ text: "t2" });
  assert.equal(runMain(["blocked", g2.id, "--why", "stuck"]), `mission ${g2.id} -> blocked`);
  assert.equal(m.readMission(g2.id), null, "blocked also archives the mission out of the live directory");

  const g3 = m.createMission({ text: "t3" });
  assert.equal(runMain(["paused", g3.id]), `mission ${g3.id} -> paused`);
  assert.equal(m.readMission(g3.id).status, "paused");
});

test("CLI: main() prints usage for an unrecognized command", () => {
  assert.match(runMain(["frobnicate"]), /^usage: mission\.mjs/);
});

// ---------------------------------------------------------- Phase 1: ceilings

test("ceilingReached: cycles-over, wall-over, dollar-over, both-under, and every dial disabled (0/missing)", async () => {
  const { m } = await loadMission();
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
  // whatever the mission's own numbers are.
  const huge = { cycles: 999, createdAt: created(999999), totalCostUsd: 999999 };
  assert.equal(m.ceilingReached(huge, now, {}).reached, false);
  assert.equal(m.ceilingReached(huge, now, { maxCycles: 0, maxWallClockMinutes: 0, maxCostUsd: 0 }).reached, false);
});

test("reapCeilings: transitions an over-ceiling ACTIVE mission to paused with an alert file; leaves an under-ceiling one alone", async () => {
  const { m, dir } = await loadMission();
  const alerts = path.join(dir, "alerts");
  process.env.ACC_ALERTS_DIR = alerts;
  try {
    const over = m.createMission({ text: "runaway" });
    m.bindSession({ sessionId: SID(50), consolePid: LIVE, missionId: over.id });
    for (let i = 0; i < 5; i++) m.appendCycle(over.id, { sessionId: SID(50), ctx: 1000, text: "cycle" });
    assert.equal(m.readMission(over.id).cycles, 5);

    const under = m.createMission({ text: "fine" });
    m.bindSession({ sessionId: SID(51), consolePid: LIVE, missionId: under.id });

    const reaped = m.reapCeilings(Date.now(), { maxCycles: 5 });
    assert.deepEqual(reaped, [over.id]);
    assert.equal(m.readMission(over.id).status, "paused");
    assert.match(m.readMission(over.id).why, /CEILING REACHED.*cycles/);
    assert.equal(m.readMission(under.id).status, "active", "a mission under every ceiling is untouched");

    const alertFile = path.join(alerts, `${over.id}.ceiling.json`);
    assert.ok(fs.existsSync(alertFile), "an alert file is written for the paused mission");
    const alert = JSON.parse(fs.readFileSync(alertFile, "utf8"));
    assert.equal(alert.id, over.id);
    assert.equal(alert.dimension, "cycles");

    // A paused mission must not be kickable — pendingKicks reads only activeMissions().
    // The still-active "fine" mission legitimately remains kickable, so assert
    // on membership, not on the whole list being empty.
    const kickable = m.pendingKicks(Date.now() + 999999).map((k) => k.id);
    assert.ok(!kickable.includes(over.id), "the paused mission must not appear in pendingKicks");
    assert.ok(kickable.includes(under.id), "the still-active mission remains kickable");
  } finally {
    delete process.env.ACC_ALERTS_DIR;
  }
});

test("reapCeilings does nothing when every dial is disabled (today's default, unchanged behavior)", async () => {
  const { m, dir } = await loadMission();
  process.env.ACC_ALERTS_DIR = path.join(dir, "alerts");
  try {
    const g = m.createMission({ text: "t" });
    m.bindSession({ sessionId: SID(52), consolePid: LIVE, missionId: g.id });
    for (let i = 0; i < 50; i++) m.appendCycle(g.id, { sessionId: SID(52), ctx: 1, text: "x" });
    assert.deepEqual(m.reapCeilings(Date.now(), {}), []);
    assert.equal(m.readMission(g.id).status, "active");
  } finally {
    delete process.env.ACC_ALERTS_DIR;
  }
});

test("resumeMission: paused -> active, re-arms needsKick, clears the alert file; refuses a non-paused mission", async () => {
  const { m, dir } = await loadMission();
  const alerts = path.join(dir, "alerts");
  process.env.ACC_ALERTS_DIR = alerts;
  try {
    const g = m.createMission({ text: "t" });
    m.bindSession({ sessionId: SID(53), consolePid: LIVE, missionId: g.id });
    m.reapCeilings(Date.now(), { maxCycles: 0 }); // no-op, dial disabled
    m.setStatus(g.id, "paused", "CEILING REACHED: cycles (test)");
    fs.mkdirSync(alerts, { recursive: true });
    fs.writeFileSync(path.join(alerts, `${g.id}.ceiling.json`), "{}");

    const resumed = m.resumeMission(g.id);
    assert.equal(resumed.status, "active");
    assert.equal(resumed.needsKick, true);
    assert.equal(fs.existsSync(path.join(alerts, `${g.id}.ceiling.json`)), false, "the alert is cleared on resume");

    // An active (non-paused) mission cannot be "resumed" — refuse, don't corrupt it.
    assert.equal(m.resumeMission(g.id), null);
    // A nonexistent id also refuses cleanly.
    assert.equal(m.resumeMission("m-nope"), null);
  } finally {
    delete process.env.ACC_ALERTS_DIR;
  }
});

test("CLI: main() 'resume <id>' unpauses a mission; refuses without a resolvable id", () => {
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(54), consolePid: LIVE, missionId: g.id });
  m.setStatus(g.id, "paused", "test pause");
  assert.equal(runMain(["resume", g.id]), `mission ${g.id} -> active`);
  assert.equal(m.readMission(g.id).status, "active");

  assert.equal(runMain(["resume", "m-nope"]), "mission m-nope could not be resumed (not paused, or does not exist)");
});

test("appendCycle accumulates totalCostUsd across cycles when a cost is passed, and tolerates none being passed", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.appendCycle(g.id, { sessionId: SID(55), ctx: 100, text: "c1", costUsd: 0.5 });
  assert.equal(m.readMission(g.id).totalCostUsd, 0.5);
  m.appendCycle(g.id, { sessionId: SID(55), ctx: 200, text: "c2", costUsd: 1.25 });
  assert.equal(m.readMission(g.id).totalCostUsd, 1.75);
  m.appendCycle(g.id, { sessionId: SID(55), ctx: 300, text: "c3" }); // no costUsd passed
  assert.equal(m.readMission(g.id).totalCostUsd, 1.75, "an omitted cost does not corrupt the running total");
});

test("CLI: main() 'pending' calls reapCeilings before pendingKicks, using the same policy dials", () => {
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(56), consolePid: LIVE, missionId: g.id });
  for (let i = 0; i < 20; i++) m.appendCycle(g.id, { sessionId: SID(56), ctx: 1, text: "x" });

  const savedPolicy = process.env.ACC_POLICY;
  const savedAlerts = process.env.ACC_ALERTS_DIR;
  const polPath = path.join(MISSIONS_DIR, "pending-ceiling-policy.json");
  process.env.ACC_POLICY = polPath;
  process.env.ACC_ALERTS_DIR = path.join(MISSIONS_DIR, "alerts");
  fs.writeFileSync(polPath, JSON.stringify({ missions: { maxCycles: 3 } }));
  try {
    const printed = JSON.parse(runMain(["pending"]));
    assert.deepEqual(printed, [], "a mission reaped to paused by THIS SAME pending call must not be kicked");
    assert.equal(m.readMission(g.id).status, "paused");
  } finally {
    if (savedPolicy === undefined) delete process.env.ACC_POLICY; else process.env.ACC_POLICY = savedPolicy;
    if (savedAlerts === undefined) delete process.env.ACC_ALERTS_DIR; else process.env.ACC_ALERTS_DIR = savedAlerts;
  }
});

test("a mission persists correctly after its directory is moved to a new location", async () => {
  const { m, dir } = await loadMission();

  // Create a mission in the original directory
  const g = m.createMission({ text: "portable mission", cwd: "C:/code" });
  const originalMissionJson = m.readMission(g.id);
  assert.ok(originalMissionJson);
  assert.equal(originalMissionJson.text, "portable mission");

  // Move the entire missions directory to a new location
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-mission-moved-"));
  try {
    // Copy the original directory contents
    const moveDir = path.join(newDir, "moved-missions");
    fs.cpSync(dir, moveDir, { recursive: true });

    // Update the environment to point to the new location
    const savedMissionsDir = process.env.ACC_MISSIONS_DIR;
    process.env.ACC_MISSIONS_DIR = moveDir;

    // Verify the mission can still be read from the new location
    // missionsDir() resolves from the environment variable on every call
    const movedMissionJson = m.readMission(g.id);
    assert.ok(movedMissionJson, "mission can be read from moved directory");
    assert.equal(movedMissionJson.text, "portable mission");
    assert.equal(movedMissionJson.id, g.id);

    // Verify listMissions also finds it in the new location
    const listedMissions = m.listMissions();
    assert.ok(listedMissions.some(mission => mission.id === g.id), "mission appears in list after directory move");

    // Restore the original directory reference
    process.env.ACC_MISSIONS_DIR = savedMissionsDir;
  } finally {
    fs.rmSync(newDir, { recursive: true, force: true });
  }
});

test("Phase 4 D2: concurrent appendCycle calls against the SAME mission from separate PROCESSES never lose an update", async () => {
  // Reproduced directly before this lock existed: 30 truly-concurrent
  // appendCycle calls (each its own process, since in-process concurrency
  // can't race synchronous code) landed 24/30 and 27/30 cycles -- read
  // (mission.cycles) / modify / write with nothing serializing it across
  // processes silently lost updates.
  //
  // Real CI flake (2026-08-06, Windows): 30-way process-spawn contention
  // against the default 3000ms LOCK_TIMEOUT_MS occasionally exceeds it
  // under a loaded/slower runner, throwing inside the child's .then() --
  // an unhandled rejection this fixture didn't check for, so a timed-out
  // child still resolved via 'close' and the lost update looked identical
  // to a real regression (24/30). Same root cause and same fix already
  // applied once tonight for kernel/autonomy.test.mjs's own N-way lock
  // race: a generous timeout for the spawned children (this is testing
  // the LOCK's correctness under contention, not tuning the production
  // default) plus explicit exit-code checking so a genuine failure is
  // visible instead of silently swallowed as a false "lost update".
  const g = m.createMission({ text: "race probe" });
  const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "mission.mjs");
  const N = 30;
  const fireAsync = () => new Promise((resolve) => {
    let stderr = "";
    const child = spawn(process.execPath, ["-e", `
      import(${JSON.stringify("file://" + HOOK)}).then((mm) => {
        mm.appendCycle(${JSON.stringify(g.id)}, { sessionId: "s", ctx: 1, text: "x" });
        process.exit(0);
      }).catch((e) => { console.error(e.stack || e); process.exit(1); });
    `], { env: { ...process.env, ACC_MISSIONS_DIR: MISSIONS_DIR, ACC_MISSION_LOCK_TIMEOUT_MS: "15000" } });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all(Array.from({ length: N }, fireAsync));
  const failed = results.filter((r) => r.code !== 0);
  assert.equal(failed.length, 0, `expected all ${N} children to succeed; failures: ${failed.map((f) => f.stderr).join("\n")}`);
  assert.equal(m.readMission(g.id).cycles, N, `expected all ${N} concurrent cycles counted, none lost to the race`);
});

// ------------------------------------------------------ Phase 4 D3: stale kicks

test("reapStaleKicks re-arms a kick with no sign of life past the stale window", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(60), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id); // needsKick -> false, lastKickAt -> now
  assert.equal(m.readMission(g.id).needsKick, false);

  const farFuture = Date.now() + 10 * 60_000; // 10 min later, past a 5-min default window
  const rearmed = m.reapStaleKicks(farFuture, {});
  assert.deepEqual(rearmed, [g.id]);
  assert.equal(m.readMission(g.id).needsKick, true, "re-armed so clearbot tries the kick again");
});

test("reapStaleKicks leaves a kick alone when a turn-end (sign of life) landed after it", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(61), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id);
  m.recordTurnEnd(g.id, {}); // the kick worked -- a turn ended afterward

  const farFuture = Date.now() + 10 * 60_000;
  assert.deepEqual(m.reapStaleKicks(farFuture, {}), [], "a real turn-end after the kick means it landed -- nothing to re-arm");
  assert.equal(m.readMission(g.id).needsKick, true, "recordTurnEnd itself already re-arms needsKick for the NEXT kick -- untouched by reapStaleKicks");
});

test("reapStaleKicks does nothing before the stale window has elapsed", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(62), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id);
  assert.deepEqual(m.reapStaleKicks(Date.now() + 1000, {}), [], "1 second later is well inside the default 5-minute window");
  assert.equal(m.readMission(g.id).needsKick, false);
});

test("reapStaleKicks does nothing for a mission that was never kicked, or already needs one", async () => {
  const { m } = await loadMission();
  const neverKicked = m.createMission({ text: "t1" });
  m.bindSession({ sessionId: SID(63), consolePid: LIVE, missionId: neverKicked.id }); // needsKick already true from binding
  const alreadyPending = m.createMission({ text: "t2" });
  m.bindSession({ sessionId: SID(64), consolePid: LIVE, missionId: alreadyPending.id });
  m.markKicked(alreadyPending.id);
  m.recordTurnEnd(alreadyPending.id, {}); // re-arms needsKick=true for a NEW kick

  const farFuture = Date.now() + 10 * 60_000;
  assert.deepEqual(m.reapStaleKicks(farFuture, {}), []);
});

test("reapStaleKicks honors a policy-configured kickStaleMinutes dial", async () => {
  const { m } = await loadMission();
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(65), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id);
  const twoMinLater = Date.now() + 2 * 60_000;
  assert.deepEqual(m.reapStaleKicks(twoMinLater, { kickStaleMinutes: 5 }), [], "still under a 5-minute configured window");
  assert.deepEqual(m.reapStaleKicks(twoMinLater, { kickStaleMinutes: 1 }), [g.id], "past a tighter 1-minute configured window");
});

test("CLI: main() 'pending' calls reapStaleKicks before pendingKicks, re-arming and kicking in the SAME call", () => {
  const g = m.createMission({ text: "t" });
  m.bindSession({ sessionId: SID(66), consolePid: LIVE, missionId: g.id });
  m.markKicked(g.id);

  const savedPolicy = process.env.ACC_POLICY;
  const polPath = path.join(MISSIONS_DIR, "stale-kick-policy.json");
  process.env.ACC_POLICY = polPath;
  fs.writeFileSync(polPath, JSON.stringify({ missions: { kickStaleMinutes: 1 } }));
  try {
    // Simulate "well past stale" without waiting for real time to pass: back-date
    // lastKickAt AND boundAt directly, the same shape a real stale kick would
    // have on disk -- pendingKicks' own tuiReadySettleMs filter would otherwise
    // reject a mission bound only milliseconds ago (real Date.now() inside main(),
    // not test-controlled).
    const raw = JSON.parse(fs.readFileSync(path.join(MISSIONS_DIR, `${g.id}.json`), "utf8"));
    raw.lastKickAt = new Date(Date.now() - 5 * 60_000).toISOString();
    raw.boundAt = new Date(Date.now() - 5 * 60_000).toISOString();
    fs.writeFileSync(path.join(MISSIONS_DIR, `${g.id}.json`), JSON.stringify(raw, null, 2) + "\n");

    const printed = JSON.parse(runMain(["pending"]));
    assert.ok(printed.some((k) => k.id === g.id), "the re-armed mission is kickable in the SAME pending call, not the next poll");
  } finally {
    if (savedPolicy === undefined) delete process.env.ACC_POLICY; else process.env.ACC_POLICY = savedPolicy;
  }
});

// node --test core/autonomy.test.mjs  (run from the repo root)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTONOMY_MJS = path.join(HERE, "autonomy.mjs");

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-autonomy-"));
process.env.ACC_ROOT = path.join(BASE, "root");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({
  kernel: {
    budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 },
    hardCaps: { wallClockMin: 240 },
    autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 },
    checkpointMin: 20,
  },
}));

const A = await import("./autonomy.mjs");
const L = await import("./ledger.mjs");
const { loadKernelPolicy } = await import("./policy.mjs");

function seedRuns(outcomes) {
  outcomes.forEach((outcome, i) => {
    L.appendStarted({ runId: `s${i}`, startedAt: new Date(2026, 7, 3, 0, i).toISOString(), contract: {}, settingsSha256: "x" });
    L.appendFinalized({ runId: `s${i}`, finishedAt: new Date(2026, 7, 3, 0, i, 30).toISOString(),
      outcome, harness: { name: "fake", version: "1" }, criteria: [], decisions: {}, tokens: 0, wallClockMs: 1 });
  });
}

beforeEach(() => fs.rmSync(L.ledgerDir(), { recursive: true, force: true }));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("effective ceiling = min(contract, policy default, hard cap) x factor (AC-B6)", () => {
  const p = loadKernelPolicy();
  const contract = { budget: { wallClockMin: 30, toolCalls: 100, tokens: 200000 } };
  assert.deepEqual(A.effectiveCeilings(contract, p, { factor: 1 }),
    { wallClockMs: 30 * 60000, toolCalls: 100, tokens: 200000 });
  assert.deepEqual(A.effectiveCeilings(contract, p, { factor: 0.5 }),
    { wallClockMs: 15 * 60000, toolCalls: 50, tokens: 100000 });
  assert.deepEqual(A.effectiveCeilings({}, p, { factor: 1 }),
    { wallClockMs: 60 * 60000, toolCalls: 200, tokens: 500000 });
  assert.equal(A.effectiveCeilings({ budget: { wallClockMin: 9999 } }, p, { factor: 1 }).wallClockMs,
    240 * 60000, "the hard cap wins over a larger contract value");
});

test("crossing the rejected-rate threshold tightens the next N runs automatically (AC-B2)", () => {
  seedRuns(["accepted", "accepted", "accepted", "accepted", "accepted",
            "accepted", "accepted", "rejected", "rejected", "aborted-by-budget"]);
  const { state, adjustment } = A.updateAfterRun();
  assert.equal(state.factor, 0.5);
  assert.equal(state.runsLeft, 5);
  assert.equal(adjustment.direction, "tighten");
  assert.match(adjustment.reason, /3\/10/);
});

test("two real OS processes finalizing concurrently do not clobber each other's autonomy update (rare, OI-043)", async () => {
  seedRuns(["rejected", "rejected", "rejected", "rejected", "accepted", "accepted", "accepted", "accepted", "accepted", "accepted"]);
  const { spawn } = await import("node:child_process");
  const sigFile = path.join(BASE, "autonomy-race.sig");
  fs.rmSync(sigFile, { force: true });
  const script = path.join(BASE, "autonomy-race.mjs");
  fs.writeFileSync(script, `
    const A = await import(${JSON.stringify(pathToFileURL(AUTONOMY_MJS).href)});
    const fs = await import("node:fs");
    const sig = ${JSON.stringify(sigFile)};
    while (!fs.existsSync(sig)) { /* busy-wait for the synchronized start */ }
    A.updateAfterRun({ autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 } });
  `);
  const runOnce = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { env: process.env });
    p.on("exit", resolve);
  });
  const races = [runOnce(), runOnce()];
  await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(sigFile, "");
  await Promise.all(races);
  const state = A.readAutonomy();
  assert.equal(state.factor, 0.5, "the tightening decision must survive both concurrent writers");
  assert.equal(state.runsLeft, 4, "the second finalize must see the first's write and decrement from it, not overwrite it");
  assert.equal(state.log.length, 1, "exactly one adjustment happened; the second call is a mid-tightening decrement with no new log entry");
});

test("a call that finds the lock briefly held retries until the holder releases it (fault-tolerance, OI-043)", async () => {
  seedRuns(["accepted", "accepted", "accepted", "accepted", "accepted"]);
  const lockFile = `${L.autonomyFile()}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid)); // fresh (not stale) — must be waited out, not stolen
  const releaser = path.join(BASE, "releaser.mjs");
  fs.writeFileSync(releaser, `
    const fs = await import("node:fs");
    await new Promise((r) => setTimeout(r, 80));
    fs.rmSync(${JSON.stringify(lockFile)}, { force: true });
  `);
  const { spawn } = await import("node:child_process");
  const p = spawn(process.execPath, [releaser], { env: process.env });
  const { state } = A.updateAfterRun(); // blocks synchronously: must retry-sleep until the releaser deletes the lock
  await new Promise((r) => p.on("exit", r));
  assert.equal(state.factor, 1, "the update must complete once the held lock is released, not time out");
});

test("a stale lock (crashed holder) is stolen instead of deadlocking autonomy updates forever (fault-tolerance, OI-043)", () => {
  seedRuns(["accepted", "accepted", "accepted", "accepted", "accepted"]);
  const lockFile = `${L.autonomyFile()}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, "99999999"); // a pid that is certainly not this process
  const old = new Date(Date.now() - 60000); // older than LOCK_STALE_MS (30s)
  fs.utimesSync(lockFile, old, old);
  const { state } = A.updateAfterRun();
  assert.equal(state.factor, 1, "the update must complete by stealing the stale lock, not hang");
  assert.equal(fs.existsSync(lockFile), false, "the winning caller releases the lock it stole");
});

test("a healthy window makes no adjustment", () => {
  seedRuns(["accepted", "accepted", "accepted", "accepted", "rejected"]);
  const { state, adjustment } = A.updateAfterRun();
  assert.equal(state.factor, 1);
  assert.equal(adjustment, null);
});

test("failed-to-start does not count as a rejection — tightening cannot fix a missing binary", () => {
  seedRuns(["failed-to-start", "failed-to-start", "failed-to-start", "failed-to-start",
            "accepted", "accepted", "accepted", "accepted", "accepted", "accepted"]);
  assert.equal(A.updateAfterRun().state.factor, 1);
});

test("a window of only failed-to-start runs makes no adjustment (empty counted window, no divide-by-zero)", () => {
  seedRuns(["failed-to-start", "failed-to-start", "failed-to-start"]);
  const { state, adjustment } = A.updateAfterRun();
  assert.equal(state.factor, 1);
  assert.equal(adjustment, null);
});

test("ceilings restore automatically once the window recovers (AC-B3)", () => {
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  assert.equal(A.updateAfterRun().state.factor, 0.5);
  A.writeAutonomy({ ...A.readAutonomy(), runsLeft: 1 });
  L.clearRunLog();
  seedRuns(["accepted", "accepted", "accepted", "accepted", "accepted"]);
  const after2 = A.updateAfterRun();
  assert.equal(after2.state.factor, 1);
  assert.equal(after2.adjustment.direction, "restore");
});

test("mid-tightening runs are decremented without a new adjustment or log entry", () => {
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  assert.equal(A.updateAfterRun().state.factor, 0.5);
  assert.equal(A.readAutonomy().runsLeft, 5);
  L.clearRunLog();
  seedRuns(["accepted", "accepted", "accepted", "accepted", "accepted"]);
  const { state, adjustment } = A.updateAfterRun();
  assert.equal(state.runsLeft, 4, "one run consumed from the tightening window, still not elapsed");
  assert.equal(state.factor, 0.5, "factor unchanged mid-tightening");
  assert.equal(adjustment, null);
});

test("if the window is still bad when the tightened runs elapse, tightening re-arms instead of silently sticking", () => {
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  assert.equal(A.updateAfterRun().state.factor, 0.5);
  A.writeAutonomy({ ...A.readAutonomy(), runsLeft: 1 });
  L.clearRunLog();
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  const after2 = A.updateAfterRun();
  assert.equal(after2.state.factor, 0.5, "still bad, so it must not silently restore");
  assert.equal(after2.state.runsLeft, 5, "re-armed for another full tightening window");
  assert.equal(after2.adjustment.direction, "tighten");
});

test("every adjustment is logged with its trigger reason and window (AC-B4)", () => {
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  A.updateAfterRun();
  const entry = A.readAutonomy().log.at(-1);
  assert.equal(entry.direction, "tighten");
  assert.equal(entry.factor, 0.5);
  assert.ok(entry.at);
  assert.deepEqual(entry.window, ["rejected", "rejected", "rejected", "accepted", "accepted"]);
});

test("a checkpoint stops a run that made no tool call in a whole interval (AC-B5)", () => {
  const ceilings = { wallClockMs: 60 * 60000, toolCalls: 200, tokens: 500000 };
  const live = { elapsedMs: 60000, ceilings, tokens: 10, attemptsNow: 5, attemptsAtLastCheckpoint: 3, checkpointDue: true };
  assert.equal(A.checkpointVerdict(live).stop, false);
  const stalled = { ...live, attemptsAtLastCheckpoint: 5 };
  assert.equal(A.checkpointVerdict(stalled).stop, true);
  assert.equal(A.checkpointVerdict(stalled).dimension, "stalled");
  assert.equal(A.checkpointVerdict({ ...stalled, checkpointDue: false }).stop, false,
    "the stall test only applies on a checkpoint boundary");
});

test("a checkpoint stops a run over any ceiling, naming the dimension (AC-B1)", () => {
  const ceilings = { wallClockMs: 1000, toolCalls: 5, tokens: 100 };
  const base = { ceilings, elapsedMs: 0, tokens: 0, attemptsNow: 0, attemptsAtLastCheckpoint: 0, checkpointDue: false };
  assert.equal(A.checkpointVerdict({ ...base, elapsedMs: 1001 }).dimension, "wallClock");
  assert.equal(A.checkpointVerdict({ ...base, tokens: 101 }).dimension, "tokens");
  assert.equal(A.checkpointVerdict({ ...base, attemptsNow: 5 }).dimension, "toolCalls");
  assert.equal(A.checkpointVerdict(base).stop, false);
});

test("readAutonomyStrict: missing file is fresh, corrupt file THROWS (never fails open)", () => {
  fs.rmSync(L.autonomyFile(), { force: true });
  assert.equal(A.readAutonomyStrict().factor, 1);
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), "{ not json");
  assert.throws(() => A.readAutonomyStrict());
  fs.writeFileSync(L.autonomyFile(), JSON.stringify({ factor: 0.5, runsLeft: 3 }));
  assert.equal(A.readAutonomyStrict().factor, 0.5);
});

test("readAutonomyStrict: a non-ENOENT read error (e.g. EISDIR) is re-thrown, not treated as fresh (error)", () => {
  fs.rmSync(L.autonomyFile(), { force: true, recursive: true });
  fs.mkdirSync(L.autonomyFile(), { recursive: true }); // a directory where a file is expected: readFileSync throws EISDIR, never ENOENT
  assert.throws(() => A.readAutonomyStrict(), /EISDIR/);
  fs.rmSync(L.autonomyFile(), { recursive: true, force: true });
});

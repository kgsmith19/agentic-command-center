// node --test kernel/autonomy.test.mjs  (run from C:\code\guards)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  fs.rmSync(L.runsFile(), { force: true });
  seedRuns(["accepted", "accepted", "accepted", "accepted", "accepted"]);
  const after2 = A.updateAfterRun();
  assert.equal(after2.state.factor, 1);
  assert.equal(after2.adjustment.direction, "restore");
});

test("mid-tightening runs are decremented without a new adjustment or log entry", () => {
  seedRuns(["rejected", "rejected", "rejected", "accepted", "accepted"]);
  assert.equal(A.updateAfterRun().state.factor, 0.5);
  assert.equal(A.readAutonomy().runsLeft, 5);
  fs.rmSync(L.runsFile(), { force: true });
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
  fs.rmSync(L.runsFile(), { force: true });
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

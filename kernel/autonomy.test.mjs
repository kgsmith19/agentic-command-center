// node --test kernel/autonomy.test.mjs  (run from C:\code\guards)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, ".mjs");

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

test("readAutonomyStrict: missing file is fresh, corrupt file THROWS (never fails open)", () => {
  fs.rmSync(L.autonomyFile(), { force: true });
  assert.equal(A.readAutonomyStrict().factor, 1);
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), "{ not json");
  assert.throws(() => A.readAutonomyStrict());
  fs.writeFileSync(L.autonomyFile(), JSON.stringify({ factor: 0.5, runsLeft: 3 }));
  assert.equal(A.readAutonomyStrict().factor, 0.5);
});

// Full-repo review (2026-08-06) regression: kernel/policy.mjs's own
// validator already enforces autonomy.factor in (0, 1] for the POLICY dial
// (the tightening amount) -- but the PERSISTED, currently-active factor in
// autonomy.json was read back with a bare object spread, letting a
// corrupted, tampered, or buggy state file carry ANY value straight into
// effectiveCeilings(). A factor <= 0 makes every ceiling zero or negative
// (every checkpointVerdict check trips instantly); a factor above 1 WIDENS
// ceilings past normal, silently defeating the whole tightening mechanism
// this file exists to run. Both readAutonomy and readAutonomyStrict must
// clamp back to 1 (the safe, neutral "no tightening" default) on anything
// outside (0, 1], the same way hooks/usage.mjs's own finiteOr already
// guards other policy-derived numbers.
test("readAutonomy and readAutonomyStrict clamp an out-of-range persisted factor back to 1, never pass it through raw", () => {
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  const bad = [-1, 0, 1.5, 999, NaN, "not-a-number", null];
  for (const factor of bad) {
    fs.writeFileSync(L.autonomyFile(), JSON.stringify({ factor, runsLeft: 0, log: [] }));
    assert.equal(A.readAutonomy().factor, 1, `readAutonomy must clamp factor=${factor} to 1`);
    assert.equal(A.readAutonomyStrict().factor, 1, `readAutonomyStrict must clamp factor=${factor} to 1`);
  }
  // A genuinely valid factor still passes through untouched.
  fs.writeFileSync(L.autonomyFile(), JSON.stringify({ factor: 0.5, runsLeft: 0, log: [] }));
  assert.equal(A.readAutonomy().factor, 0.5);
  assert.equal(A.readAutonomyStrict().factor, 0.5);
});

// OI-019 scenario-enumeration pass: writeAutonomy was the one JSON state
// file in this codebase still using a bare writeFileSync instead of
// tmp+rename -- a reader (readAutonomyStrict, an enforcement point that
// fails CLOSED on any read error) could observe a half-written file from a
// crash mid-write and deny every subsequent tool call for a reason that
// isn't real tightening. Same tmp+rename discipline every other JSON state
// file already uses (mission.mjs, budget.mjs, engine.mjs).
test("writeAutonomy writes atomically -- content round-trips, no leftover .tmp- file", () => {
  A.writeAutonomy({ factor: 0.5, runsLeft: 3, log: [{ direction: "tighten" }] });
  assert.deepEqual(A.readAutonomy(), { factor: 0.5, runsLeft: 3, log: [{ direction: "tighten" }] });
  const leftovers = fs.readdirSync(path.dirname(L.autonomyFile())).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

// Full-repo review (2026-08-06): a real Windows CI failure on this file's
// own 20-way concurrent lock race (below) surfaced a genuine production
// gap, not a test-tuning issue: withAutonomyLock's retry loop only retries
// on EEXIST (another process already holds the lock). ANY other error --
// including EPERM, which really happened on CI ("operation not permitted,
// open .../autonomy.json.lock", a well-documented Windows quirk where
// antivirus/Defender transiently locks a just-created file during a scan)
// -- was rethrown immediately, aborting the whole lock acquisition instead
// of retrying like a transient failure deserves. The same duplicated lock
// primitive in kernel/ledger.mjs, hooks/budget.mjs, and hooks/mission.mjs
// shares this exact gap; fixed identically in all four.
test("withAutonomyLock retries past a transient EPERM instead of aborting the whole lock acquisition", () => {
  const origOpenSync = fs.openSync;
  let thrown = false;
  fs.openSync = (p, flags, ...rest) => {
    if (!thrown && String(p).endsWith(".lock") && flags === "wx") {
      thrown = true;
      const e = new Error("operation not permitted, open '" + p + "'");
      e.code = "EPERM";
      throw e;
    }
    return origOpenSync(p, flags, ...rest);
  };
  try {
    assert.doesNotThrow(() => A.updateAfterRun(), "a transient EPERM on lock creation must be retried, not surfaced as a hard failure");
    assert.equal(thrown, true, "sanity: the mocked EPERM actually fired");
  } finally {
    fs.openSync = origOpenSync;
  }
});

// Lean-review finding (2026-08-06): updateAfterRun's read-modify-write was
// unserialized across PROCESSES -- the lane slot a harness run holds is
// released on the child's `close`, which fires BEFORE run.mjs's own
// finalize()/updateAfterRun() runs, so a second run can start and finalize
// while the first's updateAfterRun() is still in flight. Same class of
// lost-update race kernel/ledger.mjs's withDecisionLock already closes for
// guardhook's attempts counter (see that file's own comment: "40 truly-
// concurrent fires... let 4-8 through before this lock existed"). Same
// proof technique: separate node PROCESSES (synchronous JS in one process
// cannot race itself), barrier-synchronized so they genuinely overlap.
// autonomy.runs: 0 makes every call independently re-evaluate from
// runsLeft===0 (never takes the runsLeft>0 branch, which doesn't log) --
// so with a `rejected`-heavy window, EVERY concurrent call should append
// its own "tighten" log entry, deterministically, regardless of order.
test("concurrent updateAfterRun calls, from separate PROCESSES, never lose a log entry", async () => {
  for (let i = 0; i < 10; i++) {
    L.appendStarted({ runId: `race${i}`, startedAt: new Date(2026, 7, 3, 1, i).toISOString(), contract: {}, settingsSha256: "x" });
    L.appendFinalized({ runId: `race${i}`, finishedAt: new Date(2026, 7, 3, 1, i, 30).toISOString(),
      outcome: "rejected", harness: { name: "fake", version: "1" }, criteria: [], decisions: {}, tokens: 0, wallClockMs: 1 });
  }
  const racePolicy = JSON.stringify({ autonomy: { window: 10, rejectRate: 0.1, factor: 0.5, runs: 0 } });
  const goFile = path.join(BASE, "go-signal-autonomy");
  fs.rmSync(goFile, { force: true });
  const N = 20;
  // Real flake on Windows CI (2026-08-06, this exact test, 19/20): the
  // production LOCK_TIMEOUT_MS default (3000ms) is tuned for realistic
  // contention (a handful of concurrent finalizations, not this test's
  // deliberately adversarial 20-way stress), and a slower/loaded CI runner
  // pushed total queue time for the LAST waiter past it -- a lock TIMEOUT
  // (updateAfterRun throwing, silently swallowed as an unhandled rejection
  // inside the child, since the exit code was never checked), not a
  // correctness bug in the lock itself (no torn read, no lost update WHILE
  // holding it -- see the other assertions in this file). Generous headroom
  // via the same env override kernel/ledger.mjs's own lock tests use, plus
  // actually checking each child's exit code so a real failure is
  // diagnosable instead of surfacing only as a confusing count mismatch.
  const fireAsync = () => new Promise((resolve) => {
    let stderr = "";
    const child = spawn(process.execPath, ["-e", `
      import(${JSON.stringify("file://" + MODULE_PATH)}).then((m) => {
        const fs = require("fs");
        while (!fs.existsSync(${JSON.stringify(goFile)})) {}
        m.updateAfterRun(${racePolicy});
        process.exit(0);
      }).catch((e) => { console.error(e.stack || e); process.exit(1); });
    `], { env: { ...process.env, ACC_AUTONOMY_LOCK_TIMEOUT_MS: "15000" } });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  const promises = Array.from({ length: N }, fireAsync);
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(goFile, "go");
  const results = await Promise.all(promises);
  const failed = results.filter((r) => r.code !== 0);
  assert.equal(failed.length, 0, `expected all ${N} children to exit 0; failures:\n${failed.map((f) => f.stderr).join("\n")}`);
  const finalState = A.readAutonomy();
  assert.equal(finalState.log.length, N, `expected all ${N} concurrent tighten entries logged, none lost to the race`);
});

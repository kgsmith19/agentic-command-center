// Autonomy that tightens itself. Two rules, both automatic and both logged:
//
//   1. Every run gets a ceiling on wall-clock, tool calls, and tokens.
//   2. When the recent record is bad, the ceilings shrink on their own, and
//      they restore on their own once it recovers. No human in either loop.
//
// A run counts against the record when its outcome is `rejected` or
// `aborted-by-budget`. `failed-to-start` is excluded on purpose: a smaller
// ceiling does not fix a harness that will not launch, and counting it would
// throttle the system for an infrastructure fault.
import fs from "node:fs";
import path from "node:path";
import { readRuns, autonomyFile } from "./ledger.mjs";
import { loadKernelPolicy } from "./policy.mjs";

const NOT_DELIVERED = new Set(["rejected", "aborted-by-budget"]);
const FRESH = { factor: 1, runsLeft: 0, log: [] };

// guards#OI-043: updateAfterRun does read-autonomy -> compute -> write-
// autonomy with no lock. core/run.mjs calls it after every finalized run,
// and two runs CAN finalize concurrently (proven by run.mjs's own concurrent-
// runs test) -- two processes reading the same old state before either
// writes means the second writeAutonomy() unconditionally overwrites the
// first, silently discarding its adjustment and its log entry (reproduced
// empirically: two racing writers, one log entry, every time). An exclusive-
// create lock file serializes the whole read-modify-write; a stale lock
// (age > LOCK_STALE_MS) is stolen rather than deadlocking autonomy updates
// forever if a holder crashed mid-update.
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 20;

function lockPath() {
  return autonomyFile() + ".lock";
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  fs.mkdirSync(path.dirname(autonomyFile()), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath(), String(process.pid), { flag: "wx" });
      return;
    } catch (e) {
      // Windows can throw EPERM/EBUSY (not EEXIST) for a brief window right
      // after another process deletes the same path — a transient delete-
      // then-create race on NTFS, not a real error. Treated as "still
      // contended," same as EEXIST, rather than propagated.
      if (e.code !== "EEXIST" && e.code !== "EPERM" && e.code !== "EBUSY") throw e;
      try {
        if (Date.now() - fs.statSync(lockPath()).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath(), { force: true });
          continue;
        }
      } catch { /* lock vanished between the failed create and this check; retry */ }
      if (Date.now() > deadline) throw new Error("autonomy lock: timed out waiting for a concurrent update to finish");
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function releaseLock() {
  fs.rmSync(lockPath(), { force: true });
}

function withAutonomyLock(fn) {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

export function readAutonomy() {
  try {
    return { ...FRESH, ...JSON.parse(fs.readFileSync(autonomyFile(), "utf8")) };
  } catch {
    return { ...FRESH, log: [] };
  }
}

// Strict read for ENFORCEMENT points (guardhook). ENOENT = fresh state (the
// first-run case). Anything else THROWS: an enforcement point that treats a
// corrupt state file as "no tightening" fails open, and readAutonomy's
// lenient fallback is exactly that. Reporting paths keep readAutonomy.
export function readAutonomyStrict() {
  let raw;
  try {
    raw = fs.readFileSync(autonomyFile(), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { ...FRESH, log: [] };
    throw e;
  }
  return { ...FRESH, ...JSON.parse(raw) };
}

export function writeAutonomy(state) {
  fs.mkdirSync(path.dirname(autonomyFile()), { recursive: true });
  fs.writeFileSync(autonomyFile(), JSON.stringify(state, null, 2));
  return state;
}

export function effectiveCeilings(contract, policy, state = readAutonomy()) {
  const b = contract?.budget || {};
  const factor = state.factor ?? 1;
  const wallMin = Math.min(b.wallClockMin ?? policy.budget.wallClockMin, policy.hardCaps.wallClockMin);
  return {
    wallClockMs: Math.round(wallMin * 60000 * factor),
    toolCalls: Math.round((b.toolCalls ?? policy.budget.toolCalls) * factor),
    tokens: Math.round((b.tokens ?? policy.budget.tokens) * factor),
  };
}

function windowOutcomes(size) {
  const finals = readRuns().filter((r) => r.event === "run_finalized");
  return finals.slice(-size).map((r) => r.outcome);
}

// Call once after every finalized run.
export function updateAfterRun(policy = null) {
  return withAutonomyLock(() => updateAfterRunLocked(policy));
}

function updateAfterRunLocked(policy) {
  const cfg = (policy || loadKernelPolicy()).autonomy;
  const state = readAutonomy();
  const window = windowOutcomes(cfg.window);
  const counted = window.filter((o) => o !== "failed-to-start");
  const bad = counted.filter((o) => NOT_DELIVERED.has(o)).length;
  const rate = counted.length ? bad / counted.length : 0;
  const log = (direction, reason) => {
    const entry = { at: new Date().toISOString(), direction, factor: state.factor, runsLeft: state.runsLeft, reason, window };
    state.log = [...(state.log || []), entry];
    writeAutonomy(state);
    return entry;
  };

  if (state.runsLeft > 0) {
    state.runsLeft -= 1;
    if (state.runsLeft === 0 && rate < cfg.rejectRate) {
      state.factor = 1;
      return { state, adjustment: log("restore", `recent record recovered (${bad}/${counted.length} not delivered, under the ${cfg.rejectRate} threshold)`) };
    }
    if (state.runsLeft === 0) {
      // Still bad when the tightened window elapsed: fall through so the
      // block below re-arms tightening instead of sticking at factor<1
      // forever with no further log entries.
    } else {
      writeAutonomy(state);
      return { state, adjustment: null };
    }
  }

  if (rate >= cfg.rejectRate && counted.length > 0) {
    state.factor = cfg.factor;
    state.runsLeft = cfg.runs;
    return { state, adjustment: log("tighten", `${bad}/${counted.length} recent runs did not deliver, at or over the ${cfg.rejectRate} threshold — ceilings x${cfg.factor} for the next ${cfg.runs} runs`) };
  }

  writeAutonomy(state);
  return { state, adjustment: null };
}

// The automated milestone check. This is re-evaluation, never a human
// interrupt: it either lets the run continue or stops it, and says which
// dimension made the call.
export function checkpointVerdict({ elapsedMs, ceilings, tokens, attemptsNow, attemptsAtLastCheckpoint, checkpointDue }) {
  if (elapsedMs > ceilings.wallClockMs) return { stop: true, dimension: "wallClock", reason: `wall-clock ceiling ${Math.round(ceilings.wallClockMs / 60000)} min reached` };
  if (tokens > ceilings.tokens) return { stop: true, dimension: "tokens", reason: `token ceiling ${ceilings.tokens} reached` };
  if (attemptsNow >= ceilings.toolCalls) return { stop: true, dimension: "toolCalls", reason: `tool-call ceiling ${ceilings.toolCalls} reached` };
  if (checkpointDue && attemptsNow <= attemptsAtLastCheckpoint) {
    return { stop: true, dimension: "stalled", reason: "no tool call in a whole checkpoint interval" };
  }
  return { stop: false, dimension: null, reason: "" };
}

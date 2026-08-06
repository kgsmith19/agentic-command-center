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

// Full-repo review (2026-08-06): kernel/policy.mjs's own validator already
// enforces autonomy.factor in (0, 1] for the POLICY dial (the tightening
// amount), but the PERSISTED, currently-active factor in autonomy.json was
// read back with a bare object spread -- a corrupted, tampered, or buggy
// state file could carry ANY value straight into effectiveCeilings(). A
// factor <= 0 makes every ceiling zero or negative (every checkpointVerdict
// check trips instantly); a factor above 1 WIDENS ceilings past normal,
// silently defeating the whole tightening mechanism this file exists to
// run. Clamped at the read boundary so every consumer gets a safe value
// automatically, matching hooks/usage.mjs's own finiteOr pattern.
function safeFactor(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
}

export function readAutonomy() {
  try {
    const state = { ...FRESH, ...JSON.parse(fs.readFileSync(autonomyFile(), "utf8")) };
    return { ...state, factor: safeFactor(state.factor) };
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
  const state = { ...FRESH, ...JSON.parse(raw) };
  return { ...state, factor: safeFactor(state.factor) };
}

// tmp+rename instead of a bare writeFileSync -- a reader (readAutonomy,
// readAutonomyStrict, another process's own updateAfterRun) must never
// observe a half-written autonomy.json. Same pattern every other JSON state
// file in this codebase already uses (hooks/mission.mjs's write(), hooks/
// budget.mjs's tier.json, hooks/engine.mjs's vault.json/config.json) --
// this file was the one left behind.
export function writeAutonomy(state) {
  const file = autonomyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
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

// Lean review (2026-08-06): updateAfterRun's whole read-modify-write was
// unserialized across PROCESSES. The launch-lane slot a harness run holds is
// released on the child's `close` event, which fires BEFORE kernel/run.mjs's
// own finalize()/updateAfterRun() runs -- so a second run.mjs can acquire the
// slot and reach its own updateAfterRun() while the first's is still in
// flight. Two such calls can read the same stale {factor, runsLeft, log},
// and whichever writes last silently discards the other's transition -- the
// same class of lost-update race kernel/ledger.mjs's withDecisionLock
// already exists to close for guardhook's attempts counter. Duplicated
// locally (same primitive, same shape) rather than imported, since
// withDecisionLock is keyed by runId against decisionsFile(runId), not a
// generic path -- autonomy.json has exactly one lock to hold, not one per run.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const LOCK_TIMEOUT_MS = Number(process.env.ACC_AUTONOMY_LOCK_TIMEOUT_MS) || 3000;
const LOCK_STALE_MS = Number(process.env.ACC_AUTONOMY_LOCK_STALE_MS) || 5000;

function withAutonomyLock(fn) {
  const lockPath = autonomyFile() + ".lock";
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      break;
    } catch (e) {
      // Full-repo review (2026-08-06), real Windows CI failure: EPERM is a
      // transient failure to acquire the lock, same as EEXIST -- observed
      // for real ("operation not permitted, open .../autonomy.json.lock"
      // under 20-way concurrent load), a well-documented Windows quirk
      // where antivirus/Defender transiently locks a just-created file
      // during a scan. Retrying past it is correct; surfacing it as a hard
      // failure (the previous behavior) aborted the whole lock acquisition
      // for a condition that resolves itself within milliseconds.
      if (e.code !== "EEXIST" && e.code !== "EPERM") throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* lock vanished between the stat and here — fine, loop retries */ }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`autonomy lock still held after ${LOCK_TIMEOUT_MS}ms`);
      }
      sleepSync(5 + Math.floor(Math.random() * 10));
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
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

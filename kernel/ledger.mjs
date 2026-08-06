// The run record. Append-only JSONL: one `run_started` at launch and one
// `run_finalized` at close for every run — success, failure, or abort. A
// started line with no finalized line is an INTERRUPTED run, and that is
// visible by construction rather than by a flag someone must remember to set.
//
// Appends are idempotent by (runId, event): the launch lane retries transport
// failures and a resumed kernel must not double-write, so the FIRST record for
// a run wins and later duplicates are dropped (AC-G4).
//
// Nothing here ever receives a credential value. Callers pass key NAMES only;
// kernel/credentials.mjs is the single place values exist, and they go into a
// child process env, never into an argument that could reach this file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kernelRoot } from "./policy.mjs";

export const ledgerDir = () => path.join(kernelRoot(), "runner", "ledger");
export const runsFile = () => path.join(ledgerDir(), "runs.jsonl");
export const decisionsFile = (runId) => path.join(ledgerDir(), `${runId}.decisions.jsonl`);
export const autonomyFile = () => path.join(ledgerDir(), "autonomy.json");

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

function readLines(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // A truncated trailing line (killed mid-write) must not discard the
    // records before it — skip it, never throw.
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

export function readRuns() {
  return readLines(runsFile());
}

function appendOnce(event, entry) {
  if (readRuns().some((r) => r.event === event && r.runId === entry.runId)) return false;
  appendLine(runsFile(), { event, ...entry });
  return true;
}

export function appendStarted(entry) {
  return appendOnce("run_started", entry);
}

export function appendFinalized(entry) {
  return appendOnce("run_finalized", entry);
}

export function appendDecision(runId, decision) {
  appendLine(decisionsFile(runId), { ts: new Date().toISOString(), ...decision });
}

// OI-019: guardhook.mjs's read-attempts / decide / append-decision was three
// unsynchronized steps across processes — concurrent tool calls against the
// SAME run (Claude Code dispatches several from one turn routinely) could all
// read the same stale attempts count and all be allowed, blowing past the
// contract's tool-call ceiling. Reproduced directly: 40 truly-concurrent
// fires against a ceiling of 3 let 4-8 through before this lock existed.
//
// A synchronous, cross-process, cross-platform mutex via exclusive file
// creation (fs.openSync(..., "wx") fails EEXIST if the lock already exists —
// the create itself is the atomic op, same primitive flock()/CreateFile
// exclusive-create ultimately reduce to). Busy-waits with jitter rather than
// blocking on an OS primitive because guardhook.mjs's flow past the initial
// stdin await is synchronous by design (AC-G9: re-read everything fresh on
// every fire, no persistent state to hold a real lock handle across awaits).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_TIMEOUT_MS = Number(process.env.ACC_LEDGER_LOCK_TIMEOUT_MS) || 3000;
// A process that dies mid-critical-section (killed, crashed) leaves its lock
// file behind forever with nothing to release it — a stale lock older than
// this is reclaimed rather than deadlocking every future fire on this run.
const LOCK_STALE_MS = Number(process.env.ACC_LEDGER_LOCK_STALE_MS) || 5000;

// timeoutMs/staleMs are parameters (defaulting to the env-derived constants
// above), not read from the environment directly inside the function, so a
// test can exercise the timeout/reclaim paths in-process, fast, without
// mutating process.env after this module has already been imported (the
// module-level consts above are evaluated once, at import time).
export function withDecisionLock(runId, fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lockPath = decisionsFile(runId) + ".lock";
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.rmSync(lockPath, { force: true });
          continue; // retry the create immediately, no need to sleep first
        }
      } catch { /* lock vanished between the stat and here — fine, loop retries */ }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`decision lock for ${runId} still held after ${timeoutMs}ms`);
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

export function readDecisions(runId) {
  return readLines(decisionsFile(runId));
}

export function decisionCounts(runId) {
  const rows = readDecisions(runId);
  const allow = rows.filter((r) => r.allow === true).length;
  return { allow, deny: rows.length - allow, total: rows.length };
}

// Queryable by status, harness identity, and date range (AC-L3). No dashboard:
// the spec's out-of-scope list rules presentation out, and JSONL + this filter
// is the whole "queryable" requirement.
export function query({ status, harness, since, until } = {}) {
  const rows = readRuns();
  const finals = new Map();
  for (const r of rows) if (r.event === "run_finalized") finals.set(r.runId, r);
  const from = since ? Date.parse(since) : null;
  const to = until ? Date.parse(until) : null;
  const out = [];
  for (const s of rows) {
    if (s.event !== "run_started") continue;
    const f = finals.get(s.runId);
    const at = Date.parse(s.startedAt);
    if (from !== null && at < from) continue;
    if (to !== null && at > to) continue;
    const row = {
      runId: s.runId,
      status: f ? f.outcome : "interrupted",
      harness: f ? f.harness : null,
      startedAt: s.startedAt,
      finishedAt: f ? f.finishedAt : null,
      criteria: f ? f.criteria : null,
    };
    if (status && row.status !== status) continue;
    if (harness && (!row.harness || row.harness.name !== harness)) continue;
    out.push(row);
  }
  return out;
}

export function runCli(argv) {
  const [cmd, ...args] = argv;
  if (cmd !== "query") {
    throw new Error("usage: ledger.mjs query [--status <s>] [--harness <h>] [--since <date>] [--until <date>]");
  }
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return query({
    status: flag("--status"), harness: flag("--harness"),
    since: flag("--since"), until: flag("--until"),
  });
}

// Guarded so the module stays importable by its own suite without running the
// CLI on import — the same shape hooks/covgate.mjs and runner/runner.mjs use.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const row of runCli(process.argv.slice(2))) console.log(JSON.stringify(row));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

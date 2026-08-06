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
// core/credentials.mjs is the single place values exist, and they go into a
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

// Test-only reset: wipes the transactional run log AND its claim markers,
// but leaves autonomyFile() untouched — a bare `rm runsFile()` used to be
// enough to let a runId be reused (the old dedup re-read the now-empty
// file), but the OI-042 claim markers outlive the log on their own, so a
// caller wiping just the log must wipe this too or every re-seeded runId
// silently no-ops.
export function clearRunLog() {
  fs.rmSync(runsFile(), { force: true });
  fs.rmSync(claimsDir(), { recursive: true, force: true });
}

// guards#OI-042: the old check was "does a matching line already exist in
// runs.jsonl?", read-then-decide over the WHOLE file — safe against a single
// process's own sequential retries, but two real OS processes racing to
// finalize the same runId (the exact "resumed kernel must not double-write"
// case this function exists for) can both read "not yet written" before
// either appends, and both win. An exclusive-create marker file makes the
// CLAIM atomic at the filesystem level (Windows and POSIX both refuse a
// second `wx` create), so only the process that wins the claim ever appends.
function claimsDir() {
  return path.join(ledgerDir(), ".claims");
}

function claimOnce(event, runId) {
  fs.mkdirSync(claimsDir(), { recursive: true });
  try {
    fs.writeFileSync(path.join(claimsDir(), `${runId}.${event}`), "", { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

function appendOnce(event, entry) {
  if (!claimOnce(event, entry.runId)) return false;
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

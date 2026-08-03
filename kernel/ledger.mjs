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

export function decisionCounts(runId) {
  const rows = readLines(decisionsFile(runId));
  const allow = rows.filter((r) => r.allow === true).length;
  return { allow, deny: rows.length - allow, total: rows.length };
}

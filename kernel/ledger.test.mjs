// node --test kernel/ledger.test.mjs  (run from C:\code\guards)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-ledger-"));
process.env.ACC_ROOT = path.join(BASE, "root");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
fs.writeFileSync(process.env.ACC_POLICY, "{}");

const L = await import("./ledger.mjs");

beforeEach(() => fs.rmSync(L.ledgerDir(), { recursive: true, force: true }));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const started = (runId) => ({
  runId, startedAt: "2026-08-03T10:00:00.000Z",
  contract: { goal: "g", acceptanceCriteria: [{ id: "AC1" }] }, settingsSha256: "abc",
});
const finalized = (runId, outcome = "accepted") => ({
  runId, finishedAt: "2026-08-03T10:05:00.000Z", outcome,
  harness: { name: "claude-code", version: "9.9.9" },
  criteria: [{ id: "AC1", status: "pass" }],
  decisions: { allow: 3, deny: 1 }, tokens: 1234, wallClockMs: 300000,
});

test("one run writes exactly one started and one finalized line (AC-L1)", () => {
  L.appendStarted(started("r1"));
  L.appendFinalized(finalized("r1"));
  const rows = L.readRuns();
  assert.equal(rows.filter((r) => r.event === "run_started" && r.runId === "r1").length, 1);
  assert.equal(rows.filter((r) => r.event === "run_finalized" && r.runId === "r1").length, 1);
});

test("a repeated append with the same runId applies exactly once (AC-G4)", () => {
  assert.equal(L.appendStarted(started("r2")), true);
  assert.equal(L.appendStarted(started("r2")), false, "second append must be a no-op");
  L.appendFinalized(finalized("r2"));
  assert.equal(L.appendFinalized(finalized("r2", "rejected")), false);
  const rows = L.readRuns().filter((r) => r.runId === "r2");
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.event === "run_finalized").outcome, "accepted",
    "the first finalize wins; a duplicate must not rewrite the outcome");
});

test("an abort still writes a finalized line (AC-L1 covers failure and abort)", () => {
  L.appendStarted(started("r3"));
  L.appendFinalized(finalized("r3", "aborted-by-budget"));
  assert.equal(L.readRuns().find((r) => r.event === "run_finalized").outcome, "aborted-by-budget");
});

test("finalized carries outcome, harness, per-criterion results, counts, cost, wall-clock (AC-L5)", () => {
  L.appendStarted(started("r4"));
  L.appendFinalized(finalized("r4"));
  const f = L.readRuns().find((r) => r.event === "run_finalized");
  for (const k of ["outcome", "harness", "criteria", "decisions", "tokens", "wallClockMs"]) {
    assert.ok(f[k] !== undefined, `finalized must carry ${k}`);
  }
  assert.equal(f.harness.version, "9.9.9");
});

test("the contract is stored byte-identically alongside the run (AC-C3)", () => {
  const c = { goal: "exact", nested: { list: [1, 2, 3] }, acceptanceCriteria: [{ id: "AC1" }] };
  L.appendStarted({ ...started("r5"), contract: c });
  assert.deepEqual(L.readRuns().find((r) => r.event === "run_started").contract, c);
});

test("guard decisions stream to a per-run sidecar and are counted", () => {
  L.appendDecision("r6", { tool: "Bash", allow: false, rule: "bashPatterns", reason: "no match", target: "rm -rf /" });
  L.appendDecision("r6", { tool: "Read", allow: true, rule: "readRoots", target: "C:/x/a.txt" });
  assert.deepEqual(L.decisionCounts("r6"), { allow: 1, deny: 1, total: 2 });
  assert.equal(fs.existsSync(L.decisionsFile("r6")), true);
});

test("autonomyFile lives beside the runs file, under the ledger dir", () => {
  assert.equal(path.dirname(L.autonomyFile()), L.ledgerDir());
  assert.equal(path.basename(L.autonomyFile()), "autonomy.json");
});

test("a truncated trailing line does not lose the records before it", () => {
  L.appendStarted(started("r7"));
  fs.appendFileSync(L.runsFile(), '{"event":"run_fina');
  assert.equal(L.readRuns().length, 1);
});

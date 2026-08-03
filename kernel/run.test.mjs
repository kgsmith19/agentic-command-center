// node --test kernel/run.test.mjs  (run from C:\code\guards)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, "run.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-run-"));
process.env.ACC_ROOT = path.join(BASE, "root");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_LANE_DIR = path.join(BASE, "lane");
fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({
  kernel: { harness: "claude-code", hardCaps: { wallClockMin: 240 } },
  lane: { slots: 1, minGapMs: 0, pollMs: 10, breakerThreshold: 100000 },
}));

const R = await import("./run.mjs");
const L = await import("./ledger.mjs");

const contractFile = (c) => {
  const f = path.join(BASE, `c-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(c));
  return f;
};
const good = () => ({
  goal: "g", constraints: [],
  allowedActions: { readRoots: [path.join(BASE, "work")], writeRoots: [], bashPatterns: [], networkHosts: [], vaultKeys: [], subagents: [] },
  budget: { wallClockMin: 30, toolCalls: 100, tokens: 200000 },
  acceptanceCriteria: [{ id: "AC1", ears: "x", verify: { method: "file_exists", path: path.join(BASE, "work", "out.txt") } }],
  rollbackPlan: "none",
});
const fakeAdapter = (over = {}) => ({
  id: "fake", identity: () => ({ name: "fake", version: "1.0.0" }),
  startTask: async () => ({ pid: 1, done: Promise.resolve({ code: 0, events: [] }), stop: async () => {} }),
  sendStep: async () => {}, readState: () => ({ toolCalls: 0, tokens: 0, texts: [], sessionId: null }),
  stopTask: async () => {}, ...over,
});

beforeEach(() => fs.rmSync(L.ledgerDir(), { recursive: true, force: true }));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("an incomplete contract is refused with NO ledger entry and no harness (AC-C1)", async () => {
  const c = good(); delete c.acceptanceCriteria;
  let probed = false;
  const r = await R.runTask(contractFile(c), { adapter: fakeAdapter({ identity: () => { probed = true; return {}; } }) });
  assert.equal(r.outcome, "refused");
  assert.ok(r.errors.join(" ").includes("acceptanceCriteria"));
  assert.equal(probed, false, "a harness must never be probed for an invalid contract");
  assert.equal(L.readRuns().length, 0, "a refused contract is not a run and gets no ledger entry");
});

test("a harness that cannot start is recorded as failed-to-start, fail closed (AC-A3, AC-L1)", async () => {
  const adapter = fakeAdapter({ identity: () => { throw new Error("ENOENT"); } });
  const r = await R.runTask(contractFile(good()), { adapter });
  assert.equal(r.outcome, "failed-to-start");
  const rows = L.readRuns();
  assert.equal(rows.filter((x) => x.event === "run_started").length, 1);
  const f = rows.find((x) => x.event === "run_finalized");
  assert.equal(f.outcome, "failed-to-start");
  assert.match(f.error, /ENOENT/);
});

test("harness identity and version reach the ledger for every run (AC-A2)", async () => {
  await R.runTask(contractFile(good()), { adapter: fakeAdapter() });
  const f = L.readRuns().find((x) => x.event === "run_finalized");
  assert.deepEqual(f.harness, { name: "fake", version: "1.0.0" });
});

test("the contract is stored verbatim in the started line (AC-C3)", async () => {
  const c = good();
  await R.runTask(contractFile(c), { adapter: fakeAdapter() });
  assert.deepEqual(L.readRuns().find((x) => x.event === "run_started").contract, c);
});

test("runTask resolves a real adapter when none is injected", async () => {
  const r = await R.runTask(contractFile(good()));
  assert.equal(r.harness.name, "claude-code");
});

test("run ids are unique", () => {
  assert.notEqual(R.newRunId(), R.newRunId());
  assert.match(R.newRunId(), /^r-\d{8}T\d{6}-[0-9a-f]{6}$/);
});

// The isMain guard only runs via a real process invocation, never via
// `node --test` import (the same shape kernel/ledger.mjs proves itself).
test("end-to-end: the CLI with no contract argument prints usage and exits 2", () => {
  assert.throws(
    () => execFileSync("node", [RUN], { encoding: "utf8", env: process.env }),
    (err) => /usage: node kernel\/run\.mjs/.test(err.stderr) && err.status === 2
  );
});

test("end-to-end: the CLI refuses an invalid contract and exits 2", () => {
  const f = contractFile({ goal: "g" });
  assert.throws(
    () => execFileSync("node", [RUN, f], { encoding: "utf8", env: process.env }),
    (err) => {
      const out = JSON.parse(err.stdout);
      return out.outcome === "refused" && err.status === 2;
    }
  );
});

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
  goal: "g", constraints: ["do not touch files outside the workspace"],
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
  // A vault key the (empty) test vault doesn't have makes envForKeys throw
  // and fail closed AFTER identity() but BEFORE startTask() — proving real
  // adapter resolution without ever spawning a live `claude -p` process.
  const c = good();
  c.allowedActions.vaultKeys = ["NOT_IN_VAULT_XYZ"];
  const r = await R.runTask(contractFile(c));
  assert.equal(r.harness.name, "claude-code");
  assert.equal(r.outcome, "failed-to-start");
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

const S = await import("./settings.mjs");
const workDir = path.join(BASE, "work");
fs.mkdirSync(workDir, { recursive: true });
process.env.ACC_VAULT = path.join(BASE, "vault.json");
fs.writeFileSync(process.env.ACC_VAULT, JSON.stringify({ TASK_KEY: "sk-live-LEDGER-SENTINEL" }));

// A fake harness that records how it was launched and can act on the workspace.
function recordingAdapter({ onLaunch, exitCode = 0, events = [] } = {}) {
  const seen = {};
  return {
    adapter: {
      id: "fake", identity: () => ({ name: "fake", version: "1.0.0" }),
      startTask: async (opts) => {
        Object.assign(seen, opts);
        if (onLaunch) await onLaunch(opts);
        return { pid: 1, events, done: Promise.resolve({ code: exitCode, events }), stop: async () => {} };
      },
      sendStep: async () => {}, stopTask: async () => {},
      readState: (evts) => ({ toolCalls: evts.length, tokens: 42, texts: [], sessionId: "s" }),
    },
    seen,
  };
}

test("the harness is launched with the run's staging dir and the pinned settings (AC-G5)", async () => {
  const { adapter, seen } = recordingAdapter();
  const c = good();
  const r = await R.runTask(contractFile(c), { adapter });
  assert.equal(seen.env.ACC_KERNEL_DIR, S.runDir(r.runId));
  assert.match(seen.settingsPath, /settings\.json$/);
  assert.deepEqual(seen.tools.sort(), ["Glob", "Grep", "Read", "TodoWrite"].sort());
  const started = L.readRuns().find((x) => x.event === "run_started");
  assert.match(started.settingsSha256, /^[0-9a-f]{64}$/);
});

test("contract-listed vault keys reach the child env and NOTHING else (AC-L4)", async () => {
  const c = good();
  c.allowedActions.vaultKeys = ["TASK_KEY"];
  const { adapter, seen } = recordingAdapter();
  const r = await R.runTask(contractFile(c), { adapter });
  assert.equal(seen.env.TASK_KEY, "sk-live-LEDGER-SENTINEL", "the value must reach the child env");

  // The real assertion: the value exists nowhere on disk under the ledger.
  for (const f of fs.readdirSync(L.ledgerDir())) {
    const text = fs.readFileSync(path.join(L.ledgerDir(), f), "utf8");
    assert.equal(text.includes("LEDGER-SENTINEL"), false, `${f} contains a credential value`);
    assert.equal(text.includes("sk-live"), false, `${f} contains a credential value`);
  }
  assert.ok(JSON.stringify(L.readRuns()).includes("TASK_KEY"), "key NAMES are recorded, values are not");
  assert.equal(r.outcome === "accepted" || r.outcome === "rejected", true);
});

test("a vault key the contract asks for but the vault lacks fails closed", async () => {
  const c = good();
  c.allowedActions.vaultKeys = ["NOT_IN_VAULT"];
  const r = await R.runTask(contractFile(c), { adapter: recordingAdapter().adapter });
  assert.equal(r.outcome, "failed-to-start");
  assert.match(L.readRuns().find((x) => x.event === "run_finalized").error, /NOT_IN_VAULT/);
});

test("settings tampered BEFORE launch refuse to launch (AC-G5)", async () => {
  let launched = false;
  const adapter = recordingAdapter({ onLaunch: () => { launched = true; } }).adapter;
  const r = await R.runTask(contractFile(good()), {
    adapter,
    afterStage: (dir) => {                       // test seam: mutate between pin and launch
      const f = path.join(dir, "settings.json");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8") + "\n");
    },
  });
  assert.equal(launched, false, "a failed integrity check must happen BEFORE the harness starts");
  assert.equal(r.outcome, "failed-to-start");
  assert.match(L.readRuns().find((x) => x.event === "run_finalized").error, /integrity/i);
});

test("verification runs only after the harness process has exited (AC-V3)", async () => {
  const out = path.join(workDir, "out.txt");
  fs.rmSync(out, { force: true });
  // The criterion can only pass if the verifier ran AFTER the harness finished.
  const { adapter } = recordingAdapter({ onLaunch: () => fs.writeFileSync(out, "done") });
  const r = await R.runTask(contractFile(good()), { adapter });
  assert.equal(r.outcome, "accepted");
  assert.deepEqual(r.criteria.map((c) => [c.id, c.status]), [["AC1", "pass"]]);
});

test("a criterion that does not hold makes the run rejected (AC-V2, AC-L5)", async () => {
  fs.rmSync(path.join(workDir, "out.txt"), { force: true });
  const r = await R.runTask(contractFile(good()), { adapter: recordingAdapter().adapter });
  assert.equal(r.outcome, "rejected");
  const f = L.readRuns().find((x) => x.event === "run_finalized");
  assert.equal(f.criteria[0].status, "fail");
  assert.equal(f.tokens, 42);
  assert.ok(f.wallClockMs >= 0);
});

test("a contract that omits every optional field still runs with sensible defaults", async () => {
  const c = good();
  delete c.allowedActions.writeRoots;
  delete c.allowedActions.readRoots;
  delete c.allowedActions.vaultKeys;
  delete c.budget.wallClockMin;
  const { adapter, seen } = recordingAdapter();
  const r = await R.runTask(contractFile(c), { adapter });
  assert.equal(seen.cwd, process.cwd(), "workspaceOf falls back to cwd when no roots are named");
  assert.equal(seen.env.TASK_KEY, undefined, "no vaultKeys means no credentials injected");
  assert.equal(seen.ttlMs, 60 * 60 * 1000, "wallClockMin defaults to 60 minutes");
  assert.equal(r.outcome === "accepted" || r.outcome === "rejected", true);
});

test("a harness whose startTask itself throws is recorded as failed-to-start (AC-A3)", async () => {
  const adapter = { ...recordingAdapter().adapter, startTask: async () => { throw new Error("spawn ENOENT"); } };
  const r = await R.runTask(contractFile(good()), { adapter });
  assert.equal(r.outcome, "failed-to-start");
  assert.match(L.readRuns().find((x) => x.event === "run_finalized").error, /spawn ENOENT/);
});

test("the staging directory is removed on every exit path (AC-G3)", async () => {
  fs.writeFileSync(path.join(workDir, "out.txt"), "done");
  const okRun = await R.runTask(contractFile(good()), { adapter: recordingAdapter().adapter });
  assert.equal(fs.existsSync(S.runDir(okRun.runId)), false);
  const badRun = await R.runTask(contractFile(good()), {
    adapter: { ...recordingAdapter().adapter, identity: () => { throw new Error("ENOENT"); } },
  });
  assert.equal(fs.existsSync(S.runDir(badRun.runId)), false);
});

// node --test kernel/guardhook.test.mjs  (run from C:\code\guards)
// Integration: spawns the hook as a real subprocess with a real stdin payload,
// which is the only way the fail-closed and exit-code contract is actually proven.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "guardhook.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-hook-"));
const ROOT = path.join(BASE, "root");
const POLICY = path.join(BASE, "policy.json");
fs.writeFileSync(POLICY, JSON.stringify({ kernel: { alwaysAllowTools: ["TodoWrite"] } }));

const S = await import("./settings.mjs");
const L = await import("./ledger.mjs");
const AU = await import("./autonomy.mjs");
const P = await import("./policy.mjs");

const RUN = "r-hook";
const contract = {
  goal: "g", constraints: [], rollbackPlan: "none",
  allowedActions: { readRoots: [path.join(BASE, "work")], writeRoots: [], bashPatterns: ["npm test"], networkHosts: [], vaultKeys: [], subagents: [] },
  budget: { wallClockMin: 10, toolCalls: 3, tokens: 100 },
  acceptanceCriteria: [{ id: "AC1", ears: "x", verify: { method: "git_clean" } }],
};

function stage() {
  process.env.ACC_ROOT = ROOT;
  process.env.ACC_POLICY = POLICY;
  fs.rmSync(ROOT, { recursive: true, force: true });
  return S.writeRunFiles(contract, { runId: RUN, guardhookPath: HOOK });
}

function fire(payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, ACC_ROOT: ROOT, ACC_POLICY: POLICY, ACC_KERNEL_DIR: S.runDir(RUN), ...env },
  });
  return { code: r.status, err: r.stderr || "" };
}

beforeEach(() => stage());
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("an allowed call exits 0; a denied call exits 2 with the reason on stderr (AC-G1)", () => {
  const ok = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(ok.code, 0);
  const no = fire({ tool_name: "Write", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(no.code, 2);
  assert.match(no.err, /not granted by the contract/);
});

test("every decision, allow and deny, is appended to the run's sidecar (AC-G2)", () => {
  fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  fire({ tool_name: "Bash", tool_input: { command: "curl evil.example" } });
  process.env.ACC_ROOT = ROOT;
  const counts = L.decisionCounts(RUN);
  assert.deepEqual(counts, { allow: 1, deny: 1, total: 2 });
  const rows = fs.readFileSync(L.decisionsFile(RUN), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[1].tool, "Bash");
  assert.equal(rows[1].allow, false);
  assert.ok(rows[1].ts, "each decision is timestamped");
});

test("a settings file tampered mid-run denies everything and flags the run (AC-G6)", () => {
  const w = S.writeRunFiles(contract, { runId: RUN, guardhookPath: HOOK });
  const evil = JSON.parse(fs.readFileSync(w.settingsPath, "utf8"));
  evil.hooks.PreToolUse = [];
  fs.writeFileSync(w.settingsPath, JSON.stringify(evil, null, 2));
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 2);
  assert.match(r.err, /integrity/i);
  process.env.ACC_ROOT = ROOT;
  const rows = fs.readFileSync(L.decisionsFile(RUN), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).rule, "integrity");
});

test("every unreadable input fails closed (AC-G11)", () => {
  // no payload
  const noPayload = spawnSync(process.execPath, [HOOK], {
    input: "", encoding: "utf8",
    env: { ...process.env, ACC_ROOT: ROOT, ACC_POLICY: POLICY, ACC_KERNEL_DIR: S.runDir(RUN) },
  });
  assert.equal(noPayload.status, 2);

  // no run directory in the environment
  assert.equal(fire({ tool_name: "Read", tool_input: { file_path: "x" } }, { ACC_KERNEL_DIR: "" }).code, 2);

  // corrupt contract
  fs.writeFileSync(path.join(S.runDir(RUN), "contract.json"), "{ not json");
  assert.equal(fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } }).code, 2);

  // corrupt policy
  stage();
  fs.writeFileSync(POLICY, "{ not json");
  assert.equal(fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } }).code, 2);
  fs.writeFileSync(POLICY, JSON.stringify({ kernel: { alwaysAllowTools: ["TodoWrite"] } }));

  // corrupt/missing pin
  stage();
  fs.rmSync(path.join(S.runDir(RUN), "pin.json"));
  const noPin = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(noPin.code, 2);
  assert.match(noPin.err, /cannot read the run pin/);
});

test("a corrupt contract with a payload that itself has no tool_name still fails closed", () => {
  fs.writeFileSync(path.join(S.runDir(RUN), "contract.json"), "{ not json");
  const r = fire({});
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot read the contract or kernel policy/);
});

test("the tool-call ceiling falls back to the policy default when the contract omits budget.toolCalls", () => {
  const c = { ...contract, budget: { wallClockMin: 10, tokens: 100 } }; // no toolCalls
  fs.writeFileSync(POLICY, JSON.stringify({ kernel: { alwaysAllowTools: ["TodoWrite"], budget: { toolCalls: 1 } } }));
  S.writeRunFiles(c, { runId: RUN, guardhookPath: HOOK });
  assert.equal(fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } }).code, 0);
  const over = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(over.code, 2);
  assert.match(over.err, /ceiling/);
  fs.writeFileSync(POLICY, JSON.stringify({ kernel: { alwaysAllowTools: ["TodoWrite"] } }));
});

test("a decision log that cannot be written fails closed (AC-G11)", () => {
  // Block only THIS run's decisions file, not the whole ledger directory:
  // OI-024's readAutonomyStrict() also reads a sibling file in that same
  // directory (autonomyFile()) earlier in the hook's flow, so blocking the
  // directory itself now trips that check first instead of the decision-log
  // write this test targets. A directory in place of the decisions file
  // makes appendFileSync throw while leaving autonomy.json's path untouched.
  fs.mkdirSync(L.decisionsFile(RUN), { recursive: true });
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot write the decision log/);
});

test("a deny that itself cannot log the decision still denies (the denial stands regardless)", () => {
  const w = S.writeRunFiles(contract, { runId: RUN, guardhookPath: HOOK });
  const evil = JSON.parse(fs.readFileSync(w.settingsPath, "utf8"));
  evil.hooks.PreToolUse = [];
  fs.writeFileSync(w.settingsPath, JSON.stringify(evil, null, 2));
  fs.mkdirSync(path.join(ROOT, "runner"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "runner", "ledger"), "blocked");
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 2);
  assert.match(r.err, /integrity/i);
});

test("a stdin pipe that never closes still fails closed once the timeout cap elapses", async () => {
  const child = spawn(process.execPath, [HOOK], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ACC_ROOT: ROOT, ACC_POLICY: POLICY, ACC_KERNEL_DIR: S.runDir(RUN), ACC_GUARDHOOK_STDIN_TIMEOUT_MS: "50" },
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  // Deliberately never end() stdin — the hook must not hang waiting for it.
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 2);
  assert.match(stderr, /unreadable stdin payload|no readable hook payload/);
});

test("OI-028: an oversized stdin payload fails closed instead of buffering unbounded", async () => {
  const child = spawn(process.execPath, [HOOK], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ACC_ROOT: ROOT, ACC_POLICY: POLICY, ACC_KERNEL_DIR: S.runDir(RUN), ACC_GUARDHOOK_STDIN_MAX_BYTES: "100" },
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdin.write("x".repeat(1000)); // well over the 100-byte cap
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 2);
  assert.match(stderr, /exceeded 100 bytes/);
});

test("the tool-call ceiling is enforced across separate hook fires (AC-B1)", () => {
  const call = () => fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(call().code, 0);
  assert.equal(call().code, 0);
  assert.equal(call().code, 0);
  const over = call();               // contract budget.toolCalls is 3
  assert.equal(over.code, 2);
  assert.match(over.err, /ceiling/);
});

test("a tightened autonomy factor shrinks the per-fire ceiling to EXACTLY effectiveCeilings' number (OI-024)", () => {
  stage();
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), JSON.stringify({ factor: 0.5 }));
  const shrunk = AU.effectiveCeilings(contract, P.loadKernelPolicy(), { factor: 0.5 }).toolCalls; // 3 * 0.5 -> 2
  const read = () => fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  for (let i = 0; i < shrunk; i++) assert.equal(read().code, 0, `fire ${i + 1} of ${shrunk} must still be allowed`);
  const over = read();
  assert.equal(over.code, 2, "the fire after the shrunk ceiling must be denied");
  const rows = fs.readFileSync(L.decisionsFile(RUN), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).ceiling, shrunk, "the decision record must carry the effective ceiling");
  assert.equal(rows.at(-1).autonomyFactor, 0.5, "…and the factor that produced it");
});

test("absent autonomy state means base ceiling, corrupt autonomy state fails closed", () => {
  stage(); // no autonomy file
  const read = () => fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  for (let i = 0; i < 3; i++) assert.equal(read().code, 0); // contract.budget.toolCalls = 3
  assert.equal(read().code, 2);
  stage();
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), "{ not json");
  const r = read();
  assert.equal(r.code, 2);
  assert.match(r.err, /autonomy/i);
});

test("a contract yielding no finite toolCalls ceiling denies instead of comparing against NaN", () => {
  process.env.ACC_ROOT = ROOT; process.env.ACC_POLICY = POLICY;
  fs.rmSync(ROOT, { recursive: true, force: true });
  S.writeRunFiles({ ...contract, budget: { ...contract.budget, toolCalls: "many" } }, { runId: RUN, guardhookPath: HOOK });
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 2);
  assert.match(r.err, /finite/i);
});

test("the autonomy-state and non-finite-ceiling denials still record with tool:null when the payload itself has no tool_name", () => {
  stage();
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), "{ not json");
  const noToolAutonomy = fire({});
  assert.equal(noToolAutonomy.code, 2);
  assert.match(noToolAutonomy.err, /autonomy/i);

  stage();
  S.writeRunFiles({ ...contract, budget: { ...contract.budget, toolCalls: "many" } }, { runId: RUN, guardhookPath: HOOK });
  const noToolCeiling = fire({});
  assert.equal(noToolCeiling.code, 2);
  assert.match(noToolCeiling.err, /finite/i);
});

test("a stored autonomy factor of null falls back to 1 in the decision record, not NaN or null", () => {
  stage();
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), JSON.stringify({ factor: null }));
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 0);
  const rows = fs.readFileSync(L.decisionsFile(RUN), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).autonomyFactor, 1);
});

test("OI-019: a decision lock that cannot be acquired fails closed with its own distinct reason", () => {
  const lockPath = L.decisionsFile(RUN) + ".lock";
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, ""); // fresh mtime — held, not stale, within the low timeout below
  const r = fire(
    { tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } },
    { ACC_LEDGER_LOCK_TIMEOUT_MS: "50" }
  );
  assert.equal(r.code, 2);
  assert.match(r.err, /cannot acquire the decision lock/);
  // A payload that parses to `null` (valid JSON, not an object) reaching this
  // SAME denial exercises payload?.tool_name's other branch — the lock-denial
  // record must still carry tool:null rather than throwing on a null payload.
  const r2 = fire(null, { ACC_LEDGER_LOCK_TIMEOUT_MS: "50" });
  assert.equal(r2.code, 2);
  assert.match(r2.err, /cannot acquire the decision lock/);
  fs.rmSync(lockPath, { force: true });
});

test("OI-019: concurrent hook fires against the SAME run never allow more than the ceiling, total (read-decide-append race)", async () => {
  // contract.budget.toolCalls = 3 (see top of file). Claude Code can and does
  // dispatch several tool calls from one turn concurrently, all hitting this
  // same run's guardhook — read-attempts / decide / append-decision is three
  // separate steps with nothing serializing them across processes. Fire well
  // more than the ceiling, truly concurrently (spawn, not spawnSync), and the
  // allowed count must never exceed the ceiling no matter how the races land.
  const N = 40;
  const fireAsync = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, ACC_ROOT: ROOT, ACC_POLICY: POLICY, ACC_KERNEL_DIR: S.runDir(RUN) },
    });
    child.on("close", (code) => resolve(code));
    child.stdin.end(JSON.stringify({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } }));
  });
  const codes = await Promise.all(Array.from({ length: N }, fireAsync));
  const allowed = codes.filter((c) => c === 0).length;
  assert.ok(
    allowed <= 3,
    `ceiling is 3 but ${allowed} of ${N} truly-concurrent fires were allowed — the read-decide-append sequence is not atomic across processes`
  );
  process.env.ACC_ROOT = ROOT;
  const counts = L.decisionCounts(RUN);
  assert.equal(counts.total, N, "every fire must still be recorded exactly once, race or not");
});

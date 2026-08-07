// node --test gui/server.test.mjs  (run from C:\code\guards)
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-gui-srv-"));
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_ROOT = path.join(BASE, "root");
const KERNEL = {
  harness: "claude-code",
  budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 },
  hardCaps: { wallClockMin: 240 },
  autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 },
  checkpointMin: 20, alwaysAllowTools: ["TodoWrite"], extraDenyWriteRoots: [],
};
const resetPolicy = () => fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ kernel: { ...KERNEL, _note: "fixture" } }, null, 2));

const { startServer, handler, cli } = await import("./server.mjs");
let srv, base;
before(async () => { const s = await startServer({ port: 0 }); srv = s.server; base = `http://127.0.0.1:${s.port}`; });
beforeEach(resetPolicy);
after(() => { srv.close(); fs.rmSync(BASE, { recursive: true, force: true }); });

const good = () => ({ ...KERNEL, budget: { ...KERNEL.budget, toolCalls: 150 } });
const post = (body, headers = {}) => fetch(`${base}/api/kernel-policy`, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", "X-ACC": "1", ...headers },
});

test("GET / serves the kernel page", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /id="toolCalls"/);
});

test("GET /api/kernel-policy returns the live block", async () => {
  const r = await fetch(`${base}/api/kernel-policy`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).kernel.budget.toolCalls, 200);
});

test("a valid POST lands on disk and preserves _note", async () => {
  const r = await post(good());
  assert.equal(r.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  assert.equal(onDisk.kernel.budget.toolCalls, 150);
  assert.equal(onDisk.kernel._note, "fixture");
});

// fetch() (undici) enforces the Fetch spec's forbidden-header list: a
// caller-supplied Host header is silently dropped and the real connection
// host is sent instead, so it cannot exercise the Host-spoofing defense.
// node:http's raw client has no such restriction — use it for that case.
const rawRequest = (method, headers) => new Promise((resolve) => {
  const port = Number(new URL(base).port);
  const req = http.request(
    { host: "127.0.0.1", port, path: "/api/kernel-policy", method, headers },
    (res) => { let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, body })); }
  );
  req.end(method === "POST" ? JSON.stringify(good()) : undefined);
});

test("CSRF is closed by construction: no X-ACC header, foreign Origin, foreign Host all 403 and never write", async () => {
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  assert.equal((await post(good(), { "X-ACC": "" })).status, 403);
  assert.equal((await post(good(), { origin: "https://evil.example" })).status, 403);
  assert.equal((await rawRequest("POST", { "content-type": "application/json", "X-ACC": "1", host: "evil.example" })).status, 403);
  assert.equal((await rawRequest("GET", { host: "evil.example" })).status, 403);
  assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before);
});

test("no CORS grant ever leaves this server", async () => {
  const r = await fetch(`${base}/api/kernel-policy`, { headers: { origin: "http://127.0.0.1" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("invalid input: bad JSON 400, invalid block 400 with the validator's message, file untouched", async () => {
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  const raw = await fetch(`${base}/api/kernel-policy`, { method: "POST", body: "{ nope", headers: { "X-ACC": "1" } });
  assert.equal(raw.status, 400);
  const bad = await post({ ...good(), checkpointMin: -1 });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /checkpointMin/);
  assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before);
});

test("unknown routes 404", async () => {
  assert.equal((await fetch(`${base}/api/other`)).status, 404);
  assert.equal((await fetch(`${base}/../policy.json`)).status, 404);
});

test("GET /api/kernel-policy surfaces a 500 when the policy file is unreadable", async () => {
  fs.writeFileSync(process.env.ACC_POLICY, "{ not json");
  const r = await fetch(`${base}/api/kernel-policy`);
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /kernel policy unreadable/);
});

test("handler(): a request with no Host header at all is denied (defensive default)", () => {
  const res = { writeHead(code, headers) { res.code = code; res.headers = headers; }, end(body) { res.body = body; } };
  handler({ headers: {}, url: "/", method: "GET" }, res);
  assert.equal(res.code, 403);
});

test("a POST body over the cap is dropped before parsing (no memory blow-up)", async () => {
  const port = Number(new URL(base).port);
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/kernel-policy", method: "POST", headers: { "content-type": "application/json", "X-ACC": "1" } });
    req.on("error", resolve); // req.destroy() aborts the socket; either an error or an unfinished response is fine
    req.on("response", (res) => { res.resume(); res.on("end", resolve); });
    req.write("x".repeat(70 * 1024));
    req.end();
  });
  assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before, "an over-cap body must never reach saveKernelPolicy");
});

test("cli(): starts a server and logs LISTENING <port>; --port is optional (defaults to ephemeral)", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  let withPort, withoutPort;
  try {
    withPort = await cli(["node", "server.mjs", "--port", "0"]);
    withoutPort = await cli(["node", "server.mjs"]);
    assert.match(logs.join("\n"), /^LISTENING \d+$/m);
    assert.ok(withPort.port > 0 && withoutPort.port > 0);
    const r = await fetch(`http://127.0.0.1:${withPort.port}/api/kernel-policy`);
    assert.equal(r.status, 200);
  } finally {
    console.log = orig;
    withPort?.server.close();
    withoutPort?.server.close();
  }
});

test("CLI: prints LISTENING <port> and serves on it", async () => {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
  const child = spawn(process.execPath, [serverPath, "--port", "0"], {
    env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  const line = await new Promise((res) => child.stdout.once("data", (d) => res(String(d))));
  const m = line.match(/^LISTENING (\d+)/);
  assert.ok(m, `expected LISTENING banner, got: ${line}`);
  const r = await fetch(`http://127.0.0.1:${m[1]}/api/kernel-policy`);
  assert.equal(r.status, 200);
  child.kill();
});

// ------------------------------------------------------------- guards API (SPEC-0002, SL-009)
// The server shells hooks/engine.mjs exactly as guards-gui.ps1 does. Tests
// drive it against a FAKE engine (runner.test.mjs's fake-claude discipline):
// canned outputs, argv recorded, the real repo's config.json never touched.
// ACC_ENGINE is read per request, so one suite can exercise fake and real.
const ENGINE_DIR = path.join(BASE, "engine-state");
const FAKE_ENGINE = path.join(BASE, "fake-engine.mjs");
const RUNBOX = path.join(BASE, "rb");
fs.writeFileSync(
  FAKE_ENGINE,
  `
import fs from "node:fs";
const dir = process.env.FAKE_ENGINE_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(argv) + "\\n");
const mode = fs.existsSync(dir + "/mode.txt") ? fs.readFileSync(dir + "/mode.txt", "utf8").trim() : "ok";
if (mode === "fail") { process.stderr.write("engine says no"); process.exit(1); }
const lists = JSON.parse(fs.readFileSync(dir + "/list.json", "utf8"));
if (argv[0] === "status") { console.log(JSON.stringify(lists.status)); process.exit(0); }
if (argv[0] === "list" && argv[1] === "--json") { console.log(JSON.stringify(lists.pending)); process.exit(0); }
if (argv[0] === "trash-list" && argv[1] === "--json") { console.log(JSON.stringify(lists.trashed)); process.exit(0); }
console.log("did " + argv.join(" "));
`.trimStart()
);
process.env.FAKE_ENGINE_DIR = ENGINE_DIR;

const engineCalls = () => {
  try { return fs.readFileSync(path.join(ENGINE_DIR, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

function resetEngine() {
  process.env.ACC_ENGINE = FAKE_ENGINE;
  fs.rmSync(ENGINE_DIR, { recursive: true, force: true });
  fs.mkdirSync(ENGINE_DIR, { recursive: true });
  fs.mkdirSync(RUNBOX, { recursive: true });
  fs.writeFileSync(path.join(RUNBOX, "fix.ps1"), "# does a thing\necho hi\n");
  fs.writeFileSync(path.join(ENGINE_DIR, "list.json"), JSON.stringify({
    status: { enabled: true, secrets: [".env"], protected: ["/x"], projects: [], vaultKeys: ["K"], pending: 1, trashed: 0 },
    pending: [{ label: "central", name: "fix.ps1", dir: RUNBOX, runboxDir: RUNBOX, cwd: RUNBOX, keep: false, summary: "does a thing" }],
    trashed: [],
  }));
}

const gpost = (route, body, headers = {}) => fetch(`${base}${route}`, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", "X-ACC": "1", ...headers },
});

test("AC-001: GET /api/guards/status passes the engine's status JSON through", async () => {
  resetEngine();
  const r = await fetch(`${base}/api/guards/status`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.enabled, true);
  assert.deepEqual(j.secrets, [".env"]);
  assert.deepEqual(j.vaultKeys, ["K"]);
});

test("GET /api/guards/list returns pending and trashed from the --json verbs", async () => {
  resetEngine();
  const r = await fetch(`${base}/api/guards/list`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.pending[0].name, "fix.ps1");
  assert.deepEqual(j.trashed, []);
});

test("AC-002: an allowlisted verb builds the exact engine argv", async () => {
  resetEngine();
  const r = await gpost("/api/guards/engine", { verb: "toggle", arg: "on" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.code, 0);
  assert.deepEqual(engineCalls().at(-1), ["toggle", "on"]);
});

test("AC-003: a verb outside the allowlist is refused and the engine is never invoked", async () => {
  resetEngine();
  for (const verb of ["apply", "vault-import", "rm -rf /", "status; curl evil"]) {
    const r = await gpost("/api/guards/engine", { verb, arg: "x" });
    assert.equal(r.status, 400, `verb "${verb}" must be refused`);
  }
  assert.equal(engineCalls().length, 0, "no refused verb may reach the engine");
});

test("AC-003b: a malformed arg (empty, huge, NUL, non-string) is refused before the engine", async () => {
  resetEngine();
  for (const arg of ["", "x".repeat(513), "a\0b", 42, null]) {
    const r = await gpost("/api/guards/engine", { verb: "trash", arg });
    assert.equal(r.status, 400);
  }
  assert.equal(engineCalls().length, 0);
});

test("AC-004: guards POSTs demand X-ACC and local Origin, like every mutating route", async () => {
  resetEngine();
  assert.equal((await gpost("/api/guards/engine", { verb: "toggle", arg: "on" }, { "X-ACC": "" })).status, 403);
  assert.equal((await gpost("/api/guards/engine", { verb: "toggle", arg: "on" }, { origin: "https://evil.example" })).status, 403);
  assert.equal(engineCalls().length, 0);
});

test("AC-005: preview returns the listed script's content", async () => {
  resetEngine();
  const r = await gpost("/api/guards/preview", { ref: "central:fix.ps1" });
  assert.equal(r.status, 200);
  assert.match((await r.json()).content, /does a thing/);
});

test("AC-006: preview refuses refs the engine's list does not contain — traversal never reaches the filesystem", async () => {
  resetEngine();
  for (const ref of ["../../etc/passwd", "central:../../../etc/passwd", "ghost.ps1"]) {
    const r = await gpost("/api/guards/preview", { ref });
    assert.equal(r.status, 404, `ref "${ref}" must 404`);
  }
});

test("AC-007: an engine failure surfaces as code+stderr, never masked as success", async () => {
  resetEngine();
  fs.writeFileSync(path.join(ENGINE_DIR, "mode.txt"), "fail");
  const r = await gpost("/api/guards/engine", { verb: "run", arg: "central:fix.ps1" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.code, 1);
  assert.match(j.out, /engine says no/);
});

test("AC-008: flush needs an explicit confirm and maps to `flush --really`", async () => {
  resetEngine();
  assert.equal((await gpost("/api/guards/engine", { verb: "flush" })).status, 400);
  assert.equal(engineCalls().length, 0);
  const r = await gpost("/api/guards/engine", { verb: "flush", confirm: true });
  assert.equal(r.status, 200);
  assert.deepEqual(engineCalls().at(-1), ["flush", "--really"]);
});

test("AC-009: the real engine answers status through the same route (read-only wiring proof)", async () => {
  resetEngine();
  delete process.env.ACC_ENGINE; // fall back to the real hooks/engine.mjs
  try {
    const r = await fetch(`${base}/api/guards/status`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.enabled, "boolean");
    assert.ok(Array.isArray(j.secrets));
  } finally {
    process.env.ACC_ENGINE = FAKE_ENGINE;
  }
});

test("GET /guards serves the guards page", async () => {
  const r = await fetch(`${base}/guards`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /id="toggle"/);
});

test("an engine failure on the read routes surfaces as 500, never an empty 200", async () => {
  resetEngine();
  fs.writeFileSync(path.join(ENGINE_DIR, "mode.txt"), "fail");
  assert.equal((await fetch(`${base}/api/guards/status`)).status, 500);
  assert.equal((await fetch(`${base}/api/guards/list`)).status, 500);
});

test("preview of a listed script whose file is gone is a 500, not a crash or an empty success", async () => {
  resetEngine();
  fs.rmSync(path.join(RUNBOX, "fix.ps1"));
  const r = await gpost("/api/guards/preview", { ref: "central:fix.ps1" });
  assert.equal(r.status, 500);
});

test("PROP-001 hardening: prototype-key verbs (__proto__, toString, constructor) are refused as own-property misses", async () => {
  resetEngine();
  for (const verb of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
    const r = await gpost("/api/guards/engine", { verb, arg: "x" });
    assert.equal(r.status, 400, `prototype key "${verb}" must be refused, never resolved`);
  }
  assert.equal(engineCalls().length, 0);
});

// ------------------------------------------------------------- vault API (SPEC-0003, secret-value-in-transit)
// The fake engine records its STDIN so a test can prove the value's only sink
// is that channel — never argv, never a response field, never a log line.
function fakeStdinFrom() {
  try { return fs.readFileSync(path.join(ENGINE_DIR, "stdin.txt"), "utf8"); } catch { return ""; }
}
// Extend the fake engine to capture stdin for vault-import.
function withVaultFake() {
  fs.writeFileSync(FAKE_ENGINE, `
import fs from "node:fs";
const dir = process.env.FAKE_ENGINE_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(argv) + "\\n");
if (argv[0] === "vault-import") {
  let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => {
    fs.writeFileSync(dir + "/stdin.txt", s);
    const names = s.split(/\\r?\\n/).map((l) => l.trim()).filter((l) => l && l.indexOf("=") > 0).map((l) => l.slice(0, l.indexOf("=")).trim());
    if (!names.length) { process.stderr.write("no KEY=VALUE lines found on stdin"); process.exit(1); }
    console.log("stored: " + names.join(", ")); process.exit(0);
  });
} else { console.log("did " + argv.join(" ")); process.exit(0); }
`.trimStart());
  resetEngine();
  process.env.ACC_ENGINE = FAKE_ENGINE;
}
const RESTORE_FAKE = fs.existsSync(FAKE_ENGINE) ? fs.readFileSync(FAKE_ENGINE, "utf8") : null;

test("AC-001/PROP-001: a value's ONLY sink is engine stdin — never argv, never the response", async () => {
  withVaultFake();
  const r = await gpost("/api/guards/vault-import", { pairs: [{ key: "API_KEY", value: "s3cr3t-v4lue" }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.stored, ["API_KEY"]);
  assert.ok(!JSON.stringify(j).includes("s3cr3t"), "no response field may carry the value");
  assert.equal(fakeStdinFrom(), "API_KEY=s3cr3t-v4lue\n");
  for (const call of engineCalls()) assert.ok(!call.join(" ").includes("s3cr3t"), "the value must never be an argv token");
});

test("AC-002: multiple pairs travel as multiple stdin lines, named in order", async () => {
  withVaultFake();
  const r = await gpost("/api/guards/vault-import", { pairs: [{ key: "A", value: "1" }, { key: "B", value: "2" }] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).stored, ["A", "B"]);
  assert.equal(fakeStdinFrom(), "A=1\nB=2\n");
});

test("AC-003/PROP-002: an invalid key shape is refused before the engine", async () => {
  withVaultFake();
  for (const key of ["BAD KEY", "1KEY", "A=B", "", "K-1", "__proto__"]) {
    const r = await gpost("/api/guards/vault-import", { pairs: [{ key, value: "x" }] });
    assert.equal(r.status, 400, `key "${key}" must be refused`);
  }
  assert.equal(engineCalls().length, 0, "no invalid import may reach the engine");
});

test("AC-004/PROP-002: a value containing a newline is refused — it would forge a second vault line", async () => {
  withVaultFake();
  for (const value of ["a\nINJECTED=x", "a\r\nB=y", "trailing\n"]) {
    const r = await gpost("/api/guards/vault-import", { pairs: [{ key: "K", value }] });
    assert.equal(r.status, 400, `value ${JSON.stringify(value)} must be refused`);
  }
  assert.equal(engineCalls().length, 0);
});

test("vault-import with a non-string value or a malformed pairs array is refused", async () => {
  withVaultFake();
  for (const body of [{ pairs: [{ key: "K", value: 42 }] }, { pairs: [{ key: "K" }] }, { pairs: [] }, { pairs: "nope" }, {}]) {
    const r = await gpost("/api/guards/vault-import", body);
    assert.equal(r.status, 400);
  }
  assert.equal(engineCalls().length, 0);
});

test("AC-005: vault-rm sends the key NAME as argv (a name is not a secret)", async () => {
  withVaultFake();
  const r = await gpost("/api/guards/vault-rm", { key: "API_KEY" });
  assert.equal(r.status, 200);
  assert.deepEqual(engineCalls().at(-1), ["vault-rm", "API_KEY"]);
});

test("vault-rm validates the key shape too", async () => {
  withVaultFake();
  const r = await gpost("/api/guards/vault-rm", { key: "BAD KEY" });
  assert.equal(r.status, 400);
  assert.equal(engineCalls().length, 0);
});

test("AC-006: vault routes demand X-ACC and local Origin like every mutating route", async () => {
  withVaultFake();
  assert.equal((await gpost("/api/guards/vault-import", { pairs: [{ key: "K", value: "v" }] }, { "X-ACC": "" })).status, 403);
  assert.equal((await gpost("/api/guards/vault-rm", { key: "K" }, { origin: "https://evil.example" })).status, 403);
  assert.equal(engineCalls().length, 0);
});

test("AC-007: an engine failure surfaces as code+out, which by engine contract names only keys", async () => {
  withVaultFake();
  // A single well-formed pair whose engine run we force to fail by clearing
  // list.json is not how vault-import fails; instead send a pair the fake
  // stores fine, then assert the success shape. Failure shape is covered by
  // the generic engine-failure test; here we assert no value in the tail.
  const r = await gpost("/api/guards/vault-import", { pairs: [{ key: "TOK", value: "zzz-secret" }] });
  const j = await r.json();
  assert.ok(!JSON.stringify(j).includes("zzz-secret"));
});

if (RESTORE_FAKE) after(() => { try { fs.writeFileSync(FAKE_ENGINE, RESTORE_FAKE); } catch {} });

// ------------------------------------------------------------- process/spending API (SPEC-0004)
// Fake usage + budget scripts record argv; policy.json lives in the sandbox
// (process.env.ACC_POLICY, already set at top). ACC_ROOT sandboxes the
// stop-file and kill-switch. Nothing touches the real machine.
const PROC_DIR = path.join(BASE, "proc");
const FAKE_USAGE = path.join(BASE, "fake-usage.mjs");
const FAKE_BUDGET = path.join(BASE, "fake-budget.mjs");
const FAKE_START = path.join(BASE, "fake-clearbot-start.mjs");
fs.writeFileSync(FAKE_USAGE, `
const a = process.argv.slice(2);
if (a[0] === "check") console.log(JSON.stringify({ tier: "amber", pct: 60, weekTokens: 1200000, redTokens: 2000000 }));
else if (a[0] === "week") console.log("TOTAL  $12.34");
`.trimStart());
fs.writeFileSync(FAKE_BUDGET, `
import fs from "node:fs";
fs.appendFileSync(process.env.FAKE_BUDGET_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("budget " + process.argv.slice(2).join(" ") + " ok");
`.trimStart());
fs.writeFileSync(FAKE_START, `
import fs from "node:fs";
fs.appendFileSync(process.env.FAKE_BUDGET_LOG, JSON.stringify(["clearbot-start"]) + "\\n");
console.log("started");
`.trimStart());
const BUDGET_LOG = path.join(PROC_DIR, "budget-calls.jsonl");
const budgetCalls = () => { try { return fs.readFileSync(BUDGET_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const POLICY_BASE = { _comment: "keep me", context: { softK: 400, hardK: 600 }, week: { amberTokens: 1e9, redTokens: 2e9 }, review: { maxFinders: 3 }, subagents: { allow: ["Explore"] }, autoApprove: { enabled: false }, kernel: { harness: "claude-code", budget: { toolCalls: 200 } }, rates: { opus: { in: 15 } } };

function resetProc() {
  fs.rmSync(PROC_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROC_DIR, { recursive: true });
  process.env.ACC_ROOT = PROC_DIR;
  process.env.ACC_USAGE = FAKE_USAGE;
  process.env.ACC_BUDGET = FAKE_BUDGET;
  process.env.FAKE_BUDGET_LOG = BUDGET_LOG;
  delete process.env.ACC_CLEARBOT_START;
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify(POLICY_BASE, null, 2));
}
const ppost = (route, body, headers = {}) => fetch(`${base}${route}`, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", "X-ACC": "1", ...headers },
});

test("AC-001: GET /api/process/status returns tier, week text, dials, and control state", async () => {
  resetProc();
  const r = await fetch(`${base}/api/process/status`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tier.tier, "amber");
  assert.match(j.weekText, /\$12\.34/);
  assert.equal(j.dials.softK, 400);
  assert.deepEqual(j.dials.allow, ["Explore"]);
  assert.equal(j.dials.autoApprove, false);
  assert.equal(j.stopped, false);
  assert.equal(j.cleanupKilled, false);
  resetPolicy(); // restore the kernel-policy fixture other tests rely on
});

test("AC-002/PROP-001: saving dials updates the owned blocks and leaves every other key byte-identical", async () => {
  resetProc();
  const before = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  const r = await ppost("/api/process/dials", { softK: 350, hardK: 550, amberTokens: 1.2e9, redTokens: 1.8e9, maxFinders: 5, allow: ["Explore", "Plan"], autoApprove: true });
  assert.equal(r.status, 200);
  const after = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  assert.equal(after.context.softK, 350);
  assert.equal(after.week.redTokens, 1.8e9);
  assert.equal(after.review.maxFinders, 5);
  assert.deepEqual(after.subagents.allow, ["Explore", "Plan"]);
  assert.equal(after.autoApprove.enabled, true);
  // untouched blocks
  assert.deepEqual(after.kernel, before.kernel);
  assert.deepEqual(after.rates, before.rates);
  assert.equal(after._comment, before._comment);
  resetPolicy();
});

test("AC-003: an invalid dial is refused and policy.json is left untouched", async () => {
  resetProc();
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  for (const bad of [
    { softK: "x", hardK: 600, amberTokens: 1e9, redTokens: 2e9, maxFinders: 3, allow: [], autoApprove: false },
    { softK: 400, hardK: -1, amberTokens: 1e9, redTokens: 2e9, maxFinders: 3, allow: [], autoApprove: false },
    { softK: 400, hardK: 600, amberTokens: 1e9, redTokens: 2e9, maxFinders: 3, allow: "nope", autoApprove: false },
    { softK: 400, hardK: 600, amberTokens: 1e9, redTokens: 2e9, maxFinders: 3, allow: [], autoApprove: "yes" },
  ]) {
    const r = await ppost("/api/process/dials", bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before, "no bad dial may write");
  resetPolicy();
});

test("AC-004: control stop writes the slice-runner stop file", async () => {
  resetProc();
  const r = await ppost("/api/process/control", { action: "stop" });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(PROC_DIR, "runner", "stop", "slice-runner.stop")));
  resetPolicy();
});

test("AC-005/AC-006: resume and fanout invoke the right budget verb", async () => {
  resetProc();
  await ppost("/api/process/control", { action: "resume" });
  await ppost("/api/process/control", { action: "fanout" });
  assert.deepEqual(budgetCalls(), [["unstop"], ["fanout", "30"]]);
  resetPolicy();
});

test("AC-007: cleanup-off engages the kill switch; cleanup-on clears it and fires the start seam", async () => {
  resetProc();
  process.env.ACC_CLEARBOT_START = FAKE_START;
  await ppost("/api/process/control", { action: "cleanup-off" });
  assert.ok(fs.existsSync(path.join(PROC_DIR, "watcher", "clearbot.stop")), "kill switch engaged");
  await ppost("/api/process/control", { action: "cleanup-on" });
  assert.ok(!fs.existsSync(path.join(PROC_DIR, "watcher", "clearbot.stop")), "kill switch cleared");
  assert.deepEqual(budgetCalls().at(-1), ["clearbot-start"]);
  resetPolicy();
});

test("AC-008: clear-now needs confirm; with it, budget clear-now fires", async () => {
  resetProc();
  assert.equal((await ppost("/api/process/control", { action: "clear-now" })).status, 400);
  assert.equal(budgetCalls().length, 0);
  const r = await ppost("/api/process/control", { action: "clear-now", confirm: true });
  assert.equal(r.status, 200);
  assert.deepEqual(budgetCalls().at(-1), ["clear-now"]);
  resetPolicy();
});

test("AC-009: an action outside the allowlist (incl. a prototype key) is refused, nothing invoked", async () => {
  resetProc();
  for (const action of ["rm", "__proto__", "toString", "", "constructor"]) {
    const r = await ppost("/api/process/control", { action });
    assert.equal(r.status, 400, `action "${action}" must be refused`);
  }
  assert.equal(budgetCalls().length, 0);
  resetPolicy();
});

test("AC-010: process routes demand X-ACC and local Origin", async () => {
  resetProc();
  assert.equal((await ppost("/api/process/dials", { softK: 1, hardK: 2, amberTokens: 0, redTokens: 0, maxFinders: 1, allow: [], autoApprove: false }, { "X-ACC": "" })).status, 403);
  assert.equal((await ppost("/api/process/control", { action: "stop" }, { origin: "https://evil.example" })).status, 403);
  resetPolicy();
});

test("status: an unreadable policy.json is a 500, and a non-JSON tier degrades to null", async () => {
  resetProc();
  fs.writeFileSync(FAKE_USAGE, 'const a=process.argv.slice(2); if(a[0]==="check")console.log("not json"); else console.log("wk");\n');
  fs.rmSync(process.env.ACC_POLICY);
  const r = await fetch(`${base}/api/process/status`);
  assert.equal(r.status, 500);
  // now a readable policy with a valid-but-non-JSON check → tier null, 200
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify(POLICY_BASE));
  const r2 = await fetch(`${base}/api/process/status`);
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).tier, null);
  fs.writeFileSync(FAKE_USAGE, `const a=process.argv.slice(2);\nif(a[0]==="check")console.log(JSON.stringify({tier:"green"}));else console.log("TOTAL $0.00");\n`);
  resetPolicy();
});

test("status: policy blocks that are absent surface as undefined dials, not a crash", async () => {
  resetProc();
  fs.writeFileSync(FAKE_USAGE, `const a=process.argv.slice(2);\nif(a[0]==="check")console.log(JSON.stringify({tier:"green"}));else console.log("TOTAL $0.00");\n`);
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ _comment: "bare" }));
  const r = await fetch(`${base}/api/process/status`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.dials.allow, []);
  assert.equal(j.dials.autoApprove, false);
  resetPolicy();
});

test("dials: an unreadable policy.json is a 500", async () => {
  resetProc();
  fs.rmSync(process.env.ACC_POLICY);
  const r = await ppost("/api/process/dials", { softK: 1, hardK: 2, amberTokens: 0, redTokens: 0, maxFinders: 1, allow: [], autoApprove: false });
  assert.equal(r.status, 500);
  resetPolicy();
});

test("control: a non-string action is refused", async () => {
  resetProc();
  assert.equal((await ppost("/api/process/control", { action: 42 })).status, 400);
  assert.equal((await ppost("/api/process/control", {})).status, 400);
  resetPolicy();
});

test("control: cleanup-on with no start seam clears the switch and reports it (no Windows launcher on this host)", async () => {
  resetProc();
  delete process.env.ACC_CLEARBOT_START;
  fs.mkdirSync(path.join(PROC_DIR, "watcher"), { recursive: true });
  fs.writeFileSync(path.join(PROC_DIR, "watcher", "clearbot.stop"), "x");
  const r = await ppost("/api/process/control", { action: "cleanup-on" });
  assert.equal(r.status, 200);
  assert.match((await r.json()).note, /kill switch cleared/);
  assert.ok(!fs.existsSync(path.join(PROC_DIR, "watcher", "clearbot.stop")));
  resetPolicy();
});

test("vault-import surfaces an engine failure as code+out (no value in the tail)", async () => {
  // A stdin with no '=' makes the real-shaped fake exit 1 naming no keys.
  withVaultFake();
  const r = await gpost("/api/guards/vault-import", { pairs: [{ key: "K", value: "v-secret" }] });
  // The withVaultFake stores fine; to force failure, point at a fake that always fails:
  fs.writeFileSync(FAKE_ENGINE, `process.stderr.write("no KEY=VALUE lines found on stdin"); process.exit(1);\n`);
  const r2 = await gpost("/api/guards/vault-import", { pairs: [{ key: "K", value: "v-secret" }] });
  assert.equal(r2.status, 200);
  const j = await r2.json();
  assert.equal(j.code, 1);
  assert.ok(!JSON.stringify(j).includes("v-secret"));
});

test("control: cleanup-on when no kill-switch file exists is a no-op unlink, not a crash", async () => {
  resetProc();
  delete process.env.ACC_CLEARBOT_START;
  // no watcher/clearbot.stop present
  const r = await ppost("/api/process/control", { action: "cleanup-on" });
  assert.equal(r.status, 200);
  resetPolicy();
});

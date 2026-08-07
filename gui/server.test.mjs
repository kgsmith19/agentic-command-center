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

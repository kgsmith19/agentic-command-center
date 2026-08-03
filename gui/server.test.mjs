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

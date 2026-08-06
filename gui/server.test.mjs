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
const resetEngine = () => {
  fs.mkdirSync(process.env.ACC_ROOT, { recursive: true });
  fs.writeFileSync(path.join(process.env.ACC_ROOT, "config.json"), JSON.stringify({ enabled: true, secrets: [], protected: [], projects: [] }));
  fs.rmSync(path.join(process.env.ACC_ROOT, "vault.json"), { force: true });
  fs.rmSync(path.join(process.env.ACC_ROOT, "runbox"), { recursive: true, force: true });
};

const { startServer, handler, cli } = await import("./server.mjs");
let srv, base;
before(async () => { const s = await startServer({ port: 0 }); srv = s.server; base = `http://127.0.0.1:${s.port}`; });
beforeEach(() => { resetPolicy(); resetEngine(); });
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

// Found while building the Spending tab: a page GET whose file is missing or
// unreadable threw uncaught before this catch existed -- the client's
// fetch() hung forever rather than getting a fast, clean error, since
// nothing ever called res.end(). This is the only regression test that can
// exercise it without a real missing file on disk permanently.
test("handler(): a PAGES route whose file is unreadable is a clean 500, not a hang", () => {
  const real = path.join(path.dirname(fileURLToPath(import.meta.url)), "engine.html");
  const away = real + ".moved-for-test";
  fs.renameSync(real, away);
  try {
    const res = { writeHead(code, headers) { res.code = code; res.headers = headers; }, end(body) { res.body = body; } };
    handler({ headers: { host: "127.0.0.1" }, url: "/engine.html", method: "GET" }, res);
    assert.equal(res.code, 500);
    assert.match(JSON.parse(res.body).error, /ENOENT/);
  } finally {
    fs.renameSync(away, real);
  }
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

// ================================================================
// gui/engine.html routes (Protected paths, Vault, Runbox) — design spec
// docs/superpowers/specs/2026-08-06-acc-gui-remaining-tabs-design.md §4.
// Same CSRF/loopback/error-shape discipline as /api/kernel-policy above;
// business logic lives in gui/engineClient.mjs (already unit-tested on its
// own), so these tests focus on the HTTP contract, not re-proving
// engine.mjs's behavior.
// ================================================================

const postEngine = (route, body, headers = {}) => fetch(`${base}${route}`, {
  method: "POST", body: JSON.stringify(body ?? {}),
  headers: { "content-type": "application/json", "X-ACC": "1", ...headers },
});

test("GET /engine.html serves the page", async () => {
  const r = await fetch(`${base}/engine.html`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /id="secretList"/);
});

test("GET /api/engine/status returns the live block", async () => {
  const r = await fetch(`${base}/api/engine/status`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { enabled: true, secrets: [], protected: [], projects: [], vaultKeys: [], pending: 0, trashed: 0 });
});

test("secret/protected/project add-then-remove round-trip through the real files", async () => {
  assert.equal((await postEngine("/api/engine/secret", { op: "add", pattern: "*.pfx" })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/engine/status`)).json()).secrets, ["*.pfx"]);
  assert.equal((await postEngine("/api/engine/secret", { op: "rm", pattern: "*.pfx" })).status, 200);

  const p = path.join(process.env.ACC_ROOT, "important.yaml");
  assert.equal((await postEngine("/api/engine/protected", { op: "add", path: p })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/engine/status`)).json()).protected, [p]);

  const proj = path.join(process.env.ACC_ROOT, "myproj");
  fs.mkdirSync(proj, { recursive: true });
  assert.equal((await postEngine("/api/engine/project", { op: "add", path: proj })).status, 200);
  // engine.mjs's projects-add normalizes stored paths to forward slashes
  // (see norm() in hooks/engine.mjs) — unlike protected-add above, which
  // stores the raw path verbatim. Expect the normalized form here.
  assert.deepEqual((await (await fetch(`${base}/api/engine/status`)).json()).projects, [proj.replaceAll("\\", "/")]);
});

test("an invalid engine mutation is a 400 with engine.mjs's own message, and CSRF applies the same as kernel-policy", async () => {
  const bad = await postEngine("/api/engine/project", { op: "add", path: path.join(process.env.ACC_ROOT, "nope") });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not a folder/);

  const noHeader = await postEngine("/api/engine/secret", { op: "add", pattern: "*.pfx" }, { "X-ACC": "" });
  assert.equal(noHeader.status, 403);
  assert.deepEqual((await (await fetch(`${base}/api/engine/status`)).json()).secrets, []);
});

test("vault-import (raw body, not JSON) stores keys without ever returning values; vault-rm removes one", async () => {
  const r = await fetch(`${base}/api/engine/vault-import`, {
    method: "POST", headers: { "X-ACC": "1" }, body: "A=secretvalue\nB=2\n",
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.imported.sort(), ["A", "B"]);
  assert.equal(JSON.stringify(j).includes("secretvalue"), false);

  const status = await (await fetch(`${base}/api/engine/status`)).json();
  assert.deepEqual(status.vaultKeys.sort(), ["A", "B"]);

  assert.equal((await postEngine("/api/engine/vault-rm", { key: "A" })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/engine/status`)).json()).vaultKeys, ["B"]);
});

test("vault-import without X-ACC is refused, same CSRF rule as the JSON routes", async () => {
  const r = await fetch(`${base}/api/engine/vault-import`, { method: "POST", body: "A=1\n" });
  assert.equal(r.status, 403);
});

// Lean-review finding (2026-08-06): readBody accumulated raw Buffer chunks
// via `body += c`, which coerces each chunk to a string (UTF-8 decode)
// INDEPENDENTLY. A multi-byte character split across a chunk boundary --
// entirely possible on a real socket, not a contrived edge case -- decodes
// each half as an invalid/incomplete sequence (U+FFFD replacement chars)
// instead of the one real character, corrupting the body before any
// business logic (including vault-import, where the payload IS the secret
// value) ever sees it. Two raw writes with a real gap between them force
// separate TCP segments / "data" events on the server, splitting "é"
// (0xC3 0xA9 in UTF-8) across the boundary.
test("vault-import: a multi-byte UTF-8 character split across a TCP chunk boundary is not corrupted", async () => {
  const port = Number(new URL(base).port);
  const chunk1 = Buffer.concat([Buffer.from("K=caf", "utf8"), Buffer.from([0xc3])]);
  const chunk2 = Buffer.concat([Buffer.from([0xa9]), Buffer.from("\n", "utf8")]);
  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/engine/vault-import", method: "POST", headers: { "X-ACC": "1" } },
      (res) => { res.resume(); res.on("end", resolve); }
    );
    req.on("error", reject);
    req.write(chunk1, () => {
      setTimeout(() => req.end(chunk2), 50); // real gap -> separate segments, not one coalesced write
    });
  });
  const vault = JSON.parse(fs.readFileSync(path.join(process.env.ACC_ROOT, "vault.json"), "utf8"));
  assert.equal(vault.K, "café", "the stored value must be the real character, not replacement-char mojibake");
});

test("runbox list/preview/run/trash/restore/flush all work over HTTP end to end", async () => {
  const runbox = path.join(process.env.ACC_ROOT, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "a.mjs"), "// hello there\nprocess.exit(0);\n");

  const list = await (await fetch(`${base}/api/engine/runbox?trash=0`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "a.mjs");

  const preview = await (await fetch(`${base}/api/engine/runbox/preview?ref=${encodeURIComponent("central:a.mjs")}`)).json();
  assert.match(preview.content, /hello there/);

  fs.writeFileSync(path.join(runbox, "b.mjs"), "process.exit(0);\n");
  const trashed = await postEngine("/api/engine/runbox/trash", { ref: "central:b.mjs" });
  assert.equal(trashed.status, 200);
  assert.equal((await (await fetch(`${base}/api/engine/runbox?trash=1`)).json()).length, 1);

  const restored = await postEngine("/api/engine/runbox/restore", { ref: "central:b.mjs" });
  assert.equal(restored.status, 200);
  assert.equal((await (await fetch(`${base}/api/engine/runbox?trash=1`)).json()).length, 0);

  const ran = await postEngine("/api/engine/runbox/run", { ref: "central:a.mjs" });
  assert.equal(ran.status, 200);
  const ranBody = await ran.json();
  assert.equal(ranBody.ok, true);
  assert.match(ranBody.out, /archived/);

  await postEngine("/api/engine/runbox/trash", { ref: "central:b.mjs" });
  const flushRefused = await postEngine("/api/engine/runbox/flush", {});
  assert.equal(flushRefused.status, 400, "flush without confirm:true is refused");
  const flushed = await postEngine("/api/engine/runbox/flush", { confirm: true });
  assert.equal(flushed.status, 200);
  assert.equal((await (await fetch(`${base}/api/engine/runbox?trash=1`)).json()).length, 0);
});

test("runbox/preview refuses a ref not in the current listing (400, not a filesystem error leak)", async () => {
  const r = await fetch(`${base}/api/engine/runbox/preview?ref=${encodeURIComponent("../../../etc/passwd")}`);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not found/);
});

// ================================================================
// gui/spending.html routes (design spec §5) — same CSRF/loopback/error-shape
// discipline as the routes above; business logic lives in hooks/status.mjs
// (already unit-tested on its own), so these focus on the HTTP contract.
// ================================================================

const postStatus = (route, body, headers = {}) => fetch(`${base}${route}`, {
  method: "POST", body: JSON.stringify(body ?? {}),
  headers: { "content-type": "application/json", "X-ACC": "1", ...headers },
});

test("GET /spending.html serves the page", async () => {
  const r = await fetch(`${base}/spending.html`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /id="weekTier"/);
});

test("GET /api/status/spending returns the live week summary", async () => {
  const r = await fetch(`${base}/api/status/spending`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tier, "green");
  assert.equal(typeof j.costUsd, "number");
});

test("GET /api/status/summary returns the tiny global-status block every page's shared header polls", async () => {
  const r = await fetch(`${base}/api/status/summary`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tier, "green");
  assert.equal(j.text, "week usage: green");
});

test("GET/POST /api/status/policy round-trips the ops dials, CSRF applies the same as kernel-policy", async () => {
  const before = await (await fetch(`${base}/api/status/policy`)).json();
  assert.equal(before.context.softK, 400);

  const noHeader = await postStatus("/api/status/policy", { ...before, context: { softK: 100, hardK: 200 } }, { "X-ACC": "" });
  assert.equal(noHeader.status, 403);
  assert.equal((await (await fetch(`${base}/api/status/policy`)).json()).context.softK, 400);

  const good = await postStatus("/api/status/policy", { ...before, context: { softK: 100, hardK: 200 } });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).policy.context.softK, 100);
  assert.equal((await (await fetch(`${base}/api/status/policy`)).json()).context.softK, 100);
});

test("POST /api/status/policy with an invalid block is a 400 with status.mjs's own message, dials untouched", async () => {
  const before = await (await fetch(`${base}/api/status/policy`)).json();
  const bad = await postStatus("/api/status/policy", { ...before, context: { softK: 600, hardK: 400 } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /hardK must be greater than/);
  assert.equal((await (await fetch(`${base}/api/status/policy`)).json()).context.softK, before.context.softK);
});

test("GET /api/status/clearbot never 500s, and reports a real count where powershell exists (Windows), null where it doesn't", async () => {
  const r = await fetch(`${base}/api/status/clearbot`);
  assert.equal(r.status, 200);
  const j = await r.json();
  // Windows CI genuinely has powershell, so the real Get-CimInstance query
  // runs and returns a real count (0 in this fixture, correctly -- no
  // clearbot.ps1 process is actually running) rather than the "unknown"
  // null this sandbox reports. Both are the honest answer for their host;
  // asserting a hardcoded null broke on the one platform where the query
  // actually succeeds.
  assert.ok(j.running === null || typeof j.running === "number");
  assert.deepEqual(j.pending, []);
});

test("POST /api/status/stop then /unstop round-trip the real stop-file on disk", async () => {
  assert.equal((await postStatus("/api/status/stop", {})).status, 200);
  assert.ok(fs.existsSync(path.join(process.env.ACC_ROOT, "runner", "stop", "slice-runner.stop")));
  assert.equal((await postStatus("/api/status/unstop", {})).status, 200);
  assert.equal(fs.existsSync(path.join(process.env.ACC_ROOT, "runner", "stop", "slice-runner.stop")), false);
});

test("POST /api/status/fanout grants a real time-boxed window; a non-positive value is a 400 with no header set to disk", async () => {
  const r = await postStatus("/api/status/fanout", { mins: 20 });
  assert.equal(r.status, 200);
  const grant = JSON.parse(fs.readFileSync(path.join(process.env.ACC_ROOT, "runner", "state", "fanout.json"), "utf8"));
  assert.ok(grant.until > Date.now());

  const bad = await postStatus("/api/status/fanout", { mins: 0 });
  assert.equal(bad.status, 400);
});

test("POST /api/status/clearbot rejects an unknown op with status.mjs's own message", async () => {
  const r = await postStatus("/api/status/clearbot", { op: "explode" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /unknown clearbot op/);
});

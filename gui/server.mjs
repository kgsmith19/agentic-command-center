#!/usr/bin/env node
// gui/server.mjs — rails of the web GUI (spec 2026-08-03-acc-oi-closure-design
// §5-§6): the kernel-settings tab is the first migrated tab; later tabs mount
// alongside. Loopback-only, ZERO business logic — reads and writes go through
// kernel/policy.mjs, the same single owner the WinForms tab used.
//
// Ethos answer (OI-022's recorded tension): binds 127.0.0.1 only. A same-user
// local process could already edit policy.json directly, so no new privilege
// exists here. The genuinely new risk is web-borne CSRF against a localhost
// mutator; it is closed by construction — mutating routes demand the custom
// X-ACC header (unsettable cross-origin without a CORS grant this server
// never issues), Origin/Host must be local, and no CORS header ever leaves.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKernelPolicy, saveKernelPolicy } from "../kernel/policy.mjs";
import * as engine from "./engineClient.mjs";
import * as status from "../hooks/status.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Exact-match route map — request input never touches a filesystem path, so
// there is no traversal surface to defend.
const PAGES = { "/": "kernel.html", "/kernel.html": "kernel.html", "/engine.html": "engine.html", "/spending.html": "spending.html" };
const BODY_CAP = 64 * 1024;

const localHost = (h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(h || ""));
const localOrigin = (o) => o === undefined || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(o));

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

// Lean review (2026-08-06): `body += c` coerced each raw Buffer chunk to a
// string independently -- a multi-byte UTF-8 character split across a chunk
// boundary decodes each half as an invalid sequence (replacement chars)
// instead of the one real character, silently corrupting data before it
// reaches any business logic (vault-import's payload IS a secret value).
// The same bug also made the cap a soft "after the fact" check: a single
// oversized chunk fully materialized (as a string) before its length was
// ever compared to BODY_CAP. Buffering as Buffer objects and decoding once,
// after the byte-length cap check, fixes both: the cap is checked on raw
// byte length before any decode, and decode happens exactly once against
// the complete, correctly-ordered byte stream.
function readBody(req, done) {
  const chunks = [];
  let total = 0;
  req.on("data", (c) => {
    total += c.length;
    if (total > BODY_CAP) return req.destroy(); // over-cap is dropped, never buffered further or decoded
    chunks.push(c);
  });
  req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
}

// Shared shape for every mutating route: X-ACC required, body is JSON, `fn`
// returns the success response body (defaulting to {ok:true}) or throws --
// a thrown error becomes a 400 with the thrower's own message, matching
// how every business-logic module here (kernel/policy.mjs, engineClient.mjs)
// already raises a client-shaped rejection, never an unhandled crash.
function postJson(req, res, fn) {
  if (req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
  readBody(req, (raw) => {
    let body;
    try { body = JSON.parse(raw); }
    catch { return send(res, 400, { error: "body is not JSON" }); }
    try { return send(res, 200, fn(body) ?? { ok: true }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  });
}

// vault-import's body is the KEY=VALUE payload itself, not JSON (matches
// engine.mjs's own stdin contract) -- same X-ACC/error-shape discipline,
// no JSON.parse step.
function postRaw(req, res, fn) {
  if (req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
  readBody(req, (raw) => {
    try { return send(res, 200, fn(raw)); }
    catch (e) { return send(res, 400, { error: e.message }); }
  });
}

const ENGINE_MUTATIONS = {
  "/api/engine/secret": (b) => engine.secretOp(b.op, b.pattern),
  "/api/engine/protected": (b) => engine.protectedOp(b.op, b.path),
  "/api/engine/project": (b) => engine.projectOp(b.op, b.path),
  "/api/engine/vault-rm": (b) => engine.vaultRm(b.key),
  "/api/engine/runbox/run": (b) => engine.runboxRun(b.ref),
  "/api/engine/runbox/trash": (b) => engine.runboxTrash(b.ref),
  "/api/engine/runbox/restore": (b) => engine.runboxRestore(b.ref),
  "/api/engine/runbox/flush": (b) => {
    if (b.confirm !== true) throw new Error("flush is permanent — confirm required");
    engine.runboxFlush();
  },
};

const STATUS_MUTATIONS = {
  "/api/status/stop": () => status.stopRunnerNow(),
  "/api/status/unstop": () => status.unstopRunner(),
  "/api/status/fanout": (b) => status.fanout(b.mins),
  "/api/status/clearbot": (b) => status.clearbotOp(b.op),
};

export function handler(req, res) {
  if (!localHost(req.headers.host)) return send(res, 403, { error: "non-local Host" });
  if (!localOrigin(req.headers.origin)) return send(res, 403, { error: "non-local Origin" });
  const route = req.url.split("?")[0];
  if (req.method === "GET" && PAGES[route]) {
    // Found by this file's own test suite (2026-08-06, Spending tab):
    // fs.readFileSync throwing here (a page listed in PAGES but missing or
    // unreadable on disk) had no catch, unlike every other route below --
    // the exception escaped the request listener uncaught, and the client's
    // fetch() simply hung waiting for a response that was never going to
    // arrive, rather than a clean, fast error.
    try { return send(res, 200, fs.readFileSync(path.join(HERE, PAGES[route])), "text/html; charset=utf-8"); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (route === "/api/kernel-policy") {
    if (req.method === "GET") {
      try { return send(res, 200, { kernel: loadKernelPolicy() }); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (req.method === "POST") return postJson(req, res, (block) => ({ ok: true, kernel: saveKernelPolicy(block) }));
  }
  if (route === "/api/engine/status" && req.method === "GET") {
    try { return send(res, 200, engine.status()); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (route === "/api/engine/runbox" && req.method === "GET") {
    const query = new URLSearchParams(req.url.split("?")[1] || "");
    try { return send(res, 200, engine.runboxList(query.get("trash") === "1")); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (route === "/api/engine/runbox/preview" && req.method === "GET") {
    const query = new URLSearchParams(req.url.split("?")[1] || "");
    try { return send(res, 200, { content: engine.runboxPreview(query.get("ref") || "") }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (route === "/api/engine/vault-import" && req.method === "POST") return postRaw(req, res, (text) => engine.vaultImport(text));
  if (ENGINE_MUTATIONS[route] && req.method === "POST") return postJson(req, res, ENGINE_MUTATIONS[route]);
  if (route === "/api/status/spending" && req.method === "GET") {
    try { return send(res, 200, status.spendingSummary()); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (route === "/api/status/summary" && req.method === "GET") {
    try { return send(res, 200, status.globalStatusSummary()); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (route === "/api/status/policy") {
    if (req.method === "GET") {
      try { return send(res, 200, status.loadOpsPolicy()); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (req.method === "POST") return postJson(req, res, (block) => ({ ok: true, policy: status.saveOpsPolicy(block) }));
  }
  if (route === "/api/status/clearbot" && req.method === "GET") {
    try { return send(res, 200, status.clearbotStatus()); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (STATUS_MUTATIONS[route] && req.method === "POST") return postJson(req, res, STATUS_MUTATIONS[route]);
  send(res, 404, { error: "not found" });
}

export function startServer({ port = 0 } = {}) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// One-line trigger (kept testable in-process, same shape as hooks/covgate.mjs's
// own bottom line): a real CLI invocation spawns a long-running listener that
// only exits by being force-killed, which on Windows never flushes V8
// coverage — so cli() is exported and unit-tested directly instead.
export async function cli(argv = process.argv) {
  const i = argv.indexOf("--port");
  const s = await startServer({ port: i === -1 ? 0 : Number(argv[i + 1]) });
  console.log(`LISTENING ${s.port}`); // consumers (guards-gui.ps1, Playwright) parse this line
  return s;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();

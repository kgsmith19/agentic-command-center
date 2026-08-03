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

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Exact-match route map — request input never touches a filesystem path, so
// there is no traversal surface to defend.
const PAGES = { "/": "kernel.html", "/kernel.html": "kernel.html" };
const BODY_CAP = 64 * 1024;

const localHost = (h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(h || ""));
const localOrigin = (o) => o === undefined || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(o));

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

export function handler(req, res) {
  if (!localHost(req.headers.host)) return send(res, 403, { error: "non-local Host" });
  if (!localOrigin(req.headers.origin)) return send(res, 403, { error: "non-local Origin" });
  const route = req.url.split("?")[0];
  if (req.method === "GET" && PAGES[route]) {
    return send(res, 200, fs.readFileSync(path.join(HERE, PAGES[route])), "text/html; charset=utf-8");
  }
  if (route === "/api/kernel-policy") {
    if (req.method === "GET") {
      try { return send(res, 200, { kernel: loadKernelPolicy() }); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (req.method === "POST") {
      if (req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > BODY_CAP) req.destroy(); // over-cap is dropped, never parsed
      });
      req.on("end", () => {
        let block;
        try { block = JSON.parse(body); }
        catch { return send(res, 400, { error: "body is not JSON" }); }
        try { return send(res, 200, { ok: true, kernel: saveKernelPolicy(block) }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      });
      return;
    }
  }
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

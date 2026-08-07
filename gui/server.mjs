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
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKernelPolicy, saveKernelPolicy } from "../kernel/policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Exact-match route map — request input never touches a filesystem path, so
// there is no traversal surface to defend.
const PAGES = { "/": "kernel.html", "/kernel.html": "kernel.html", "/guards": "guards.html" };
const BODY_CAP = 64 * 1024;

// --- guards API (SPEC-0002): thin shell over hooks/engine.mjs -------------
// The engine stays the single owner of every state change, exactly as it is
// for guards-gui.ps1 — this server adds transport, never logic. ACC_ENGINE
// is resolved per request so tests can drive a fake engine (and one
// read-only case the real one) without a restart.
const enginePath = () => process.env.ACC_ENGINE || path.join(HERE, "..", "hooks", "engine.mjs");
// SPEC-0004 process controls shell the same node scripts the WinForms GUI did;
// each path is env-overridable so a test can point at a fake that records its
// argv/stdin. ACC_ROOT sandboxes the control files (stop-file, kill switch),
// the same discipline budget.mjs/runner already honour.
const budgetPath = () => process.env.ACC_BUDGET || path.join(HERE, "..", "hooks", "budget.mjs");
const usagePath = () => process.env.ACC_USAGE || path.join(HERE, "..", "hooks", "usage.mjs");
const repoRoot = () => (process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.join(HERE, ".."));
const policyFile = () => process.env.ACC_POLICY || path.join(HERE, "..", "policy.json");
const sliceStopFile = () => path.join(repoRoot(), "runner", "stop", "slice-runner.stop");
const clearbotStopFile = () => path.join(repoRoot(), "watcher", "clearbot.stop");

// Run a node script; `stdin`, when given, is written and closed. This is the
// ONLY channel a secret value ever travels (SPEC-0003): never argv, so it
// cannot land in a process listing or a log; the value is not returned here
// either — callers surface `code`/`stdout` only.
function nodeExec(script, args, stdin) {
  return new Promise((resolveExec) => {
    const child = execFile(process.execPath, [script, ...args], { timeout: 120000 }, (err, stdout, stderr) => {
      resolveExec({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
    if (stdin !== undefined) { child.stdin.end(stdin); }
  });
}
const engineExec = (args, stdin) => nodeExec(enginePath(), args, stdin);

// A vault key must be an env-var-shaped name and a value must be single-line:
// the engine frames the vault as `KEY=VALUE\n` lines on stdin, so a `\n` in a
// value or an `=`/newline in a key would forge an extra entry. Enforced here
// as a security boundary (PROP-002), not politeness.
// The anti-forgery guarantee rests on engine.mjs framing the vault as
// `KEY=VALUE` lines split ONLY on /\r?\n/: rejecting \r and \n in a value is
// therefore sufficient (a U+2028/U+2029 in a value passes through as literal
// value text, not a new line). If the engine's split ever widens, widen
// validVaultValue's rejected set in lockstep.
const VAULT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// `__proto__`/`constructor`/`prototype` are env-var-shaped but would pollute
// the prototype of engine.mjs's plain-object vault via `v[key] = value` —
// rejected here even though the engine's string-value assignment happens to
// be inert today, so no future consumer can be surprised.
const VAULT_KEY_RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const validVaultKey = (k) => typeof k === "string" && VAULT_KEY_RE.test(k) && !VAULT_KEY_RESERVED.has(k);
const validVaultValue = (v) => typeof v === "string" && !/[\r\n]/.test(v) && v.length <= 8192;

// PROP-001: engine argv is built ONLY from this map plus one validated arg.
// No browser string is ever a path, a flag, or shell input (execFile, no
// shell). Verbs that consume secret values (apply, vault-import) are
// deliberately absent — SPEC-0003 owns that surface with its own review.
const oneRef = (b) =>
  typeof b.arg === "string" && b.arg.length > 0 && b.arg.length <= 512 && !b.arg.includes("\0")
    ? [b.arg] : null;
const ENGINE_VERBS = {
  toggle: (b) => (b.arg === "on" || b.arg === "off" ? [b.arg] : null),
  "secret-add": oneRef, "secret-rm": oneRef,
  "protected-add": oneRef, "protected-rm": oneRef,
  "projects-add": oneRef, "projects-rm": oneRef,
  run: oneRef, trash: oneRef, restore: oneRef,
  // Permanent deletion keeps its human gate: the browser must send an
  // explicit confirm, and only the server ever writes the --really flag.
  flush: (b) => (b.confirm === true ? ["--really"] : null),
};

async function engineJson(args) {
  const r = await engineExec(args);
  if (r.code !== 0) throw new Error(r.stderr || `engine exited ${r.code}`);
  return JSON.parse(r.stdout);
}

// --- spending/process controls (SPEC-0004) --------------------------------
const nonNegInt = (n) => Number.isInteger(n) && n >= 0;
const nonNegNum = (n) => Number.isFinite(n) && n >= 0;

// PROP-001: merge validated dials into the policy object while leaving every
// key the dials form does not own byte-identical. Returns the new policy
// object, or throws naming the first bad field — the caller writes only on a
// clean return, so a bad dial never partially corrupts policy.json.
export function mergeDials(policy, d) {
  const req = (name, v, ok) => { if (!ok(v)) throw new Error(`invalid ${name}`); return v; };
  if (!Array.isArray(d.allow) || d.allow.some((s) => typeof s !== "string")) throw new Error("invalid allow (must be a string array)");
  if (typeof d.autoApprove !== "boolean") throw new Error("invalid autoApprove (must be boolean)");
  return {
    ...policy,
    context: { ...(policy.context || {}), softK: req("softK", d.softK, nonNegInt), hardK: req("hardK", d.hardK, nonNegInt) },
    week: { ...(policy.week || {}), amberTokens: req("amberTokens", d.amberTokens, nonNegNum), redTokens: req("redTokens", d.redTokens, nonNegNum) },
    review: { ...(policy.review || {}), maxFinders: req("maxFinders", d.maxFinders, nonNegInt) },
    subagents: { ...(policy.subagents || {}), allow: d.allow.map((s) => s.trim()).filter(Boolean) },
    autoApprove: { ...(policy.autoApprove || {}), enabled: d.autoApprove },
  };
}

// Allowlisted control actions. Each returns a thunk performing exactly one
// side effect — the browser's `action` string only selects a thunk, it never
// becomes argv, a path, or a flag (PROP-002). `confirm`-gated actions type
// into a real console, so they demand an explicit browser confirm.
function controlAction(action, body) {
  const startCmd = process.env.ACC_CLEARBOT_START; // fake seam for the Windows launcher
  const writeFile = (f, txt) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
  const table = {
    stop: () => { writeFile(sliceStopFile(), "stopped from the Command Center\n"); return { ok: true }; },
    resume: () => nodeExec(budgetPath(), ["unstop"]),
    fanout: () => nodeExec(budgetPath(), ["fanout", "30"]),
    "clear-now": () => (body.confirm === true ? nodeExec(budgetPath(), ["clear-now"]) : null),
    // The kill-switch file is the cross-platform gate clearbot.ps1 actually
    // checks; the Windows watcher launch is a best-effort extra behind the
    // injectable seam.
    "cleanup-off": () => { writeFile(clearbotStopFile(), `stopped ${""}\n`); return { ok: true }; },
    "cleanup-on": () => {
      try { fs.unlinkSync(clearbotStopFile()); } catch {}
      return startCmd ? nodeExec(startCmd, []) : { ok: true, note: "kill switch cleared" };
    },
  };
  return Object.hasOwn(table, action) ? table[action] : null;
}

function readBody(req, res, cb) {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > BODY_CAP) req.destroy(); // over-cap is dropped, never parsed
  });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return send(res, 400, { error: "body is not JSON" }); }
    cb(parsed);
  });
}

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
      return readBody(req, res, (block) => {
        try { return send(res, 200, { ok: true, kernel: saveKernelPolicy(block) }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      });
    }
  }
  if (route === "/api/guards/status" && req.method === "GET") {
    return engineJson(["status"])
      .then((j) => send(res, 200, j))
      .catch((e) => send(res, 500, { error: e.message }));
  }
  if (route === "/api/guards/list" && req.method === "GET") {
    return Promise.all([engineJson(["list", "--json"]), engineJson(["trash-list", "--json"])])
      .then(([pending, trashed]) => send(res, 200, { pending, trashed }))
      .catch((e) => send(res, 500, { error: e.message }));
  }
  if (route === "/api/guards/engine" && req.method === "POST") {
    if (req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
    return readBody(req, res, async (b) => {
      // Object.hasOwn, not bare property access: a prototype-key verb
      // ("__proto__", "toString") would otherwise resolve to an Object
      // prototype member — non-callable ones threw here and HUNG the
      // request (found by this route's own suite, 2026-08-07).
      const build = typeof b.verb === "string" && Object.hasOwn(ENGINE_VERBS, b.verb) ? ENGINE_VERBS[b.verb] : null;
      const args = build && build(b);
      if (!args) return send(res, 400, { error: `verb "${b.verb}" is not allowed here or its arg is invalid` });
      const r = await engineExec([b.verb, ...args]);
      // A non-zero engine exit is a RESULT, not a transport error: 200 with
      // the code and output tail, so the page can show exactly what failed.
      send(res, 200, { code: r.code, out: (r.stdout + r.stderr).slice(-4000) });
    });
  }
  if (route === "/api/guards/vault-import" && req.method === "POST") {
    if (req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
    return readBody(req, res, async (b) => {
      const pairs = Array.isArray(b.pairs) ? b.pairs : null;
      if (!pairs || !pairs.length) return send(res, 400, { error: "pairs must be a non-empty array" });
      // Validate EVERY pair before invoking the engine: one bad entry rejects
      // the whole import, so a partial write can never happen.
      for (const p of pairs) {
        if (!p || !validVaultKey(p.key)) return send(res, 400, { error: `invalid vault key: ${JSON.stringify(p && p.key)}` });
        if (!validVaultValue(p.value)) return send(res, 400, { error: `invalid value for ${p.key} (must be single-line text)` });
      }
      const stdin = pairs.map((p) => `${p.key}=${p.value}\n`).join("");
      const r = await engineExec(["vault-import"], stdin);
      // Always 200 — a non-zero engine exit is a RESULT the page shows, not a
      // transport error. Names only on success (derived from the validated
      // request keys); on failure the engine's own output, which by contract
      // names keys, never values.
      send(res, 200, r.code === 0
        ? { stored: pairs.map((p) => p.key) }
        : { code: r.code, out: (r.stdout + r.stderr).slice(-2000) });
    });
  }
  if (route === "/api/guards/vault-rm" && req.method === "POST") {
    if (req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
    return readBody(req, res, async (b) => {
      if (!validVaultKey(b.key)) return send(res, 400, { error: `invalid vault key: ${JSON.stringify(b.key)}` });
      const r = await engineExec(["vault-rm", b.key]);
      send(res, 200, { code: r.code, out: (r.stdout + r.stderr).slice(-2000) });
    });
  }
  if (route === "/api/guards/preview" && req.method === "POST") {
    if (req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
    return readBody(req, res, async (b) => {
      // AC-006: the ref resolves ONLY through the engine's own list — a
      // browser string never becomes a filesystem path by itself.
      let items;
      try { items = await engineJson(["list", "--json"]); }
      catch (e) { return send(res, 500, { error: e.message }); }
      const item = (items || []).find((i) => `${i.label}:${i.name}` === b.ref || i.name === b.ref);
      if (!item) return send(res, 404, { error: "no pending script matches that ref" });
      try {
        return send(res, 200, { content: fs.readFileSync(path.join(item.dir, item.name), "utf8").slice(0, BODY_CAP) });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    });
  }
  if (route === "/api/process/status" && req.method === "GET") {
    return (async () => {
      const check = await nodeExec(usagePath(), ["check"]);
      const week = await nodeExec(usagePath(), ["week"]);
      let tier = null;
      try { tier = JSON.parse(check.stdout.trim()); } catch {}
      let dials = null;
      try {
        const p = JSON.parse(fs.readFileSync(policyFile(), "utf8").replace(/^﻿/, ""));
        dials = {
          softK: p.context?.softK, hardK: p.context?.hardK,
          amberTokens: p.week?.amberTokens, redTokens: p.week?.redTokens,
          maxFinders: p.review?.maxFinders, allow: p.subagents?.allow ?? [],
          autoApprove: !!p.autoApprove?.enabled,
        };
      } catch (e) { return send(res, 500, { error: `cannot read policy.json: ${e.message}` }); }
      send(res, 200, {
        tier, weekText: (week.stdout + week.stderr).trim(), dials,
        stopped: fs.existsSync(sliceStopFile()),
        cleanupKilled: fs.existsSync(clearbotStopFile()),
      });
    })();
  }
  if (route === "/api/process/dials" && req.method === "POST") {
    if (req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
    return readBody(req, res, (b) => {
      let policy, merged;
      try { policy = JSON.parse(fs.readFileSync(policyFile(), "utf8").replace(/^﻿/, "")); }
      catch (e) { return send(res, 500, { error: `cannot read policy.json: ${e.message}` }); }
      try { merged = mergeDials(policy, b); }
      catch (e) { return send(res, 400, { error: e.message }); } // bad dial -> file untouched
      // Atomic write (tmp + rename), matching kernel/policy.mjs: a crash
      // mid-write can't truncate policy.json, the file the whole system reads.
      const tmp = policyFile() + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
      fs.renameSync(tmp, policyFile());
      send(res, 200, { ok: true });
    });
  }
  if (route === "/api/process/control" && req.method === "POST") {
    if (req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
    return readBody(req, res, async (b) => {
      const thunk = typeof b.action === "string" ? controlAction(b.action, b) : null;
      if (!thunk) return send(res, 400, { error: `action "${b.action}" is not allowed or is missing its confirm` });
      const outcome = thunk();
      if (outcome === null) return send(res, 400, { error: `action "${b.action}" requires confirm:true` });
      const r = await outcome; // a plain object (file ops) or a nodeExec result
      send(res, 200, r.code !== undefined ? { code: r.code, out: (r.stdout + r.stderr).slice(-2000) } : r);
    });
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

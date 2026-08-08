#!/usr/bin/env node
// Agentic Command Center - the DIRECTIVE store. This is what makes ACC able to
// carry a piece of work across context resets instead of losing it.
//
// THE PROBLEM IT SOLVES: a long task outruns one context window. The directive
// lives in a FILE, not in context: the headless runner (runner/runner.mjs)
// relaunches `claude -p` per cycle with ACC_DIRECTIVE=<id>, budget.mjs's
// SessionStart hook injects the text + progress log into each fresh session,
// and the Stop hook appends the closing summary as the next cycle's handoff.
// The loop ends only when the model itself runs `done`/`blocked` (or a human
// closes it from the Command Center's Start-work page).
//
// THE THREAD OF CONTINUITY IS THE DIRECTIVE ID, carried in ACC_DIRECTIVE by
// every runner-spawned session. (The console-PID binding and keystroke kicks
// of the pre-SPEC-0005 era are gone.) A stale "active" directive nobody is
// running is curated by hand — the web list's Mark-finished / Stop-restarting
// buttons — never reaped automatically.
//
// Fails OPEN, like every other ACC hook helper: a broken directive store must
// cost auto-resume and nothing else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ACC_ROOT: see budget.mjs. Both must honour it or a test would split its state
// across two trees. Resolved on every call, not captured once at import: a
// test process that imports this module once and then runs many cases, each
// against its own ACC_ROOT/ACC_DIRECTIVES_DIR sandbox, needs every call to see
// whatever is current -- a module-load-time const would only ever see the
// first sandbox and silently leak state into every later one.
function root() {
  return process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.resolve(HERE, "..");
}

// The whole -p bootstrap runner.mjs sends for a directive job (SPEC-0001).
// The real directive context (text, log tail, done/blocked protocol) is
// injected by budget.mjs's SessionStart hook; this string only wakes the
// session up.
export const KICK_TEXT = "Continue the active ACC directive.";
export function directivesDir() {
  return process.env.ACC_DIRECTIVES_DIR || path.join(root(), "runner", "directives");
}
function doneDir() {
  return path.join(directivesDir(), "done");
}

const nowIso = () => new Date().toISOString();

function ensureDirs() {
  fs.mkdirSync(directivesDir(), { recursive: true });
  fs.mkdirSync(doneDir(), { recursive: true });
}

function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
}

function directivePath(id) {
  return path.join(directivesDir(), `${safeId(id)}.json`);
}

export function logPath(id) {
  return path.join(directivesDir(), `${safeId(id)}.log.md`);
}

// Ids are used to build file paths and are echoed into injected context, so they
// are constrained here rather than trusted from a caller.
function safeId(id) {
  return String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
}

function write(directive) {
  directive.updatedAt = nowIso();
  fs.writeFileSync(directivePath(directive.id), JSON.stringify(directive, null, 2) + "\n");
  return directive;
}

// SessionStart, Stop, the runner, and a model run can all touch the same
// directive at once, and every mutator below was a bare read -> change ->
// write with nothing serializing it across processes -- a lost update looks
// exactly like the silent stall this whole mechanism exists to prevent
// (issue #14). Same fs-primitives shape kernel/ledger.mjs's withLock proves
// (exclusive-create + stale-mtime reap + Atomics.wait backoff), reimplemented
// here rather than imported: kernel and the directive loop are deliberately
// separate systems (kernel/README.md "Out of scope"), and the lock itself is
// small enough that a cross-module dependency would cost more than it saves.
function withLock(id, fn) {
  fs.mkdirSync(directivesDir(), { recursive: true });
  const file = path.join(directivesDir(), `${safeId(id)}.lock`);
  const deadline = Date.now() + 4000;
  for (;;) {
    try { fs.closeSync(fs.openSync(file, "wx")); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(file).mtimeMs > 5000) { fs.rmSync(file, { force: true }); continue; } } catch {}
      if (Date.now() > deadline) throw new Error(`timed out waiting for the "${id}" directive lock`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(file); } catch {} }
}

// read -> change -> write as one locked unit. The read happens AFTER the
// lock is held, not before, so a writer never acts on a copy another process
// has since changed. `change` returning literal `false` aborts without
// writing (a mutator whose own precondition, e.g. "still active", failed).
function mutate(id, change) {
  return withLock(id, () => {
    const directive = readDirective(id);
    if (!directive) return null;
    // Test seam ONLY (default 0, a no-op): the natural read-to-write window is
    // microseconds, so a lost-update race reproduces only rarely by chance.
    // Widening it on demand makes the regression test deterministic — same
    // pattern as kernel/ledger.mjs's ACC_LEDGER_APPEND_ONCE_DELAY_MS.
    const delay = Number(process.env.ACC_DIRECTIVE_MUTATE_DELAY_MS) || 0;
    if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    if (change(directive) === false) return null;
    return write(directive);
  });
}

export function readDirective(id) {
  const g = readJson(directivePath(id), null);
  return g && g.id ? g : null;
}

export function listDirectives() {
  try {
    return fs
      .readdirSync(directivesDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(path.join(directivesDir(), f), null))
      .filter((g) => g && g.id);
  } catch {
    return [];
  }
}

export function activeDirectives() {
  return listDirectives().filter((g) => g.status === "active");
}

export function directiveForSession(sessionId) {
  if (!sessionId) return null;
  return activeDirectives().find((g) => g.sessionId === sessionId) || null;
}

export function createDirective({ text, cwd, profile }) {
  ensureDirs();
  const t = String(text || "").trim();
  if (!t) throw new Error("a directive needs text");
  const iso = new Date().toISOString(); // 2026-07-31T04:10:27.123Z
  const id =
    "d-" +
    iso.slice(0, 10).replace(/-/g, "") +
    "-" +
    iso.slice(11, 19).replace(/:/g, "") +
    "-" +
    Math.random().toString(36).slice(2, 6);
  const directive = {
    id,
    text: t,
    cwd: cwd || "",
    profile: profile || "",
    status: "active",
    sessionId: "",
    cycles: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  write(directive);
  fs.writeFileSync(
    logPath(id),
    `# Directive ${id}\n\n${t}\n\n- folder: ${directive.cwd || "(not set)"}\n- profile: ${directive.profile || "(default)"}\n- opened: ${directive.createdAt}\n\n## Progress\n\n`
  );
  return directive;
}

// Real Claude Code session ids are always UUIDs. bindSession is reachable by
// hand (piping a fake SessionStart payload into budget.mjs against live
// state), and a synthetic sessionId there would otherwise silently steal a
// live console's directive binding (OI-006, reproduced). A non-UUID sessionId is
// therefore treated exactly like none was passed at all.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Called from SessionStart. One way in: ACC_DIRECTIVE names the directive the
// Command Center (or the headless runner) launched this session for. Each
// fresh runner cycle rebinds the same directive to its new session id.
export function bindSession({ sessionId, cwd, directiveId }) {
  ensureDirs();
  // Unlocked lookup only decides WHICH directive to target; mutate() below
  // re-reads it fresh once the lock is held, so a candidate that went stale
  // between this search and the lock can never be written over.
  let found = directiveId ? readDirective(directiveId) : null;
  if (found && found.status !== "active") found = null;
  if (!found) return null;

  return mutate(found.id, (directive) => {
    if (directive.status !== "active") return false; // went inactive since the lookup
    // A non-UUID id (garbage, or simply absent) never touches sessionId (OI-006)
    // -- it is inert, not "no-op with side effects".
    const validId = sessionId && SESSION_ID_RE.test(String(sessionId)) ? sessionId : null;
    if (validId !== null) directive.sessionId = validId;
    if (!directive.cwd && cwd) directive.cwd = cwd;
  });
}

export function appendCycle(id, { sessionId, ctx, text }) {
  const directive = mutate(id, (d) => { d.cycles = Number(d.cycles || 0) + 1; });
  if (!directive) return null;
  const body = String(text || "").trim().slice(0, 4000);
  try {
    fs.appendFileSync(
      logPath(id),
      `\n### Cycle ${directive.cycles} - ${nowIso()}\n` +
        `_session ${sessionId || "?"} ended at ${Math.round(Number(ctx || 0) / 1000)}k_\n\n` +
        (body || "_(no closing summary captured)_") +
        "\n"
    );
  } catch {}
  return directive;
}

// The stuck signal for a headless run (runner.mjs's directiveState hashes
// this): the BODY of the log's last section, with the header and _session_
// lines dropped — their timestamps change on every append, so hashing them
// would make every run read as progress and disarm the stuck brake entirely.
export function lastCycleBody(id) {
  let all = "";
  try { all = fs.readFileSync(logPath(id), "utf8"); } catch { return ""; }
  const i = all.lastIndexOf("### ");
  if (i < 0) return "";
  const lines = all.slice(i).split("\n").slice(1);
  if (/^_session .*_\s*$/.test(lines[0] || "")) lines.shift();
  return lines.join("\n").trim();
}

// The tail is what gets injected into the next session, so it is bounded here
// rather than at the call site: an unbounded log would grow until it ate the
// very context budget this whole mechanism exists to protect.
export function logTail(id, maxChars = 3000) {
  try {
    const all = fs.readFileSync(logPath(id), "utf8");
    if (all.length <= maxChars) return all;
    return "...(earlier progress trimmed)...\n" + all.slice(-maxChars);
  } catch {
    return "";
  }
}

export function setStatus(id, status, why) {
  const directive = mutate(id, (d) => {
    d.status = status;
    if (why) d.why = String(why).slice(0, 500);
  });
  if (!directive) return null;
  if (status === "done" || status === "blocked" || status === "dead") {
    try {
      fs.appendFileSync(logPath(id), `\n### ${status.toUpperCase()} - ${nowIso()}\n${why || ""}\n`);
    } catch {}
    // Archive so the live directory only ever holds work in flight.
    try {
      ensureDirs();
      fs.renameSync(directivePath(id), path.join(doneDir(), `${safeId(id)}.json`));
      fs.renameSync(logPath(id), path.join(doneDir(), `${safeId(id)}.log.md`));
    } catch {}
  }
  return directive;
}

// ------------------------------------------------------------- CLI

function arg(argv, name, dflt = "") {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}

// Directive text for `new`. --text-file exists because the caller that matters is the
// GUI, and the GUI's node shim strips double quotes and cannot pass a newline in
// a command line at all - so a multi-line directive typed in the box would arrive
// mangled or truncated. A file has neither problem.
export function textFromArgs(argv) {
  const file = arg(argv, "--text-file");
  if (file) return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return arg(argv, "--text");
}

// Positional id, falling back to the single active directive. Every command a MODEL
// is told to run takes an explicit id (SessionStart injects it), so this fallback
// only serves a human at a prompt.
function resolveId(argv) {
  const pos = argv.find((a) => /^d-/.test(a));
  if (pos) return pos;
  const act = activeDirectives();
  return act.length === 1 ? act[0].id : "";
}

export function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "list";

  if (cmd === "new") {
    const g = createDirective({
      text: textFromArgs(argv),
      cwd: arg(argv, "--cwd"),
      profile: arg(argv, "--profile"),
    });
    console.log(JSON.stringify(g));
    return;
  }
  if (cmd === "list") {
    console.log(JSON.stringify(activeDirectives(), null, 2));
    return;
  }
  if (cmd === "show") {
    const g = readDirective(resolveId(argv));
    console.log(g ? JSON.stringify(g, null, 2) : "no active directive");
    return;
  }
  if (cmd === "log") {
    const id = resolveId(argv);
    const text = arg(argv, "--text") || argv.slice(1).filter((a) => !/^d-/.test(a)).join(" ");
    const g = readDirective(id);
    if (!g) return console.log("no active directive");
    try {
      fs.appendFileSync(logPath(id), `\n- ${nowIso()} ${text}\n`);
    } catch {}
    console.log(`logged to ${logPath(id)}`);
    return;
  }
  if (cmd === "done" || cmd === "blocked" || cmd === "paused") {
    const id = resolveId(argv);
    if (!id) return console.log("no active directive (pass the id)");
    setStatus(id, cmd === "paused" ? "paused" : cmd, arg(argv, "--why"));
    console.log(`directive ${id} -> ${cmd}`);
    return;
  }
  console.log(
    "usage: directive.mjs new (--text T | --text-file F) [--cwd D] [--profile P] | list | show [id] | log [id] --text T | done [id] [--why W] | blocked [id] --why W | paused [id]"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();

#!/usr/bin/env node
// Agentic Command Center - the DIRECTIVE store. This is what makes ACC able to carry
// a piece of work across a /clear instead of losing it.
//
// THE PROBLEM IT SOLVES: the auto-clear chain (Stop hook -> clear-request ->
// clearbot -> WriteConsoleInput types "/clear") worked, but it stopped there.
// The fresh session came up with an empty prompt and no idea what it had been
// doing, so a human had to retype the task. A directive survives the clear because it
// lives in a FILE, not in context.
//
// THE THREAD OF CONTINUITY IS THE CONSOLE PID, not the session id. A /clear ends
// the session id and starts a new one, but the terminal window - and therefore
// the console pid that clearbot types into - is the same process throughout. So
// a directive binds to a console, and every session that starts in that console
// adopts it.
//
// WHY THE TEXT NEVER TRAVELS AS KEYSTROKES: clearbot turns text into real key
// events, so a newline in a task would submit a fragment (this is OI-004). The
// directive text goes in this file; the only thing ever typed is a constant. That is
// also what lets a multi-line task work at all.
//
// Fails OPEN, like every other ACC hook helper: a broken directive store must cost
// auto-resume and nothing else.

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
export function directivesDir() {
  return process.env.ACC_DIRECTIVES_DIR || path.join(root(), "runner", "directives");
}
function doneDir() {
  return path.join(directivesDir(), "done");
}

// A kick is only sent once the binding has had time to settle. SessionStart runs
// before the TUI is ready to accept input, so firing the instant a directive binds
// types into a console that is still starting up. Policy-overridable
// (`tui.readySettleMs`) and reused verbatim by watcher/clearbot.ps1's
// Get-TuiReadyMs for the /cd settle (guards OI-003) -- one proven number for
// "is this session's TUI ready for injected input yet" instead of two
// independently-guessed ones. Was `KICK_DELAY_MS = 4000` hardcoded here only;
// clearbot's own /cd settle separately guessed 1200 and that guess failed a
// real-token repro (OI-003, 2026-08-04) after already failing once with zero
// settle at all -- so this value now has exactly one source of truth.
const TUI_READY_MS_DEFAULT = 4000;
// One kick per directive per minute, whatever happens. A resume loop that somehow
// re-armed itself must not be able to machine-gun the console.
const KICK_COOLDOWN_MS = 60000;
// A turn that ends UNDER budget used to end the loop: nothing re-armed the
// kick, so an active directive sat dead until a human typed (observed twice on
// 2026-07-31, once for 18 minutes). These two windows are what make an
// under-budget turn end resume instead of stall. Both are policy dials
// (directives.kickSettleSeconds / directives.humanHoldMinutes); these are the fallbacks.
const KICK_SETTLE_MS_DEFAULT = 90_000;
// While Kyle is actively prompting this console, stay out of his way. The hold
// EXPIRES, so walking away mid-conversation still self-heals into autonomy.
const HUMAN_HOLD_MS_DEFAULT = 10 * 60_000;

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

// Is that console still alive? A directive bound to a window Kyle has since closed
// must never be resumed - there is nothing to type into, and the pid may since
// have been reused by an unrelated process.
export function consoleAlive(pid) {
  const n = Number(pid || 0);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM"; // exists, owned by someone else
  }
}

// OI-031: left alone, an active directive whose console died just sits "active"
// forever - nothing ever marked it dead, so the store only grows and
// pendingKicks keeps re-checking directives no one can ever resume (found live:
// 7 "active" directives, oldest four days old, every consolePid gone). "dead"
// means BOUND (consolePid nonzero) and NOT alive; an unbound directive
// (consolePid 0 - created but not yet launched into a console) is left
// alone, since there is nothing yet to prove dead. Runs on every
// activeDirectives() call rather than on a timer: cheap (one process.kill(pid,0)
// per active directive, same cost pendingKicks already pays), and it means every
// reader - list, pending, directiveForSession - sees the reaped result
// immediately instead of a stale one.
export function reapDeadDirectives() {
  const reaped = [];
  for (const g of listDirectives()) {
    if (g.status !== "active") continue;
    if (!g.consolePid || consoleAlive(g.consolePid)) continue;
    setStatus(g.id, "dead", `console pid ${g.consolePid} is gone (reaped)`);
    reaped.push(g.id);
  }
  return reaped;
}

export function activeDirectives() {
  reapDeadDirectives();
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
    consolePid: 0,
    sessionId: "",
    cycles: 0,
    needsKick: false,
    boundAt: "",
    lastKickAt: "",
    turnEndedAt: "",
    humanPromptAt: "",
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

// Called from SessionStart. Two ways in:
//   - ACC_DIRECTIVE is set   -> the Command Center launched this session for that directive
//   - otherwise         -> adopt whatever active directive owns this console
// The second case is the one that survives a /clear, and it is deliberately not
// conditional on how the clear happened: a directive Kyle cleared by hand resumes the
// same way an auto-clear does.
export function bindSession({ sessionId, consolePid, cwd, directiveId }) {
  ensureDirs();
  let directive = directiveId ? readDirective(directiveId) : null;
  if (directive && directive.status !== "active") directive = null;
  if (!directive && consolePid) {
    directive = activeDirectives().find((g) => Number(g.consolePid) === Number(consolePid)) || null;
  }
  if (!directive) return null;

  // A non-UUID id (garbage, or simply absent) never touches sessionId/
  // needsKick/boundAt below -- it is inert, not "no-op with side effects".
  const validId = sessionId && SESSION_ID_RE.test(String(sessionId)) ? sessionId : null;
  const fresh = validId !== null && directive.sessionId !== validId;
  if (validId !== null) directive.sessionId = validId;
  if (consolePid) directive.consolePid = Number(consolePid);
  if (!directive.cwd && cwd) directive.cwd = cwd;
  if (fresh) {
    // A new session for a live directive is exactly the state that needs a prompt
    // typed into it - whether this is the launch or the 4th resume.
    directive.needsKick = true;
    directive.boundAt = nowIso();
  }
  return write(directive);
}

export function appendCycle(id, { sessionId, ctx, text }) {
  const directive = readDirective(id);
  if (!directive) return null;
  directive.cycles = Number(directive.cycles || 0) + 1;
  write(directive);
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
  const directive = readDirective(id);
  if (!directive) return null;
  directive.status = status;
  directive.needsKick = false;
  if (why) directive.why = String(why).slice(0, 500);
  write(directive);
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

// What clearbot asks for every cycle. Everything that makes a kick unsafe is
// decided HERE, in one place, so the watcher stays a dumb executor:
//   - directive must be active
//   - its console must still exist
//   - the binding must have settled (TUI ready)
//   - the cooldown must have expired
export function pendingKicks(now = Date.now(), opts = {}) {
  const tuiReadyMs =
    opts.tuiReadySettleMs != null ? Number(opts.tuiReadySettleMs) : TUI_READY_MS_DEFAULT;
  const settleMs =
    opts.kickSettleSeconds != null ? Number(opts.kickSettleSeconds) * 1000 : KICK_SETTLE_MS_DEFAULT;
  const holdMs =
    opts.humanHoldMinutes != null ? Number(opts.humanHoldMinutes) * 60000 : HUMAN_HOLD_MS_DEFAULT;
  return activeDirectives()
    .filter((g) => g.needsKick)
    .filter((g) => consoleAlive(g.consolePid))
    .filter((g) => !g.boundAt || now - Date.parse(g.boundAt) >= tuiReadyMs)
    // Turn-end settle: the TUI needs a moment after a turn ends, and an instant
    // kick would race the model's own closing tool calls.
    .filter((g) => !g.turnEndedAt || now - Date.parse(g.turnEndedAt) >= settleMs)
    // Human hold: quiet while he is typing, self-healing once he stops.
    .filter((g) => !g.humanPromptAt || now - Date.parse(g.humanPromptAt) >= holdMs)
    .filter((g) => !g.lastKickAt || now - Date.parse(g.lastKickAt) >= KICK_COOLDOWN_MS)
    .map((g) => ({ id: g.id, consolePid: g.consolePid, cycles: g.cycles, sessionId: g.sessionId }));
}

// Called from the Stop hook on every turn end of a directive session that did NOT go
// over budget (the over-budget path has its own clear/resume chain). This is the
// liveness trigger: it re-arms the kick, and pendingKicks() above decides when
// firing it is safe. `human` marks a turn Kyle prompted, which backs the kick
// off - see HUMAN_HOLD_MS_DEFAULT.
export function recordTurnEnd(id, { human } = {}) {
  const directive = readDirective(id);
  if (!directive || directive.status !== "active") return null;
  directive.needsKick = true;
  directive.turnEndedAt = nowIso();
  if (human) directive.humanPromptAt = nowIso();
  return write(directive);
}

export function markKicked(id) {
  const directive = readDirective(id);
  if (!directive) return null;
  directive.needsKick = false;
  directive.lastKickAt = nowIso();
  return write(directive);
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
  if (cmd === "reap") {
    console.log(JSON.stringify(reapDeadDirectives()));
    return;
  }
  if (cmd === "pending") {
    // Dials live in policy.json so they can be tuned without a restart; a
    // missing or broken policy just uses the defaults (fail open).
    let dials = {};
    try {
      const pol = JSON.parse(
        fs.readFileSync(process.env.ACC_POLICY || path.join(root(), "policy.json"), "utf8")
      );
      dials = {
        kickSettleSeconds: pol?.directives?.kickSettleSeconds,
        humanHoldMinutes: pol?.directives?.humanHoldMinutes,
        tuiReadySettleMs: pol?.tui?.readySettleMs,
      };
    } catch {}
    console.log(JSON.stringify(pendingKicks(Date.now(), dials)));
    return;
  }
  if (cmd === "kicked") {
    markKicked(resolveId(argv));
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
    "usage: directive.mjs new (--text T | --text-file F) [--cwd D] [--profile P] | list | show [id] | log [id] --text T | done [id] [--why W] | blocked [id] --why W | paused [id] | pending | kicked [id] | reap"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();

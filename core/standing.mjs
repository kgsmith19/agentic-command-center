#!/usr/bin/env node
// Agentic Command Center - the STANDING store. This is what makes ACC able to carry
// a piece of work across a /clear instead of losing it.
//
// THE PROBLEM IT SOLVES: the auto-clear chain (Stop hook -> clear-request ->
// autopilot -> WriteConsoleInput types "/clear") worked, but it stopped there.
// The fresh session came up with an empty prompt and no idea what it had been
// doing, so a human had to retype the task. A standing survives the clear because it
// lives in a FILE, not in context.
//
// THE THREAD OF CONTINUITY IS THE CONSOLE PID, not the session id. A /clear ends
// the session id and starts a new one, but the terminal window - and therefore
// the console pid that autopilot types into - is the same process throughout. So
// a standing binds to a console, and every session that starts in that console
// adopts it.
//
// WHY THE TEXT NEVER TRAVELS AS KEYSTROKES: autopilot turns text into real key
// events, so a newline in a task would submit a fragment (this is OI-004). The
// standing text goes in this file; the only thing ever typed is a constant. That is
// also what lets a multi-line task work at all.
//
// Fails OPEN, like every other ACC hook helper: a broken standing store must cost
// auto-resume and nothing else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ACC_ROOT: see budget.mjs. Both must honour it or a test would split its state
// across two trees. Resolved on every call, not captured once at import: a
// test process that imports this module once and then runs many cases, each
// against its own ACC_ROOT/ACC_STANDING_DIR sandbox, needs every call to see
// whatever is current -- a module-load-time const would only ever see the
// first sandbox and silently leak state into every later one.
function root() {
  return process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.resolve(HERE, "..");
}
export function standingDir() {
  return process.env.ACC_STANDING_DIR || path.join(root(), "runner", "standing");
}
function doneDir() {
  return path.join(standingDir(), "done");
}

// A kick is only sent once the binding has had time to settle. SessionStart runs
// before the TUI is ready to accept input, so firing the instant a standing binds
// types into a console that is still starting up. Policy-overridable
// (`tui.readySettleMs`) and reused verbatim by watcher/autopilot.ps1's
// Get-TuiReadyMs for the /cd settle (guards OI-003) -- one proven number for
// "is this session's TUI ready for injected input yet" instead of two
// independently-guessed ones. Was `KICK_DELAY_MS = 4000` hardcoded here only;
// autopilot's own /cd settle separately guessed 1200 and that guess failed a
// real-token repro (OI-003, 2026-08-04) after already failing once with zero
// settle at all -- so this value now has exactly one source of truth.
const TUI_READY_MS_DEFAULT = 4000;
// One kick per standing per minute, whatever happens. A resume loop that somehow
// re-armed itself must not be able to machine-gun the console.
const KICK_COOLDOWN_MS = 60000;
// A turn that ends UNDER budget used to end the loop: nothing re-armed the
// kick, so an active standing sat dead until a human typed (observed twice on
// 2026-07-31, once for 18 minutes). These two windows are what make an
// under-budget turn end resume instead of stall. Both are policy dials
// (standing.kickSettleSeconds / standing.humanHoldMinutes); these are the fallbacks.
const KICK_SETTLE_MS_DEFAULT = 90_000;
// While Kyle is actively prompting this console, stay out of his way. The hold
// EXPIRES, so walking away mid-conversation still self-heals into autonomy.
const HUMAN_HOLD_MS_DEFAULT = 10 * 60_000;

const nowIso = () => new Date().toISOString();

function ensureDirs() {
  fs.mkdirSync(standingDir(), { recursive: true });
  fs.mkdirSync(doneDir(), { recursive: true });
}

function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
}

function standingPath(id) {
  return path.join(standingDir(), `${safeId(id)}.json`);
}

export function logPath(id) {
  return path.join(standingDir(), `${safeId(id)}.log.md`);
}

// Ids are used to build file paths and are echoed into injected context, so they
// are constrained here rather than trusted from a caller.
function safeId(id) {
  return String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
}

function write(standing) {
  standing.updatedAt = nowIso();
  fs.writeFileSync(standingPath(standing.id), JSON.stringify(standing, null, 2) + "\n");
  return standing;
}

export function readStanding(id) {
  const g = readJson(standingPath(id), null);
  return g && g.id ? g : null;
}

export function listStanding() {
  try {
    return fs
      .readdirSync(standingDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(path.join(standingDir(), f), null))
      .filter((g) => g && g.id);
  } catch {
    return [];
  }
}

export function activeStanding() {
  return listStanding().filter((g) => g.status === "active");
}

// OI-034. A pid is not an identity: Windows recycles them, and the comment
// this replaced named that hazard since the file was written while the check
// below it did nothing about it. A console is (pid, startTime).
//
// This function does NOT query the OS. Autopilot already enumerates processes
// every cycle and gets StartTime free, so it passes the table in. That keeps
// this module pure and keeps every kick-safety rule in this one file, which is
// what its header promises.
export function consoleState(standing, consoles) {
  if (!consoles) return "unknown"; // cannot tell -> do nothing
  const pid = Number(standing.consolePid || 0);
  if (!pid) return "dead";
  const seen = consoles[String(pid)];
  if (!seen) return "dead"; // pid is gone
  if (!standing.consoleStartedAt) return "unknown"; // not stamped yet
  return standing.consoleStartedAt === seen ? "alive" : "dead"; // recycled if it differs
}

// Stamped by autopilot on first sighting rather than at bind time: bindSession's
// caller has the pid but no cheap way to read a start time. Inside the grace
// window the standing is seconds old, so a recycle here is not credible - and this
// is the same window reapDeadStanding already protects (REAP_GRACE_MS_DEFAULT).
// An unstamped standing older than the grace window is left unstamped on purpose:
// it predates this change and its identity cannot be reconstructed, so it is
// left for reapDeadStanding to reap rather than guessed at.
export function stampConsoles(consoles, { now = Date.now(), graceMs = REAP_GRACE_MS_DEFAULT } = {}) {
  if (!consoles) return [];
  const stamped = [];
  for (const g of activeStanding()) {
    if (g.consoleStartedAt) continue;
    const seen = consoles[String(Number(g.consolePid || 0))];
    if (!seen) continue;
    const createdMs = Date.parse(g.createdAt || 0);
    if (!Number.isFinite(createdMs) || now - createdMs > graceMs) continue;
    g.consoleStartedAt = seen;
    write(g);
    stamped.push(g.id);
  }
  return stamped;
}

export function standingForSession(sessionId) {
  if (!sessionId) return null;
  return activeStanding().find((g) => g.sessionId === sessionId) || null;
}

// AC-J5/J6/J7: the injected marker format changed from `[ACC GOAL g-...]` to
// `[ACC STANDING so-...]`. A transcript or log written before this rename
// still carries the old marker, so it must still be understood for one
// release rather than silently failing to match - with a deprecation notice
// so any remaining caller of the old form is visible instead of quiet.
const LEGACY_MARKER_RE = /^\[ACC GOAL (g-[A-Za-z0-9_-]+)\]/;
const MARKER_RE = /^\[ACC STANDING (so-[A-Za-z0-9_-]+)\]/;

export function parseInjection(text) {
  const s = String(text || "");
  const legacy = s.match(LEGACY_MARKER_RE);
  if (legacy) {
    return {
      id: "so-" + legacy[1].slice("g-".length),
      deprecation: "[ACC GOAL] is deprecated, use [ACC STANDING so-...] (guards#OI-026)",
    };
  }
  const current = s.match(MARKER_RE);
  if (current) return { id: current[1], deprecation: null };
  return { id: null, deprecation: null };
}

export function createStanding({ text, cwd, profile }) {
  ensureDirs();
  const t = String(text || "").trim();
  if (!t) throw new Error("a standing order needs text");
  const iso = new Date().toISOString(); // 2026-07-31T04:10:27.123Z
  const id =
    "so-" +
    iso.slice(0, 10).replace(/-/g, "") +
    "-" +
    iso.slice(11, 19).replace(/:/g, "") +
    "-" +
    Math.random().toString(36).slice(2, 6);
  const standing = {
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
  write(standing);
  fs.writeFileSync(
    logPath(id),
    `# Standing order ${id}\n\n${t}\n\n- folder: ${standing.cwd || "(not set)"}\n- profile: ${standing.profile || "(default)"}\n- opened: ${standing.createdAt}\n\n## Progress\n\n`
  );
  return standing;
}

// Real Claude Code session ids are always UUIDs. bindSession is reachable by
// hand (piping a fake SessionStart payload into budget.mjs against live
// state), and a synthetic sessionId there would otherwise silently steal a
// live console's standing binding (OI-006, reproduced). A non-UUID sessionId is
// therefore treated exactly like none was passed at all.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Called from SessionStart. Two ways in:
//   - ACC_STANDING is set   -> the Command Center launched this session for that standing
//   - otherwise         -> adopt whatever active standing owns this console
// The second case is the one that survives a /clear, and it is deliberately not
// conditional on how the clear happened: a standing Kyle cleared by hand resumes the
// same way an auto-clear does.
export function bindSession({ sessionId, consolePid, cwd, standingId, consoles }) {
  ensureDirs();
  // guards OI-031, and it belongs HERE rather than at the SessionStart call site:
  // the fallback below adopts "whatever active standing owns this console pid", and
  // Windows recycles pids, so a stale standing is exactly what a fresh session would
  // inherit -- injecting last week's task into today's work. Six such standing orders were
  // live on 2026-08-04, the oldest from 07-31, every console long dead. Reaping
  // first means there is nothing stale left to adopt, and it keeps every rule
  // about what makes adoption unsafe in this one file, as the header promises.
  reapDeadStanding({ consoles });
  let standing = standingId ? readStanding(standingId) : null;
  if (standing && standing.status !== "active") standing = null;
  if (!standing && consolePid) {
    // OI-034: matching on pid alone is how a fresh session inherited last
    // week's task. Identity, or no adoption.
    standing =
      activeStanding().find(
        (g) => Number(g.consolePid) === Number(consolePid) && consoleState(g, consoles) === "alive"
      ) || null;
  }
  if (!standing) return null;

  // A non-UUID id (garbage, or simply absent) never touches sessionId/
  // needsKick/boundAt below -- it is inert, not "no-op with side effects".
  const validId = sessionId && SESSION_ID_RE.test(String(sessionId)) ? sessionId : null;
  const fresh = validId !== null && standing.sessionId !== validId;
  if (validId !== null) standing.sessionId = validId;
  if (consolePid) standing.consolePid = Number(consolePid);
  if (!standing.cwd && cwd) standing.cwd = cwd;
  if (fresh) {
    // A new session for a live standing is exactly the state that needs a prompt
    // typed into it - whether this is the launch or the 4th resume.
    standing.needsKick = true;
    standing.boundAt = nowIso();
  }
  return write(standing);
}

export function appendCycle(id, { sessionId, ctx, text }) {
  const standing = readStanding(id);
  if (!standing) return null;
  standing.cycles = Number(standing.cycles || 0) + 1;
  write(standing);
  const body = String(text || "").trim().slice(0, 4000);
  try {
    fs.appendFileSync(
      logPath(id),
      `\n### Cycle ${standing.cycles} - ${nowIso()}\n` +
        `_session ${sessionId || "?"} ended at ${Math.round(Number(ctx || 0) / 1000)}k_\n\n` +
        (body || "_(no closing summary captured)_") +
        "\n"
    );
  } catch {}
  return standing;
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
  const standing = readStanding(id);
  if (!standing) return null;
  standing.status = status;
  standing.needsKick = false;
  if (why) standing.why = String(why).slice(0, 500);
  write(standing);
  if (status === "done" || status === "blocked" || status === "abandoned") {
    try {
      fs.appendFileSync(logPath(id), `\n### ${status.toUpperCase()} - ${nowIso()}\n${why || ""}\n`);
    } catch {}
    // Archive so the live directory only ever holds work in flight.
    try {
      ensureDirs();
      fs.renameSync(standingPath(id), path.join(doneDir(), `${safeId(id)}.json`));
      fs.renameSync(logPath(id), path.join(doneDir(), `${safeId(id)}.log.md`));
    } catch {}
  }
  return standing;
}

// guards OI-031. Nothing used to mark a standing dead when its console died, so the
// store only ever grew: six standing orders sat "active" from 2026-07-31 onward, every one
// bound to a console gone for days, and pendingKicks kept considering work
// nobody was doing. autopilot even LOGGED the deaths ("GUI-DEAD ... hosting GUI
// (pid 1620) is gone") and left the standing orders active - detection without reaping.
//
// "abandoned" is deliberately a third status, not done/blocked: the console went
// away, the model never finished. A ledger that cannot tell those apart cannot
// tell a completed loop from a lost one.
const REAP_GRACE_MS_DEFAULT = 120000;

export function reapDeadStanding({ now = Date.now(), graceMs = REAP_GRACE_MS_DEFAULT, consoles } = {}) {
  const reaped = [];
  for (const g of activeStanding()) {
    // OI-034: identity, not existence. Without a table we cannot prove a pid is
    // gone, so nothing is reaped on a guess - see consoleState's own comment.
    if (consoleState(g, consoles) !== "dead") continue;
    // Never bound: the GUI creates the standing and THEN launches the console, so
    // for a moment a healthy standing legitimately has no console. Reaping there
    // would kill the very launch the standing belongs to. A standing that HAS bound was
    // attached to a console that provably existed, so a dead pid now means that
    // console died - no grace applies.
    if (!g.boundAt) {
      const born = Date.parse(g.createdAt || "");
      if (Number.isFinite(born) && now - born < graceMs) continue;
    }
    setStatus(g.id, "abandoned", "console gone - reaped by reapDeadStanding");
    reaped.push(g.id);
  }
  return reaped;
}

// What autopilot asks for every cycle. Everything that makes a kick unsafe is
// decided HERE, in one place, so the watcher stays a dumb executor:
//   - standing must be active
//   - its console must still exist
//   - the binding must have settled (TUI ready)
//   - the cooldown must have expired
export function pendingKicks(now = Date.now(), opts = {}) {
  // No table means we cannot prove which process owns that pid. Typing into an
  // unproven process is OI-034 itself, so this fails closed rather than
  // best-effort.
  if (!opts.consoles) return [];
  const tuiReadyMs =
    opts.tuiReadySettleMs != null ? Number(opts.tuiReadySettleMs) : TUI_READY_MS_DEFAULT;
  const settleMs =
    opts.kickSettleSeconds != null ? Number(opts.kickSettleSeconds) * 1000 : KICK_SETTLE_MS_DEFAULT;
  const holdMs =
    opts.humanHoldMinutes != null ? Number(opts.humanHoldMinutes) * 60000 : HUMAN_HOLD_MS_DEFAULT;
  return activeStanding()
    .filter((g) => g.needsKick)
    .filter((g) => consoleState(g, opts.consoles) === "alive")
    .filter((g) => !g.boundAt || now - Date.parse(g.boundAt) >= tuiReadyMs)
    // Turn-end settle: the TUI needs a moment after a turn ends, and an instant
    // kick would race the model's own closing tool calls.
    .filter((g) => !g.turnEndedAt || now - Date.parse(g.turnEndedAt) >= settleMs)
    // Human hold: quiet while he is typing, self-healing once he stops.
    .filter((g) => !g.humanPromptAt || now - Date.parse(g.humanPromptAt) >= holdMs)
    .filter((g) => !g.lastKickAt || now - Date.parse(g.lastKickAt) >= KICK_COOLDOWN_MS)
    .map((g) => ({ id: g.id, consolePid: g.consolePid, cycles: g.cycles, sessionId: g.sessionId }));
}

// Called from the Stop hook on every turn end of a standing session that did NOT go
// over budget (the over-budget path has its own clear/resume chain). This is the
// liveness trigger: it re-arms the kick, and pendingKicks() above decides when
// firing it is safe. `human` marks a turn Kyle prompted, which backs the kick
// off - see HUMAN_HOLD_MS_DEFAULT.
export function recordTurnEnd(id, { human } = {}) {
  const standing = readStanding(id);
  if (!standing || standing.status !== "active") return null;
  standing.needsKick = true;
  standing.turnEndedAt = nowIso();
  if (human) standing.humanPromptAt = nowIso();
  return write(standing);
}

export function markKicked(id) {
  const standing = readStanding(id);
  if (!standing) return null;
  standing.needsKick = false;
  standing.lastKickAt = nowIso();
  return write(standing);
}

// ------------------------------------------------------------- CLI

function arg(argv, name, dflt = "") {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}

// Standing text for `new`. --text-file exists because the caller that matters is the
// GUI, and the GUI's node shim strips double quotes and cannot pass a newline in
// a command line at all - so a multi-line standing typed in the box would arrive
// mangled or truncated. A file has neither problem.
export function textFromArgs(argv) {
  const file = arg(argv, "--text-file");
  if (file) return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return arg(argv, "--text");
}

// Positional id, falling back to the single active standing. Every command a MODEL
// is told to run takes an explicit id (SessionStart injects it), so this fallback
// only serves a human at a prompt.
function resolveId(argv) {
  const pos = argv.find((a) => /^so-/.test(a));
  if (pos) return pos;
  const act = activeStanding();
  return act.length === 1 ? act[0].id : "";
}

// The console table arrives on stdin, not argv: the pid list is unbounded and
// Windows caps command lines. Empty stdin -> no table -> pendingKicks/
// reapDeadStanding fail closed, which is the intended behaviour, not a degraded
// one.
function readConsoleTable() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "list";

  if (cmd === "new") {
    const g = createStanding({
      text: textFromArgs(argv),
      cwd: arg(argv, "--cwd"),
      profile: arg(argv, "--profile"),
    });
    console.log(JSON.stringify(g));
    return;
  }
  if (cmd === "list") {
    console.log(JSON.stringify(activeStanding(), null, 2));
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
        kickSettleSeconds: pol?.standing?.kickSettleSeconds,
        humanHoldMinutes: pol?.standing?.humanHoldMinutes,
        tuiReadySettleMs: pol?.tui?.readySettleMs,
      };
    } catch {}
    const consoles = readConsoleTable();
    stampConsoles(consoles);
    console.log(JSON.stringify(pendingKicks(Date.now(), { ...dials, consoles })));
    return;
  }
  if (cmd === "kicked") {
    markKicked(resolveId(argv));
    return;
  }
  if (cmd === "reap") {
    // Same table as 'pending', same fail-closed rule: reap only what the
    // caller can prove is gone. An empty table ({}) is a caller asserting "I
    // enumerated every process and this pid was not among them" - that is
    // still proof. No table at all proves nothing, so nothing is reaped.
    const ids = reapDeadStanding({ consoles: readConsoleTable() });
    console.log(ids.length ? `reaped ${ids.length}: ${ids.join(" ")}` : "reaped 0");
    return;
  }
  if (cmd === "show") {
    const g = readStanding(resolveId(argv));
    console.log(g ? JSON.stringify(g, null, 2) : "no active standing order");
    return;
  }
  if (cmd === "log") {
    const id = resolveId(argv);
    const text = arg(argv, "--text") || argv.slice(1).filter((a) => !/^so-/.test(a)).join(" ");
    const g = readStanding(id);
    if (!g) return console.log("no active standing order");
    try {
      fs.appendFileSync(logPath(id), `\n- ${nowIso()} ${text}\n`);
    } catch {}
    console.log(`logged to ${logPath(id)}`);
    return;
  }
  if (cmd === "done" || cmd === "blocked" || cmd === "paused") {
    const id = resolveId(argv);
    if (!id) return console.log("no active standing order (pass the id)");
    setStatus(id, cmd === "paused" ? "paused" : cmd, arg(argv, "--why"));
    console.log(`standing ${id} -> ${cmd}`);
    return;
  }
  console.log(
    "usage: standing.mjs new (--text T | --text-file F) [--cwd D] [--profile P] | list | show [id] | log [id] --text T | done [id] [--why W] | blocked [id] --why W | paused [id] | pending | kicked [id] | reap"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();

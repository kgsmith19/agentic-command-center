#!/usr/bin/env node
// Agentic Command Center - the GOAL store. This is what makes ACC able to carry
// a piece of work across a /clear instead of losing it.
//
// THE PROBLEM IT SOLVES: the auto-clear chain (Stop hook -> clear-request ->
// clearbot -> WriteConsoleInput types "/clear") worked, but it stopped there.
// The fresh session came up with an empty prompt and no idea what it had been
// doing, so a human had to retype the task. A goal survives the clear because it
// lives in a FILE, not in context.
//
// THE THREAD OF CONTINUITY IS THE CONSOLE PID, not the session id. A /clear ends
// the session id and starts a new one, but the terminal window - and therefore
// the console pid that clearbot types into - is the same process throughout. So
// a goal binds to a console, and every session that starts in that console
// adopts it.
//
// WHY THE TEXT NEVER TRAVELS AS KEYSTROKES: clearbot turns text into real key
// events, so a newline in a task would submit a fragment (this is OI-004). The
// goal text goes in this file; the only thing ever typed is a constant. That is
// also what lets a multi-line task work at all.
//
// Fails OPEN, like every other ACC hook helper: a broken goal store must cost
// auto-resume and nothing else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ACC_ROOT: see budget.mjs. Both must honour it or a test would split its state
// across two trees. Resolved on every call, not captured once at import: a
// test process that imports this module once and then runs many cases, each
// against its own ACC_ROOT/ACC_GOALS_DIR sandbox, needs every call to see
// whatever is current -- a module-load-time const would only ever see the
// first sandbox and silently leak state into every later one.
function root() {
  return process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.resolve(HERE, "..");
}
export function goalsDir() {
  return process.env.ACC_GOALS_DIR || path.join(root(), "runner", "goals");
}
function doneDir() {
  return path.join(goalsDir(), "done");
}

// A kick is only sent once the binding has had time to settle. SessionStart runs
// before the TUI is ready to accept input, so firing the instant a goal binds
// types into a console that is still starting up. Policy-overridable
// (`tui.readySettleMs`) and reused verbatim by watcher/clearbot.ps1's
// Get-TuiReadyMs for the /cd settle (guards OI-003) -- one proven number for
// "is this session's TUI ready for injected input yet" instead of two
// independently-guessed ones. Was `KICK_DELAY_MS = 4000` hardcoded here only;
// clearbot's own /cd settle separately guessed 1200 and that guess failed a
// real-token repro (OI-003, 2026-08-04) after already failing once with zero
// settle at all -- so this value now has exactly one source of truth.
const TUI_READY_MS_DEFAULT = 4000;
// One kick per goal per minute, whatever happens. A resume loop that somehow
// re-armed itself must not be able to machine-gun the console.
const KICK_COOLDOWN_MS = 60000;
// A turn that ends UNDER budget used to end the loop: nothing re-armed the
// kick, so an active goal sat dead until a human typed (observed twice on
// 2026-07-31, once for 18 minutes). These two windows are what make an
// under-budget turn end resume instead of stall. Both are policy dials
// (goals.kickSettleSeconds / goals.humanHoldMinutes); these are the fallbacks.
const KICK_SETTLE_MS_DEFAULT = 90_000;
// While Kyle is actively prompting this console, stay out of his way. The hold
// EXPIRES, so walking away mid-conversation still self-heals into autonomy.
const HUMAN_HOLD_MS_DEFAULT = 10 * 60_000;

const nowIso = () => new Date().toISOString();

function ensureDirs() {
  fs.mkdirSync(goalsDir(), { recursive: true });
  fs.mkdirSync(doneDir(), { recursive: true });
}

function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
}

function goalPath(id) {
  return path.join(goalsDir(), `${safeId(id)}.json`);
}

export function logPath(id) {
  return path.join(goalsDir(), `${safeId(id)}.log.md`);
}

// Ids are used to build file paths and are echoed into injected context, so they
// are constrained here rather than trusted from a caller.
function safeId(id) {
  return String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
}

function write(goal) {
  goal.updatedAt = nowIso();
  fs.writeFileSync(goalPath(goal.id), JSON.stringify(goal, null, 2) + "\n");
  return goal;
}

export function readGoal(id) {
  const g = readJson(goalPath(id), null);
  return g && g.id ? g : null;
}

export function listGoals() {
  try {
    return fs
      .readdirSync(goalsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(path.join(goalsDir(), f), null))
      .filter((g) => g && g.id);
  } catch {
    return [];
  }
}

export function activeGoals() {
  return listGoals().filter((g) => g.status === "active");
}

// Is that console still alive? A goal bound to a window Kyle has since closed
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

export function goalForSession(sessionId) {
  if (!sessionId) return null;
  return activeGoals().find((g) => g.sessionId === sessionId) || null;
}

export function createGoal({ text, cwd, profile }) {
  ensureDirs();
  const t = String(text || "").trim();
  if (!t) throw new Error("a goal needs text");
  const iso = new Date().toISOString(); // 2026-07-31T04:10:27.123Z
  const id =
    "g-" +
    iso.slice(0, 10).replace(/-/g, "") +
    "-" +
    iso.slice(11, 19).replace(/:/g, "") +
    "-" +
    Math.random().toString(36).slice(2, 6);
  const goal = {
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
  write(goal);
  fs.writeFileSync(
    logPath(id),
    `# Goal ${id}\n\n${t}\n\n- folder: ${goal.cwd || "(not set)"}\n- profile: ${goal.profile || "(default)"}\n- opened: ${goal.createdAt}\n\n## Progress\n\n`
  );
  return goal;
}

// Real Claude Code session ids are always UUIDs. bindSession is reachable by
// hand (piping a fake SessionStart payload into budget.mjs against live
// state), and a synthetic sessionId there would otherwise silently steal a
// live console's goal binding (OI-006, reproduced). A non-UUID sessionId is
// therefore treated exactly like none was passed at all.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Called from SessionStart. Two ways in:
//   - ACC_GOAL is set   -> the Command Center launched this session for that goal
//   - otherwise         -> adopt whatever active goal owns this console
// The second case is the one that survives a /clear, and it is deliberately not
// conditional on how the clear happened: a goal Kyle cleared by hand resumes the
// same way an auto-clear does.
export function bindSession({ sessionId, consolePid, cwd, goalId }) {
  ensureDirs();
  // guards OI-031, and it belongs HERE rather than at the SessionStart call site:
  // the fallback below adopts "whatever active goal owns this console pid", and
  // Windows recycles pids, so a stale goal is exactly what a fresh session would
  // inherit -- injecting last week's task into today's work. Six such goals were
  // live on 2026-08-04, the oldest from 07-31, every console long dead. Reaping
  // first means there is nothing stale left to adopt, and it keeps every rule
  // about what makes adoption unsafe in this one file, as the header promises.
  reapDeadGoals();
  let goal = goalId ? readGoal(goalId) : null;
  if (goal && goal.status !== "active") goal = null;
  if (!goal && consolePid) {
    goal = activeGoals().find((g) => Number(g.consolePid) === Number(consolePid)) || null;
  }
  if (!goal) return null;

  // A non-UUID id (garbage, or simply absent) never touches sessionId/
  // needsKick/boundAt below -- it is inert, not "no-op with side effects".
  const validId = sessionId && SESSION_ID_RE.test(String(sessionId)) ? sessionId : null;
  const fresh = validId !== null && goal.sessionId !== validId;
  if (validId !== null) goal.sessionId = validId;
  if (consolePid) goal.consolePid = Number(consolePid);
  if (!goal.cwd && cwd) goal.cwd = cwd;
  if (fresh) {
    // A new session for a live goal is exactly the state that needs a prompt
    // typed into it - whether this is the launch or the 4th resume.
    goal.needsKick = true;
    goal.boundAt = nowIso();
  }
  return write(goal);
}

export function appendCycle(id, { sessionId, ctx, text }) {
  const goal = readGoal(id);
  if (!goal) return null;
  goal.cycles = Number(goal.cycles || 0) + 1;
  write(goal);
  const body = String(text || "").trim().slice(0, 4000);
  try {
    fs.appendFileSync(
      logPath(id),
      `\n### Cycle ${goal.cycles} - ${nowIso()}\n` +
        `_session ${sessionId || "?"} ended at ${Math.round(Number(ctx || 0) / 1000)}k_\n\n` +
        (body || "_(no closing summary captured)_") +
        "\n"
    );
  } catch {}
  return goal;
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
  const goal = readGoal(id);
  if (!goal) return null;
  goal.status = status;
  goal.needsKick = false;
  if (why) goal.why = String(why).slice(0, 500);
  write(goal);
  if (status === "done" || status === "blocked" || status === "abandoned") {
    try {
      fs.appendFileSync(logPath(id), `\n### ${status.toUpperCase()} - ${nowIso()}\n${why || ""}\n`);
    } catch {}
    // Archive so the live directory only ever holds work in flight.
    try {
      ensureDirs();
      fs.renameSync(goalPath(id), path.join(doneDir(), `${safeId(id)}.json`));
      fs.renameSync(logPath(id), path.join(doneDir(), `${safeId(id)}.log.md`));
    } catch {}
  }
  return goal;
}

// guards OI-031. Nothing used to mark a goal dead when its console died, so the
// store only ever grew: six goals sat "active" from 2026-07-31 onward, every one
// bound to a console gone for days, and pendingKicks kept considering work
// nobody was doing. clearbot even LOGGED the deaths ("GUI-DEAD ... hosting GUI
// (pid 1620) is gone") and left the goals active - detection without reaping.
//
// "abandoned" is deliberately a third status, not done/blocked: the console went
// away, the model never finished. A ledger that cannot tell those apart cannot
// tell a completed loop from a lost one.
const REAP_GRACE_MS_DEFAULT = 120000;

export function reapDeadGoals({ now = Date.now(), graceMs = REAP_GRACE_MS_DEFAULT } = {}) {
  const reaped = [];
  for (const g of activeGoals()) {
    if (consoleAlive(g.consolePid)) continue;
    // Never bound: the GUI creates the goal and THEN launches the console, so
    // for a moment a healthy goal legitimately has no console. Reaping there
    // would kill the very launch the goal belongs to. A goal that HAS bound was
    // attached to a console that provably existed, so a dead pid now means that
    // console died - no grace applies.
    if (!g.boundAt) {
      const born = Date.parse(g.createdAt || "");
      if (Number.isFinite(born) && now - born < graceMs) continue;
    }
    setStatus(g.id, "abandoned", "console gone - reaped by reapDeadGoals");
    reaped.push(g.id);
  }
  return reaped;
}

// What clearbot asks for every cycle. Everything that makes a kick unsafe is
// decided HERE, in one place, so the watcher stays a dumb executor:
//   - goal must be active
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
  return activeGoals()
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

// Called from the Stop hook on every turn end of a goal session that did NOT go
// over budget (the over-budget path has its own clear/resume chain). This is the
// liveness trigger: it re-arms the kick, and pendingKicks() above decides when
// firing it is safe. `human` marks a turn Kyle prompted, which backs the kick
// off - see HUMAN_HOLD_MS_DEFAULT.
export function recordTurnEnd(id, { human } = {}) {
  const goal = readGoal(id);
  if (!goal || goal.status !== "active") return null;
  goal.needsKick = true;
  goal.turnEndedAt = nowIso();
  if (human) goal.humanPromptAt = nowIso();
  return write(goal);
}

export function markKicked(id) {
  const goal = readGoal(id);
  if (!goal) return null;
  goal.needsKick = false;
  goal.lastKickAt = nowIso();
  return write(goal);
}

// ------------------------------------------------------------- CLI

function arg(argv, name, dflt = "") {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}

// Goal text for `new`. --text-file exists because the caller that matters is the
// GUI, and the GUI's node shim strips double quotes and cannot pass a newline in
// a command line at all - so a multi-line goal typed in the box would arrive
// mangled or truncated. A file has neither problem.
export function textFromArgs(argv) {
  const file = arg(argv, "--text-file");
  if (file) return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return arg(argv, "--text");
}

// Positional id, falling back to the single active goal. Every command a MODEL
// is told to run takes an explicit id (SessionStart injects it), so this fallback
// only serves a human at a prompt.
function resolveId(argv) {
  const pos = argv.find((a) => /^g-/.test(a));
  if (pos) return pos;
  const act = activeGoals();
  return act.length === 1 ? act[0].id : "";
}

export function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "list";

  if (cmd === "new") {
    const g = createGoal({
      text: textFromArgs(argv),
      cwd: arg(argv, "--cwd"),
      profile: arg(argv, "--profile"),
    });
    console.log(JSON.stringify(g));
    return;
  }
  if (cmd === "list") {
    console.log(JSON.stringify(activeGoals(), null, 2));
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
        kickSettleSeconds: pol?.goals?.kickSettleSeconds,
        humanHoldMinutes: pol?.goals?.humanHoldMinutes,
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
  if (cmd === "reap") {
    const ids = reapDeadGoals();
    console.log(ids.length ? `reaped ${ids.length}: ${ids.join(" ")}` : "reaped 0");
    return;
  }
  if (cmd === "show") {
    const g = readGoal(resolveId(argv));
    console.log(g ? JSON.stringify(g, null, 2) : "no active goal");
    return;
  }
  if (cmd === "log") {
    const id = resolveId(argv);
    const text = arg(argv, "--text") || argv.slice(1).filter((a) => !/^g-/.test(a)).join(" ");
    const g = readGoal(id);
    if (!g) return console.log("no active goal");
    try {
      fs.appendFileSync(logPath(id), `\n- ${nowIso()} ${text}\n`);
    } catch {}
    console.log(`logged to ${logPath(id)}`);
    return;
  }
  if (cmd === "done" || cmd === "blocked" || cmd === "paused") {
    const id = resolveId(argv);
    if (!id) return console.log("no active goal (pass the id)");
    setStatus(id, cmd === "paused" ? "paused" : cmd, arg(argv, "--why"));
    console.log(`goal ${id} -> ${cmd}`);
    return;
  }
  console.log(
    "usage: goal.mjs new (--text T | --text-file F) [--cwd D] [--profile P] | list | show [id] | log [id] --text T | done [id] [--why W] | blocked [id] --why W | paused [id] | pending | kicked [id] | reap"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();

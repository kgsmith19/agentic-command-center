#!/usr/bin/env node
// Agentic Command Center - the MISSION store. This is what makes ACC able to carry
// a piece of work across a /clear instead of losing it.
//
// THE PROBLEM IT SOLVES: the auto-clear chain (Stop hook -> clear-request ->
// clearbot -> WriteConsoleInput types "/clear") worked, but it stopped there.
// The fresh session came up with an empty prompt and no idea what it had been
// doing, so a human had to retype the task. A mission survives the clear because it
// lives in a FILE, not in context.
//
// THE THREAD OF CONTINUITY IS THE CONSOLE PID, not the session id. A /clear ends
// the session id and starts a new one, but the terminal window - and therefore
// the console pid that clearbot types into - is the same process throughout. So
// a mission binds to a console, and every session that starts in that console
// adopts it.
//
// WHY THE TEXT NEVER TRAVELS AS KEYSTROKES: clearbot turns text into real key
// events, so a newline in a task would submit a fragment (this is OI-004). The
// mission text goes in this file; the only thing ever typed is a constant. That is
// also what lets a multi-line task work at all.
//
// Fails OPEN, like every other ACC hook helper: a broken mission store must cost
// auto-resume and nothing else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ACC_ROOT: see budget.mjs. Both must honour it or a test would split its state
// across two trees. Resolved on every call, not captured once at import: a
// test process that imports this module once and then runs many cases, each
// against its own ACC_ROOT/ACC_MISSIONS_DIR sandbox, needs every call to see
// whatever is current -- a module-load-time const would only ever see the
// first sandbox and silently leak state into every later one.
function root() {
  return process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.resolve(HERE, "..");
}
export function missionsDir() {
  return process.env.ACC_MISSIONS_DIR || path.join(root(), "runner", "missions");
}
function doneDir() {
  return path.join(missionsDir(), "done");
}
// Phase 1 (full-remediation-prompt.md): where reapCeilings writes a
// <id>.ceiling.json when a mission pauses at a ceiling, for statusline.mjs and
// budget.mjs to notice. Same env-override pattern as ACC_MISSIONS_DIR, for the
// same reason -- test hermeticity.
function alertsDir() {
  return process.env.ACC_ALERTS_DIR || path.join(root(), "runner", "alerts");
}

// A kick is only sent once the binding has had time to settle. SessionStart runs
// before the TUI is ready to accept input, so firing the instant a mission binds
// types into a console that is still starting up. Policy-overridable
// (`tui.readySettleMs`) and reused verbatim by watcher/clearbot.ps1's
// Get-TuiReadyMs for the /cd settle (guards OI-003) -- one proven number for
// "is this session's TUI ready for injected input yet" instead of two
// independently-guessed ones. Was `KICK_DELAY_MS = 4000` hardcoded here only;
// clearbot's own /cd settle separately guessed 1200 and that guess failed a
// real-token repro (OI-003, 2026-08-04) after already failing once with zero
// settle at all -- so this value now has exactly one source of truth.
const TUI_READY_MS_DEFAULT = 4000;
// One kick per mission per minute, whatever happens. A resume loop that somehow
// re-armed itself must not be able to machine-gun the console.
const KICK_COOLDOWN_MS = 60000;
// A turn that ends UNDER budget used to end the loop: nothing re-armed the
// kick, so an active mission sat dead until a human typed (observed twice on
// 2026-07-31, once for 18 minutes). These two windows are what make an
// under-budget turn end resume instead of stall. Both are policy dials
// (missions.kickSettleSeconds / missions.humanHoldMinutes); these are the fallbacks.
const KICK_SETTLE_MS_DEFAULT = 90_000;
// While Kyle is actively prompting this console, stay out of his way. The hold
// EXPIRES, so walking away mid-conversation still self-heals into autonomy.
const HUMAN_HOLD_MS_DEFAULT = 10 * 60_000;
// Phase 4 D3 (full-remediation-prompt.md): a kick clearbot BELIEVES it
// delivered (Send-Keys reported ok, markKicked ran) can still miss --
// TUI not actually ready despite the settle window, a dropped keystroke.
// Today nothing notices: needsKick stays false forever, no new cycle or
// turn-end ever arrives, and the mission silently strands until a human
// happens to look. If no sign of life (a turn-end AFTER the kick) shows up
// within this window, re-arm and let clearbot try again.
const KICK_STALE_MS_DEFAULT = 5 * 60_000;

const nowIso = () => new Date().toISOString();

function ensureDirs() {
  fs.mkdirSync(missionsDir(), { recursive: true });
  fs.mkdirSync(doneDir(), { recursive: true });
}

function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
}

function missionPath(id) {
  return path.join(missionsDir(), `${safeId(id)}.json`);
}

export function logPath(id) {
  return path.join(missionsDir(), `${safeId(id)}.log.md`);
}

// Ids are used to build file paths and are echoed into injected context, so they
// are constrained here rather than trusted from a caller.
function safeId(id) {
  return String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
}

// Phase 4 D2 (full-remediation-prompt.md): tmp+rename instead of a bare
// writeFileSync -- a reader (readMission, listMissions, or another process) must
// never be able to observe a half-written file (a crash or a concurrent
// read mid-write) and silently treat it as "no mission" or corrupt JSON. The
// rename is the atomic step; same pattern usage.mjs's scan cache already
// uses, now the second atomic write in the codebase rather than the only
// one.
function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function write(mission) {
  mission.updatedAt = nowIso();
  atomicWrite(missionPath(mission.id), JSON.stringify(mission, null, 2) + "\n");
  return mission;
}

// Phase 4 D2: every read-modify-write sequence below (bindSession,
// appendCycle, setStatus, recordTurnEnd, markKicked, resumeMission) was
// read-then-mutate-then-write with nothing serializing it across
// PROCESSES -- a concurrent write (clearbot's poll loop and a hook fire
// landing close together, or two hook fires) could read the same stale
// mission and one write's changes (lastKickAt, needsKick, turnEndedAt) would
// silently overwrite the other's. Same cross-process exclusive-file-create
// mutex kernel/ledger.mjs's withDecisionLock uses (OI-019), keyed per mission
// id rather than per run.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const LOCK_TIMEOUT_MS = Number(process.env.ACC_MISSION_LOCK_TIMEOUT_MS) || 3000;
const LOCK_STALE_MS = Number(process.env.ACC_MISSION_LOCK_STALE_MS) || 5000;

function withMissionLock(id, fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
  // Only the missions dir, not ensureDirs()'s full pair -- the lock file lives
  // alongside mission-<id>.json, and setStatus's own archive step (which DOES
  // need doneDir) already has its own try/catch for exactly a blocked/
  // unwritable done dir. Calling the broader ensureDirs() here would throw
  // BEFORE that established handling ever runs.
  fs.mkdirSync(missionsDir(), { recursive: true });
  const lockPath = missionPath(id) + ".lock";
  const start = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* lock vanished between the stat and here -- fine, loop retries */ }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`mission lock for ${id} still held after ${timeoutMs}ms`);
      }
      sleepSync(5 + Math.floor(Math.random() * 10));
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

export function readMission(id) {
  const g = readJson(missionPath(id), null);
  return g && g.id ? g : null;
}

// Phase 5 step 1 (full-remediation-prompt.md): readMission only ever finds a
// LIVE mission -- setStatus archives done/blocked/dead missions out of the live
// directory the instant they're set, so a caller that wants to know a
// mission's FINAL status (e.g. runner.mjs checking whether the model called
// `done`/`blocked` after a run) would see a false "not found" the moment
// the very state it's checking for is reached. Checks the archive too,
// once the live lookup misses.
export function readMissionAnywhere(id) {
  const live = readMission(id);
  if (live) return live;
  const g = readJson(path.join(doneDir(), `${safeId(id)}.json`), null);
  return g && g.id ? g : null;
}

export function listMissions() {
  try {
    return fs
      .readdirSync(missionsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(path.join(missionsDir(), f), null))
      .filter((g) => g && g.id);
  } catch {
    return [];
  }
}

// Is that console still alive? A mission bound to a window Kyle has since closed
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

// OI-031: left alone, an active mission whose console died just sits "active"
// forever - nothing ever marked it dead, so the store only grows and
// pendingKicks keeps re-checking missions no one can ever resume (found live:
// 7 "active" missions, oldest four days old, every consolePid gone). "dead"
// means BOUND (consolePid nonzero) and NOT alive; an unbound mission
// (consolePid 0 - created but not yet launched into a console) is left
// alone, since there is nothing yet to prove dead. Runs on every
// activeMissions() call rather than on a timer: cheap (one process.kill(pid,0)
// per active mission, same cost pendingKicks already pays), and it means every
// reader - list, pending, missionForSession - sees the reaped result
// immediately instead of a stale one.
// OI-034 (2026-08-06): a reboot (or crash, or power loss) leaves a dead
// mission's reap totally silent -- clean, not a zombie, but nothing ever told
// Kyle work was interrupted; he'd only notice by chance. This does NOT
// auto-resume anything (OI-034's own entry explains why not: unattended
// work resuming when he didn't ask for it is a real, separate risk this
// alert-only fix deliberately avoids) -- it only makes the interruption
// visible, the same way `.ceiling.json` already does for a paused mission.
// hooks/statusline.mjs shows it persistently; hooks/budget.mjs's
// deadMissionWarning() (SessionStart) surfaces it inline in chat once and
// clears it, since unlike a paused mission there is no "resume" command whose
// own success would clear it instead.
function writeDeadAlert(g, why) {
  try {
    fs.mkdirSync(alertsDir(), { recursive: true });
    fs.writeFileSync(
      path.join(alertsDir(), `${safeId(g.id)}.dead.json`),
      JSON.stringify({ id: g.id, text: g.text || "", why, at: nowIso() }, null, 2) + "\n"
    );
  } catch {}
}

// Read-and-clear: hooks/budget.mjs's SessionStart calls this once per
// session so a reboot-orphaned mission gets shown inline in chat exactly once,
// then stops repeating (unlike the ceiling alert, a dead mission has no
// "resume" command whose success would clear it instead -- this call IS
// the acknowledgement).
export function consumeDeadMissionAlerts() {
  let files;
  try {
    files = fs.readdirSync(alertsDir()).filter((f) => f.endsWith(".dead.json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const p = path.join(alertsDir(), f);
    const a = readJson(p, null);
    fs.rmSync(p, { force: true });
    if (a && a.id) out.push(a);
  }
  return out;
}

export function reapDeadMissions() {
  const reaped = [];
  for (const g of listMissions()) {
    if (g.status !== "active") continue;
    if (!g.consolePid || consoleAlive(g.consolePid)) continue;
    const why = `console pid ${g.consolePid} is gone (reaped)`;
    writeDeadAlert(g, why);
    setStatus(g.id, "dead", why);
    reaped.push(g.id);
  }
  return reaped;
}

export function activeMissions() {
  reapDeadMissions();
  return listMissions().filter((g) => g.status === "active");
}

export function missionForSession(sessionId) {
  if (!sessionId) return null;
  return activeMissions().find((g) => g.sessionId === sessionId) || null;
}

export function createMission({ text, cwd, profile }) {
  ensureDirs();
  const t = String(text || "").trim();
  if (!t) throw new Error("a mission needs text");
  const iso = new Date().toISOString(); // 2026-07-31T04:10:27.123Z
  const id =
    "m-" +
    iso.slice(0, 10).replace(/-/g, "") +
    "-" +
    iso.slice(11, 19).replace(/:/g, "") +
    "-" +
    Math.random().toString(36).slice(2, 6);
  const mission = {
    id,
    text: t,
    cwd: cwd || "",
    profile: profile || "",
    status: "active",
    consolePid: 0,
    sessionId: "",
    cycles: 0,
    totalCostUsd: 0,
    needsKick: false,
    boundAt: "",
    lastKickAt: "",
    turnEndedAt: "",
    humanPromptAt: "",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  write(mission);
  fs.writeFileSync(
    logPath(id),
    `# Mission ${id}\n\n${t}\n\n- folder: ${mission.cwd || "(not set)"}\n- profile: ${mission.profile || "(default)"}\n- opened: ${mission.createdAt}\n\n## Progress\n\n`
  );
  return mission;
}

// Real Claude Code session ids are always UUIDs. bindSession is reachable by
// hand (piping a fake SessionStart payload into budget.mjs against live
// state), and a synthetic sessionId there would otherwise silently steal a
// live console's mission binding (OI-006, reproduced). A non-UUID sessionId is
// therefore treated exactly like none was passed at all.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Called from SessionStart. Two ways in:
//   - ACC_MISSION is set   -> the Command Center launched this session for that mission
//   - otherwise         -> adopt whatever active mission owns this console
// The second case is the one that survives a /clear, and it is deliberately not
// conditional on how the clear happened: a mission Kyle cleared by hand resumes the
// same way an auto-clear does.
export function bindSession({ sessionId, consolePid, cwd, missionId }) {
  ensureDirs();
  // Discovery read, outside the lock: which mission (if any) this call is even
  // about. The mutation below re-reads INSIDE the lock rather than trusting
  // this snapshot, since another process could have changed it in between.
  let found = missionId ? readMission(missionId) : null;
  if (found && found.status !== "active") found = null;
  if (!found && consolePid) {
    found = activeMissions().find((g) => Number(g.consolePid) === Number(consolePid)) || null;
  }
  if (!found) return null;

  return withMissionLock(found.id, () => {
    const mission = readMission(found.id);
    if (!mission || mission.status !== "active") return null;

    // A non-UUID id (garbage, or simply absent) never touches sessionId/
    // needsKick/boundAt below -- it is inert, not "no-op with side effects".
    const validId = sessionId && SESSION_ID_RE.test(String(sessionId)) ? sessionId : null;
    const fresh = validId !== null && mission.sessionId !== validId;
    if (validId !== null) mission.sessionId = validId;
    if (consolePid) mission.consolePid = Number(consolePid);
    if (!mission.cwd && cwd) mission.cwd = cwd;
    if (fresh) {
      // A new session for a live mission is exactly the state that needs a prompt
      // typed into it - whether this is the launch or the 4th resume.
      mission.needsKick = true;
      mission.boundAt = nowIso();
    }
    return write(mission);
  });
}

export function appendCycle(id, { sessionId, ctx, text, costUsd }) {
  return withMissionLock(id, () => {
    const mission = readMission(id);
    if (!mission) return null;
    mission.cycles = Number(mission.cycles || 0) + 1;
    // Phase 1: real per-cycle cost (budget.mjs computes it via usage.mjs's
    // costOfTranscript before calling this), accumulated for the dollar
    // ceiling. Omitted/non-finite is treated as 0 -- an unpriced cycle must
    // never corrupt the running total into NaN.
    const add = Number.isFinite(costUsd) ? costUsd : 0;
    mission.totalCostUsd = Number(mission.totalCostUsd || 0) + add;
    write(mission);
    const body = String(text || "").trim().slice(0, 4000);
    try {
      fs.appendFileSync(
        logPath(id),
        `\n### Cycle ${mission.cycles} - ${nowIso()}\n` +
          `_session ${sessionId || "?"} ended at ${Math.round(Number(ctx || 0) / 1000)}k_\n\n` +
          (body || "_(no closing summary captured)_") +
          "\n"
      );
    } catch {}
    return mission;
  });
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
  return withMissionLock(id, () => {
    const mission = readMission(id);
    if (!mission) return null;
    mission.status = status;
    mission.needsKick = false;
    if (why) mission.why = String(why).slice(0, 500);
    write(mission);
    if (status === "done" || status === "blocked" || status === "dead") {
      try {
        fs.appendFileSync(logPath(id), `\n### ${status.toUpperCase()} - ${nowIso()}\n${why || ""}\n`);
      } catch {}
      // Archive so the live directory only ever holds work in flight.
      try {
        ensureDirs();
        fs.renameSync(missionPath(id), path.join(doneDir(), `${safeId(id)}.json`));
        fs.renameSync(logPath(id), path.join(doneDir(), `${safeId(id)}.log.md`));
      } catch {}
    }
    return mission;
  });
}

// What clearbot asks for every cycle. Everything that makes a kick unsafe is
// decided HERE, in one place, so the watcher stays a dumb executor:
//   - mission must be active
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
  return activeMissions()
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

// Phase 1 (full-remediation-prompt.md) -- the loop ceiling. policy.json's
// missions.maxCycles was still 0 (unbounded) after the original 08-02 design
// specified this exact mechanism and it was never shipped; "the single most
// evidence-backed fix in either review." 0/missing on any dial disables that
// dimension, which is what makes today's unbounded default reproduce exactly
// when every dial is left at 0 -- pure opt-in tightening, no behavior change
// until Kyle sets a real number.
export function ceilingReached(mission, now = Date.now(), dials = {}) {
  const maxCycles = Number(dials.maxCycles || 0);
  if (maxCycles > 0 && Number(mission.cycles || 0) >= maxCycles) {
    return { reached: true, dimension: "cycles", detail: `${mission.cycles}/${maxCycles} cycles` };
  }
  const maxWallClockMinutes = Number(dials.maxWallClockMinutes || 0);
  if (maxWallClockMinutes > 0) {
    const elapsedMin = (now - Date.parse(mission.createdAt)) / 60000;
    if (elapsedMin >= maxWallClockMinutes) {
      return { reached: true, dimension: "wallClock", detail: `${Math.round(elapsedMin)}/${maxWallClockMinutes} min` };
    }
  }
  const maxCostUsd = Number(dials.maxCostUsd || 0);
  if (maxCostUsd > 0 && Number(mission.totalCostUsd || 0) >= maxCostUsd) {
    return { reached: true, dimension: "cost", detail: `$${Number(mission.totalCostUsd).toFixed(2)}/$${maxCostUsd}` };
  }
  return { reached: false, dimension: null, detail: "" };
}

// Called at the top of the `pending` CLI, before pendingKicks -- a mission this
// call itself just paused must not be kicked by the SAME call, which is why
// this runs first rather than being folded into pendingKicks's own filters.
export function reapCeilings(now = Date.now(), dials = {}) {
  const paused = [];
  for (const g of activeMissions()) {
    const verdict = ceilingReached(g, now, dials);
    if (!verdict.reached) continue;
    setStatus(g.id, "paused", `CEILING REACHED: ${verdict.dimension} (${verdict.detail})`);
    try {
      fs.mkdirSync(alertsDir(), { recursive: true });
      fs.writeFileSync(
        path.join(alertsDir(), `${safeId(g.id)}.ceiling.json`),
        JSON.stringify({ id: g.id, dimension: verdict.dimension, detail: verdict.detail, at: nowIso() }, null, 2) + "\n"
      );
    } catch {}
    paused.push(g.id);
  }
  return paused;
}

// Phase 4 D3: a kick clearbot believes it delivered but the TUI silently
// missed. "Sign of life" is a turn-end recorded AFTER the kick was sent --
// recordTurnEnd fires on every under-budget Stop, so if the kick actually
// landed, one should show up well within the stale window. No sign of life
// past that window means the kick missed; re-arm rather than strand the
// mission until a human notices.
export function reapStaleKicks(now = Date.now(), dials = {}) {
  const staleMs = (Number(dials.kickStaleMinutes) || 0) * 60000 || KICK_STALE_MS_DEFAULT;
  const rearmed = [];
  for (const g of activeMissions()) {
    if (g.needsKick || !g.lastKickAt) continue;
    if (now - Date.parse(g.lastKickAt) < staleMs) continue;
    const sawLifeSinceKick = g.turnEndedAt && Date.parse(g.turnEndedAt) > Date.parse(g.lastKickAt);
    if (sawLifeSinceKick) continue;
    withMissionLock(g.id, () => {
      // Re-verify inside the lock: another process may have already
      // re-armed it, recorded a fresh turn-end, or moved it off "active"
      // in the time between the scan above and acquiring this lock.
      const fresh = readMission(g.id);
      if (!fresh || fresh.status !== "active" || fresh.needsKick || !fresh.lastKickAt) return;
      if (now - Date.parse(fresh.lastKickAt) < staleMs) return;
      const freshSawLife = fresh.turnEndedAt && Date.parse(fresh.turnEndedAt) > Date.parse(fresh.lastKickAt);
      if (freshSawLife) return;
      fresh.needsKick = true;
      write(fresh);
      rearmed.push(fresh.id);
    });
  }
  return rearmed;
}

// The `resume`/`unpause` CLI verb's implementation. Only a genuinely paused
// mission can be resumed -- resuming an active mission (or a nonexistent id) is
// refused rather than silently no-op'd, so a caller can tell success from
// "there was nothing to do".
export function resumeMission(id) {
  return withMissionLock(id, () => {
    const mission = readMission(id);
    if (!mission || mission.status !== "paused") return null;
    mission.status = "active";
    mission.needsKick = true;
    mission.why = "";
    write(mission);
    try {
      fs.rmSync(path.join(alertsDir(), `${safeId(id)}.ceiling.json`), { force: true });
    } catch {}
    return mission;
  });
}

// Called from the Stop hook on every turn end of a mission session that did NOT go
// over budget (the over-budget path has its own clear/resume chain). This is the
// liveness trigger: it re-arms the kick, and pendingKicks() above decides when
// firing it is safe. `human` marks a turn Kyle prompted, which backs the kick
// off - see HUMAN_HOLD_MS_DEFAULT.
export function recordTurnEnd(id, { human } = {}) {
  return withMissionLock(id, () => {
    const mission = readMission(id);
    if (!mission || mission.status !== "active") return null;
    mission.needsKick = true;
    mission.turnEndedAt = nowIso();
    if (human) mission.humanPromptAt = nowIso();
    return write(mission);
  });
}

export function markKicked(id) {
  return withMissionLock(id, () => {
    const mission = readMission(id);
    if (!mission) return null;
    mission.needsKick = false;
    mission.lastKickAt = nowIso();
    return write(mission);
  });
}

// ------------------------------------------------------------- CLI

function arg(argv, name, dflt = "") {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}

// Mission text for `new`. --text-file exists because the caller that matters is the
// GUI, and the GUI's node shim strips double quotes and cannot pass a newline in
// a command line at all - so a multi-line mission typed in the box would arrive
// mangled or truncated. A file has neither problem.
export function textFromArgs(argv) {
  const file = arg(argv, "--text-file");
  if (file) return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return arg(argv, "--text");
}

// Positional id, falling back to the single active mission. Every command a MODEL
// is told to run takes an explicit id (SessionStart injects it), so this fallback
// only serves a human at a prompt.
function resolveId(argv) {
  const pos = argv.find((a) => /^m-/.test(a));
  if (pos) return pos;
  const act = activeMissions();
  return act.length === 1 ? act[0].id : "";
}

export function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "list";

  if (cmd === "new") {
    const g = createMission({
      text: textFromArgs(argv),
      cwd: arg(argv, "--cwd"),
      profile: arg(argv, "--profile"),
    });
    console.log(JSON.stringify(g));
    return;
  }
  if (cmd === "list") {
    console.log(JSON.stringify(activeMissions(), null, 2));
    return;
  }
  if (cmd === "reap") {
    console.log(JSON.stringify(reapDeadMissions()));
    return;
  }
  if (cmd === "pending") {
    // Dials live in policy.json so they can be tuned without a restart; a
    // missing or broken policy just uses the defaults (fail open).
    let dials = {};
    let ceilingDials = {};
    try {
      const pol = JSON.parse(
        fs.readFileSync(process.env.ACC_POLICY || path.join(root(), "policy.json"), "utf8")
      );
      dials = {
        kickSettleSeconds: pol?.missions?.kickSettleSeconds,
        humanHoldMinutes: pol?.missions?.humanHoldMinutes,
        tuiReadySettleMs: pol?.tui?.readySettleMs,
        kickStaleMinutes: pol?.missions?.kickStaleMinutes,
      };
      ceilingDials = {
        maxCycles: pol?.missions?.maxCycles,
        maxWallClockMinutes: pol?.missions?.maxWallClockMinutes,
        maxCostUsd: pol?.missions?.maxCostUsd,
      };
    } catch {}
    // Phase 1: a mission THIS SAME call just paused must not be kicked below --
    // reap runs first, so pendingKicks's activeMissions() read never sees it.
    reapCeilings(Date.now(), ceilingDials);
    // Phase 4 D3: same ordering logic -- a mission re-armed THIS call must be
    // picked up by pendingKicks below, not wait for the next poll.
    reapStaleKicks(Date.now(), dials);
    console.log(JSON.stringify(pendingKicks(Date.now(), dials)));
    return;
  }
  if (cmd === "resume") {
    const id = resolveId(argv);
    const g = id ? resumeMission(id) : null;
    console.log(g ? `mission ${id} -> active` : `mission ${id || "(no id given)"} could not be resumed (not paused, or does not exist)`);
    return;
  }
  if (cmd === "kicked") {
    markKicked(resolveId(argv));
    return;
  }
  if (cmd === "show") {
    const g = readMission(resolveId(argv));
    console.log(g ? JSON.stringify(g, null, 2) : "no active mission");
    return;
  }
  if (cmd === "log") {
    const id = resolveId(argv);
    const text = arg(argv, "--text") || argv.slice(1).filter((a) => !/^m-/.test(a)).join(" ");
    const g = readMission(id);
    if (!g) return console.log("no active mission");
    try {
      fs.appendFileSync(logPath(id), `\n- ${nowIso()} ${text}\n`);
    } catch {}
    console.log(`logged to ${logPath(id)}`);
    return;
  }
  if (cmd === "done" || cmd === "blocked" || cmd === "paused") {
    const id = resolveId(argv);
    if (!id) return console.log("no active mission (pass the id)");
    setStatus(id, cmd === "paused" ? "paused" : cmd, arg(argv, "--why"));
    console.log(`mission ${id} -> ${cmd}`);
    return;
  }
  console.log(
    "usage: mission.mjs new (--text T | --text-file F) [--cwd D] [--profile P] | list | show [id] | log [id] --text T | done [id] [--why W] | blocked [id] --why W | paused [id] | resume [id] | pending | kicked [id] | reap"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();

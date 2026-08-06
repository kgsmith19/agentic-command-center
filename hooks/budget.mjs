#!/usr/bin/env node
// Agentic Command Center - context budget, waiting guard, subagent allowlist.
// One hook binary, dispatched by hook_event_name:
//   SessionStart     log start context, inject the budget line
//   UserPromptSubmit warn at softK
//   Stop             block ONCE at hardK to force a checkpoint; waiting guard
//   PreToolUse/Agent enforce the subagent allowlist and the kill switch
// Fails OPEN on any internal error: a broken budget hook must never wedge a
// session. Guard enforcement (guard.mjs) is the thing that fails closed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPolicy, contextOf, startContextOf, applyProfile, ptyAnchorPid, ancestorChain, costOfTranscript, accActive } from "./usage.mjs";
import { bindSession, appendCycle, logTail, missionForSession, recordTurnEnd, readMission, listMissions, consumeDeadMissionAlerts } from "./mission.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ACC_ROOT redirects every runner/ path (state, logs, missions, clear-requests) at a
// throwaway tree. It exists so the tests can exercise THIS file instead of a
// copy: a test that reset the live runner/state would delete the .window files
// running sessions depend on, which is precisely how auto-clear died once.
const ROOT = process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.resolve(HERE, "..");
const STATE = path.join(ROOT, "runner", "state");
const LOGS = path.join(ROOT, "runner", "logs");
const CLEARREQ = path.join(ROOT, "runner", "clear-requests");
const MISSIONSDIR = path.join(ROOT, "runner", "missions");
const QUEUEDIR = path.join(ROOT, "runner", "queued");
const HEADLESS = process.env.CLAUDE_CODE_RUNNER === "1";

const K = (n) => Math.round(n / 1000) + "k";

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function ensureDirs() {
  for (const d of [STATE, LOGS, CLEARREQ]) fs.mkdirSync(d, { recursive: true });
}

// Record which terminal window this session lives in, so clearbot.ps1 can type
// /clear into THAT window and nothing else. Runs once, at SessionStart. Failing
// here only costs auto-clear; the session is unaffected (hooks fail open).
function captureWindow(sid) {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "winfind.ps1"),
       "-FromPid", String(process.pid)],
      { encoding: "utf8", timeout: 15000, windowsHide: true }
    );
    const w = JSON.parse(String(out).trim());
    // consolePid is the whole requirement - see winfind.ps1. hwnd is recorded for
    // diagnostics only; gating on it is what made auto-clear fail silently.
    if (w && w.ok && w.consolePid) {
      fs.writeFileSync(statePath(sid, "window"), JSON.stringify(w));
      return w;
    }
  } catch {}
  return null;
}

// The whole auto-clear chain is dead if the watcher process is not up, and it
// fails SILENTLY (the request file just sits there). So every interactive session
// start makes sure it is running. Fire-and-forget: detached, never waited on, so
// it cannot slow the session down or wedge it if PowerShell is unhappy.
function ensureClearbot() {
  try {
    // A deliberate stop must STICK. start-clearbot.cmd removes the stop file, so
    // without this check every new session would silently re-arm a watcher Kyle
    // had turned off on purpose.
    if (fs.existsSync(path.join(ROOT, "watcher", "clearbot.stop"))) return;
    const cmd = path.join(ROOT, "watcher", "start-clearbot.cmd");
    if (!fs.existsSync(cmd)) return;
    const child = spawn("cmd.exe", ["/c", cmd], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

// SELF-HEALING (guards OI-007): the watcher is the only thing that can clear or
// resume a session, and when it dies the mission loop dies silently with it. A
// turn boundary is exactly where that matters, so check there: one stat, and
// ensureClearbot() is idempotent (start-clearbot.cmd no-ops when a watcher is
// already up) and still honours the deliberate kill switch. A MISSING heartbeat
// counts as dead here - unlike the status line, which stays quiet rather than
// crying wolf, this path only costs a no-op start.
const HEARTBEAT_STALE_MS = 30_000;
function reviveClearbotIfDead(policy) {
  try {
    if (policy.autoClear?.enabled === false) return;
    let stale = true;
    try {
      stale = Date.now() - fs.statSync(path.join(ROOT, "watcher", "clearbot.heartbeat")).mtimeMs > HEARTBEAT_STALE_MS;
    } catch {
      stale = true;
    }
    if (stale) ensureClearbot();
  } catch {}
}

// Ask the outside watcher to type /clear. Written at the Stop hook, i.e. a turn
// boundary with an idle prompt - never mid-turn.
function requestClear(p, policy, ctx) {
  try {
    const w = readJson(statePath(p.session_id, "window"), null);
    if (!w || !w.consolePid) return false;
    atomicWrite(
      path.join(CLEARREQ, `${String(p.session_id).slice(0, 40)}.json`),
      JSON.stringify({
        sessionId: p.session_id,
        hwnd: w.hwnd,
        consolePid: w.consolePid || 0,
        title: w.title || "",
        transcript: p.transcript_path || "",
        ctx,
        hardK: policy.context.hardK,
        ts: new Date().toISOString(),
      })
    );
    return true;
  } catch {
    return false;
  }
}

export function statePath(sid, suffix) {
  return path.join(STATE, `${String(sid || "unknown").slice(0, 40)}.${suffix}`);
}

export function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
}

// Phase 4 D2 (full-remediation-prompt.md): tmp+rename instead of a bare
// writeFileSync -- a reader must never observe a half-written tier.json or
// clear-request file (a crash mid-write, or a concurrent read) and silently
// treat it as corrupt/missing. Same pattern hooks/mission.mjs's write() and
// usage.mjs's scan cache already use.
export function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Lean review (2026-08-06): reserveAgentSlot's read-modify-write was
// unserialized across PROCESSES -- two PreToolUse/Agent hook fires from the
// same turn's parallel Agent tool calls could both read the same stale n and
// both pass a cap check that should only pass once, silently over-granting
// the subagent cap and under-reporting the persisted counter afterward. Same
// cross-process exclusive-file-create mutex hooks/mission.mjs's withMissionLock
// uses (itself closing the identical class of bug for appendCycle) --
// duplicated locally rather than imported, matching this file's existing
// convention of its own statePath/readJson/atomicWrite rather than reaching
// into mission.mjs for file-IO primitives mission.mjs happens to also have.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const LOCK_TIMEOUT_MS = Number(process.env.ACC_AGENTS_LOCK_TIMEOUT_MS) || 3000;
const LOCK_STALE_MS = Number(process.env.ACC_AGENTS_LOCK_STALE_MS) || 5000;

function withStateLock(lockPath, fn) {
  const start = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* lock vanished between the stat and here — fine, loop retries */ }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`agents-slot lock for ${lockPath} still held after ${LOCK_TIMEOUT_MS}ms`);
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

// The per-session subagent spawn cap's whole critical section: read the
// current count, decide against cap, persist if granted. Exported so it can
// be exercised directly (mission.test.mjs's own technique for proving a lock
// closes a race: many separate node PROCESSES, not in-process concurrency,
// since synchronous JS in one process cannot race itself).
export function reserveAgentSlot(sessionId, cap) {
  ensureDirs();
  const cnt = statePath(sessionId, "agents");
  return withStateLock(`${cnt}.lock`, () => {
    const n = Number(readJson(cnt, { n: 0 }).n || 0) + 1;
    if (n > cap) return { allowed: false, n: n - 1 };
    fs.writeFileSync(cnt, JSON.stringify({ n }));
    return { allowed: true, n };
  });
}

// Spending tab (design spec 2026-08-06-acc-gui-remaining-tabs-design.md §5):
// exported so hooks/status.mjs can call this directly instead of a THIRD
// duplicate of the same Win32_Process scan (budget.mjs's CLI already has one,
// guards-gui.ps1's Refresh-Clearbot is the second). `running: null` (not `0`
// or a thrown error) is the honest answer on a host with no `powershell` --
// previously this whole CLI command produced NO output at all on such a
// host: execFileSync threw ENOENT, main()'s outer catch swallowed it silent
// and fail-open (by design, for the hook-dispatch paths), which for a CLI
// helper meant losing the pending-count/kill-switch fields too, not just the
// unreachable process count.
export function clearbotStatus() {
  ensureDirs();
  const stop = path.join(ROOT, "watcher", "clearbot.stop");
  let running = null;
  try {
    running = Number(
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command",
         // must exclude the probe's own command line, which also contains the
         // pattern - otherwise this always reports "running".
         "$me=$PID; @(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
         "Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*clearbot.ps1*' }).Count"],
        { encoding: "utf8", timeout: 15000, windowsHide: true }
      ).trim()
    );
  } catch {
    running = null;
  }
  return {
    running,
    killSwitchEngaged: fs.existsSync(stop),
    pending: fs.readdirSync(CLEARREQ).filter((f) => f.endsWith(".json")),
    log: path.join(ROOT, "watcher", "clearbot.log"),
  };
}

// ------------------------------------------------------------- hook output

// UserPromptSubmit / SessionStart: inject text into the session.
function inject(event, text) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })
  );
  process.exit(0);
}

// Stop: force the model to keep going with an instruction.
function blockStop(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

// PreToolUse: deny. exit 2 + stderr is the contract guard.mjs already uses.
function deny(msg) {
  process.stderr.write(msg);
  process.exit(2);
}

const allow = () => process.exit(0);

// ------------------------------------------------------------- kill switch

// Rolling-7-day tier without re-scanning every project on every hook fire:
// cached for 10 minutes in state/tier.json.
export function weekTier(policy) {
  const red = policy.week.redTokens || 0;
  const amber = policy.week.amberTokens || 0;
  if (!red && !amber) return { tier: "green", weekTokens: 0, pct: 0 };
  const cacheFile = path.join(STATE, "tier.json");
  const cached = readJson(cacheFile, null);
  if (cached && Date.now() - cached.ts < 6e5) return cached;
  let weekTokens = 0;
  try {
    // The rolling window must not reach back past the day the discipline landed.
    // Without this the tier fires RETROACTIVELY on pre-ACC burn: the measured
    // baseline week was 2.35B against a 1.8B red line, so arming the switch put
    // it instantly at 131% of red and would have stopped the runner and blocked
    // subagents for work that had not happened yet. Reporting (usage.mjs week)
    // still shows the true rolling 7 days - this bound is for the TIER only.
    const from = Date.parse(policy.week.effectiveFrom || "") || 0;
    const since = Math.max(Date.now() - 7 * 864e5, from);
    weekTokens = scanWeek(since);
  } catch {
    return { tier: "green", weekTokens: 0, pct: 0 };
  }
  const tier = red && weekTokens >= red ? "red" : amber && weekTokens >= amber ? "amber" : "green";
  const out = { tier, weekTokens, pct: red ? (weekTokens / red) * 100 : 0, ts: Date.now() };
  try {
    atomicWrite(cacheFile, JSON.stringify(out));
  } catch {}
  return out;
}

// Minimal week scan (kept here so the hook does not pull the whole report path).
export function scanWeek(since) {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let total = 0;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".jsonl")) {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (st.mtimeMs < since) continue;
        for (const line of fs.readFileSync(p, "utf8").split("\n")) {
          if (!line || line.charCodeAt(0) !== 123) continue;
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          const u = o.type === "assistant" && o.message && o.message.usage;
          if (!u) continue;
          if (o.timestamp && Date.parse(o.timestamp) < since) continue;
          total +=
            (u.input_tokens || 0) +
            (u.cache_creation_input_tokens || 0) +
            (u.cache_read_input_tokens || 0) +
            (u.output_tokens || 0);
        }
      }
    }
  };
  walk(projects, 0);
  return total;
}

export function stopRunner(policy) {
  if (!policy.runner.stopOnRed) return;
  try {
    const stopDir = path.join(ROOT, "runner", "stop");
    fs.mkdirSync(stopDir, { recursive: true });
    fs.writeFileSync(path.join(stopDir, "slice-runner.stop"), `red tier ${new Date().toISOString()}\n`);
  } catch {}
}

// ------------------------------------------------------------- transcript

export function lastAssistantText(transcript) {
  let out = "";
  try {
    const lines = fs.readFileSync(transcript, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l || l.charCodeAt(0) !== 123) continue;
      let o;
      try {
        o = JSON.parse(l);
      } catch {
        continue;
      }
      if (o.type !== "assistant" || o.isSidechain || !o.message) continue;
      const c = o.message.content;
      if (Array.isArray(c)) out = c.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (out.trim()) return out;
    }
  } catch {}
  return out;
}

// The last USER message of a transcript. Used only to tell a machine
// continuation from something Kyle typed - see KICK_CONSTANTS.
export function lastUserText(transcript) {
  let last = "";
  try {
    for (const l of fs.readFileSync(transcript, "utf8").split("\n")) {
      if (!l || l.charCodeAt(0) !== 123) continue;
      let o;
      try {
        o = JSON.parse(l);
      } catch {
        continue;
      }
      if (o.type !== "user" || o.isSidechain || !o.message) continue;
      const c = o.message.content;
      last = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.filter((b) => b && b.type === "text").map((b) => b.text).join("")
          : "";
    }
  } catch {}
  return String(last || "").trim();
}

// Exactly the constants clearbot types (watcher/clearbot.ps1 $KICK and
// $QUEUEKICK). Anything else came from a human, so the kick backs off.
const KICK_CONSTANTS = ["Continue the active ACC mission.", "Run the queued prompt."];

// ------------------------------------------------------------- handlers

// Bind this session to the mission that owns its console (or the one the Command
// Center launched it for) and hand the model everything it needs to carry on
// without a human retyping anything.
//
// THE LOOP ONLY ENDS BECAUSE THE MODEL ENDS IT. Nothing else can tell whether
// the work is finished, so the two exit commands are stated as the last thing in
// the block, in full, with the id already substituted - there is no id to look
// up and no ambiguity about what "done" means.
// Phase 1: bindSession only finds ACTIVE missions, so a mission paused at a
// ceiling produces no mission context at all -- silently, from this session's
// point of view, since it never got as far as being told why. This is the
// definition-of-done's explicit ask: warn instead of saying nothing.
// Checked by ACC_MISSION first (a fresh launch aimed straight at a specific
// mission), then by consolePid (the resume-after-clear path, since a paused
// mission keeps the consolePid it had when it paused).
export function pausedMissionWarning(p, win) {
  const wanted = process.env.ACC_MISSION || "";
  const pid = win && win.consolePid;
  const paused = listMissions().find(
    (g) => g.status === "paused" && (wanted ? g.id === wanted : pid && Number(g.consolePid) === Number(pid))
  );
  if (!paused) return "";
  return `[ACC MISSION ${paused.id}] PAUSED at a ceiling (${paused.why || "reason not recorded"}). This session was NOT resumed for it. Review the mission (\`node C:/code/guards/hooks/mission.mjs show ${paused.id}\`) and, if the work should continue, run \`node C:/code/guards/hooks/mission.mjs resume ${paused.id}\`.`;
}

// OI-034: a mission reaped as dead (its bound console gone — a reboot, a
// crash, power loss) does NOT auto-resume (see that entry for why not);
// it just stopped silently until now. Unlike pausedMissionWarning, this is
// NOT scoped to the current session's own consolePid — the dead mission's
// pid is, definitionally, gone, so there is no "this session" it could
// still match. Shown to whichever session starts next, then consumed
// (deleted) so it never repeats — there is no "resume" command whose
// success would clear it the way a paused mission's alert clears itself.
export function deadMissionWarning() {
  let alerts;
  try {
    alerts = consumeDeadMissionAlerts();
  } catch {
    return "";
  }
  if (!alerts.length) return "";
  return alerts
    .map(
      (a) =>
        `[ACC MISSION ${a.id}] DIED — its console went away (${a.why || "reason not recorded"}), most likely a reboot or crash. Work was interrupted and NOT auto-resumed. Review it (\`node C:/code/guards/hooks/mission.mjs show ${a.id}\`) and start a fresh mission if it should continue: the old one is archived, not resumable.`
    )
    .join("\n");
}

export function missionContext(p, win, policy) {
  const mission = bindSession({
    sessionId: p.session_id,
    consolePid: win && win.consolePid,
    cwd: p.cwd,
    missionId: process.env.ACC_MISSION || "",
  });
  if (!mission) return "";

  const cycle = Number(mission.cycles || 0);
  const head =
    cycle === 0
      ? `[ACC MISSION ${mission.id}] The Command Center started this session to do the following. Begin work on it now.`
      : `[ACC MISSION ${mission.id}] RESUMED - this is continuation ${cycle + 1}. The previous session hit the context budget and was cleared; you are the same work, not a new task. Pick up where the progress log stops.`;

  const parts = [head, "", mission.text, ""];
  if (mission.cwd) parts.push(`Working folder: ${mission.cwd}`);
  if (cycle > 0) {
    parts.push(
      "",
      `Progress so far (from ${path.join(MISSIONSDIR, mission.id + ".log.md")}, most recent last):`,
      "",
      logTail(mission.id, 3000).trim()
    );
  }
  parts.push(
    "",
    `[ACC MISSION] How this ends. When the budget is reached you will be told to checkpoint; do that and stop, and the Command Center clears and resumes you automatically. Do NOT stop early, do NOT ask whether to continue, and do NOT treat a clear as the end of the work.`,
    `  - finished, everything verified:  node C:/code/guards/hooks/mission.mjs done ${mission.id}`,
    `  - genuinely blocked on a human:   node C:/code/guards/hooks/mission.mjs blocked ${mission.id} --why "<one line>"`,
    `Until one of those runs, ACC will keep resuming this mission after every clear.`
  );
  return parts.join("\n");
}

// A prompt that route.mjs could not hand back as keystrokes - multi-line, or
// longer than the injector's limit. It travels as a FILE keyed by console pid
// (the same thread of continuity missions use, because the session id dies with the
// clear) and is injected here, into the session that comes up after the clear.
//
// Consumed once: the file is deleted as it is read, so a queued prompt can never
// re-run on a later clear. Deleting BEFORE returning is deliberate - if the
// injection is lost, the cost is one retyped prompt, whereas a file that
// survives is a prompt that fires again out of nowhere.
export function queuedPromptContext(win) {
  const cpid = win && win.consolePid;
  if (!cpid) return "";
  const f = path.join(QUEUEDIR, `${cpid}.md`);
  let text = "";
  try {
    text = fs.readFileSync(f, "utf8").replace(/^﻿/, "").trim();
  } catch {
    return "";
  }
  try { fs.unlinkSync(f); } catch {}
  if (!text) return "";
  return [
    "[ACC route] This session was just re-scoped to this folder for the prompt below,",
    "which was too long or too many lines to type back into the console. It is the",
    "prompt you were asked to run - treat it exactly as if it had just been typed.",
    "",
    text,
  ].join("\n");
}

function onSessionStart(p, policy) {
  ensureDirs();
  const start = p.transcript_path ? startContextOf(p.transcript_path) : 0;
  try {
    fs.appendFileSync(
      path.join(LOGS, "context.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        sessionId: p.session_id,
        startContext: start,
        headless: HEADLESS,
        cwd: p.cwd,
      }) + "\n"
    );
  } catch {}
  // Interactive only: learn which terminal window to type /clear into later.
  let win = null;
  // A capture that blips must not cost the session its mission or its queued
  // prompt: both are addressed by console pid, and a previously recorded one is
  // still the right console. Fall back to what was written last time.
  if (!HEADLESS) {
    // An ACC-hosted pty session has no HWND to find: the GUI is the terminal.
    // The persistent process across /clear (what consolePid means to mission
    // binding) is the claude process - NOT this hook's raw parent, which is a
    // transient bash/cmd wrapper that dies with the turn (recording it gave
    // clearbot a dead pid: consolePid 80480 GONE while claude.exe 70152 lived).
    if (process.env.ACC_PTY) {
      const chain = ancestorChain();
      win = { ok: true, hwnd: 0,
              consolePid: chain.length ? ptyAnchorPid(chain) : process.ppid,
              transport: "pty",
              pipe: process.env.ACC_PTY, title: "acc-pty" };
      try { fs.writeFileSync(statePath(p.session_id, "window"), JSON.stringify(win)); } catch {}
    } else {
      win = captureWindow(p.session_id) || readJson(statePath(p.session_id, "window"), null);
    }
    if (policy.autoClear?.enabled !== false) ensureClearbot();
  }
  // Record the status file's mtime so the Stop waiting-guard can tell whether
  // this run actually checkpointed.
  try {
    const sf = path.join(p.cwd || process.cwd(), policy.runner.statusFile);
    fs.writeFileSync(statePath(p.session_id, "start"), JSON.stringify({ mtime: fs.statSync(sf).mtimeMs, sf }));
  } catch {}

  // Warm the tier cache so the status line shows "wk %" from the first prompt
  // of a session, not only after the first UserPromptSubmit refresh.
  try { weekTier(policy); } catch {}

  const { hardK, softK } = policy.context;
  const lines = [];
  if (policy.activeProfile) {
    lines.push(
      `[ACC] Profile: ${policy.activeProfile} (launched from the Command Center). Its subagent rules apply to this session; the context budget comes from the Process-tab dials.`
    );
  }
  // A mission is what makes this session a continuation rather than a fresh start.
  // It is adopted by CONSOLE, so this fires identically on the launch and on
  // every session that comes up after a /clear. Failing here costs auto-resume
  // and nothing else - hooks fail open.
  try {
    const mission = missionContext(p, win, policy);
    if (mission) lines.push(mission);
    else {
      const paused = pausedMissionWarning(p, win);
      if (paused) lines.push(paused);
    }
  } catch {}
  // OI-034: independent of the mission/paused check above — a dead mission has
  // no consolePid left to match against THIS session, so it can't be
  // folded into that if/else the way paused is.
  try {
    const died = deadMissionWarning();
    if (died) lines.push(died);
  } catch {}
  try {
    const queued = queuedPromptContext(win);
    if (queued) lines.push(queued);
  } catch {}

  // If the watcher is down, this session has no auto-clear and no auto-resume.
  // Say it once, at the top, instead of letting the mission loop fail silently.
  try {
    const hb = path.join(ROOT, "watcher", "clearbot.heartbeat");
    if (Date.now() - fs.statSync(hb).mtimeMs > 30_000) {
      lines.push(
        `[ACC] WARNING: the clearbot watcher looks DEAD (stale heartbeat). Auto-clear and auto-resume will NOT fire, so this session will not be continued for you. Start it: guards\\watcher\\start-clearbot.cmd`
      );
    }
  } catch {}

  lines.push(
    ...[
    `[ACC] Context budget: soft ${softK}k, hard ${hardK}k. Context is checked after EVERY tool call; past ${hardK}k you will be told to checkpoint and end the turn, and the Stop hook enforces it.`,
    `[ACC] Subagents: allowlist ${JSON.stringify(policy.subagents.allow)}; implementation work goes to a runner session, not a subagent. Explore reports are capped at ${policy.subagents.exploreMaxReportLines} lines, structural only, no file dumps.`,
    `[ACC] Reviews: /diff-review-kgs and /sec-diff-kgs are the default checks (main thread, no fan-out). /lean-review-kgs is ${policy.review.fullLeanReview}.`,
    ]
  );
  inject("SessionStart", lines.join("\n"));
}

function onUserPromptSubmit(p, policy) {
  // Keep state/tier.json warm for the status line. weekTier() is otherwise only
  // called on the subagent-spawn path, and subagents are allowlisted down to
  // Explore - so the cache was almost never written and the status line silently
  // dropped its "wk %" segment. Must run BEFORE the early allow() below, which
  // exits the process. The 10-minute cache means the real scan runs at most once
  // per 10 min, not once per prompt.
  try { weekTier(policy); } catch {}
  if (!p.transcript_path) allow();
  const ctx = contextOf(p.transcript_path);
  const { softK, hardK } = policy.context;
  if (ctx < softK * 1000) allow();
  inject(
    "UserPromptSubmit",
    `[ACC ctx ${K(ctx)}/${hardK}k] Approaching the context budget. Finish the unit of work you are on; do not start new work. Keep detail in scratchpad files, not in context.`
  );
}

// The continuous watcher. Stop only fires at turn boundaries and
// UserPromptSubmit only when the operator types, so a long autonomous stretch
// (tool call after tool call, no turn end) can sail far past the ceiling with
// nothing checking - exactly how a session reached 178k against an 80k budget.
// PostToolUse fires on EVERY tool call, so this is the only event that tracks
// context continuously.
//
// It never blocks. Blocking here would also block the Write that the checkpoint
// needs, wedging the session at precisely the moment it must save its work.
// Pressure is applied as injected text; the Stop hook still does the hard halt.
function onPostToolUse(p, policy) {
  if (!p.transcript_path) allow();
  const ctx = contextOf(p.transcript_path);
  const { softK, hardK } = policy.context;
  if (ctx < softK * 1000) allow();

  const over = ctx >= hardK * 1000;
  if (!over) {
    // Below the ceiling: warn once per 10k band so this stays cheap.
    const band = Math.floor(ctx / 10000);
    const f = statePath(p.session_id, "band");
    if (Number(readJson(f, { band: 0 }).band || 0) >= band) allow();
    try {
      ensureDirs();
      fs.writeFileSync(f, JSON.stringify({ band }));
    } catch {}
    inject(
      "PostToolUse",
      `[ACC ctx ${K(ctx)}/${hardK}k] Approaching the context budget. Finish the unit of work you are on and do not start new work. Keep detail in scratchpad files, not in context.`
    );
  }

  // Over the ceiling: every tool call, until the session ends. ~40 tokens each
  // is the correct price for not silently running to 3x budget.
  inject(
    "PostToolUse",
    `[ACC ctx ${K(ctx)}/${hardK}k] OVER BUDGET. Stop starting new work NOW. ` +
      `Finish only what makes this session droppable: checkpoint ${policy.runner.statusFile} ` +
      `(board + RESUME, written so a COLD session resumes from that file alone), move long detail to a ` +
      `scratchpad and cite its path, then END YOUR TURN so the session can be cleared. ` +
      `Do not begin another task, review, or investigation.`
  );
}

const WAITING_RE =
  /\b(waiting (on|for)|i'?ll resume when|once it'?s green|once ci|when the .{0,40} completes?|waiting for its completion|will resume)\b/i;

function onStop(p, policy) {
  ensureDirs();
  reviveClearbotIfDead(policy);

  // --- waiting guard (headless only: nothing re-invokes a -p session) ---
  // stop_hook_active means a Stop hook (this one or another) already blocked
  // this turn once; the guard must not re-block its own continuation.
  if (HEADLESS && policy.runner.waitingGuard && !p.stop_hook_active) {
    const latch = statePath(p.session_id, "waiting");
    if (!fs.existsSync(latch)) {
      const text = lastAssistantText(p.transcript_path);
      if (WAITING_RE.test(text)) {
        const st = readJson(statePath(p.session_id, "start"), null);
        let checkpointed = false;
        try {
          if (st && st.sf) checkpointed = fs.statSync(st.sf).mtimeMs > st.mtime;
        } catch {}
        if (!checkpointed) {
          try {
            fs.writeFileSync(latch, "1");
          } catch {}
          blockStop(
            "Nothing re-invokes a headless (-p) session. You cannot wait for CI, a background suite, or any external event -- " +
              "ending the turn here burns the run with no board progress (this cost runs 8, 10 and 12 of the 2026-07-30 queue). " +
              "Do ONE of these now: (a) poll in the FOREGROUND with an explicit timeout and finish the work, or " +
              "(b) checkpoint the status file (board + RESUME, so a cold session resumes from it alone) and then end."
          );
        }
      }
    }
  }

  // --- context budget ---
  if (!p.transcript_path) allow();
  const ctx = contextOf(p.transcript_path);
  const { hardK } = policy.context;
  if (ctx < hardK * 1000) {
    // LIVENESS (guards OI-002): a mission session that ends its turn UNDER the
    // ceiling gets no clear, and therefore no resume - the loop used to die
    // right here, silently. Re-arm the kick and let mission.mjs decide when
    // firing it is safe. Fails open: liveness must never cost a turn its
    // clean exit.
    try {
      const g = missionForSession(p.session_id);
      if (g) recordTurnEnd(g.id, { human: !KICK_CONSTANTS.includes(lastUserText(p.transcript_path)) });
    } catch {}
    allow();
  }

  const latch = statePath(p.session_id, "budget");
  if (!fs.existsSync(latch)) {
    try {
      fs.writeFileSync(latch, String(ctx));
    } catch {}
    blockStop(
      `[ACC] CONTEXT BUDGET REACHED - ${K(ctx)} of ${hardK}k. Start NO new work. ` +
        `Finish only what is needed to make this session droppable, then: ` +
        `(1) checkpoint the status file (${policy.runner.statusFile}) - board + RESUME, written so a COLD session resumes from that file alone; ` +
        `(2) move any long detail into a scratchpad file and cite its path; ` +
        `(3) state in one line where you are and what the next action is. Then stop.`
    );
  }

  // Latched: the checkpoint turn is done. Budget WINS from here (OI-011): a
  // /mission Stop hook may keep blocking the turn, so this path must fire on
  // every Stop until the clear actually lands - stop_hook_active no longer
  // short-circuits it. appendCycle is one-shot so blocked loops don't spam.
  if (HEADLESS) allow(); // the runner relaunch IS the clear

  // If a mission owns this session, its closing summary IS the handoff to the next
  // continuation. Captured automatically from the checkpoint turn the block above
  // just forced, so the model carries no extra burden and cannot forget to do it.
  let mission = null;
  try {
    mission = missionForSession(p.session_id);
    const cycled = statePath(p.session_id, "cycled");
    if (mission && !fs.existsSync(cycled)) {
      // Phase 1: real cost for THIS session's transcript, for the mission's
      // dollar ceiling. costOfTranscript never throws (empty/unreadable file
      // -> {costUsd:0}), so this can't cost the checkpoint its clean exit.
      const { costUsd } = p.transcript_path ? costOfTranscript(p.transcript_path, policy.rates) : { costUsd: 0 };
      appendCycle(mission.id, { sessionId: p.session_id, ctx, text: lastAssistantText(p.transcript_path), costUsd });
      fs.writeFileSync(cycled, "1");
    }
  } catch {}

  // Interactive: hand off to the outside watcher, which types /clear as real
  // keystrokes (hooks cannot clear context - see watcher/clearbot.ps1).
  const queued = policy.autoClear?.enabled !== false && requestClear(p, policy, ctx);
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        `\n[ACC ctx ${K(ctx)}/${hardK}k] BUDGET REACHED - checkpoint written.\n` +
        (queued
          ? `\n    >>> auto-clear requested - clearbot will type /clear <<<\n\n` +
            `  If nothing happens within ~5s the watcher is not running:\n` +
            `    node C:/code/guards/hooks/budget.mjs clearbot-status\n`
          : `\n    >>> TYPE /clear NOW <<<\n\n` +
            `  (auto-clear unavailable - no window captured for this session)\n`) +
        (mission
          ? `  Mission ${mission.id} is active - the next session adopts it automatically and\n` +
            `  is resumed by the Command Center. Cycle ${mission.cycles} logged.\n`
          : `  The next session re-primes itself from ${policy.runner.statusFile}.\n`) +
        `  Verify the clear was real: node C:/code/guards/hooks/usage.mjs clears\n`,
    })
  );
  process.exit(0);
}

function onPreToolUseAgent(p, policy) {
  const input = p.tool_input || {};
  const type = input.subagent_type || "general-purpose";

  // Kill switch.
  const { tier, weekTokens } = weekTier(policy);
  if (tier === "red") {
    stopRunner(policy);
    deny(
      `[ACC KILL SWITCH] Rolling 7-day usage is at the RED line (${Math.round(weekTokens / 1e6)}M tokens). ` +
        `Subagent spawns are blocked and the runner is stopped. Main-thread work continues normally. ` +
        `Clear it in the Command Center GUI (Process tab) or raise week.redTokens in C:/code/guards/policy.json.`
    );
  }

  // Explicit time-boxed fan-out grant (GUI / engine.mjs fanout <minutes>).
  const grant = readJson(path.join(STATE, "fanout.json"), null);
  const granted = grant && grant.until > Date.now();

  if (!granted && policy.subagents.mode === "allowlist" && !policy.subagents.allow.includes(type)) {
    deny(
      `[ACC] Subagent type "${type}" is not on the allowlist (${policy.subagents.allow.join(", ")}).\n` +
        `Do this work in the MAIN thread. Implementation of a slice task belongs in a runner session ` +
        `(fresh context by construction, far cheaper than an Opus subagent), not here.\n` +
        `If this genuinely needs fan-out: grant a window with ` +
        `\`node C:/code/guards/hooks/budget.mjs fanout 30\` or the Command Center Process tab.`
    );
  }

  // Per-session spawn cap. Locked (reserveAgentSlot) so two concurrent Agent
  // tool calls in the same turn can never both read the same stale count and
  // both pass a cap check meant to only pass once. A lock failure (timeout,
  // disk error) falls open to allow — same "never wedge a session" contract
  // as every other internal error in this file — rather than denying on an
  // unrelated I/O problem.
  const cap = granted ? policy.review.maxFinders : policy.subagents.maxPerSession;
  let reservation;
  try {
    reservation = reserveAgentSlot(p.session_id, cap);
  } catch {
    allow();
  }
  if (!reservation.allowed) {
    deny(
      `[ACC] Subagent cap reached for this session (${cap}). ` +
        `${granted ? "Fan-out grants are capped at review.maxFinders." : "Continue in the main thread, or clear context and start fresh."}`
    );
  }
  allow();
}

// ------------------------------------------------------------- entry

// applyProfile lives in usage.mjs so budget.mjs and statusline.mjs resolve
// policy identically - the budget on screen is the budget enforced.
function main() {
  const argv = process.argv.slice(2);
  const policy = applyProfile(loadPolicy());

  // CLI helpers (not hook paths).
  if (argv[0] === "fanout") {
    ensureDirs();
    const mins = Number(argv[1] || 30);
    fs.writeFileSync(
      path.join(STATE, "fanout.json"),
      JSON.stringify({ until: Date.now() + mins * 60000, granted: new Date().toISOString() })
    );
    console.log(`fan-out granted for ${mins} min (max ${policy.review.maxFinders} finders)`);
    return;
  }
  if (argv[0] === "unstop") {
    try {
      fs.unlinkSync(path.join(ROOT, "runner", "stop", "slice-runner.stop"));
    } catch {}
    try {
      fs.unlinkSync(path.join(STATE, "tier.json"));
    } catch {}
    console.log("runner stop-file cleared, tier cache flushed");
    return;
  }

  // Fire the auto-clear on demand, against the most recently started session.
  // This is the honest end-to-end proof: it types /clear for real.
  if (argv[0] === "clear-now") {
    ensureDirs();
    const wins = fs
      .readdirSync(STATE)
      .filter((f) => f.endsWith(".window"))
      .map((f) => ({ f, m: fs.statSync(path.join(STATE, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!wins.length) return console.log("no session window captured yet");
    const sid = wins[0].f.replace(/\.window$/, "");
    const w = readJson(path.join(STATE, wins[0].f), {});
    if (!w.consolePid) return console.log(`${sid}: no consolePid - restart the session to re-capture`);
    atomicWrite(
      path.join(CLEARREQ, `${sid}.json`),
      JSON.stringify({
        sessionId: sid, hwnd: w.hwnd, consolePid: w.consolePid, title: w.title || "",
        transcript: "", ctx: 0, hardK: 0, ts: new Date().toISOString(),
      })
    );
    console.log(`clear requested for ${sid} (consolePid ${w.consolePid}) - clearbot fires within ~2s`);
    return;
  }

  if (argv[0] === "clearbot-status") {
    const s = clearbotStatus();
    console.log(`clearbot processes : ${s.running === null ? "unknown (no powershell on this host)" : s.running}`);
    console.log(`kill switch        : ${s.killSwitchEngaged ? "ENGAGED (clearbot.stop present)" : "off"}`);
    console.log(`pending requests   : ${s.pending.length}${s.pending.length ? " -> " + s.pending.join(", ") : ""}`);
    console.log(`log                : ${s.log}`);
    if (s.running === 0) console.log(`\nNOT RUNNING. Start it: guards\\watcher\\start-clearbot.cmd`);
    return;
  }

  // Phase 3 (full-remediation-prompt.md): the CLI helpers above stay
  // unconditional (the GUI/engine call them directly); only hook dispatch
  // from here down requires an active ACC session.
  if (!accActive()) allow();

  const p = readStdin();
  const event = p.hook_event_name || "";
  if (event === "SessionStart") return onSessionStart(p, policy);
  if (event === "UserPromptSubmit") return onUserPromptSubmit(p, policy);
  if (event === "PostToolUse") return onPostToolUse(p, policy);
  if (event === "Stop") return onStop(p, policy);
  if (event === "PreToolUse") {
    // Full-repo review (2026-08-06): Claude Code's real subagent-launching
    // tool is named "Task" (confirmed against Anthropic's own hooks
    // documentation), not "Agent" -- the stale name here meant this branch
    // exited via allow() before onPreToolUseAgent ever ran, for every real
    // subagent spawn. The RED-tier kill switch, the allowlist, and the
    // per-session cap were all silently dead code in production.
    if ((p.tool_name || "") !== "Task") allow();
    return onPreToolUseAgent(p, policy);
  }
  allow();
}

// Phase 7 (full-remediation-prompt.md): main() used to run unconditionally
// at module load, which is exactly why this file could never be `import`ed
// for unit testing (covgate read it at a permanent 0% -- OI-033) -- an
// import would immediately read stdin and process.exit() before a test ever
// got to assert anything. Guarding it the same way covgate.mjs/kernel/run.mjs
// already do lets a test import the pure helpers below without also running
// the hook.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    // Fail open, but leave a trace.
    try {
      ensureDirs();
      fs.appendFileSync(path.join(LOGS, "budget-errors.log"), `${new Date().toISOString()} ${e && e.stack}\n`);
    } catch {}
    process.exit(0);
  }
}

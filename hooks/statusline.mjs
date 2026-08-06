#!/usr/bin/env node
// Agentic Command Center - status line.
// Prints:  <cwd> | Opus 5 | ctx 102k/150k ###------- | wk 3% | subs 2
// (the k values are the ENFORCED budget: policy resolved via the same
// applyProfile(loadPolicy()) call budget.mjs uses, so screen == enforcement)
// Statusline output never enters the model's context, so this visibility
// is free. Must be fast and must never throw - a failing statusline is
// rendered verbatim to the user.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy, contextOf, applyProfile } from "./usage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.resolve(HERE, "..");
const STATE = path.join(ROOT, "runner", "state");

// The watcher is what types /clear and the resume prompt. If it is dead this
// session has no autonomy at all, and nothing else says so out loud.
const HEARTBEAT_STALE_MS = 30_000;
function botDead() {
  try {
    return Date.now() - fs.statSync(path.join(ROOT, "watcher", "clearbot.heartbeat")).mtimeMs > HEARTBEAT_STALE_MS;
  } catch {
    return false; // absent = never started here; do not cry wolf
  }
}

// ANSI: dim for chrome, colour for the budget bar.
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function bar(frac, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  return "#".repeat(filled) + "-".repeat(width - filled);
}

function agentCount(sid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, `${sid}.agents`), "utf8")).n || 0;
  } catch {
    return 0;
  }
}

// Phase 1 (full-remediation-prompt.md): any unread ceiling alert shows here.
// "Unread" = the file still exists -- goal.mjs's resumeGoal deletes it, so
// resuming the goal is what clears the warning, no separate ack needed.
function goalPaused() {
  try {
    const dir = process.env.ACC_ALERTS_DIR || path.join(ROOT, "runner", "alerts");
    return fs.readdirSync(dir).some((f) => f.endsWith(".ceiling.json"));
  } catch {
    return false; // no alerts dir at all = nothing paused
  }
}

// OI-034: a goal reaped as dead (console gone -- a reboot, a crash, power
// loss) writes a `.dead.json` alert the same way a paused goal's ceiling
// does. Unlike the ceiling alert, nothing "resumes" a dead goal to clear
// this one -- hooks/budget.mjs's SessionStart consumes (reads + deletes)
// it once, inline in chat; this indicator is a secondary, persistent
// surface for the window between the reap and that next SessionStart.
function goalDied() {
  try {
    const dir = process.env.ACC_ALERTS_DIR || path.join(ROOT, "runner", "alerts");
    return fs.readdirSync(dir).some((f) => f.endsWith(".dead.json"));
  } catch {
    return false;
  }
}

function weekPct() {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(STATE, "tier.json"), "utf8"));
    // Written by budget.mjs (10-min cache). Stale is fine for a status line.
    return t.pct > 0 ? t : null;
  } catch {
    return null;
  }
}

function main() {
  const p = readStdin();
  const policy = applyProfile(loadPolicy());
  const parts = [];

  const dir = p.workspace?.current_dir || p.cwd || process.cwd();
  parts.push(`${DIM}${path.basename(dir)}${RESET}`);

  if (p.model?.display_name) parts.push(`${DIM}${p.model.display_name}${RESET}`);

  const { softK, hardK } = policy.context;
  let ctx = 0;
  if (p.transcript_path) ctx = contextOf(p.transcript_path);
  if (ctx > 0) {
    const k = Math.round(ctx / 1000);
    const frac = ctx / (hardK * 1000);
    const colour = k >= hardK ? RED : k >= softK ? YELLOW : GREEN;
    parts.push(`${colour}ctx ${k}k/${hardK}k ${bar(frac)}${RESET}`);
  }

  if (botDead()) parts.push(`${RED}bot DEAD${RESET}`);
  if (goalPaused()) parts.push(`${RED}goal PAUSED${RESET}`);
  if (goalDied()) parts.push(`${RED}goal DIED${RESET}`);

  const wk = weekPct();
  if (wk) {
    const colour = wk.tier === "red" ? RED : wk.tier === "amber" ? YELLOW : GREEN;
    parts.push(`${colour}wk ${wk.pct.toFixed(0)}%${RESET}`);
  }

  const n = agentCount(p.session_id);
  if (n > 0) parts.push(`${DIM}subs ${n}/${policy.subagents.maxPerSession}${RESET}`);

  process.stdout.write(parts.join(` ${DIM}|${RESET} `));
}

try {
  main();
} catch {
  process.stdout.write(""); // never render an error into the status line
}

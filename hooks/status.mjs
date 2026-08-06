// Spending tab (design spec 2026-08-06-acc-gui-remaining-tabs-design.md §5):
// the read-aggregation + write-owner for everything gui/spending.html shows.
// Named "status", not "spending" -- this module answers several tabs' worth
// of "what's true right now" questions, spending being the biggest one.
//
// Consolidates what guards-gui.ps1's tab-4 handlers scattered across raw
// policy.json reads/writes from two independent handlers (a real race,
// closed here by having exactly ONE owner: saveOpsPolicy), hooks/usage.mjs's
// week/cost logic (already pure/importable), and hooks/budget.mjs's
// clearbot-status/fanout/unstop CLI helpers (kept as subprocess calls,
// the same "keep shelling out" decision the design spec made for
// hooks/engine.mjs in §4 -- budget.mjs's handlers call process.exit(),
// exactly the hazard importing them in-process would reintroduce).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPolicy, weekTier, totalsSince } from "./usage.mjs";
import { clearbotStatus as budgetClearbotStatus } from "./budget.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.resolve(HERE, "..");
const BUDGET = path.join(HERE, "budget.mjs");
const policyPath = () => process.env.ACC_POLICY || path.join(ROOT, "policy.json");

function req(cond, msg) {
  if (!cond) throw new Error(`ops policy: ${msg}`);
}
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function readRawPolicy() {
  let text;
  try {
    text = fs.readFileSync(policyPath(), "utf8");
  } catch (e) {
    throw new Error(`policy unreadable: ${policyPath()} (${e.message})`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`policy unreadable: ${policyPath()} (${e.message})`);
  }
}

// ------------------------------------------------------------- spending read

export function spendingSummary() {
  const policy = loadPolicy();
  const t = weekTier();
  const { main, sub } = totalsSince({ since: Date.now() - 7 * 864e5 });
  return {
    tier: t.tier,
    weekTokens: t.weekTokens,
    pct: t.pct,
    amberTokens: policy.week.amberTokens,
    redTokens: policy.week.redTokens,
    costUsd: Math.round((main.cost + sub.cost) * 100) / 100,
  };
}

// Design spec §5, "Global-status leakage, named not ignored": the WinForms
// tab wrote into the outer window's header chrome ($lblStatusAct) when the
// tier went amber/red -- a cross-tab side effect that has no web analog
// (there's no single process/DOM spanning every page the way WinForms
// panels shared one). The fix: a tiny, cheap, independently-pollable
// summary any page's shared header widget can ask for on its own, rather
// than one page reaching into another's state. Same tier math
// spendingSummary() already uses -- kept separate rather than having
// spendingSummary return a `text` field too, since every OTHER page that
// polls this only needs the one-line summary, not the full week/cost block.
export function globalStatusSummary() {
  const { tier, pct } = weekTier();
  const text =
    tier === "red" ? "week usage RED — kill switch engaged" :
    tier === "amber" ? `week usage AMBER (${Math.round(pct)}%)` :
    "week usage: green";
  return { tier, text };
}

// ---------------------------------------------------------- ops policy dials

const OPS_DEFAULTS = {
  context: { softK: 400, hardK: 600 },
  week: { amberTokens: 0, redTokens: 0 },
  subagents: { mode: "allowlist", allow: [], maxPerSession: 1, exploreMaxReportLines: 80 },
  review: { fullLeanReview: "manual-only", localFullSuiteInReview: false, maxFinders: 1 },
};

// The NON-kernel policy blocks (context/week/subagents/review) -- a
// different top-level key than "kernel" in the SAME policy.json file.
// Unreadable/missing file = defaults, matching kernel/policy.mjs's own
// first-run convention.
export function loadOpsPolicy() {
  let raw = {};
  try {
    raw = readRawPolicy();
  } catch {
    raw = {};
  }
  return {
    context: { ...OPS_DEFAULTS.context, ...(raw.context || {}) },
    week: { ...OPS_DEFAULTS.week, ...(raw.week || {}) },
    subagents: { ...OPS_DEFAULTS.subagents, ...(raw.subagents || {}) },
    review: { ...OPS_DEFAULTS.review, ...(raw.review || {}) },
  };
}

export function validateOpsBlock(block) {
  req(block && typeof block === "object", "block must be an object");
  req(isNum(block.context?.softK) && block.context.softK > 0, "context.softK must be a positive number");
  req(isNum(block.context?.hardK) && block.context.hardK > 0, "context.hardK must be a positive number");
  req(block.context.hardK > block.context.softK, "context.hardK must be greater than context.softK");
  req(isNum(block.week?.amberTokens) && block.week.amberTokens >= 0, "week.amberTokens must be >= 0");
  req(isNum(block.week?.redTokens) && block.week.redTokens >= 0, "week.redTokens must be >= 0");
  req(["allowlist", "off"].includes(block.subagents?.mode), "subagents.mode must be 'allowlist' or 'off'");
  req(
    Array.isArray(block.subagents?.allow) && block.subagents.allow.every((s) => typeof s === "string" && s.trim()),
    "subagents.allow must be a list of non-empty strings"
  );
  req(Number.isInteger(block.subagents?.maxPerSession) && block.subagents.maxPerSession >= 0, "subagents.maxPerSession must be an integer >= 0");
  req(Number.isInteger(block.review?.maxFinders) && block.review.maxFinders >= 0, "review.maxFinders must be an integer >= 0");
}

// Single owner for the whole ops-policy write, closing the two-writer race
// the design spec's research pass found (guards-gui.ps1's btnPolSave and
// chkAutoApprove's change handler each did their own independent raw
// read-modify-write). Same atomic tmp+rename discipline kernel/policy.mjs's
// saveKernelPolicy already uses for the sibling "kernel" block.
export function saveOpsPolicy(block) {
  validateOpsBlock(block);
  const file = policyPath();
  let pol;
  try {
    pol = readRawPolicy();
  } catch (e) {
    throw new Error(`ops policy: cannot edit ${file} (${e.message})`);
  }
  pol.context = { softK: block.context.softK, hardK: block.context.hardK };
  pol.week = { ...(pol.week || {}), amberTokens: block.week.amberTokens, redTokens: block.week.redTokens };
  pol.subagents = {
    ...(pol.subagents || {}),
    mode: block.subagents.mode,
    allow: block.subagents.allow.map((s) => s.trim()),
    maxPerSession: block.subagents.maxPerSession,
    exploreMaxReportLines: block.subagents.exploreMaxReportLines ?? OPS_DEFAULTS.subagents.exploreMaxReportLines,
  };
  pol.review = { ...(pol.review || {}), maxFinders: block.review.maxFinders };
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(pol, null, 2));
  fs.renameSync(tmp, file);
  return loadOpsPolicy();
}

// ------------------------------------------------------------------ actions

export function clearbotStatus() {
  return budgetClearbotStatus();
}

function runBudget(args) {
  return execFileSync("node", [BUDGET, ...args], { encoding: "utf8", env: process.env });
}

// Same bare touch-file guards-gui.ps1's kill-switch button already does --
// no CLI indirection needed, matches stopRunner()'s own mechanism in
// hooks/budget.mjs.
export function stopRunnerNow() {
  const dir = path.join(ROOT, "runner", "stop");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "slice-runner.stop"), `stopped via GUI ${new Date().toISOString()}\n`);
  return { ok: true };
}

export function unstopRunner() {
  runBudget(["unstop"]);
  return { ok: true };
}

export function fanout(mins) {
  const n = Number(mins);
  req(Number.isFinite(n) && n > 0, "fanout minutes must be a positive number");
  runBudget(["fanout", String(n)]);
  return { ok: true };
}

// start/stop shell to the same .cmd files guards-gui.ps1 already invokes
// (Windows-only by necessity -- no portable equivalent, same ceiling
// hooks/engine.mjs's RUNNERS map already documents for .ps1/.cmd/.bat
// runbox scripts). clear-now is a real cross-platform Node path, so it goes
// through budget.mjs like the other CLI helpers.
export function clearbotOp(op) {
  if (op === "start") {
    execFileSync("cmd", ["/c", path.join(ROOT, "watcher", "start-clearbot.cmd")]);
    return { ok: true };
  }
  if (op === "stop") {
    execFileSync("cmd", ["/c", path.join(ROOT, "watcher", "stop-clearbot.cmd")]);
    return { ok: true };
  }
  if (op === "clear-now") {
    runBudget(["clear-now"]);
    return { ok: true };
  }
  throw new Error(`unknown clearbot op: ${op}`);
}

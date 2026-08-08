#!/usr/bin/env node
// testplan.mjs — plan-time test-contract injector (UserPromptSubmit).
//
// WHY: the tests that exist get run; the tests that were never DEMANDED never
// get written. This hook fires when a prompt reads like the start of
// implementation planning and injects the testing contract, so every plan is
// forced to end with a test matrix BEFORE code exists — unit, integration,
// e2e mapped 1:1 to acceptance criteria, red-first, and the proof tier routed
// through the launch lane (hooks/lane.mjs) so the tests themselves can never
// recreate the concurrent-stream jam.
//
// ADVISORY BY DESIGN, same philosophy as route.mjs — and here it is load-
// bearing, not taste: a blocking verdict needs replay machinery (route has
// it; this has none), and a blocked prompt inside a directive session stalls
// the autonomous loop. The contract's teeth are in its GATES (fast tier green,
// covgate green), not in eating prompts.
//
// Fires ONCE per session (latch in runner/state, sandboxed via ACC_ROOT like
// every other hook) and only on prompts that look like planning kickoff.
// Overfiring is cheap — the latch caps the cost at one injection per session.
// Fails open in every direction: a broken injector must never cost a turn.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoot } from "./root.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = resolveRoot(HERE);
const STATE = path.join(ROOT, "runner", "state");

// Planning kickoff, not chat. Verbs that start implementation work, plus the
// board/slice vocabulary the runner bootstraps use. Slash commands and the
// runner bootstrap constants must never match — they are machinery, not intent.
const PLAN_RE =
  /\b(plan(ning)? (out|the|a|this)|write (a |the )?(spec|plan|prd)|spec (out|for)|design (a|the|this)|implement|build (out|a|the|this)|add (a|the) (feature|hook|endpoint|command|cell|skill|migration|tab|watcher)|refactor|next slice|work the board|start (the |a )?(task|slice|feature))\b/i;

export function shouldFire(prompt) {
  const p = String(prompt || "").trim();
  if (!p || p.startsWith("/")) return false;
  if (p.length > 8000) return false; // pasted logs, not a plan
  return PLAN_RE.test(p);
}

export function contract() {
  return [
    "[ACC testplan] This prompt starts implementation. Before any code, the plan MUST end with a \"Test contract\" section, and the work MUST honor it:",
    "1. MATRIX (1:1) — list every acceptance criterion; beside each, the test(s) that prove it: unit (pure logic, hermetic), integration (process/filesystem boundary, hermetic), e2e (only for cross-process promises). A criterion with no test is not in the plan; a test proving no criterion is deleted.",
    "2. RED FIRST — write each test before its code and RUN it: it must fail for the stated reason, and the red run is recorded in the slice log. A test born green proves nothing.",
    "3. TIERS — unit + integration belong to the fast tier: node --test, hermetic, no network, no real claude, sandboxed via ACC_ROOT/ACC_POLICY/ACC_LANE_DIR like every existing suite. e2e belongs to the proof tier: it SPENDS TOKENS and every real-claude launch goes through hooks/lane.mjs withLaunchSlot — never spawn claude directly.",
    "4. GATES (objective, all must pass before done): fast tier green; `node hooks/covgate.mjs` green — every changed lib file at the policy floors, default 100% lines, 100% functions, 90% branches; the relevant proof scenario green when loop behavior changed. Coverage is a floor, not the goal: assert observable behavior, never implementation detail.",
    "5. LEAN — one behavior per test, no sleeps except the lane's own pacing, no shared state between tests. Prefer 10 sharp tests over 40 flabby ones; every test must be able to fail.",
    "If this prompt is not actually implementation planning, ignore this block.",
  ].join("\n");
}

function hook() {
  let p = {};
  try { p = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  if (!shouldFire(p.prompt)) return;

  const sid = String(p.session_id || "unknown").slice(0, 40);
  const latch = path.join(STATE, `${sid}.testplan`);
  // No try/catch here: fs.existsSync is documented to never throw (Node
  // wraps every internal error into a `false` return), so wrapping it was
  // dead defensive code — found 2026-08-01 while covgate's branch floor
  // flagged it as an unreachable catch.
  if (fs.existsSync(latch)) return;

  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(latch, JSON.stringify({ at: new Date().toISOString() }));
  } catch {}

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: contract() },
    }) + "\n"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) hook();

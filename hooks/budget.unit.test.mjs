// Phase 7 (full-remediation-prompt.md), OI-033: budget.mjs's own code was
// permanently invisible to covgate -- main() ran unconditionally at module
// load (an import would process.exit() before a test could assert anything),
// so every existing test spawns it as a subprocess with NODE_V8_COVERAGE
// deleted from the env (see budget.test.mjs's own header), which is correct
// for that file's purpose (proving the Stop-gate precedence for real) but
// means node's coverage instrumentation never sees budget.mjs's own lines.
//
// This file imports budget.mjs directly instead, exercising the pure helpers
// (tier calc, transcript parsing, context building, dial-adjacent file I/O)
// that don't process.exit() or write to stdout/stderr -- the "non-console-
// coupled paths" the phase asked for. The handlers that dispatch and exit
// (onSessionStart etc, via inject/blockStop/deny/allow) still need the real
// process boundary and stay covered by budget.test.mjs's subprocess suite.
//
// ACC_ROOT/CLAUDE_CONFIG_DIR must be set BEFORE the first import of
// budget.mjs (and usage.mjs, which it re-exports through) -- both resolve
// their roots into module-level consts at import time, not per-call (the
// same gotcha usage.mjs's own doc comment and runner.test.mjs's fix already
// describe). One sandbox for the whole file; tests that need isolation from
// each other use distinct filenames/ids within it instead of a fresh root.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-budget-unit-"));
process.env.ACC_ROOT = BASE;
process.env.ACC_GOALS_DIR = path.join(BASE, "runner", "goals");
process.env.CLAUDE_CONFIG_DIR = path.join(BASE, "claudecfg");
fs.mkdirSync(path.join(BASE, "runner", "state"), { recursive: true });
fs.mkdirSync(path.join(BASE, "runner", "queued"), { recursive: true });
fs.mkdirSync(process.env.ACC_GOALS_DIR, { recursive: true });

const {
  statePath, readJson, atomicWrite, weekTier, scanWeek, stopRunner,
  lastAssistantText, lastUserText, pausedGoalWarning, goalContext, queuedPromptContext,
} = await import("./budget.mjs");
const { createGoal, setStatus } = await import("./goal.mjs");

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

// ------------------------------------------------------------- statePath / readJson / atomicWrite

test("statePath joins under runner/state, truncating a session id to 40 chars, and falls back to 'unknown'", () => {
  const p = statePath("s".repeat(60), "window");
  assert.ok(p.endsWith(`${"s".repeat(40)}.window`));
  assert.ok(p.includes(path.join("runner", "state")));
  assert.ok(statePath(undefined, "window").endsWith("unknown.window"));
});

test("readJson returns the parsed file, or the default on missing/corrupt", () => {
  const f = path.join(BASE, "runner", "state", "rj-test.json");
  fs.writeFileSync(f, JSON.stringify({ a: 1 }));
  assert.deepEqual(readJson(f, null), { a: 1 });
  assert.equal(readJson(path.join(BASE, "runner", "state", "missing.json"), "dflt"), "dflt");
  fs.writeFileSync(f, "{not json");
  assert.equal(readJson(f, "dflt"), "dflt");
});

test("atomicWrite leaves the real file readable and no leftover .tmp- file", () => {
  const f = path.join(BASE, "runner", "state", "aw-test.json");
  atomicWrite(f, JSON.stringify({ ok: true }));
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { ok: true });
  const leftovers = fs.readdirSync(path.join(BASE, "runner", "state")).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

// ------------------------------------------------------------- weekTier / scanWeek

test("weekTier is green with 0 scan when both thresholds are disabled", () => {
  const r = weekTier({ week: { redTokens: 0, amberTokens: 0 } });
  assert.deepEqual(r, { tier: "green", weekTokens: 0, pct: 0 });
});

function writeTranscript(dir, tokens) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `s-${Math.random().toString(36).slice(2)}.jsonl`),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { usage: { input_tokens: tokens, output_tokens: 0 } },
    }) + "\n"
  );
}

test("scanWeek sums assistant usage across every .jsonl under CLAUDE_CONFIG_DIR/projects, ignoring stale entries", () => {
  const proj = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", `p-${Math.random().toString(36).slice(2)}`);
  writeTranscript(proj, 500);
  writeTranscript(proj, 250);
  const total = scanWeek(Date.now() - 60_000);
  assert.ok(total >= 750, `expected at least 750, got ${total}`);
});

test("weekTier reaches red once scanWeek's total clears redTokens, and caches the result", () => {
  const proj = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", `p-${Math.random().toString(36).slice(2)}`);
  writeTranscript(proj, 10_000);
  fs.rmSync(path.join(BASE, "runner", "state", "tier.json"), { force: true });
  const r = weekTier({ week: { redTokens: 1000, amberTokens: 500, effectiveFrom: "" } });
  assert.equal(r.tier, "red");
  assert.ok(r.weekTokens >= 10_000);
  const cached = readJson(path.join(BASE, "runner", "state", "tier.json"), null);
  assert.equal(cached.tier, "red", "the result must be cached to tier.json");
});

test("weekTier serves the cache within its 10-minute window instead of rescanning", () => {
  const cacheFile = path.join(BASE, "runner", "state", "tier.json");
  atomicWrite(cacheFile, JSON.stringify({ tier: "amber", weekTokens: 777, pct: 50, ts: Date.now() }));
  const r = weekTier({ week: { redTokens: 1000, amberTokens: 500, effectiveFrom: "" } });
  assert.deepEqual(r, { tier: "amber", weekTokens: 777, pct: 50, ts: r.ts });
});

test("weekTier's effectiveFrom clamps the rolling window so pre-ACC burn never counts", () => {
  fs.rmSync(path.join(BASE, "runner", "state", "tier.json"), { force: true });
  const proj = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", `p-${Math.random().toString(36).slice(2)}`);
  writeTranscript(proj, 999_999);
  const farFuture = new Date(Date.now() + 3600_000).toISOString();
  const r = weekTier({ week: { redTokens: 1, amberTokens: 1, effectiveFrom: farFuture } });
  assert.equal(r.tier, "green", "effectiveFrom in the future must exclude every transcript written before it");
});

// ------------------------------------------------------------- stopRunner

test("stopRunner writes the stop file only when policy.runner.stopOnRed is true", () => {
  const stopFile = path.join(BASE, "runner", "stop", "slice-runner.stop");
  fs.rmSync(stopFile, { force: true });
  stopRunner({ runner: { stopOnRed: false } });
  assert.equal(fs.existsSync(stopFile), false);
  stopRunner({ runner: { stopOnRed: true } });
  assert.ok(fs.existsSync(stopFile));
  assert.match(fs.readFileSync(stopFile, "utf8"), /red tier/);
});

// ------------------------------------------------------------- transcript parsing

function writeJsonl(lines) {
  const f = path.join(BASE, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

test("lastAssistantText returns the last non-empty assistant text block, skipping sidechains", () => {
  const f = writeJsonl([
    { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "SIDECHAIN" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "second" }] } },
  ]);
  assert.equal(lastAssistantText(f), "second");
});

test("lastAssistantText returns '' for a missing file or a transcript with no assistant text", () => {
  assert.equal(lastAssistantText(path.join(BASE, "does-not-exist.jsonl")), "");
  const f = writeJsonl([{ type: "user", message: { content: "hi" } }]);
  assert.equal(lastAssistantText(f), "");
});

test("lastUserText returns the LAST user message, string or content-block array, trimmed", () => {
  const f = writeJsonl([
    { type: "user", message: { content: "first" } },
    { type: "assistant", message: { content: [{ type: "text", text: "reply" }] } },
    { type: "user", message: { content: [{ type: "text", text: "  second  " }] } },
  ]);
  assert.equal(lastUserText(f), "second");
});

test("lastUserText returns '' for a missing file or a transcript with no user turns", () => {
  assert.equal(lastUserText(path.join(BASE, "nope.jsonl")), "");
});

// ------------------------------------------------------------- goal / queue context

test("pausedGoalWarning is '' with no paused goal, and names the goal when one matches ACC_GOAL", () => {
  assert.equal(pausedGoalWarning({}, {}), "");
  const g = createGoal({ text: "do the thing", cwd: BASE });
  setStatus(g.id, "paused", { why: "ceiling" });
  const saved = process.env.ACC_GOAL;
  process.env.ACC_GOAL = g.id;
  try {
    const warn = pausedGoalWarning({}, {});
    assert.match(warn, new RegExp(g.id));
    assert.match(warn, /ceiling/);
  } finally {
    process.env.ACC_GOAL = saved;
  }
});

test("goalContext returns '' when bindSession finds no goal to bind (no ACC_GOAL, no matching consolePid)", () => {
  const saved = process.env.ACC_GOAL;
  delete process.env.ACC_GOAL;
  try {
    const out = goalContext({ session_id: "11111111-0000-4000-8000-000000000001", cwd: BASE }, {}, { });
    assert.equal(out, "");
  } finally {
    if (saved !== undefined) process.env.ACC_GOAL = saved;
  }
});

test("goalContext binds a fresh goal and includes its text, cwd, and the exact done/blocked commands", () => {
  const g = createGoal({ text: "ship the feature", cwd: "/some/dir" });
  const saved = process.env.ACC_GOAL;
  process.env.ACC_GOAL = g.id;
  try {
    const out = goalContext({ session_id: "11111111-0000-4000-8000-000000000002", cwd: "/some/dir" }, {}, {});
    assert.match(out, /ship the feature/);
    assert.match(out, /Working folder: \/some\/dir/);
    assert.match(out, new RegExp(`goal\\.mjs done ${g.id}`));
    assert.match(out, new RegExp(`goal\\.mjs blocked ${g.id}`));
  } finally {
    if (saved !== undefined) process.env.ACC_GOAL = saved; else delete process.env.ACC_GOAL;
  }
});

test("queuedPromptContext returns '' with no consolePid or no queued file, and consumes the file once", () => {
  assert.equal(queuedPromptContext({}), "");
  const cpid = 999123;
  assert.equal(queuedPromptContext({ consolePid: cpid }), "", "no queued file yet");
  const qf = path.join(BASE, "runner", "queued", `${cpid}.md`);
  fs.writeFileSync(qf, "the deferred prompt");
  const out = queuedPromptContext({ consolePid: cpid });
  assert.match(out, /the deferred prompt/);
  assert.equal(fs.existsSync(qf), false, "the queued file must be deleted once read");
  assert.equal(queuedPromptContext({ consolePid: cpid }), "", "a second read finds nothing");
});

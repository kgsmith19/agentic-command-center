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
process.env.ACC_MISSIONS_DIR = path.join(BASE, "runner", "missions");
process.env.CLAUDE_CONFIG_DIR = path.join(BASE, "claudecfg");
fs.mkdirSync(path.join(BASE, "runner", "state"), { recursive: true });
fs.mkdirSync(path.join(BASE, "runner", "queued"), { recursive: true });
fs.mkdirSync(process.env.ACC_MISSIONS_DIR, { recursive: true });

const {
  statePath, readJson, atomicWrite, weekTier, scanWeek, stopRunner,
  lastAssistantText, lastUserText, pausedMissionWarning, missionContext, queuedPromptContext,
  clearbotStatus, withStateLock,
} = await import("./budget.mjs");
const { createMission, setStatus } = await import("./mission.mjs");

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

// ------------------------------------------------------------- statePath / readJson / atomicWrite

test("statePath joins under runner/state, truncating a session id to 40 chars, and falls back to 'unknown'", () => {
  const p = statePath("s".repeat(60), "window");
  assert.ok(p.endsWith(`${"s".repeat(40)}.window`));
  assert.ok(p.includes(path.join("runner", "state")));
  assert.ok(statePath(undefined, "window").endsWith("unknown.window"));
});

test("Full-repo review (2026-08-06) regression: statePath sanitizes session_id, refusing to let a path-traversal id escape runner/state", () => {
  // Corroborated MEDIUM finding: statePath's only defense was a bare
  // .slice(0, 40) -- no character filtering, unlike hooks/mission.mjs's own
  // safeId() (which allowlists [A-Za-z0-9_-]) for the structurally identical
  // problem of turning an untrusted id into a filename. p.session_id is a
  // Claude Code-generated UUID under normal operation, but the hook trusts
  // whatever JSON arrives on stdin -- defense-in-depth means this file must
  // not assume that boundary always holds. path.join does NOT stop ".."
  // segments from escaping the intended directory (path.join("/a/b",
  // "../../etc/passwd") -> "/etc/passwd"), so an id like
  // "../../../../etc/evil" reached fs.writeFileSync with a target entirely
  // outside runner/state before this fix.
  const traversal = statePath("../../../../etc/evil", "window");
  assert.ok(
    traversal.startsWith(path.join(BASE, "runner", "state")),
    `statePath must stay confined to runner/state, got: ${traversal}`
  );
  assert.ok(!traversal.includes(".."), `the sanitized path must not carry a literal ".." segment: ${traversal}`);
});

test("a lock's release never deletes it if another holder has since reclaimed and rewritten it (fencing token, not just an atomic create)", () => {
  // Full-repo review (2026-08-06): a holder that is merely SLOW -- not
  // crashed -- can have its lock look "stale" to an observer purely from
  // wall-clock elapsed time. A second process then legitimately reclaims it
  // and enters its own critical section. Without a fencing token, the
  // original holder's own release deletes whatever file is at that path
  // NOW -- the second holder's lock, not its own -- letting a third
  // process acquire while the second is still inside its critical section.
  // Same fix as kernel/ledger.mjs's withDecisionLock, which shares this
  // exact duplicated primitive.
  const lockPath = path.join(BASE, "runner", "state", "fencing-test.lock");
  withStateLock(lockPath, () => {
    fs.writeFileSync(lockPath, "someone-elses-token");
  });
  assert.equal(
    fs.readFileSync(lockPath, "utf8"),
    "someone-elses-token",
    "the original holder's release must not delete a lock another holder has since reclaimed and is still using"
  );
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

// ------------------------------------------------------------- mission / queue context

test("pausedMissionWarning is '' with no paused mission, and names the mission when one matches ACC_MISSION", () => {
  assert.equal(pausedMissionWarning({}, {}), "");
  const g = createMission({ text: "do the thing", cwd: BASE });
  setStatus(g.id, "paused", { why: "ceiling" });
  const saved = process.env.ACC_MISSION;
  process.env.ACC_MISSION = g.id;
  try {
    const warn = pausedMissionWarning({}, {});
    assert.match(warn, new RegExp(g.id));
    assert.match(warn, /ceiling/);
  } finally {
    process.env.ACC_MISSION = saved;
  }
});

test("missionContext returns '' when bindSession finds no mission to bind (no ACC_MISSION, no matching consolePid)", () => {
  const saved = process.env.ACC_MISSION;
  delete process.env.ACC_MISSION;
  try {
    const out = missionContext({ session_id: "11111111-0000-4000-8000-000000000001", cwd: BASE }, {}, { });
    assert.equal(out, "");
  } finally {
    if (saved !== undefined) process.env.ACC_MISSION = saved;
  }
});

test("missionContext binds a fresh mission and includes its text, cwd, and the exact done/blocked commands", () => {
  const g = createMission({ text: "ship the feature", cwd: "/some/dir" });
  const saved = process.env.ACC_MISSION;
  process.env.ACC_MISSION = g.id;
  try {
    const out = missionContext({ session_id: "11111111-0000-4000-8000-000000000002", cwd: "/some/dir" }, {}, {});
    assert.match(out, /ship the feature/);
    assert.match(out, /Working folder: \/some\/dir/);
    assert.match(out, new RegExp(`mission\\.mjs done ${g.id}`));
    assert.match(out, new RegExp(`mission\\.mjs blocked ${g.id}`));
  } finally {
    if (saved !== undefined) process.env.ACC_MISSION = saved; else delete process.env.ACC_MISSION;
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

// Spending tab (2026-08-06): clearbotStatus() extracted from the CLI's
// inline block so hooks/status.mjs can call it directly. On a host with no
// `powershell` (this sandbox), the OLD code's execFileSync threw ENOENT
// uncaught out of main() -- caught only by the outer fail-open catch, which
// swallowed the WHOLE command's output including pending/killSwitchEngaged,
// fields that have nothing to do with whether powershell exists. The fixed
// version must return those honestly, with running:null (not 0, not a throw)
// standing in for "unknown on this host".
test("clearbotStatus reports pending/killSwitch honestly even with no powershell binary, running:null not a throw", () => {
  const stop = path.join(BASE, "watcher", "clearbot.stop");
  fs.mkdirSync(path.dirname(stop), { recursive: true });
  fs.rmSync(stop, { force: true });
  fs.mkdirSync(path.join(BASE, "runner", "clear-requests"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "runner", "clear-requests", "abc123.json"), "{}");

  let s;
  assert.doesNotThrow(() => { s = clearbotStatus(); });
  assert.equal(s.running, null, "no powershell on this host -- unknown, not 0");
  assert.equal(s.killSwitchEngaged, false);
  assert.deepEqual(s.pending, ["abc123.json"]);
  assert.match(s.log, /clearbot\.log$/);

  fs.writeFileSync(stop, "stopped by hand\n");
  assert.equal(clearbotStatus().killSwitchEngaged, true);
  fs.rmSync(stop, { force: true });
});

// node --test hooks/status.test.mjs  (run from C:\code\guards)
//
// status.mjs re-exports budget.mjs's clearbotStatus and shells out to
// budget.mjs for fanout/unstop/clear-now, both of which resolve their ROOT
// from ACC_ROOT once, at import time (same documented caveat
// budget.unit.test.mjs's own header carries) -- each test that needs its own
// sandbox re-imports status.mjs fresh via a cache-busting query string,
// after setting ACC_ROOT/ACC_POLICY for that sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-status-test-"));

let loadSeq = 0;
async function loadStatus(root, policy) {
  process.env.ACC_ROOT = root;
  process.env.ACC_POLICY = policy;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "cfg");
  process.env.ACC_SCAN_CACHE = path.join(root, "scan-cache.json");
  fs.mkdirSync(path.join(root, "runner", "state"), { recursive: true });
  fs.mkdirSync(path.join(root, "runner", "clear-requests"), { recursive: true });
  fs.mkdirSync(path.join(root, "runner", "queued"), { recursive: true });
  fs.mkdirSync(path.join(root, "watcher"), { recursive: true });
  return import(`./status.mjs?t=${++loadSeq}`);
}

function sandbox(name) {
  const root = path.join(BASE, name, "root");
  const policy = path.join(BASE, name, "policy.json");
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  return { root, policy };
}

// ------------------------------------------------------------- spendingSummary
//
// status.mjs's static `import ... from "./usage.mjs"` means usage.mjs itself
// is cached across every status.mjs reimport in this process (a query-string
// cache-bust on status.mjs does NOT propagate to its own fixed import
// specifiers) -- so usage.mjs's CLAUDE_DIR (a module-level const, resolved
// once) stays pinned to whichever sandbox happened to be active at the
// FIRST loadStatus() call in this file, same documented gotcha
// budget.unit.test.mjs's own header carries for ACC_ROOT. Both
// spendingSummary tests below share ONE sandbox for exactly this reason,
// established by whichever runs first; ACC_POLICY still varies safely
// per-test since usage.mjs's loadPolicy() re-reads its path per call.
const spendSandbox = sandbox("spend-shared");

test("spendingSummary reports the live week tier and a rounded cost, with no scan when thresholds are 0", async () => {
  fs.writeFileSync(spendSandbox.policy, JSON.stringify({ week: { amberTokens: 0, redTokens: 0 } }));
  const S = await loadStatus(spendSandbox.root, spendSandbox.policy);
  const s = S.spendingSummary();
  assert.equal(s.tier, "green");
  assert.equal(s.weekTokens, 0);
  assert.equal(s.costUsd, 0);
  assert.equal(s.amberTokens, 0);
  assert.equal(s.redTokens, 0);
});

test("spendingSummary tier flips red once the real rolling total reaches redTokens", async () => {
  fs.writeFileSync(spendSandbox.policy, JSON.stringify({ week: { amberTokens: 500, redTokens: 1000 } }));
  const S = await loadStatus(spendSandbox.root, spendSandbox.policy);
  const proj = path.join(spendSandbox.root, "cfg", "projects", "p");
  fs.mkdirSync(proj, { recursive: true });
  const turn = JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { model: "claude-opus-5", usage: { input_tokens: 1200, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "x" }] },
  });
  fs.writeFileSync(path.join(proj, "s1.jsonl"), turn + "\n");
  const s = S.spendingSummary();
  assert.equal(s.tier, "red");
  assert.equal(s.weekTokens, 1200);
});

// Design spec §5's "global-status leakage" fix: a tiny, independently-
// pollable {tier, text} any page's shared header widget can ask for.
test("globalStatusSummary: green with no scan when thresholds are 0", async () => {
  fs.writeFileSync(spendSandbox.policy, JSON.stringify({ week: { amberTokens: 0, redTokens: 0 } }));
  const S = await loadStatus(spendSandbox.root, spendSandbox.policy);
  assert.deepEqual(S.globalStatusSummary(), { tier: "green", text: "week usage: green" });
});

test("globalStatusSummary: amber and red text carry the real rolling total", async () => {
  fs.writeFileSync(spendSandbox.policy, JSON.stringify({ week: { amberTokens: 500, redTokens: 1000 } }));
  const S = await loadStatus(spendSandbox.root, spendSandbox.policy);
  // spendSandbox is shared across every spendingSummary/globalStatusSummary
  // test in this file (usage.mjs's CLAUDE_DIR is pinned at its first import
  // -- see the sandbox-sharing comment above). weekTier() scans ALL
  // projects under it, so an earlier test's leftover transcript (the
  // "flips red" test's 1200-token session) would otherwise silently
  // contribute to this test's own total. Reset to a clean slate.
  fs.rmSync(path.join(spendSandbox.root, "cfg", "projects"), { recursive: true, force: true });
  const proj = path.join(spendSandbox.root, "cfg", "projects", "p2");
  fs.mkdirSync(proj, { recursive: true });
  const turn = (n) => JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { model: "claude-opus-5", usage: { input_tokens: n, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "x" }] },
  });

  fs.writeFileSync(path.join(proj, "amber.jsonl"), turn(600) + "\n");
  const amber = S.globalStatusSummary();
  assert.equal(amber.tier, "amber");
  assert.match(amber.text, /^week usage AMBER \(\d+%\)$/);

  fs.writeFileSync(path.join(proj, "red.jsonl"), turn(500) + "\n"); // 600+500=1100 >= redTokens
  const red = S.globalStatusSummary();
  assert.deepEqual(red, { tier: "red", text: "week usage RED — kill switch engaged" });
});

// ------------------------------------------------------------- ops policy

test("loadOpsPolicy defaults on a missing file, and deep-merges a partial one", async () => {
  const sb = sandbox("ops-load");
  const S = await loadStatus(sb.root, sb.policy);
  const defaults = S.loadOpsPolicy();
  assert.equal(defaults.context.softK, 400);
  assert.equal(defaults.subagents.mode, "allowlist");

  fs.writeFileSync(sb.policy, JSON.stringify({ context: { softK: 100 } }));
  const partial = S.loadOpsPolicy();
  assert.equal(partial.context.softK, 100, "the field actually set wins");
  assert.equal(partial.context.hardK, 600, "an omitted sibling field falls back to the default");
});

const GOOD_BLOCK = {
  context: { softK: 400, hardK: 600 },
  week: { amberTokens: 500, redTokens: 1000 },
  subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: 6, exploreMaxReportLines: 80 },
  review: { maxFinders: 3 },
};

test("saveOpsPolicy round-trips through the real file, preserving unrelated top-level keys (e.g. kernel)", async () => {
  const sb = sandbox("ops-save");
  fs.writeFileSync(sb.policy, JSON.stringify({ kernel: { harness: "claude-code" }, _note: "fixture" }));
  const S = await loadStatus(sb.root, sb.policy);
  const saved = S.saveOpsPolicy(GOOD_BLOCK);
  assert.equal(saved.context.softK, 400);
  assert.equal(saved.week.redTokens, 1000);
  assert.deepEqual(saved.subagents.allow, ["Explore"]);

  const onDisk = JSON.parse(fs.readFileSync(sb.policy, "utf8"));
  assert.equal(onDisk.kernel.harness, "claude-code", "an unrelated top-level block must survive the write");
  assert.equal(onDisk._note, "fixture");
  assert.equal(onDisk.context.hardK, 600);

  const leftovers = fs.readdirSync(path.dirname(sb.policy)).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no leftover .tmp- file after an atomic write");
});

test("saveOpsPolicy rejects a hardK not greater than softK, file untouched", async () => {
  const sb = sandbox("ops-invalid");
  fs.writeFileSync(sb.policy, JSON.stringify({ context: { softK: 400, hardK: 600 } }));
  const S = await loadStatus(sb.root, sb.policy);
  const before = fs.readFileSync(sb.policy, "utf8");
  assert.throws(
    () => S.saveOpsPolicy({ ...GOOD_BLOCK, context: { softK: 600, hardK: 400 } }),
    /hardK must be greater than.*softK/
  );
  assert.equal(fs.readFileSync(sb.policy, "utf8"), before);
});

test("saveOpsPolicy rejects an unknown subagents.mode and a negative maxFinders", async () => {
  const sb = sandbox("ops-invalid-2");
  fs.writeFileSync(sb.policy, JSON.stringify({}));
  const S = await loadStatus(sb.root, sb.policy);
  assert.throws(() => S.saveOpsPolicy({ ...GOOD_BLOCK, subagents: { ...GOOD_BLOCK.subagents, mode: "sometimes" } }), /subagents\.mode/);
  assert.throws(() => S.saveOpsPolicy({ ...GOOD_BLOCK, review: { maxFinders: -1 } }), /review\.maxFinders/);
});

test("saveOpsPolicy surfaces a clear error when the policy file itself is corrupt", async () => {
  const sb = sandbox("ops-corrupt");
  fs.writeFileSync(sb.policy, "{ not json");
  const S = await loadStatus(sb.root, sb.policy);
  assert.throws(() => S.saveOpsPolicy(GOOD_BLOCK), /ops policy: cannot edit/);
});

// ------------------------------------------------------------------ actions

test("clearbotStatus never throws, and reports a real count where powershell exists, null where it doesn't", async () => {
  const sb = sandbox("clearbot-status");
  const S = await loadStatus(sb.root, sb.policy);
  let s;
  assert.doesNotThrow(() => { s = S.clearbotStatus(); });
  // Real on a host with powershell (0 clearbot processes actually running,
  // correctly, in this fixture), null ("unknown") on one without -- both
  // are the honest answer for their host, not a fixed expectation.
  assert.ok(s.running === null || typeof s.running === "number");
  assert.equal(s.killSwitchEngaged, false);
  assert.deepEqual(s.pending, []);
});

test("stopRunnerNow writes the same bare stop-file budget.mjs's own stopRunner() writes", async () => {
  const sb = sandbox("stop-now");
  const S = await loadStatus(sb.root, sb.policy);
  const r = S.stopRunnerNow();
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(sb.root, "runner", "stop", "slice-runner.stop")));
});

test("unstopRunner clears the stop-file via budget.mjs's own unstop verb", async () => {
  const sb = sandbox("unstop");
  const S = await loadStatus(sb.root, sb.policy);
  S.stopRunnerNow();
  assert.ok(fs.existsSync(path.join(sb.root, "runner", "stop", "slice-runner.stop")));
  const r = S.unstopRunner();
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(sb.root, "runner", "stop", "slice-runner.stop")), false);
});

test("fanout grants a real time-boxed window via budget.mjs, and rejects a non-positive value before ever shelling out", async () => {
  const sb = sandbox("fanout");
  const S = await loadStatus(sb.root, sb.policy);
  const r = S.fanout(15);
  assert.equal(r.ok, true);
  const grant = JSON.parse(fs.readFileSync(path.join(sb.root, "runner", "state", "fanout.json"), "utf8"));
  assert.ok(grant.until > Date.now());

  assert.throws(() => S.fanout(0), /fanout minutes must be a positive number/);
  assert.throws(() => S.fanout("nope"), /fanout minutes must be a positive number/);
});

test("clearbotOp rejects an unknown op instead of shelling out with garbage", async () => {
  const sb = sandbox("clearbot-op");
  const S = await loadStatus(sb.root, sb.policy);
  assert.throws(() => S.clearbotOp("explode"), /unknown clearbot op/);
});

test("clearbotOp clear-now runs the real budget.mjs path (no consolePid captured yet -> a clean 'nothing to do' message, not a crash)", async () => {
  const sb = sandbox("clearbot-op-clearnow");
  const S = await loadStatus(sb.root, sb.policy);
  const r = S.clearbotOp("clear-now");
  assert.equal(r.ok, true);
});

// start/stop shell to Windows-only .cmd files -- on this Linux sandbox that's
// a real, expected ENOENT (no `cmd` binary), same "authored, not verifiable
// here" ceiling every other Windows-only path in this codebase carries. The
// point of this test isn't the specific error, it's that both branches are
// actually reachable code, not a typo'd op string that silently no-ops.
test("clearbotOp start/stop attempt the real .cmd files (Windows-only; ENOENT here is expected, not a bug)", async () => {
  const sb = sandbox("clearbot-op-startstop");
  const S = await loadStatus(sb.root, sb.policy);
  assert.throws(() => S.clearbotOp("start"));
  assert.throws(() => S.clearbotOp("stop"));
});

test("readRawPolicy strips a leading UTF-8 BOM before parsing", async () => {
  const sb = sandbox("bom");
  fs.writeFileSync(sb.policy, "﻿" + JSON.stringify({ context: { softK: 111 } }));
  const S = await loadStatus(sb.root, sb.policy);
  assert.equal(S.loadOpsPolicy().context.softK, 111);
});

test("saveOpsPolicy defaults exploreMaxReportLines when the caller omits it", async () => {
  const sb = sandbox("ops-save-explore-default");
  fs.writeFileSync(sb.policy, JSON.stringify({}));
  const S = await loadStatus(sb.root, sb.policy);
  const { exploreMaxReportLines, ...subagentsNoExplore } = GOOD_BLOCK.subagents;
  const saved = S.saveOpsPolicy({ ...GOOD_BLOCK, subagents: subagentsNoExplore });
  assert.equal(saved.subagents.exploreMaxReportLines, 80);
});

test("validateOpsBlock rejects every malformed field, one at a time, without ever writing", async () => {
  const sb = sandbox("ops-validate-sweep");
  fs.writeFileSync(sb.policy, JSON.stringify({}));
  const S = await loadStatus(sb.root, sb.policy);
  const before = fs.readFileSync(sb.policy, "utf8");
  const cases = [
    [{ context: { softK: 0, hardK: 600 } }, /context\.softK/],
    [{ context: { softK: 400, hardK: 0 } }, /context\.hardK/],
    [{ week: { amberTokens: -1, redTokens: 1000 } }, /week\.amberTokens/],
    [{ week: { amberTokens: 500, redTokens: -1 } }, /week\.redTokens/],
    [{ subagents: { ...GOOD_BLOCK.subagents, allow: "Explore" } }, /subagents\.allow/],
    [{ subagents: { ...GOOD_BLOCK.subagents, allow: [""] } }, /subagents\.allow/],
    [{ subagents: { ...GOOD_BLOCK.subagents, maxPerSession: -1 } }, /subagents\.maxPerSession/],
    [{ subagents: { ...GOOD_BLOCK.subagents, maxPerSession: 1.5 } }, /subagents\.maxPerSession/],
    // Whole sub-objects missing entirely (not just a bad value within one) --
    // every field access above is optional-chained (`block.context?.softK`)
    // specifically so a MISSING block never throws a raw TypeError instead
    // of this validator's own named error; each of these proves that.
    [{ context: undefined }, /context\.softK/],
    [{ week: undefined }, /week\.amberTokens/],
    [{ subagents: undefined }, /subagents\.mode/],
    [{ subagents: { mode: "allowlist", allow: undefined, maxPerSession: 6 } }, /subagents\.allow/],
    [{ subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: undefined } }, /subagents\.maxPerSession/],
    [{ review: undefined }, /review\.maxFinders/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(() => S.saveOpsPolicy({ ...GOOD_BLOCK, ...override }), pattern, `expected ${JSON.stringify(override)} to be rejected`);
  }
  assert.equal(fs.readFileSync(sb.policy, "utf8"), before, "no malformed case may ever reach disk");

  // "off" is the other legal subagents.mode besides "allowlist" -- prove the
  // validator's own allowlist of legal modes doesn't reject its own second
  // valid option.
  const saved = S.saveOpsPolicy({ ...GOOD_BLOCK, subagents: { ...GOOD_BLOCK.subagents, mode: "off" } });
  assert.equal(saved.subagents.mode, "off");
});

test("saveOpsPolicy rejects a non-object block, and a block missing every field entirely", async () => {
  const sb = sandbox("ops-validate-shape");
  fs.writeFileSync(sb.policy, JSON.stringify({}));
  const S = await loadStatus(sb.root, sb.policy);
  assert.throws(() => S.saveOpsPolicy(null), /block must be an object/);
  assert.throws(() => S.saveOpsPolicy("nope"), /block must be an object/);
  assert.throws(() => S.saveOpsPolicy({}), /context\.softK/, "a block missing every field fails on the first field checked");
});

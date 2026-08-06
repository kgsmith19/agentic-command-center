// Tests for the per-file bucket cache added to usage.mjs (OI-005).
//
// The cache exists to keep the transcript scan off the SessionStart critical
// path. What matters is that it cannot change a reported number, so every test
// here compares the cached path against an independent, deliberately naive
// aggregation of the same fixtures.
//
// Run: node --test hooks/usage.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


// Each test gets its own throwaway CLAUDE_CONFIG_DIR and cache file, so runs
// never touch the real transcript tree or the live scan-cache.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-usage-"));
  const projects = path.join(dir, "projects", "proj");
  fs.mkdirSync(projects, { recursive: true });
  return { dir, projects, cache: path.join(dir, "scan-cache.json") };
}

// Import usage.mjs fresh so it re-reads the env for this sandbox. The cache is
// module-level state, so a cache-busting query string is required per load.
let loadSeq = 0;
async function loadUsage(sb) {
  process.env.CLAUDE_CONFIG_DIR = sb.dir;
  process.env.ACC_SCAN_CACHE = sb.cache;
  return import(`./usage.mjs?t=${++loadSeq}`);
}

// Minimal assistant turn in transcript shape.
function turn(ts, { input = 0, out = 0, read = 0, create = 0 } = {}, model = "claude-opus-5") {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      model,
      usage: {
        input_tokens: input,
        output_tokens: out,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: create,
      },
    },
  });
}

function writeSession(sb, sid, lines) {
  fs.writeFileSync(path.join(sb.projects, `${sid}.jsonl`), lines.join("\n") + "\n");
}

// Independent oracle: sum the raw file, no buckets, no cache.
function naiveTotal(file, since) {
  let total = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    const o = JSON.parse(line);
    if (o.type !== "assistant" || !o.message?.usage) continue;
    const ms = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (since && ms && ms < since) continue;
    const u = o.message.usage;
    total +=
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
  }
  return total;
}

test("unwindowed totals match a naive sum of the same file", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn("2026-07-20T01:00:00.000Z", { input: 100, out: 10 }),
    turn("2026-07-20T02:00:00.000Z", { read: 500, create: 20 }),
    turn("2026-07-21T03:30:00.000Z", { input: 7, out: 3 }),
  ]);
  const file = path.join(sb.projects, "s1.jsonl");
  const got = u.totalTokens(u.totalsSince({ since: 0 }).main);
  assert.equal(got, naiveTotal(file, 0));
  assert.equal(got, 640);
});

test("a second scan hits the cache and returns the identical number", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn("2026-07-20T01:00:00.000Z", { input: 100, out: 10 }),
    turn("2026-07-20T02:00:00.000Z", { read: 500 }),
  ]);
  const first = u.totalTokens(u.totalsSince({ since: 0 }).main);
  assert.ok(fs.existsSync(sb.cache), "cache file written after a scan");
  const second = u.totalTokens(u.totalsSince({ since: 0 }).main);
  assert.equal(second, first);
});

test("appending to a transcript invalidates its cache entry", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  const file = path.join(sb.projects, "s1.jsonl");
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 100 })]);
  assert.equal(u.totalTokens(u.totalsSince({ since: 0 }).main), 100);

  fs.appendFileSync(file, turn("2026-07-20T01:30:00.000Z", { input: 50 }) + "\n");
  assert.equal(u.totalTokens(u.totalsSince({ since: 0 }).main), 150);
});

test("a windowed total is exact when `since` lands on an hour boundary", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn("2026-07-20T01:00:00.000Z", { input: 100 }), // before
    turn("2026-07-20T03:00:00.000Z", { input: 40 }), // at/after
    turn("2026-07-20T04:15:00.000Z", { input: 2 }), // after
  ]);
  const since = Date.parse("2026-07-20T03:00:00.000Z");
  const file = path.join(sb.projects, "s1.jsonl");
  const got = u.totalTokens(u.totalsSince({ since }).main);
  assert.equal(got, naiveTotal(file, since));
  assert.equal(got, 42);
});

test("`since` mid-hour is over-inclusive by at most that hour, never under", async () => {
  // The documented tradeoff: buckets are hourly, so `since` is floored to its
  // hour. A turn earlier in the same hour is counted. It must never DROP a turn
  // that belongs in the window - that would under-report spend and delay the
  // tier, which is the failure that actually costs money.
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn("2026-07-20T03:10:00.000Z", { input: 100 }), // same hour, before `since`
    turn("2026-07-20T03:50:00.000Z", { input: 40 }), // same hour, after `since`
  ]);
  const since = Date.parse("2026-07-20T03:30:00.000Z");
  const file = path.join(sb.projects, "s1.jsonl");
  const exact = naiveTotal(file, since); // 40
  const got = u.totalTokens(u.totalsSince({ since }).main);
  assert.equal(exact, 40);
  assert.equal(got, 140, "counts the whole hour");
  assert.ok(got >= exact, "never under-reports");
});

test("turns with no timestamp are always counted, windowed or not", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [
    turn(undefined, { input: 9 }),
    turn("2026-07-20T03:00:00.000Z", { input: 1 }),
  ]);
  const since = Date.parse("2026-07-20T03:00:00.000Z");
  assert.equal(u.totalTokens(u.totalsSince({ since }).main), 10);
});

test("a rates change invalidates the whole cache", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 1e6, out: 1e6 })]);
  const a = u.totalsSince({ since: 0 }).main.cost;
  assert.ok(a > 0, "cost is computed");

  const raw = JSON.parse(fs.readFileSync(sb.cache, "utf8"));
  raw.rates = "stale-rates-key";
  fs.writeFileSync(sb.cache, JSON.stringify(raw));

  const u2 = await loadUsage(sb);
  const b = u2.totalsSince({ since: 0 }).main.cost;
  assert.equal(b, a, "recomputed from source, same rates in policy, same cost");
});

test("a corrupt cache file is rebuilt rather than thrown on", async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.cache, "{not json");
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 42 })]);
  assert.equal(u.totalTokens(u.totalsSince({ since: 0 }).main), 42);
});

test("cache entries for deleted transcripts are pruned", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 1 })]);
  writeSession(sb, "s2", [turn("2026-07-20T01:00:00.000Z", { input: 1 })]);
  u.totalsSince({ since: 0 });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(sb.cache, "utf8")).files).length, 2);

  fs.unlinkSync(path.join(sb.projects, "s2.jsonl"));
  u.totalsSince({ since: 0 });
  const files = Object.keys(JSON.parse(fs.readFileSync(sb.cache, "utf8")).files);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith("s1.jsonl"));
});

test("costOfTranscript sums real cost/tokens for ONE file, matching an independent hand calc (Phase 1)", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  const file = path.join(sb.projects, "one.jsonl");
  fs.writeFileSync(
    file,
    [
      turn("2026-08-06T01:00:00.000Z", { input: 1000, out: 500 }, "claude-sonnet-5"),
      turn("2026-08-06T01:05:00.000Z", { input: 2000, out: 1000, read: 500 }, "claude-sonnet-5"),
    ].join("\n") + "\n"
  );
  const rates = { sonnet: { in: 3, out: 15 }, unknown: { in: 3, out: 15 } };
  const { costUsd, tokens } = u.costOfTranscript(file, rates);
  // Independent hand calc: turn1 = 1000*3 + 500*15 = 10500; turn2 = 2000*3 +
  // 1000*15 + 500*3*0.1(cache-read mult) = 6000+15000+150 = 21150. Total
  // 31650 / 1e6 = 0.03165.
  assert.ok(Math.abs(costUsd - 0.03165) < 1e-9, `expected ~0.03165, got ${costUsd}`);
  assert.equal(tokens, 1000 + 500 + 2000 + 1000 + 500); // input+output+cacheRead across both turns
});

test("costOfTranscript on a missing/unreadable file returns zero, not a throw", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  const { costUsd, tokens } = u.costOfTranscript(path.join(sb.projects, "nope.jsonl"), { unknown: { in: 3, out: 15 } });
  assert.equal(costUsd, 0);
  assert.equal(tokens, 0);
});

test("costOfTranscript defaults to the live policy's rates when none are passed", async () => {
  const sb = sandbox();
  process.env.ACC_POLICY = path.join(sb.dir, "policy.json");
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ rates: { unknown: { in: 1, out: 1 } } }));
  const u = await loadUsage(sb);
  const file = path.join(sb.projects, "d.jsonl");
  fs.writeFileSync(file, turn("2026-08-06T01:00:00.000Z", { input: 1000000 }, "some-unknown-model") + "\n");
  const { costUsd } = u.costOfTranscript(file);
  assert.equal(costUsd, 1); // 1,000,000 input tokens * $1/M
  delete process.env.ACC_POLICY;
});

test("Phase 4 D1: loadPolicy deep-merges runner/subagents/review field-by-field, same treatment as context/week/rates", async () => {
  const sb = sandbox();
  process.env.ACC_POLICY = path.join(sb.dir, "policy.json");
  // A REALISTIC partial policy: runner.statusFile is customized, everything
  // else in that block (and subagents/review entirely) is left unset --
  // exactly the shape a hand-edit or a stale file produces.
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ runner: { statusFile: "CUSTOM.md" } }));
  const u = await loadUsage(sb);
  const p = u.loadPolicy();
  assert.equal(p.runner.statusFile, "CUSTOM.md", "the field actually set in policy.json wins");
  assert.equal(p.runner.stopOnRed, true, "a field NOT set falls back to the default rather than being undefined");
  assert.equal(p.runner.waitingGuard, true, "same for a second omitted field in the same partially-set block");
  assert.deepEqual(p.subagents.allow, [], "a block entirely absent from policy.json still gets its full default");
  assert.equal(p.review.maxFinders, 1);
  delete process.env.ACC_POLICY;
});

test("Phase 4 D1: DEFAULT_POLICY's runner/subagents/review are conservative, not a copy of a real policy.json's generous grants", async () => {
  const sb = sandbox();
  process.env.ACC_POLICY = path.join(sb.dir, "does-not-exist.json"); // forces the catch -> DEFAULT_POLICY
  const u = await loadUsage(sb);
  const p = u.loadPolicy();
  assert.deepEqual(p.subagents.allow, [], "no subagent is pre-granted by a fallback the operator never configured");
  assert.equal(p.subagents.maxPerSession, 1);
  assert.equal(p.review.maxFinders, 1);
  delete process.env.ACC_POLICY;
});

test("Phase 5: weekTier short-circuits to green with NO scan when both thresholds are 0 (disabled)", async () => {
  const sb = sandbox();
  process.env.ACC_POLICY = path.join(sb.dir, "policy.json");
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ week: { amberTokens: 0, redTokens: 0 } }));
  const u = await loadUsage(sb);
  // A huge, expensive-to-scan transcript that would trip a real threshold if
  // scanning ever happened -- proves the short-circuit skips the scan
  // entirely rather than merely landing on green by coincidence.
  writeSession(sb, "huge", [turn("2026-08-06T01:00:00.000Z", { input: 999_999_999 })]);
  assert.deepEqual(u.weekTier(), { tier: "green", weekTokens: 0, pct: 0, redTokens: 0 });
  delete process.env.ACC_POLICY;
});

test("Phase 5: weekTier reports red once the real rolling total reaches redTokens", async () => {
  const sb = sandbox();
  process.env.ACC_POLICY = path.join(sb.dir, "policy.json");
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ week: { amberTokens: 500, redTokens: 1000 } }));
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn(new Date().toISOString(), { input: 1200 })]);
  const t = u.weekTier();
  assert.equal(t.tier, "red");
  assert.equal(t.weekTokens, 1200);
  delete process.env.ACC_POLICY;
});

test("Phase 3: accActive() is true when ANY of ACC_SESSION/ACC_GOAL/ACC_PROFILE/ACC_PTY is set, false when none are", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  const VARS = ["ACC_SESSION", "ACC_GOAL", "ACC_PROFILE", "ACC_PTY"];
  const saved = {};
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    assert.equal(u.accActive(), false, "none set -> inactive");
    process.env.ACC_SESSION = "1";
    assert.equal(u.accActive(), true, "ACC_SESSION=1");
    delete process.env.ACC_SESSION;

    process.env.ACC_GOAL = "g-1";
    assert.equal(u.accActive(), true, "ACC_GOAL set");
    delete process.env.ACC_GOAL;

    process.env.ACC_PROFILE = "Normal";
    assert.equal(u.accActive(), true, "ACC_PROFILE set");
    delete process.env.ACC_PROFILE;

    process.env.ACC_PTY = "some-pipe-name";
    assert.equal(u.accActive(), true, "ACC_PTY set");
    delete process.env.ACC_PTY;

    process.env.ACC_SESSION = "0"; // present but not "1" must NOT count as active
    assert.equal(u.accActive(), false, "ACC_SESSION=0 is not active");
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

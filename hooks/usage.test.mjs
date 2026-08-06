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

// ONE module instance for every test, deliberately. This used to re-import
// under `./usage.mjs?t=${n}` so each test got a module that had re-read the env
// for its own sandbox — but node's lcov merge is last-write-wins per file path,
// not a union, so every one of those instances threw away the previous one's
// coverage and this file's real numbers were never reported (the same trap
// OI-006 found in the standing-order suite). usage.mjs now resolves CLAUDE_CONFIG_DIR,
// ACC_SCAN_CACHE and ACC_POLICY on every call and reloads its cache when the
// path changes, so pointing the env at a fresh sandbox is all a test needs.
const m = await import("./usage.mjs");

async function loadUsage(sb) {
  process.env.CLAUDE_CONFIG_DIR = sb.dir;
  process.env.ACC_SCAN_CACHE = sb.cache;
  return m;
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

// --------------------------------------------------------- the week kill switch
//
// tierFor is what budget.mjs's weekTier() agrees with, and a RED tier holds
// EVERY standing-order resume. A wrong answer here either burns Kyle's week
// silently or freezes autonomy for no reason, so the thresholds get boundary
// tests rather than a happy-path one.

function withPolicy(sb, week) {
  const p = path.join(sb.dir, "policy.json");
  fs.writeFileSync(p, JSON.stringify({ week, rates: { opus: { in: 15, out: 75 } } }));
  process.env.ACC_POLICY = p;
  return p;
}

function captured(fn) {
  const realLog = console.log;
  const realErr = console.error;
  let out = "";
  console.log = (...a) => { out += a.join(" ") + "\n"; };
  console.error = (...a) => { out += a.join(" ") + "\n"; };
  try {
    const code = fn();
    return { out, code };
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

test("the week tier is green below amber, amber AT the line, red AT the line", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  withPolicy(sb, { amberTokens: 100, redTokens: 200, effectiveFrom: "" });
  // Drive through main() so the reported number is the one the CLI really emits.
  const at = (tokens) => {
    writeSession(sb, "s1", [turn(new Date().toISOString(), { input: tokens })]);
    fs.rmSync(sb.cache, { force: true });
    return JSON.parse(captured(() => m.main(["check"])).out);
  };
  assert.equal(at(99).tier, "green");
  assert.equal(at(100).tier, "amber", "amber is >=, not >");
  assert.equal(at(200).tier, "red", "red is >=, not >");
});

test("thresholds left at 0 disable the kill switch rather than firing it", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  withPolicy(sb, { amberTokens: 0, redTokens: 0, effectiveFrom: "" });
  writeSession(sb, "s1", [turn(new Date().toISOString(), { input: 999999999 })]);
  const r = JSON.parse(captured(() => m.main(["check"])).out);
  assert.equal(r.tier, "green", "unset thresholds must fail visible-and-open, never closed");
  assert.equal(r.pct, 0);
});

test("the tier window never reaches back past week.effectiveFrom", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  const threeDaysAgo = new Date(Date.now() - 3 * 864e5).toISOString();
  // Burn from before the budget discipline existed: inside the rolling 7 days,
  // but before effectiveFrom, so the kill switch must not count it.
  withPolicy(sb, { amberTokens: 50, redTokens: 100, effectiveFrom: new Date(Date.now() - 864e5).toISOString() });
  writeSession(sb, "s1", [turn(threeDaysAgo, { input: 100000 })]);
  const r = JSON.parse(captured(() => m.main(["check"])).out);
  assert.equal(r.tier, "green", "pre-effectiveFrom burn must not fire the kill switch retroactively");
});

// ------------------------------------------------------------------ the CLI

test("an unknown command prints usage and exits 1; no command at all exits 0", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  const bad = captured(() => m.main(["nonsense"]));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /week\|sessions/);
  assert.equal(captured(() => m.main([])).code, 0, "bare invocation is help, not an error");
});

test("context with no file argument refuses instead of reporting zero", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  const r = captured(() => m.main(["context"]));
  assert.equal(r.code, 1);
  assert.match(r.out, /usage: usage\.mjs context/);
});

test("context reports the LAST turn's size and the FIRST turn's, not one number twice", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  const ts = new Date().toISOString();
  writeSession(sb, "s1", [turn(ts, { input: 10, read: 5 }), turn(ts, { input: 900, read: 100 })]);
  const file = path.join(sb.projects, "s1.jsonl");
  const r = captured(() => m.main(["context", file]));
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { context: 1000, startContext: 15 });
});

test("the reports render over real fixtures without throwing", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  withPolicy(sb, { amberTokens: 0, redTokens: 0, effectiveFrom: "" });
  writeSession(sb, "s1", [turn(new Date().toISOString(), { input: 1000, out: 200, read: 50 })]);
  for (const argv of [["week"], ["sessions", "--top", "5"], ["clears"]]) {
    const r = captured(() => m.main(argv));
    assert.equal(r.code, 0, `${argv[0]} exits clean`);
    assert.ok(r.out.length > 0, `${argv[0]} produced a report`);
  }
});

test("--project filters the scan rather than being silently ignored", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  withPolicy(sb, { amberTokens: 1, redTokens: 2, effectiveFrom: "" });
  writeSession(sb, "s1", [turn(new Date().toISOString(), { input: 500 })]);
  const matched = JSON.parse(captured(() => m.main(["check", "--project", "proj"])).out);
  const missed = JSON.parse(captured(() => m.main(["check", "--project", "no-such-project"])).out);
  assert.ok(matched.weekTokens > 0, "a matching filter still sees the session");
  assert.equal(missed.weekTokens, 0, "a non-matching filter must exclude it, not fall back to everything");
});

// ------------------------------------------------------------------- policy

test("an unreadable policy.json falls back to defaults with the kill switch DISABLED", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  process.env.ACC_POLICY = path.join(sb.dir, "does-not-exist.json");
  const p = m.loadPolicy();
  assert.equal(p.context.hardK, 600, "the standing context dials survive a missing policy");
  assert.equal(p.week.redTokens, 0, "an unknown limit must not be guessed");
});

test("a corrupt policy.json is treated as missing, not as empty limits on a real file", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  const p = path.join(sb.dir, "policy.json");
  fs.writeFileSync(p, "{ this is not json");
  process.env.ACC_POLICY = p;
  assert.equal(m.loadPolicy().context.hardK, 600);
});

test("an unknown profile name leaves the limits exactly as they were", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  const base = { context: { softK: 1, hardK: 2 }, subagents: { maxPerSession: 3 } };
  process.env.ACC_PROFILE = "no-such-profile";
  try {
    assert.deepEqual(m.applyProfile(base), base, "an unknown name must never weaken a limit");
  } finally {
    delete process.env.ACC_PROFILE;
  }
});

// -------------------------------------------------- fault tolerance of the scan
//
// This module reads a transcript tree that Claude Code is APPENDING TO while it
// reads. Torn lines, files that vanish mid-scan and a projects directory that
// does not exist yet are all normal, not exotic — and every one of them must
// degrade to a number, never to a throw, because budget.mjs's Stop hook calls
// through here on the path that decides whether to clear a session.

test("a torn last line does not abort the scan of the rest of the file", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  const good = turn("2026-07-20T01:00:00.000Z", { input: 100 });
  // Exactly what a transcript looks like mid-append: a complete turn, then a
  // partially-flushed one.
  fs.writeFileSync(path.join(sb.projects, "s1.jsonl"), good + "\n" + '{"type":"assist');
  assert.equal(u.totalTokens(u.totalsSince({ since: 0 }).main), 100);
});

test("a transcript that cannot be read counts as zero, not as a crash", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  assert.equal(u.contextOf(path.join(sb.projects, "gone.jsonl")), 0);
  assert.equal(u.startContextOf(path.join(sb.projects, "gone.jsonl")), 0);
});

test("a transcript with no assistant turns has a start context of zero", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", ['{"type":"user","message":{}}']);
  assert.equal(u.startContextOf(path.join(sb.projects, "s1.jsonl")), 0);
});

test("a projects directory that does not exist yet scans to zero", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  process.env.CLAUDE_CONFIG_DIR = path.join(sb.dir, "no-such-config-dir");
  assert.equal(u.totalsSince({ since: 0 }).sessions.length, 0);
});

test("a cache that cannot be written still reports the right number", async () => {
  const sb = sandbox();
  // A directory where the cache file should be: every write fails, and the
  // module's own comment promises that cannot change a reported number.
  const blocked = path.join(sb.dir, "blocked-cache");
  fs.mkdirSync(blocked, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = sb.dir;
  process.env.ACC_SCAN_CACHE = blocked;
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 77 })]);
  assert.equal(m.totalTokens(m.totalsSince({ since: 0 }).main), 77);
});

// ------------------------------------------------------------- cost attribution

test("an unrecognised model is costed at the unknown rate rather than crashing", async () => {
  const sb = sandbox();
  const u = await loadUsage(sb);
  writeSession(sb, "s1", [turn("2026-07-20T01:00:00.000Z", { input: 1e6 }, "some-future-model-9")]);
  const agg = u.totalsSince({ since: 0 }).main;
  assert.ok(agg.cost > 0, "a model nobody has heard of still costs something");
  assert.ok("unknown" in agg.byModel, "and is attributed to the unknown family");
});

// ------------------------------------------------------------------- profiles

test("a KNOWN profile overrides the dials it names and leaves the rest alone", async () => {
  const sb = sandbox();
  await loadUsage(sb);
  const base = {
    context: { softK: 400, hardK: 600 },
    subagents: { mode: "allowlist", maxPerSession: 6 },
    profiles: { tight: { subagents: { maxPerSession: 1 } } },
  };
  process.env.ACC_PROFILE = "tight";
  try {
    const out = m.applyProfile(base);
    assert.equal(out.subagents.maxPerSession, 1, "the named dial is overridden");
    assert.equal(out.subagents.mode, "allowlist", "unnamed dials survive the merge");
    assert.deepEqual(out.context, base.context, "a profile with no context block leaves context alone");
    assert.equal(out.activeProfile, "tight");
  } finally {
    delete process.env.ACC_PROFILE;
  }
});

// -------------------------------------------------------------- process anchor

test("the pty anchor skips shell wrappers and names the first real process", () => {
  assert.equal(
    m.ptyAnchorPid([{ pid: 1, name: "bash.exe" }, { pid: 2, name: "cmd.exe" }, { pid: 3, name: "claude.exe" }]),
    3,
    "a dead transient shell must never be recorded as the console pid",
  );
  assert.equal(m.ptyAnchorPid([{ pid: 9, name: "bash.exe" }]), 9, "all-shells falls back to the nearest");
});

test("ancestorChain returns a walkable chain, or [] rather than throwing", () => {
  const chain = m.ancestorChain();
  assert.ok(Array.isArray(chain), "callers fall back to ppid on [], so it must always be an array");
  for (const p of chain) assert.equal(typeof p.pid, "number");
});

test("ancestorChain returns [] when powershell cannot be run at all", () => {
  // The real case is a POSIX machine, where there is no powershell to spawn.
  // Callers fall back to process.ppid on [], so this path must not throw — and
  // emptying PATH is the one way to reproduce it on Windows.
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.deepEqual(m.ancestorChain(), []);
  } finally {
    process.env.PATH = realPath;
  }
});

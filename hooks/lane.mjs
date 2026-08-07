#!/usr/bin/env node
// lane.mjs — machine-wide launch lane for real-API claude spawns.
//
// THE JAM (2026-07-31): runner.mjs (claude -p per board task), e2e/loop.e2e.mjs
// (real TUI sessions), the directive loop, and Kyle's interactive sessions all open
// API streams from one account with zero coordination. Concurrent bursts die in
// transport as "Unable to connect to API (econnreset)" — the edge resets the
// socket instead of returning a clean 429. The fix is not "retry harder"; it is
// the standard layers for loops against a rate-limited/overloaded API:
//   1. bounded concurrency — a cross-process semaphore, at most N real
//      sessions launched by automation at once (default 1);
//   2. start pacing — a minimum gap between launches, so N slots never means
//      "N connections on the same tick";
//   3. retry with exponential backoff + FULL JITTER — for the residue that
//      still dies in transport. Transport failures ONLY: a logic failure
//      (assertion, bad exit, model refusing) is returned untouched, because
//      retrying a real bug just spends tokens hiding it. 529 (model-layer
//      overload, not account-specific) gets a longer base delay than 429/
//      network errors — hammering an overloaded model faster only adds load;
//   4. a circuit breaker — enough transport failures in a short window means
//      something is actually down, not just contended. New automated
//      launches hold until the breaker cools down instead of retrying into a
//      known-bad API.
//
// THE SECOND JAM (2026-08-01): the above only ever wrapped AUTOMATED headless
// launches (runner.mjs, e2e). Kyle's interactive GUI launches (guards-gui.ps1
// Go button, Terminal tab) spawned `claude` with zero coordination at all —
// confirmed by grep, no `lane.mjs` import anywhere in that file. Pressing Go
// while runner.mjs or e2e held the automation slot (or while Kyle had another
// manual terminal open) could put 2-3+ concurrent streams on the wire with no
// pacing between them — the same failure shape, just from a path nothing here
// was watching. Fix: a second, fully independent CATEGORY —  "interactive" —
// with its own slot dir and its own pacing, so automation and interactive
// launches never compete for the same slot. Neither queues behind the other;
// each is still capped against itself. The breaker is shared (it reflects
// real API health, not who's asking) but only BLOCKS automation — a human who
// already decided to launch should be warned, never queued, per the original
// design note below.
//
// A category is just a subdirectory of the lane root: omit it (or pass
// undefined) and behavior is byte-identical to the original automation-only
// lane — same paths, same tests. Pass "interactive" (or any other string) to
// get a fully separate slot pool with its own dials (policy.json `lane.
// interactive`, falling back to the shared `lane` dials for anything it
// doesn't override).
//
// Interactive launches deliberately do NOT take the AUTOMATION lane — a human
// launch must never queue behind a three-hour runner hold; humans are
// self-pacing, loops are not. They DO now take their own interactive lane, so
// two GUI-launched sessions can't stack on each other either.
//
// STATE lives OUTSIDE ACC_ROOT, in os.tmpdir()/acc-lane (override:
// ACC_LANE_DIR — the lane's own tests sandbox with it). This is deliberate:
// e2e sandboxes redirect ACC_ROOT, and a lane that moved with it would let a
// sandboxed harness and the live runner spawn concurrently — the exact jam
// this file exists to prevent. One machine, one account, one lane root
// (categories are subdirectories of it, not separate roots).
//
// A slot is a DIRECTORY (mkdir is atomic on every platform); owner.json inside
// records {pid, label, at, ttlMs}. A slot is stale when its owner pid is dead
// or its own declared ttl has passed — so a crashed holder never wedges the
// lane, and pid-reuse cannot hold it past the ttl. Dials in policy.json
// `lane`, re-read on every acquire like every other hook's config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = () => process.env.ACC_POLICY || path.join(HERE, "..", "policy.json");
const LANE_DIR = () => process.env.ACC_LANE_DIR || path.join(os.tmpdir(), "acc-lane");

const DEFAULTS = {
  slots: 1,          // concurrent automated sessions. 1 = strict serial.
  minGapMs: 3000,    // pause between launches even when a slot is free
  retries: 2,        // transport retries per run (attempts = retries + 1)
  backoffBaseMs: 2000,
  overloadBaseMs: 4000, // base delay for 529/overloaded_error specifically — a
                        // model-layer overload; retrying faster just adds load.
  backoffCapMs: 30000,
  pollMs: 500,       // slot-wait poll interval (jittered)
  slotTtlMs: 30 * 60 * 1000, // default hold ceiling; callers with long runs pass their own
  breakerThreshold: 3,      // this many transport failures in the window...
  breakerWindowMs: 5 * 60 * 1000,   // ...trips the breaker...
  breakerCooldownMs: 2 * 60 * 1000, // ...for this long since the LAST failure.
  breakerBlocking: true,    // does a tripped breaker hold NEW acquires in this
                             // category? automation: yes. interactive: no
                             // (see acquireSlot's bypassBreaker option) —
                             // policy.json can override per category.
};

// laneConfig() — no category — is byte-identical to the original: reads the
// flat `lane` object from policy.json. laneConfig(category) additionally
// layers `lane[category]` on top, so `lane.interactive` can override just the
// dials that differ (slots, minGapMs, breakerBlocking) while inheriting
// everything else (retries, backoff shape, breaker window) from the shared
// block. A category key with no matching object in policy.json (or none at
// all) is simply ignored — every category always falls back to DEFAULTS.
export function laneConfig(category) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(POLICY(), "utf8").replace(/^﻿/, "")).lane || {}; } catch {}
  const base = { ...DEFAULTS, ...raw };
  if (!category) return base;
  const scoped = (raw && typeof raw[category] === "object" && raw[category]) || {};
  return { ...base, ...scoped };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// EPERM means "alive but not ours" — on Windows and POSIX both.
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function ownerOf(slotDir) {
  try { return JSON.parse(fs.readFileSync(path.join(slotDir, "owner.json"), "utf8")); } catch { return null; }
}

// Stale = reclaimable. An unreadable owner.json counts once it is older than a
// grace beat (the writer may be mid-write); a dead pid or an expired ttl
// counts immediately.
function isStale(slotDir) {
  const o = ownerOf(slotDir);
  if (!o) {
    try { return Date.now() - fs.statSync(slotDir).mtimeMs > 10000; } catch { return true; }
  }
  if (!pidAlive(o.pid)) return true;
  const ttl = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : DEFAULTS.slotTtlMs;
  return Date.now() - Date.parse(o.at || 0) > ttl;
}

// `pid` defaults to the calling process — the normal in-process acquire path.
// The CLI (bottom of file) passes an explicit pid so a short-lived `node
// hooks/lane.mjs try-acquire` invocation can hand a slot to a LONG-LIVED
// process it doesn't own (a GUI-spawned claude session) without holding the
// slot open itself.
function tryTake(slotDir, label, ttlMs, pid = process.pid) {
  try {
    fs.mkdirSync(slotDir);
  } catch {
    if (!isStale(slotDir)) return false;
    // Reclaim, then race for it again — losing the race is fine, someone won.
    try { fs.rmSync(slotDir, { recursive: true, force: true }); fs.mkdirSync(slotDir); } catch { return false; }
  }
  fs.writeFileSync(
    path.join(slotDir, "owner.json"),
    JSON.stringify({ pid, label, at: new Date().toISOString(), ttlMs })
  );
  return true;
}

// The root directory a category's slots live under. No category (undefined)
// is the lane root itself — this is what keeps every pre-existing automation
// path and test byte-identical to before categories existed.
function categoryRoot(category) {
  return category ? path.join(LANE_DIR(), category) : LANE_DIR();
}

// Everyone currently holding a slot in a category — for wait logs and the
// statusline. No category = automation (the original, pre-category root).
export function laneStatus(category) {
  const dir = categoryRoot(category);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith("slot-")); } catch {}
  return names.map((n) => ({ slot: n, ...(ownerOf(path.join(dir, n)) || {}) }));
}

// The full picture for the CLI / GUI status display: both known categories
// plus breaker state, in one call.
export function laneStatusAll() {
  return { automation: laneStatus(), interactive: laneStatus("interactive"), breaker: breakerState() };
}

// Start pacing. Read-modify-write with no lock: with slots=1 it is exact; with
// slots>1 a race can only SHORTEN one gap, never stack launches on a tick,
// which is all the gap is for. Paced PER CATEGORY (its own last-start.json)
// so an interactive launch is never paced against automation's clock or vice
// versa.
async function paceStart(cfg, onLog, root) {
  const stamp = path.join(root, "last-start.json");
  let last = 0;
  try { last = Number(JSON.parse(fs.readFileSync(stamp, "utf8")).t) || 0; } catch {}
  const wait = last + cfg.minGapMs - Date.now();
  if (wait > 0) {
    onLog?.(`lane: pacing start, ${wait}ms behind the previous launch`);
    await sleep(wait + Math.floor(Math.random() * 250));
  }
  try { fs.writeFileSync(stamp, JSON.stringify({ t: Date.now() })); } catch {}
}

// ---------------------------------------------------------------- breaker
// Shared machine-wide signal, independent of category — it reflects whether
// the real API is healthy, not who happens to be asking. State: LANE_DIR()/
// breaker.json, a rolling list of failure timestamps trimmed to the window.
function breakerFile() {
  return path.join(LANE_DIR(), "breaker.json");
}

function readBreakerRaw() {
  try {
    const j = JSON.parse(fs.readFileSync(breakerFile(), "utf8"));
    return { failures: Array.isArray(j.failures) ? j.failures.map(Number).filter((n) => Number.isFinite(n)) : [] };
  } catch { return { failures: [] }; }
}

// Called once per transport-classified failure (see retryTransport). Trims to
// the window on write, so the file never grows unbounded.
export function recordTransportFailure(cause) {
  const cfg = laneConfig();
  const cutoff = Date.now() - cfg.breakerWindowMs;
  const failures = readBreakerRaw().failures.filter((t) => t > cutoff);
  failures.push(Date.now());
  try {
    fs.mkdirSync(LANE_DIR(), { recursive: true });
    fs.writeFileSync(breakerFile(), JSON.stringify({ failures, lastCause: cause || null }));
  } catch {}
}

// Tripped iff >= threshold failures fall inside the window AND the most
// recent one is still inside the cooldown — so the breaker self-clears once
// the API has been quiet for `cooldownMs`, even if older entries are still
// technically "in window".
export function breakerState() {
  const cfg = laneConfig();
  const cutoff = Date.now() - cfg.breakerWindowMs;
  const inWindow = readBreakerRaw().failures.filter((t) => t > cutoff);
  const last = inWindow.length ? Math.max(...inWindow) : 0;
  const tripped = inWindow.length >= cfg.breakerThreshold && Date.now() - last < cfg.breakerCooldownMs;
  return { tripped, count: inWindow.length, threshold: cfg.breakerThreshold, windowMs: cfg.breakerWindowMs, cooldownMs: cfg.breakerCooldownMs };
}

export function breakerReset() {
  try { fs.rmSync(breakerFile(), { force: true }); } catch {}
}

// Hold new acquires open while the breaker is tripped (blocking categories,
// i.e. automation) or just log a warning and proceed (non-blocking
// categories, i.e. interactive — a human already decided to launch).
async function waitForBreaker(cfg, onLog) {
  if (cfg.breakerBlocking === false) {
    const b = breakerState();
    if (b.tripped) onLog?.(`lane: circuit breaker open (${b.count} transport failures in the last ${Math.round(b.windowMs / 1000)}s) — proceeding anyway`);
    return;
  }
  let noted = false;
  for (;;) {
    const b = breakerState();
    if (!b.tripped) return;
    if (!noted) {
      onLog?.(`lane: circuit breaker open (${b.count} transport failures in the last ${Math.round(b.windowMs / 1000)}s) — holding new launches`);
      noted = true;
    }
    await sleep(cfg.pollMs + Math.floor(Math.random() * cfg.pollMs));
  }
}

// ---------------------------------------------------------------- acquire
export async function acquireSlot(label, { ttlMs, onLog, category } = {}) {
  const cfg = laneConfig(category);
  const root = categoryRoot(category);
  fs.mkdirSync(root, { recursive: true });
  const ttl = ttlMs || cfg.slotTtlMs;

  await waitForBreaker(cfg, onLog);

  let lastNote = 0;
  for (;;) {
    for (let i = 0; i < Math.max(1, cfg.slots); i++) {
      const slotDir = path.join(root, `slot-${i}`);
      if (tryTake(slotDir, label, ttl)) {
        await paceStart(cfg, onLog, root);
        return {
          slot: i,
          release: () => { try { fs.rmSync(slotDir, { recursive: true, force: true }); } catch {} },
        };
      }
    }
    if (Date.now() - lastNote > 15000) {
      lastNote = Date.now();
      const held = laneStatus(category).map((s) => `${s.label || "?"}(${s.pid || "?"})`).join(", ");
      onLog?.(`lane: waiting for a slot — held by ${held || "unknown"}`);
    }
    await sleep(cfg.pollMs + Math.floor(Math.random() * cfg.pollMs));
  }
}

// The only call sites should ever need: hold a slot exactly as long as fn runs.
export async function withLaunchSlot(label, fn, opts = {}) {
  const slot = await acquireSlot(label, opts);
  try { return await fn(); } finally { slot.release(); }
}

// Transport-class failure, or null. Deliberately matched against the FAILURE
// TEXT, not the exit code: exit codes say "failed", only the text says WHY,
// and only the why decides whether a retry can possibly help.
export function transportFailure(text) {
  const m = String(text || "").match(
    /econn(reset|refused|aborted)|etimedout|epipe|socket hang up|fetch failed|network error|unable to connect|connection (reset|refused|closed|error)|overloaded|rate.?limit|too many requests|api error.{0,40}\b(429|500|502|503|504|529)\b|\b(429|529)\b/i
  );
  return m ? m[0] : null;
}

// Run `run` up to attempts times, backing off between TRANSPORT failures only.
// Returns the last result either way — callers keep their existing failure
// handling; the lane never converts a failure into a throw. Every transport
// failure is also recorded to the shared circuit breaker, win or lose.
//   failed(r) — is this result a failure at all (default: r.code !== 0)
//   textOf(r) — where the failure text lives (default: err + result)
export async function retryTransport(label, run, opts = {}) {
  const cfg = laneConfig(opts.category);
  const attempts = Math.max(1, (opts.retries ?? cfg.retries) + 1);
  const failed = opts.failed || ((r) => !r || r.code !== 0);
  const textOf = opts.textOf || ((r) => `${r?.err || ""} ${r?.result || ""}`);
  // attempts is always >= 1 (Math.max above), and every iteration returns
  // via one of the two lines inside the loop — the last iteration always
  // satisfies `i === attempts - 1`, so the loop can never fall through.
  // Unbounded `for (;;)` on purpose, not `i < attempts`: a bounded condition
  // would give V8 a "loop exhausted normally" branch to instrument that can
  // never actually be taken — dead code covergate's own branch floor caught
  // twice on 2026-08-01 (first the trailing `return r`, then this). The
  // honest fix is to stop implying an exit path that cannot happen, not to
  // manufacture a test for one.
  let r;
  for (let i = 0; ; i++) {
    r = await run();
    if (!failed(r)) return r;
    const cause = transportFailure(textOf(r));
    if (!cause) return r; // real failure — never recorded, never retried
    recordTransportFailure(cause);
    if (i === attempts - 1) return r; // out of tries
    const overload = /overloaded|529/i.test(cause);
    const base = overload ? (opts.overloadBaseMs ?? cfg.overloadBaseMs) : (opts.backoffBaseMs ?? cfg.backoffBaseMs);
    const cap = opts.backoffCapMs ?? cfg.backoffCapMs;
    // FULL jitter (AWS's "Exponential Backoff And Jitter" guidance), not
    // equal jitter: delay is uniform over [0, ceiling], not [0.5, 1] of it —
    // the wider spread is what actually breaks up a thundering herd of
    // callers that all failed on the same tick.
    const ceiling = Math.min(cap, base * 2 ** i);
    const delay = Math.round(Math.random() * ceiling);
    opts.onLog?.(`lane: transport failure (${cause}) — retry ${i + 1}/${attempts - 1} for ${label} in ${delay}ms${overload ? " [overload backoff]" : ""}`);
    await sleep(delay);
  }
}

// ------------------------------------------------------------- launch cap
// Machine-wide ceiling on concurrent claude.exe, independent of the lane
// slots above (those are cooperative; this is enforced at every claude
// resolution via the shim — see shim/claude.cmd). Policy: policy.json
// lane.total.{cap, exe}. No cap/exe configured = fail open (gate() below).
const UTILITY_ARGS = new Set(["--version", "-v", "--help", "-h", "doctor", "update", "install", "mcp", "config"]);

// Subcommands/flags that never start a session — these bypass the cap
// entirely, uncounted, so `claude --version` never queues behind a busy
// machine.
export function isUtilityInvocation(args) {
  const first = args && args[0];
  return first != null && UTILITY_ARGS.has(String(first));
}

// One real Win32_Process query, filtered by NAME only (path-filtering happens
// in countCappedProcesses) — Name alone would also match the unrelated
// desktop app's claude.exe, which is exactly why the caller must filter by
// ExecutablePath afterward.
export function queryClaudeProcesses() {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
    "Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress -Depth 3";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const trimmed = out.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Matched by absolute exe PATH, never by image name — claude.exe is also the
// name of the (separate, unrelated) desktop app's bundled binary at a
// different path, which must never count against this cap.
export function countCappedProcesses(exePaths, listProcesses = queryClaudeProcesses) {
  const procs = listProcesses() || [];
  const wanted = new Set((exePaths || []).map((p) => String(p).toLowerCase()));
  return procs.filter((p) => p && p.ExecutablePath && wanted.has(String(p.ExecutablePath).toLowerCase()));
}

function laneLabelForPid(pid) {
  const all = laneStatusAll();
  for (const list of [all.automation, all.interactive]) {
    const hit = list.find((s) => Number(s.pid) === Number(pid));
    if (hit) return hit.label || null;
  }
  return null;
}

// The gate: ok:true means "let it through" (default — every unconfigured or
// erroring path fails open, on purpose). ok:false means "refuse" and is the
// ONLY outcome the shim (shim/claude.cmd) maps to exit 42.
export function gate(args, opts = {}) {
  if (isUtilityInvocation(args)) return { ok: true, reason: "utility" };
  const cfg = laneConfig();
  const total = (cfg.total && typeof cfg.total === "object") ? cfg.total : {};
  const cap = Number(total.cap);
  if (!Number.isFinite(cap)) return { ok: true, reason: "no-cap-configured" };
  const exePaths = Array.isArray(total.exe) ? total.exe : [];
  if (!exePaths.length) return { ok: true, reason: "no-exe-configured" };
  let matched;
  try {
    matched = countCappedProcesses(exePaths, opts.listProcesses);
  } catch (e) {
    return { ok: true, reason: "count-failed", error: String((e && e.message) || e) };
  }
  if (matched.length < cap) return { ok: true, count: matched.length, cap };
  return {
    ok: false,
    count: matched.length,
    cap,
    holders: matched.map((p) => ({ pid: p.ProcessId, startedAt: p.CreationDate || null, label: laneLabelForPid(p.ProcessId) })),
  };
}

// Broken out of the CLI dispatch below so it has a deterministic unit test:
// exercising this via a real refused CLI subprocess would need an actual
// live claude.exe on the machine to populate `holders`, which is
// environment-dependent and not something a hermetic test controls.
export function formatHolders(holders) {
  return (holders || [])
    .map((h) => `pid ${h.pid}${h.label ? ` [${h.label}]` : ""}${h.startedAt ? ` (started ${h.startedAt})` : ""}`)
    .join(", ") || "unknown";
}

// ------------------------------------------------------------------- CLI
// `node hooks/lane.mjs <cmd> ...` — single-shot, NON-BLOCKING commands for
// callers that cannot import ESM directly (guards-gui.ps1 shells out to
// this). Every command prints one line of JSON to stdout and exits
// immediately; nothing here polls or waits, because a GUI click must never
// hang on a subprocess. The two-step try-acquire/reown handshake exists
// because at the moment a GUI launch reserves a slot it doesn't yet know the
// real child pid — it reserves under its own (short-lived) pid first, then
// re-owns the slot to the actual claude/PtyHost pid once spawned, so the
// slot naturally frees itself when THAT process exits, not when the GUI does.
export function tryAcquireOnce(category, label, pid, ttlMs) {
  const cat = category || undefined;
  const cfg = laneConfig(cat);
  const root = categoryRoot(cat);
  fs.mkdirSync(root, { recursive: true });
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : cfg.slotTtlMs;
  for (let i = 0; i < Math.max(1, cfg.slots); i++) {
    const slotDir = path.join(root, `slot-${i}`);
    if (tryTake(slotDir, label, ttl, Number(pid) || process.pid)) return { ok: true, slot: i };
  }
  return { ok: false, slot: null, held: laneStatus(cat) };
}

export function reownSlot(category, slotIndex, newPid) {
  const root = categoryRoot(category || undefined);
  const slotDir = path.join(root, `slot-${slotIndex}`);
  const o = ownerOf(slotDir);
  if (!o) return { ok: false, reason: "no such slot/owner" };
  o.pid = Number(newPid) || o.pid;
  try {
    fs.writeFileSync(path.join(slotDir, "owner.json"), JSON.stringify(o));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

export function releaseSlot(category, slotIndex) {
  const root = categoryRoot(category || undefined);
  const slotDir = path.join(root, `slot-${slotIndex}`);
  try { fs.rmSync(slotDir, { recursive: true, force: true }); return { ok: true }; } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
}

// "-" and "automation" both mean "no category" (the original automation
// root) — CLI callers always pass an explicit category token, so there needs
// to be a spellable way to say "the default one".
function normalizeCategory(c) {
  return c && c !== "-" && c !== "automation" ? c : undefined;
}

export function runCli(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "status":
      return laneStatusAll();
    case "try-acquire": {
      const [category, label, pid, ttlMs] = args;
      return tryAcquireOnce(normalizeCategory(category), label, pid, ttlMs);
    }
    case "reown": {
      const [category, slot, newPid] = args;
      return reownSlot(normalizeCategory(category), Number(slot), newPid);
    }
    case "release": {
      const [category, slot] = args;
      return releaseSlot(normalizeCategory(category), Number(slot));
    }
    default:
      return { ok: false, reason: `unknown command: ${cmd}` };
  }
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  if (cmd === "gate") {
    // Deliberately NOT routed through runCli's JSON-on-stdout convention:
    // shim/claude.cmd only cares about the exit code, and a JSON line on
    // every single successful `claude` launch would be noise in Kyle's
    // terminal. Silent on allow; one human-readable line on stderr to
    // refuse.
    const gateArgs = rest[0] === "--" ? rest.slice(1) : rest;
    const out = gate(gateArgs);
    if (out && out.ok === false) {
      console.error(`lane: claude launch cap reached (${out.count}/${out.cap}) — held by ${formatHolders(out.holders)}`);
      process.exitCode = 42;
    }
  } else {
    const out = runCli(argv);
    console.log(JSON.stringify(out));
    if (out && out.ok === false) process.exitCode = 1;
  }
}

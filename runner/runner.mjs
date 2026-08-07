#!/usr/bin/env node
// guards runner — relaunch `claude -p` per board task; fresh context per run.
// Usage:
//   node runner.mjs <job>            run the loop now
//   node runner.mjs <job> --once     single claude run (debug)
//   node runner.mjs <job> --install  register Task Scheduler entry (job.schedule)
//   node runner.mjs <job> --status   show recent log lines + alerts
// Jobs live in runner/jobs/<job>.json — schema in README.md.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { withLaunchSlot, retryTransport } from "../hooks/lane.mjs";
import { spawnSpec } from "../hooks/cmdline.mjs";
import { readDirective, appendCycle, lastCycleBody, KICK_TEXT } from "../hooks/directive.mjs";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// ACC_RUNNER_ROOT redirects logs/alerts/stop/jobs at a throwaway tree, same
// discipline as ACC_ROOT elsewhere (route.test.mjs, lane.test.mjs): so
// runner.test.mjs can drive real runLoop decisions without writing into the
// live runner/logs a real board depends on.
const ROOT = process.env.ACC_RUNNER_ROOT ? resolve(process.env.ACC_RUNNER_ROOT) : HERE;
const LOG_CAP = 1024 * 1024;

// A directive-backed job (SPEC-0001, FR-011): the directive store supplies
// workdir and identity; the bootstrap is only the kick constant because
// budget.mjs's SessionStart hook injects the full directive context (text,
// log tail, done/blocked protocol) into any child carrying ACC_DIRECTIVE.
// Refusals are the contract: a non-active directive or one with no working
// folder can never start a run.
export function loadDirectiveJob(id) {
  const d = readDirective(id);
  if (!d || d.status !== "active") throw new Error(`directive "${id}" is not active — nothing to run`);
  if (!d.cwd) throw new Error(`directive "${id}" has no working folder (cwd) — a headless run needs one`);
  return {
    name: `directive-${id}`, workdir: d.cwd, bootstrap: KICK_TEXT, directiveId: id,
    maxStuck: 3, maxRuns: 100, runTimeoutMin: 180,
  };
}

export function loadJob(name) {
  if (name.startsWith("directive:")) return loadDirectiveJob(name.slice("directive:".length));
  const path = name.endsWith(".json") ? resolve(name) : join(ROOT, "jobs", name + ".json");
  const job = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  for (const key of ["name", "workdir", "bootstrap", "statusFile", "doneMarker"]) {
    if (!job[key]) throw new Error(`job spec missing "${key}" (${path})`);
  }
  return { maxStuck: 3, maxRuns: 100, runTimeoutMin: 180, ...job };
}

export function log(job, line) {
  mkdirSync(join(ROOT, "logs"), { recursive: true });
  const file = join(ROOT, "logs", job.name + ".log");
  if (existsSync(file) && statSync(file).size >= LOG_CAP) renameSync(file, file + ".1");
  const stamped = `${new Date().toISOString()} ${line}`;
  appendFileSync(file, stamped + "\n");
  console.log(stamped);
}

export function alert(job, reason) {
  mkdirSync(join(ROOT, "alerts"), { recursive: true });
  const file = join(ROOT, "alerts", `${job.name}-${Date.now()}.txt`);
  writeFileSync(file, reason + "\n");
  log(job, `ALERT: ${reason} (${file})`);
}

// A directive's "board" is its own store: done the moment its status leaves
// `active` (setStatus archives it, so readDirective returns null); progress
// is the BODY of the last log entry — a model repeating the same closing
// summary verbatim is the headless stuck mode (see lastCycleBody for why
// headers/timestamps are excluded).
export function directiveState(id) {
  const d = readDirective(id);
  if (!d || d.status !== "active") return { done: true, hash: "" };
  return { done: false, hash: createHash("sha256").update(lastCycleBody(id)).digest("hex") };
}

export function boardState(job) {
  if (job.directiveId) return directiveState(job.directiveId);
  const file = join(job.workdir, job.statusFile);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return {
    done: text.split(/\r?\n/).some((l) => l.trim() === job.doneMarker),
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

// shell:true interposes /bin/sh (POSIX) or cmd.exe (Windows) between us and
// the real claude process. A plain child.kill() only signals that WRAPPER —
// a documented Node child_process gotcha — and the real claude process is
// left ORPHANED, still running, still holding its API stream. Found
// 2026-08-01 proving the timeout path in runner.test.mjs: a "killed" run's
// close event fired only after the full hang duration, not the timeout,
// because the orphan kept the stdio pipes open. This is not cosmetic: an
// orphan that outlives the lane slot that was supposed to gate it (see
// hooks/lane.mjs) is exactly the kind of invisible extra stream that
// contributes to the account-wide concurrency jam this whole change exists
// to close. `detached: true` on POSIX makes the spawned shell the leader of
// its OWN process group (verified: signaling -pid kills the group in ~10ms
// with zero orphan, vs 8s+ orphaned with a plain child.kill()); Windows has
// no process-group equivalent here, so `taskkill /t` walks the PID tree
// instead. Split into two named, independently callable functions (rather
// than one function with an internal platform if/else) so a suite running on
// EITHER platform can exercise both branches directly — a single real OS can
// only prove one of these by actually killing something; the other is proven
// by asserting the command it would issue. `platform`/`exec` are injected for
// exactly that reason; the real call site always uses the live OS default.
export function killTreeWin32(child, exec = execFileSync) {
  try { exec("taskkill", ["/pid", String(child.pid), "/t", "/f"]); } catch {}
}
export function killTreePosix(child) {
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill(); } catch {} }
}
export function killTree(child, platform = process.platform) {
  if (platform === "win32") killTreeWin32(child);
  else killTreePosix(child);
}

export function runClaudeOnce(job) {
  return new Promise((resolveRun) => {
    // Deliberately NOT --bare: each session must keep the user's hook stack —
    // guard.mjs is the safety layer that makes bypassPermissions acceptable.
    // The bootstrap goes over STDIN, never argv — argv is now quoted/shell-
    // free per platform via hooks/cmdline.mjs (see OI-023); a multi-word
    // prompt in argv still would not survive the shell boundary intact.
    const args = [
      "-p",
      "--permission-mode", "bypassPermissions",
      "--output-format", "json",
      "--max-turns", "200",
    ];
    const sp = spawnSpec("claude", args);
    const opts = {
      cwd: job.workdir, shell: sp.shell, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", // see killTree
      // runTimeoutMin owns the clock; never let the 600s print-mode
      // background-wait ceiling kill a session mid-task (lost run 2).
      // ACC_PTY must not leak: a runner child that inherited it would
      // masquerade as the embedded session and route clearbot's pipe writes
      // into the wrong terminal. NODE_V8_COVERAGE must not leak either: this
      // spawn is a hard `killTree` target on timeout (taskkill /t /f on
      // Windows, SIGTERM on the process group on POSIX), and a coverage-
      // instrumented child killed mid-write leaves a truncated raw-profile
      // JSON fragment that corrupts an ancestor's coverage report generation
      // (found 2026-08-02 via runner.test.mjs's own "hang" fixture — a real
      // node process under `node hooks/covgate.mjs` — not that claude itself
      // is ever coverage-instrumented, but the fake stub runner.test.mjs
      // spawns through this exact path is).
      // ACC_DIRECTIVE makes budget.mjs's SessionStart hook inject the full
      // directive context into this child — the entire continuity mechanism
      // for directive jobs, and set ONLY for them: a file job's child must
      // never adopt a directive it was not launched for.
      env: {
        ...process.env, ACC_PTY: "", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_CODE_RUNNER: "1", NODE_V8_COVERAGE: undefined,
        ACC_DIRECTIVE: job.directiveId || "",
      },
    };
    const child = sp.args ? spawn(sp.file, sp.args, opts) : spawn(sp.file, opts);
    child.stdin.write(job.bootstrap);
    child.stdin.end();
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      log(job, `run timed out after ${job.runTimeoutMin} min — killing (tree)`);
      killTree(child);
    }, job.runTimeoutMin * 60 * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = "";
      try {
        result = JSON.parse(out).result ?? "";
      } catch {
        result = out;
      }
      resolveRun({ code, result: String(result).slice(-2000), err: err.slice(-500) });
    });
  });
}

// The laned, retried real launch. Split out from runLoop so a test can inject
// a different `run` (below) without touching the lane wiring itself — that
// wiring has its own coverage in hooks/lane.test.mjs; here it only needs
// proving that runner.mjs actually calls it correctly (runner.test.mjs's
// "integration" group, against a fake claude binary).
export function runOnce(job) {
  return withLaunchSlot(
    `runner:${job.name}`,
    () => retryTransport(`runner:${job.name}`, () => runClaudeOnce(job), { onLog: (l) => log(job, l) }),
    { ttlMs: (job.runTimeoutMin + 10) * 60 * 1000, onLog: (l) => log(job, l) }
  );
}

// The week tier, via the same `usage.mjs check` verb clearbot shells
// (Invoke-Kicks) — one authority, two callers. Any failure reads as green:
// the console path fails open the same way (deliberate parity, revisit when
// SL-010 gives usage.mjs an in-process API with its own coverage budget).
// `exec` is injectable so the failure branches are testable without breaking
// a real usage store.
export function liveTier(exec = execFileSync) {
  try {
    const out = exec(process.execPath, [join(HERE, "..", "hooks", "usage.mjs"), "check"], { encoding: "utf8" });
    return JSON.parse(out).tier || "green";
  } catch {
    return "green";
  }
}

export async function runLoop(job, once, { run = runOnce, tier = liveTier } = {}) {
  let stuck = 0;
  for (let n = 1; n <= job.maxRuns; n++) {
    const stopFile = join(ROOT, "stop", job.name + ".stop");
    if (existsSync(stopFile)) {
      unlinkSync(stopFile);
      log(job, "stop file honored - exiting between runs (exit 4)");
      return 4;
    }
    const before = boardState(job);
    if (before.done) {
      log(job, job.directiveId ? "directive left active status — complete" : `done marker "${job.doneMarker}" present — queue complete`);
      return 0;
    }
    // FR-005 on the headless path: a red week is a hard stop for anything
    // that spends tokens unattended — same brake clearbot applies to kicks.
    // Directive jobs only; file jobs never had a tier gate (unchanged here).
    if (job.directiveId && tier() === "red") {
      alert(job, "week token tier is RED — holding headless directive runs (exit 5)");
      return 5;
    }
    log(job, `run ${n}/${job.maxRuns} starting (stuck ${stuck}/${job.maxStuck})`);
    // Every run goes through the machine-wide launch lane (hooks/lane.mjs):
    // one automated session at a time across runner + e2e, paced starts, and
    // transport-only retries — the econnreset class dies here, and a session
    // that fails for a REAL reason still fails exactly as before.
    const { code, result, err } = await run(job);
    log(job, `run ${n} exited ${code}; tail: ${result.slice(-400).replaceAll("\n", " | ")}`);
    if (err) log(job, `stderr tail: ${err.replaceAll("\n", " | ")}`);
    // The run's closing summary becomes the next fresh context's continuity
    // (budget.mjs injects it as the log tail) AND the stuck signal
    // (directiveState hashes it). Archived-mid-run is fine: appendCycle
    // returns null against a directive that already left the live store.
    if (job.directiveId) appendCycle(job.directiveId, { sessionId: "headless", ctx: 0, text: result });
    const after = boardState(job);
    if (after.done) {
      log(job, "queue complete");
      return 0;
    }
    stuck = after.hash === before.hash ? stuck + 1 : 0;
    if (stuck >= job.maxStuck) {
      alert(job, `no board progress after ${stuck} consecutive runs — stopping`);
      return 2;
    }
    if (once) return code ?? 0;
  }
  alert(job, `maxRuns (${job.maxRuns}) reached without the done marker`);
  return 3;
}

// `exec` is injectable so runner.test.mjs can assert the schtasks command
// this builds without schtasks needing to exist (it does not, on the
// sandbox this suite also runs in) — the real CLI path always uses the
// default, unchanged from before.
export function install(job, exec = execFileSync) {
  if (job.directiveId) throw new Error("directive jobs are ad-hoc — not schedulable via --install");
  const s = job.schedule;
  if (!s || s.type !== "daily" || !s.time) {
    throw new Error('install needs job.schedule = {"type":"daily","time":"HH:MM"}');
  }
  const tr = `node ${join(ROOT, "runner.mjs")} ${job.name}`;
  exec(
    "schtasks",
    ["/Create", "/F", "/TN", `guards-runner-${job.name}`, "/TR", tr, "/SC", "DAILY", "/ST", s.time],
    { stdio: "inherit" },
  );
  console.log(`installed daily task guards-runner-${job.name} at ${s.time}`);
}

export function status(job) {
  const file = join(ROOT, "logs", job.name + ".log");
  console.log(
    existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(-15).join("\n") : "no log yet",
  );
  const alertsDir = join(ROOT, "alerts");
  if (existsSync(alertsDir)) {
    const alerts = readdirSync(alertsDir).filter((f) => f.startsWith(job.name + "-"));
    if (alerts.length) console.log(`alerts: ${alerts.join(", ")}`);
  }
}

// Returns an exit code rather than calling process.exit itself, so it is
// safe to call in-process from a test (a real process.exit would kill the
// test runner) — the ONLY process.exit call is the single guarded line
// below, which subprocess CLI tests still exercise for real.
export async function cli(argv = process.argv.slice(2)) {
  const [name, flag] = argv;
  if (!name) {
    console.error("usage: node runner.mjs <job> [--once|--install|--status]");
    return 1;
  }
  const job = loadJob(name);
  if (flag === "--install") { install(job); return 0; }
  if (flag === "--status") { status(job); return 0; }
  return await runLoop(job, flag === "--once");
}
// Guarded so the file is importable by runner.test.mjs without running the
// CLI on import — the same shape hooks/testplan.mjs and hooks/covgate.mjs
// already use.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await cli());

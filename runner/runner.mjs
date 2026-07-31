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
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG_CAP = 1024 * 1024;

function loadJob(name) {
  const path = name.endsWith(".json") ? resolve(name) : join(ROOT, "jobs", name + ".json");
  const job = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  for (const key of ["name", "workdir", "bootstrap", "statusFile", "doneMarker"]) {
    if (!job[key]) throw new Error(`job spec missing "${key}" (${path})`);
  }
  return { maxStuck: 3, maxRuns: 100, runTimeoutMin: 180, ...job };
}

function log(job, line) {
  mkdirSync(join(ROOT, "logs"), { recursive: true });
  const file = join(ROOT, "logs", job.name + ".log");
  if (existsSync(file) && statSync(file).size >= LOG_CAP) renameSync(file, file + ".1");
  const stamped = `${new Date().toISOString()} ${line}`;
  appendFileSync(file, stamped + "\n");
  console.log(stamped);
}

function alert(job, reason) {
  mkdirSync(join(ROOT, "alerts"), { recursive: true });
  const file = join(ROOT, "alerts", `${job.name}-${Date.now()}.txt`);
  writeFileSync(file, reason + "\n");
  log(job, `ALERT: ${reason} (${file})`);
}

function boardState(job) {
  const file = join(job.workdir, job.statusFile);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return {
    done: text.split(/\r?\n/).some((l) => l.trim() === job.doneMarker),
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

function runClaudeOnce(job) {
  return new Promise((resolveRun) => {
    // Deliberately NOT --bare: each session must keep the user's hook stack —
    // guard.mjs is the safety layer that makes bypassPermissions acceptable.
    // The bootstrap goes over STDIN, never argv: shell:true concatenates argv
    // unescaped on Windows, and a multi-word prompt arrives mangled (proven by
    // the first smoke test — the session never saw the exact marker string).
    const args = [
      "-p",
      "--permission-mode", "bypassPermissions",
      "--output-format", "json",
      "--max-turns", "200",
    ];
    const child = spawn("claude", args, {
      cwd: job.workdir, shell: true, stdio: ["pipe", "pipe", "pipe"],
      // runTimeoutMin owns the clock; never let the 600s print-mode
      // background-wait ceiling kill a session mid-task (lost run 2).
      env: { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_CODE_RUNNER: "1" },
    });
    child.stdin.write(job.bootstrap);
    child.stdin.end();
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      log(job, `run timed out after ${job.runTimeoutMin} min — killing`);
      child.kill();
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

async function runLoop(job, once) {
  let stuck = 0;
  for (let run = 1; run <= job.maxRuns; run++) {
    const stopFile = join(ROOT, "stop", job.name + ".stop");
    if (existsSync(stopFile)) {
      unlinkSync(stopFile);
      log(job, "stop file honored - exiting between runs (exit 4)");
      return 4;
    }
    const before = boardState(job);
    if (before.done) {
      log(job, `done marker "${job.doneMarker}" present — queue complete`);
      return 0;
    }
    log(job, `run ${run}/${job.maxRuns} starting (stuck ${stuck}/${job.maxStuck})`);
    const { code, result, err } = await runClaudeOnce(job);
    log(job, `run ${run} exited ${code}; tail: ${result.slice(-400).replaceAll("\n", " | ")}`);
    if (err) log(job, `stderr tail: ${err.replaceAll("\n", " | ")}`);
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

function install(job) {
  const s = job.schedule;
  if (!s || s.type !== "daily" || !s.time) {
    throw new Error('install needs job.schedule = {"type":"daily","time":"HH:MM"}');
  }
  const tr = `node ${join(ROOT, "runner.mjs")} ${job.name}`;
  execFileSync(
    "schtasks",
    ["/Create", "/F", "/TN", `guards-runner-${job.name}`, "/TR", tr, "/SC", "DAILY", "/ST", s.time],
    { stdio: "inherit" },
  );
  console.log(`installed daily task guards-runner-${job.name} at ${s.time}`);
}

function status(job) {
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

const [name, flag] = process.argv.slice(2);
if (!name) {
  console.error("usage: node runner.mjs <job> [--once|--install|--status]");
  process.exit(1);
}
const job = loadJob(name);
if (flag === "--install") install(job);
else if (flag === "--status") status(job);
else process.exit(await runLoop(job, flag === "--once"));

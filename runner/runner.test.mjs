// node --test runner/runner.test.mjs  (run from C:\code\guards)
//
// Hermetic. ACC_RUNNER_ROOT sandboxes logs/alerts/stop/jobs (route.test.mjs
// discipline). ACC_LANE_DIR and ACC_POLICY sandbox the launch lane the same
// way — a real run here must never contend with a live runner or the
// slice-runner. No network, no real claude, no tokens.
//
// Two groups:
//   DECISION TABLE — runLoop's stuck/done/stop/maxRuns logic, driven by an
//     injected `run`, proven in milliseconds with no process spawned.
//   INTEGRATION — the real runOnce -> runClaudeOnce -> lane path, against a
//     FAKE `claude` on PATH (a stub binary, not a mock): proves the actual
//     spawn args, that the bootstrap really goes over stdin (never argv —
//     the documented reason being shell:true argv-mangling on Windows), that
//     a transport-shaped failure is retried and recovers, and that a hung
//     run is killed at its timeout. The stub ships two entry points
//     (`claude` POSIX shebang, `claude.cmd` Windows batch) both delegating to
//     one impl file, so the same test exercises runner.mjs's real spawn call
//     on either platform Kyle might run this suite from.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-runner-test-"));
process.env.ACC_RUNNER_ROOT = path.join(BASE, "runnerroot");
process.env.ACC_LANE_DIR = path.join(BASE, "lane");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ lane: { slots: 1, minGapMs: 0, retries: 2, backoffBaseMs: 5, backoffCapMs: 20, pollMs: 20 } }));
// Phase 5 step 1: runner.mjs now calls into hooks/mission.mjs directly
// (ensureJobMission/missionSignal). mission.mjs resolves its store from ACC_ROOT/
// ACC_MISSIONS_DIR, a DIFFERENT env var than ACC_RUNNER_ROOT -- without this,
// every test in this file would silently read/write the real repo's
// runner/missions directory (route.test.mjs/mission.test.mjs discipline: live
// state must never see test data).
process.env.ACC_ROOT = process.env.ACC_RUNNER_ROOT;
process.env.ACC_MISSIONS_DIR = "";
// usage.mjs resolves CLAUDE_CONFIG_DIR into a MODULE-LEVEL const at import
// time, not per-call -- must be set before runner.mjs (which imports
// usage.mjs) is first imported below, or every weekTier() scan in this file
// silently falls through to the real host ~/.claude instead of this sandbox.
process.env.CLAUDE_CONFIG_DIR = path.join(BASE, "claudecfg");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "runner.mjs");
const {
  loadJob, boardState, runLoop, install, status, runClaudeOnce, runOnce,
  killTreeWin32, killTreePosix, killTree, log, cli: cliFn,
  ensureJobMission, missionSignal,
} = await import("./runner.mjs");
const { createMission, readMission, setStatus } = await import("../hooks/mission.mjs");

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

function board(dir, statusFile, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, statusFile), text);
}

function job(overrides = {}) {
  const workdir = fs.mkdtempSync(path.join(BASE, "board-"));
  board(workdir, "BOARD.md", "- [ ] task one\n");
  return {
    name: `t-${Math.random().toString(36).slice(2)}`,
    workdir, statusFile: "BOARD.md", doneMarker: "DONE",
    bootstrap: "do the thing", maxStuck: 3, maxRuns: 5, runTimeoutMin: 180,
    ...overrides,
  };
}

// ------------------------------------------------------------- loadJob
test("loadJob fills defaults and reads an explicit path", () => {
  const p = path.join(BASE, "explicit.json");
  fs.writeFileSync(p, JSON.stringify({ name: "x", workdir: BASE, bootstrap: "b", statusFile: "s.md", doneMarker: "D" }));
  const j = loadJob(p);
  assert.equal(j.maxStuck, 3);
  assert.equal(j.maxRuns, 100);
  assert.equal(j.runTimeoutMin, 180);
});

test("loadJob resolves a bare name under ACC_RUNNER_ROOT/jobs", () => {
  fs.mkdirSync(path.join(process.env.ACC_RUNNER_ROOT, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(process.env.ACC_RUNNER_ROOT, "jobs", "byname.json"),
    JSON.stringify({ name: "byname", workdir: BASE, bootstrap: "b", statusFile: "s.md", doneMarker: "D", maxRuns: 7 })
  );
  const j = loadJob("byname");
  assert.equal(j.maxRuns, 7);
});

test("loadJob strips a BOM before parsing", () => {
  const p = path.join(BASE, "bom.json");
  fs.writeFileSync(p, "\uFEFF" + JSON.stringify({ name: "b", workdir: BASE, bootstrap: "b", statusFile: "s.md", doneMarker: "D" }));
  assert.equal(loadJob(p).name, "b");
});

test("loadJob throws naming the missing key and the path", () => {
  const p = path.join(BASE, "bad.json");
  fs.writeFileSync(p, JSON.stringify({ name: "bad", workdir: BASE, bootstrap: "b" })); // no statusFile/doneMarker
  assert.throws(() => loadJob(p), /statusFile/);
});

// ------------------------------------------------------------- boardState
test("boardState: doneMarker must be its own trimmed line, not a substring", () => {
  const j = job();
  board(j.workdir, j.statusFile, "- [ ] one\nDONE-ish, not really\n");
  assert.equal(boardState(j).done, false);
  board(j.workdir, j.statusFile, "- [x] one\nDONE\n");
  assert.equal(boardState(j).done, true);
});

test("boardState: hash is stable for identical content and changes with content", () => {
  const j = job();
  board(j.workdir, j.statusFile, "same\n");
  const a = boardState(j);
  const b = boardState(j);
  assert.equal(a.hash, b.hash);
  board(j.workdir, j.statusFile, "different\n");
  assert.notEqual(boardState(j).hash, a.hash);
});

test("boardState: a missing status file is not done and hashes empty content", () => {
  const j = job();
  fs.rmSync(path.join(j.workdir, j.statusFile));
  assert.equal(boardState(j).done, false);
});

// ------------------------------------------------------------- runLoop (decision table)
test("runLoop: board already done returns 0 without ever calling run", async () => {
  const j = job();
  board(j.workdir, j.statusFile, "DONE\n");
  let called = false;
  const code = await runLoop(j, false, { run: async () => { called = true; return { code: 0, result: "", err: "" }; } });
  assert.equal(code, 0);
  assert.equal(called, false);
});

test("runLoop: a stop file is honored before the next run and consumed", async () => {
  const j = job({ name: "stopjob" });
  fs.mkdirSync(path.join(process.env.ACC_RUNNER_ROOT, "stop"), { recursive: true });
  const stopFile = path.join(process.env.ACC_RUNNER_ROOT, "stop", `${j.name}.stop`);
  fs.writeFileSync(stopFile, "");
  let called = false;
  const code = await runLoop(j, false, { run: async () => { called = true; return { code: 0, result: "", err: "" }; } });
  assert.equal(code, 4);
  assert.equal(called, false);
  assert.equal(fs.existsSync(stopFile), false, "stop file must be consumed");
});

test("runLoop: progress resets the stuck counter, run continues past maxStuck runs", async () => {
  const j = job({ maxStuck: 2, maxRuns: 5 });
  let n = 0;
  const code = await runLoop(j, false, {
    run: async () => {
      n++;
      board(j.workdir, j.statusFile, `progress ${n}\n`); // hash changes every run
      if (n >= 4) board(j.workdir, j.statusFile, "DONE\n");
      return { code: 0, result: "ok", err: "" };
    },
  });
  assert.equal(code, 0, "must finish via the done marker, not a false stuck alert");
  assert.equal(n, 4);
});

test("runLoop: no progress for maxStuck runs alerts and returns 2", async () => {
  const j = job({ maxStuck: 3, maxRuns: 10 });
  let n = 0;
  const code = await runLoop(j, false, { run: async () => { n++; return { code: 0, result: "stuck", err: "" }; } }); // board never changes
  assert.equal(code, 2);
  assert.equal(n, 3, "must stop exactly at maxStuck, not run past it");
  const alerts = fs.readdirSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts")).filter((f) => f.startsWith(j.name));
  assert.equal(alerts.length, 1);
  assert.ok(fs.readFileSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts", alerts[0]), "utf8").includes("no board progress"));
});

test("runLoop: maxRuns exhausted without the done marker alerts and returns 3", async () => {
  const j = job({ maxStuck: 100, maxRuns: 3 });
  let n = 0;
  const code = await runLoop(j, false, {
    run: async () => { n++; board(j.workdir, j.statusFile, `tick ${n}\n`); return { code: 0, result: "", err: "" }; },
  });
  assert.equal(code, 3);
  assert.equal(n, 3);
});

test("runLoop: once=true returns after exactly one run's code", async () => {
  const j = job({ maxRuns: 10 });
  let n = 0;
  const code = await runLoop(j, true, { run: async () => { n++; return { code: 7, result: "", err: "" }; } });
  assert.equal(code, 7);
  assert.equal(n, 1);
});

test("runLoop: once=true with an undefined code falls back to 0, and stderr is logged", async () => {
  const j = job({ maxRuns: 10 });
  const code = await runLoop(j, true, { run: async () => ({ code: undefined, result: "", err: "boom on stderr" }) });
  assert.equal(code, 0);
  const logText = fs.readFileSync(path.join(process.env.ACC_RUNNER_ROOT, "logs", `${j.name}.log`), "utf8");
  assert.ok(logText.includes("stderr tail: boom on stderr"));
});

// ---------------------------------------------------- Phase 5 step 1: mission wiring

test("ensureJobMission creates a mission on first call and REUSES the same one on a second call for the same job", () => {
  const j = job();
  const id1 = ensureJobMission(j);
  assert.ok(readMission(id1), "a real mission now exists");
  assert.equal(readMission(id1).cwd, j.workdir);
  const id2 = ensureJobMission(j);
  assert.equal(id2, id1, "the same job reuses its mission rather than creating a new one every run");
});

test("ensureJobMission creates a FRESH mission once the previous one is no longer active", () => {
  const j = job();
  const id1 = ensureJobMission(j);
  setStatus(id1, "done", "finished");
  const id2 = ensureJobMission(j);
  assert.notEqual(id2, id1, "a done mission is not reused -- a new one is created");
});

test("missionSignal: null while active, 0/6/7 for done/blocked/paused, null for a nonexistent mission", () => {
  const j = job();
  const g = createMission({ text: "t", cwd: j.workdir });
  assert.equal(missionSignal(j, g.id), null, "an active mission is not a stop signal");

  const done = createMission({ text: "t2", cwd: j.workdir });
  setStatus(done.id, "done", "shipped");
  assert.equal(missionSignal(j, done.id), 0);

  const blocked = createMission({ text: "t3", cwd: j.workdir });
  setStatus(blocked.id, "blocked", "needs a human");
  assert.equal(missionSignal(j, blocked.id), 6);

  const paused = createMission({ text: "t4", cwd: j.workdir });
  setStatus(paused.id, "paused", "CEILING REACHED: cycles");
  assert.equal(missionSignal(j, paused.id), 7);

  assert.equal(missionSignal(j, "m-does-not-exist"), null, "a missing mission is not treated as a stop signal");
});

test("runLoop: a RED week tier holds the loop before ever calling run (exit 5)", async () => {
  const savedPolicy = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  // Hermetic, not "any real usage at all": usage.mjs's weekTier() scans
  // CLAUDE_CONFIG_DIR's transcript tree (sandboxed at the top of this file,
  // before runner.mjs -> usage.mjs was first imported -- that module-level
  // const is fixed at import time, so setting the env var here mid-test
  // would silently do nothing). A known fixture transcript makes the
  // threshold trip for a real, controlled reason, not incidental host state
  // (an earlier version of this test relied on the host's real ~/.claude
  // happening to contain enough usage -- true in a dev sandbox, false on a
  // clean CI runner: caught by a real CI failure, "expected 5, actual 2",
  // the week never went red because the scan found nothing).
  const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", `proj-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "s1.jsonl"),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { model: "claude-opus-5", usage: { input_tokens: 5000, output_tokens: 0 } },
    }) + "\n"
  );
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({
    lane: { slots: 1, minGapMs: 0, retries: 2, backoffBaseMs: 5, backoffCapMs: 20, pollMs: 20 },
    week: { amberTokens: 1000, redTokens: 1000 }, // the 5000-token fixture above trips this for real
  }));
  try {
    const j = job();
    let called = false;
    const code = await runLoop(j, false, { run: async () => { called = true; return { code: 0, result: "", err: "" }; } });
    assert.equal(code, 5);
    assert.equal(called, false, "claude must never launch while the week is red");
  } finally {
    fs.writeFileSync(process.env.ACC_POLICY, savedPolicy);
  }
});

test("runLoop: the injected run() receives the job's own mission id", async () => {
  const j = job();
  let seenMissionId = null;
  await runLoop(j, true, {
    run: async (jobArg, missionId) => { seenMissionId = missionId; return { code: 0, result: "", err: "" }; },
  });
  assert.ok(seenMissionId, "a mission id was passed");
  assert.ok(readMission(seenMissionId), "and it resolves to a real mission");
  assert.equal(readMission(seenMissionId).cwd, j.workdir);
});

test("runLoop: stops via the mission signal (blocked) even though the board itself shows no progress yet", async () => {
  const j = job({ maxStuck: 100, maxRuns: 100 }); // high enough that board-stuck logic would never trigger first
  const missionId = ensureJobMission(j);
  const code = await runLoop(j, false, {
    run: async () => { setStatus(missionId, "blocked", "needs Kyle"); return { code: 0, result: "", err: "" }; },
  });
  assert.equal(code, 6);
});

test("runLoop: stops via the mission signal (paused) even though the board itself shows no progress yet", async () => {
  const j = job({ maxStuck: 100, maxRuns: 100 });
  const missionId = ensureJobMission(j);
  const code = await runLoop(j, false, {
    run: async () => { setStatus(missionId, "paused", "CEILING REACHED: cycles"); return { code: 0, result: "", err: "" }; },
  });
  assert.equal(code, 7);
});

test("runLoop: the mission reaching done ends the loop even if the board's own doneMarker never appears", async () => {
  const j = job({ maxStuck: 100, maxRuns: 100 });
  const missionId = ensureJobMission(j);
  const code = await runLoop(j, false, {
    run: async () => { setStatus(missionId, "done", "shipped via the mission, not the board"); return { code: 0, result: "", err: "" }; },
  });
  assert.equal(code, 0);
});

// ------------------------------------------------------------- install
test("install throws when the job carries no schedule", () => {
  assert.throws(() => install(job()), /job\.schedule/);
});

test("install builds the schtasks command via the injected exec, without needing schtasks to exist", () => {
  const j = job({ schedule: { type: "daily", time: "06:00" } });
  let captured = null;
  install(j, (cmd, args) => { captured = { cmd, args }; });
  assert.equal(captured.cmd, "schtasks");
  assert.ok(captured.args.includes(`guards-runner-${j.name}`));
  assert.ok(captured.args.includes("06:00"));
});

// ------------------------------------------------------------- status
function captureLog(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try { fn(); } finally { console.log = orig; }
  return lines.join("\n");
}

test("status prints 'no log yet' when nothing has run", () => {
  const out = captureLog(() => status(job({ name: "neverran" })));
  assert.ok(out.includes("no log yet"));
});

test("status prints the log tail and any alerts", () => {
  const j = job({ name: "hasrun" });
  const out = captureLog(() => {
    const orig = console.log;
    console.log = () => {}; // silence the log()-internal echo while seeding
    try {
      // reach through the public API to seed real state rather than poking files
    } finally { console.log = orig; }
  });
  fs.mkdirSync(path.join(process.env.ACC_RUNNER_ROOT, "logs"), { recursive: true });
  fs.writeFileSync(path.join(process.env.ACC_RUNNER_ROOT, "logs", `${j.name}.log`), "2026-08-01T00:00:00Z line one\n");
  fs.mkdirSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts"), { recursive: true });
  fs.writeFileSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts", `${j.name}-123.txt`), "trouble\n");
  const printed = captureLog(() => status(j));
  assert.ok(printed.includes("line one"));
  assert.ok(printed.includes(`${j.name}-123.txt`));
});

// ------------------------------------------------------------- killTree branches
// Both platform branches proven on any one OS: killTreeWin32 by asserting the
// command it WOULD issue via an injected exec (never touching real taskkill,
// which doesn't exist on this sandbox); killTreePosix for real, against a
// spawned process group, in the integration test below (the one this repo's
// timeout path actually exercises on POSIX).
test("killTreeWin32 issues taskkill /pid <pid> /t /f, via the injected exec", () => {
  let captured = null;
  killTreeWin32({ pid: 4242 }, (cmd, args) => { captured = { cmd, args }; });
  assert.equal(captured.cmd, "taskkill");
  assert.deepEqual(captured.args, ["/pid", "4242", "/t", "/f"]);
});

test("killTreeWin32 swallows a failing exec rather than throwing", () => {
  assert.doesNotThrow(() => killTreeWin32({ pid: 1 }, () => { throw new Error("no taskkill here"); }));
});

test("killTree dispatches to the win32 branch on an injected platform, without a real taskkill on hand", () => {
  assert.doesNotThrow(() => killTree({ pid: 99999 }, "win32")); // killTreeWin32 swallows the real ENOENT itself
});

test("killTree dispatches to the posix branch on an injected platform", async () => {
  // NODE_V8_COVERAGE must not leak: this child is killed within 150ms of
  // spawning, and a coverage-instrumented process killed mid-write leaves a
  // truncated raw-profile JSON fragment that corrupts an ancestor's coverage
  // report generation under `node hooks/covgate.mjs` (found 2026-08-02).
  const child = spawn("node", ["-e", "setTimeout(() => {}, 5000)"], {
    detached: true, stdio: "ignore", env: { ...process.env, NODE_V8_COVERAGE: undefined },
  });
  await new Promise((r) => setTimeout(r, 50));
  killTree(child, "linux");
  await new Promise((r) => setTimeout(r, 100));
  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false);
});

test("log() rotates the log file to .1 once it reaches the size cap", () => {
  const j = job({ name: "rotatejob" });
  const logDir = path.join(process.env.ACC_RUNNER_ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${j.name}.log`);
  fs.writeFileSync(logFile, "x".repeat(1024 * 1024)); // at the cap
  log(j, "one more line");
  assert.ok(fs.existsSync(logFile + ".1"), "the full log must be rotated aside");
  assert.ok(fs.readFileSync(logFile, "utf8").includes("one more line"));
});

test("killTreePosix signals the process GROUP (negative pid), and falls back to child.kill on failure", async () => {
  // NODE_V8_COVERAGE must not leak: this child is killed within 150ms of
  // spawning, and a coverage-instrumented process killed mid-write leaves a
  // truncated raw-profile JSON fragment that corrupts an ancestor's coverage
  // report generation under `node hooks/covgate.mjs` (found 2026-08-02).
  const child = spawn("node", ["-e", "setTimeout(() => {}, 5000)"], {
    detached: true, stdio: "ignore", env: { ...process.env, NODE_V8_COVERAGE: undefined },
  });
  await new Promise((r) => setTimeout(r, 50));
  killTreePosix(child);
  await new Promise((r) => setTimeout(r, 100));
  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, "the real process must be dead, not orphaned");

  // Fallback path: an invalid pid makes process.kill(-pid,...) throw, and the
  // catch must fall back to child.kill() rather than propagate. Use a large
  // fake pid (matching this codebase's 999999-style "definitely not a real
  // process" convention), NOT -1: this sandbox runs as root, and -(-1) is 1
  // (init/PID 1). With the SIGTERM->SIGKILL escalation below, a real -1 pid
  // here would send genuine signals to PID 1 and could kill the container.
  assert.doesNotThrow(() => killTreePosix({ pid: 999999999, kill: () => {} }));

  // Both defenses failing at once must still not throw out of killTree —
  // it is called from inside a setTimeout in runClaudeOnce with nothing
  // downstream to catch it.
  assert.doesNotThrow(() => killTreePosix({ pid: 999999999, kill: () => { throw new Error("also broken"); } }));
});

test("OI-035: killTreePosix escalates to SIGKILL if an uncooperative child ignores SIGTERM", {
  // killTreePosix is a POSIX-only code path — killTree() dispatches to
  // killTreeWin32 (taskkill /t /f) on win32 in production, never this
  // function. This test's premise (a child that TRAPS SIGTERM and survives
  // it until the SIGKILL escalation) doesn't hold on Windows: Node has no
  // real signal-trapping there, and process.kill(pid, "SIGTERM") terminates
  // the process outright regardless of any "SIGTERM" listener (confirmed via
  // a real CI failure — the child was already dead after the FIRST signal,
  // "false !== true" on the "must survive the initial SIGTERM" assertion,
  // not after the grace-period escalation). Matches the established
  // skip-on-win32 convention for POSIX-only fault injection elsewhere in
  // this repo (see hooks/testplan.test.mjs).
  skip: process.platform === "win32" ? "killTreePosix is POSIX-only; Windows has no real SIGTERM-trap semantics for this test to exercise" : false,
}, async () => {
  // A real child that traps/ignores SIGTERM (a hung/misbehaving job is
  // exactly the kind of process most likely to do this — not hypothetical).
  // A single SIGTERM with no escalation leaves it alive forever; killTree
  // exists specifically to enforce runTimeoutMin, so that gap is a real bug.
  const child = spawn(
    "node",
    ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000);'],
    { detached: true, stdio: "ignore", env: { ...process.env, NODE_V8_COVERAGE: undefined } }
  );
  await new Promise((r) => setTimeout(r, 50));
  killTreePosix(child, { graceMs: 150 });

  // Still alive right after SIGTERM: it's ignoring the signal, as designed.
  await new Promise((r) => setTimeout(r, 50));
  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  assert.equal(alive, true, "an uncooperative child must survive the initial SIGTERM");

  // Past the grace period, the SIGKILL escalation must have landed.
  await new Promise((r) => setTimeout(r, 200));
  try { process.kill(child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, "the grace-period SIGKILL escalation must kill an uncooperative child");
});

// ------------------------------------------------------------- integration: fake claude
const BIN = path.join(BASE, "bin");
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(
  path.join(BIN, "claude-impl.mjs"),
  `
import fs from "node:fs";
const dir = process.env.FAKE_CLAUDE_STATE_DIR;
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
fs.mkdirSync(dir, { recursive: true });
const countFile = dir + "/calls.txt";
let n = 0;
try { n = Number(fs.readFileSync(countFile, "utf8")); } catch {}
n++;
fs.writeFileSync(countFile, String(n));
fs.writeFileSync(dir + "/argv.json", JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(dir + "/pid.txt", String(process.pid));
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.writeFileSync(dir + "/stdin.txt", stdin);
  if (mode === "ok") { process.stdout.write(JSON.stringify({ result: "BANANA" })); process.exit(0); }
  else if (mode === "badjson") { process.stdout.write("raw non-json output"); process.exit(0); }
  else if (mode === "noresult") { process.stdout.write(JSON.stringify({ ok: true })); process.exit(0); } // valid JSON, no "result" key
  else if (mode === "transport-then-ok") {
    if (n < 3) { process.stderr.write("Unable to connect to API (econnreset)"); process.exit(1); }
    process.stdout.write(JSON.stringify({ result: "RECOVERED" })); process.exit(0);
  } else if (mode === "hang") { setTimeout(() => { process.stdout.write("{}"); process.exit(0); }, 15000); }
  else { process.exit(1); }
});
`.trimStart()
);
fs.writeFileSync(
  path.join(BIN, "claude"),
  `#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
await import(path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-impl.mjs"));
`
);
fs.chmodSync(path.join(BIN, "claude"), 0o755);
fs.writeFileSync(path.join(BIN, "claude.cmd"), `@echo off\r\nnode "%~dp0claude-impl.mjs" %*\r\n`);
process.env.PATH = BIN + path.delimiter + process.env.PATH;

function fakeClaudeDir(name) {
  const d = path.join(BASE, "fake-" + name);
  process.env.FAKE_CLAUDE_STATE_DIR = d;
  return d;
}

test("integration: bootstrap travels over stdin, never argv; args match the documented flags", async () => {
  const dir = fakeClaudeDir("stdin");
  process.env.FAKE_CLAUDE_MODE = "ok";
  const j = job({ bootstrap: "multi word bootstrap with spaces and \"quotes\"" });
  const r = await runClaudeOnce(j);
  assert.equal(r.code, 0);
  assert.equal(r.result, "BANANA");
  assert.equal(fs.readFileSync(path.join(dir, "stdin.txt"), "utf8"), j.bootstrap);
  const argv = JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"));
  assert.deepEqual(argv, ["-p", "--permission-mode", "bypassPermissions", "--output-format", "json", "--max-turns", "200"]);
  assert.ok(!argv.join(" ").includes("multi word"), "bootstrap must never appear in argv");
});

test("integration: the spawn path is DEP0190-clean (--throw-deprecation stays exit 0)", async () => {
  const dir = fakeClaudeDir("dep0190");
  process.env.FAKE_CLAUDE_MODE = "ok";
  const j = job({ bootstrap: "dep check" });
  const driver = `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(HERE, "runner.mjs")).href)});
    const j = ${JSON.stringify(j)};
    const r = await m.runClaudeOnce(j);
    process.exit(r.code === 0 ? 0 : 1);
  `;
  const r = spawnSync(process.execPath, ["--throw-deprecation", "--input-type=module", "-e", driver], {
    encoding: "utf8", env: { ...process.env },
  });
  assert.ok(!/DEP0190/.test(r.stderr), `spawn still triggers DEP0190:\n${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
});

test("integration: non-JSON stdout falls back to the raw text as result", async () => {
  fakeClaudeDir("badjson");
  process.env.FAKE_CLAUDE_MODE = "badjson";
  const r = await runClaudeOnce(job());
  assert.equal(r.code, 0);
  assert.equal(r.result, "raw non-json output");
});

test("integration: valid JSON with no result key falls back to an empty string, not 'undefined'", async () => {
  fakeClaudeDir("noresult");
  process.env.FAKE_CLAUDE_MODE = "noresult";
  const r = await runClaudeOnce(job());
  assert.equal(r.code, 0);
  assert.equal(r.result, "");
});

test("integration: a hung run is killed PROMPTLY at its timeout, not merely eventually", async () => {
  // The real assertion is TIMING, not just "not code 0": a plain child.kill()
  // under shell:true only signals the shell wrapper, orphaning the real
  // process for its full natural duration (verified: 8s+ instead of ~200ms)
  // — that orphan is exactly the invisible extra stream the lane exists to
  // prevent. killTree's process-group kill must return well before the fake
  // binary's own 15s hang timer, or this is silently back to orphaning.
  const dir = fakeClaudeDir("hang");
  process.env.FAKE_CLAUDE_MODE = "hang";
  const t0 = Date.now();
  // 300ms, not tighter: the fake binary is a real spawn -> sh -> node ->
  // dynamic-import chain, and under --experimental-test-coverage
  // instrumentation that startup alone can eat tens of ms — a too-tight
  // timeout was observed killing the process before it even wrote pid.txt
  // (flaked once at 30ms). The real proof is elapsed << the 15s natural
  // hang, not a specific small number.
  const r = await runClaudeOnce(job({ runTimeoutMin: 0.005 })); // 300ms timeout
  const elapsed = Date.now() - t0;
  assert.notEqual(r.code, 0, "a killed process must not report success");
  assert.ok(elapsed < 5000, `kill took ${elapsed}ms — the process was orphaned, not killed (see killTree)`);
  // Direct proof, not just timing: the fake binary's own pid (written before
  // it ever blocks on the hang timer) must actually be dead, not merely
  // detached from our stdio pipes. process.kill(pid, 0) is a liveness probe
  // on every platform Node supports (throws ESRCH once the pid is gone), so
  // this runs on Windows too (OI-014) — proving killTreeWin32's real
  // `taskkill /pid <pid> /t /f` actually kills the fake claude's process
  // tree, not just detaches from it, on the windows-integration CI job.
  await new Promise((res) => setTimeout(res, 300));
  const pid = Number(fs.readFileSync(path.join(dir, "pid.txt"), "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, `fake claude pid ${pid} is still alive — orphaned, not killed`);
});

// Lean-review finding (2026-08-06): every OTHER exceptional runLoop
// condition (stuck board, blocked/paused mission, maxRuns exhausted) calls
// alert() -- the channel README.md and status() both frame as the
// notification surface. A killed hang only ever called log(), so a single
// runTimeoutMin timeout was invisible to anything polling alerts/ until it
// repeated maxStuck times and tripped the unrelated stuck-alert (or someone
// happened to read the log). A hang worth killing is worth alerting on its
// own, the same as every sibling exceptional path.
test("integration: a hung, killed run raises an alert, the same as every other exceptional runLoop condition", async () => {
  fakeClaudeDir("hang");
  process.env.FAKE_CLAUDE_MODE = "hang";
  const j = job({ runTimeoutMin: 0.005 }); // 300ms timeout
  await runClaudeOnce(j);
  const alerts = fs.readdirSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts")).filter((f) => f.startsWith(j.name));
  assert.equal(alerts.length, 1, "a killed hang must raise exactly one alert");
  assert.match(
    fs.readFileSync(path.join(process.env.ACC_RUNNER_ROOT, "alerts", alerts[0]), "utf8"),
    /timed out after/
  );
});

test("integration: runOnce retries a transport failure through the real lane and recovers", async () => {
  fakeClaudeDir("transport");
  process.env.FAKE_CLAUDE_MODE = "transport-then-ok";
  const r = await runOnce(job({ name: "transportjob" }));
  assert.equal(r.code, 0);
  assert.equal(r.result, "RECOVERED");
});

test("integration: a paced second launch logs via the JOB'S OWN log(), not just stdout", async () => {
  // Proves runOnce's withLaunchSlot onLog wiring end to end — the "waiting
  // for a slot" line is gated at a real 15s (too slow to wait out in a fast
  // suite; lane.test.mjs already proves it fires), but minGapMs pacing is
  // instant to trigger: bump it, run twice back to back, and the SECOND
  // job's own log file (the one a human actually reads from the Process
  // tab) must carry the pacing line, proving runner.mjs's callback wiring —
  // not just lane.mjs's internal mechanics — actually connects.
  // minGapMs must comfortably exceed job A's OWN full runOnce() duration
  // (paceStart timestamps at slot-acquisition, so the "gap" job B races
  // against includes all of job A's spawn+wait+log+release, not just the
  // moment between the two calls) — 250ms genuinely flaked under the real
  // covgate.mjs gate (all ten fast-tier files running concurrently, every
  // one coverage-instrumented): job A itself occasionally took >250ms under
  // that load, so pacing correctly and silently skipped, and the test's own
  // assumption broke, not runner.mjs (found 2026-08-02).
  fakeClaudeDir("pace");
  process.env.FAKE_CLAUDE_MODE = "ok";
  const saved = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ lane: { slots: 1, minGapMs: 3000, retries: 2, backoffBaseMs: 1, backoffCapMs: 2, pollMs: 20 } }));
  try {
    const jA = job({ name: "pace-a" });
    const jB = job({ name: "pace-b" });
    await runOnce(jA);
    await runOnce(jB);
    const logB = fs.readFileSync(path.join(process.env.ACC_RUNNER_ROOT, "logs", `${jB.name}.log`), "utf8");
    assert.ok(/lane: pacing start/.test(logB), logB);
  } finally {
    fs.writeFileSync(process.env.ACC_POLICY, saved);
  }
});

delete process.env.FAKE_CLAUDE_MODE;
delete process.env.FAKE_CLAUDE_STATE_DIR;

// ------------------------------------------------------------- CLI (subprocess)
function cli(args, env = {}) {
  try {
    return { code: 0, out: execFileSync("node", [RUNNER, ...args], { encoding: "utf8", env: { ...process.env, ...env } }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

test("CLI: no args prints usage and exits 1", () => {
  const r = cli([]);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("usage:"));
});

test("CLI: no args, ACC_RUNNER_ROOT genuinely unset, still prints usage safely", () => {
  // ROOT is a module-load-time const, so the fallback branch (-> HERE, the
  // real guards/runner dir) is only reachable in a fresh subprocess — proven
  // safe here because the no-args path returns before anything ever touches
  // a ROOT-derived path (no logs/, no alerts/, no jobs/ lookup).
  const r = cli([], { ACC_RUNNER_ROOT: undefined });
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("usage:"));
});

test("CLI: --install with no schedule throws uncaught and exits non-zero", () => {
  const p = path.join(BASE, "cli-noschedule.json");
  fs.writeFileSync(p, JSON.stringify(job()));
  const r = cli([p, "--install"]);
  assert.notEqual(r.code, 0);
  assert.ok(r.out.includes("job.schedule"));
});

test("CLI: a job that is already done exits 0 immediately and never touches claude", () => {
  const j = job({ name: "clidone" });
  board(j.workdir, j.statusFile, "DONE\n");
  const p = path.join(BASE, "cli-done.json");
  fs.writeFileSync(p, JSON.stringify(j));
  const r = cli([p]);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("queue complete"));
  assert.equal(fs.existsSync(path.join(BASE, "fake-clidone")), false, "must never have spawned the fake claude");
});

test("CLI: --status reflects the prior run's log", () => {
  const p = path.join(BASE, "cli-done.json"); // reuse the job from the previous test
  const r = cli([p, "--status"]);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("queue complete"));
});

// In-process coverage of cli() itself: subprocess invocations above prove the
// real end-to-end behavior AND the guarded process.exit wiring; these prove
// cli()'s own dispatch table returns the right code for each branch WITHOUT
// spawning a process, which is also the only way this file's own coverage
// tool ever sees cli() run (a subprocess's coverage never reports back here).
test("cli(): no args returns 1 without throwing", async () => {
  assert.equal(await cliFn([]), 1);
});

test("cli(): --install dispatches to install() (proven by the schedule-missing error surfacing through it)", async () => {
  // cli()'s --install branch calls install(job) with NO injected exec, so on
  // this sandbox (no real schtasks) a job WITH a schedule would throw ENOENT
  // from the real exec — a fact about schtasks, not about dispatch. Using a
  // job with no schedule instead proves dispatch reached install() via
  // install()'s OWN validation error, identically on every platform.
  const p = path.join(BASE, "cli-fn-install.json");
  fs.writeFileSync(p, JSON.stringify(job({ name: "clifninstall" })));
  await assert.rejects(() => cliFn([p, "--install"]), /job\.schedule/);
});

test("cli(): --status dispatches and returns 0", async () => {
  const p = path.join(BASE, "cli-fn-status.json");
  fs.writeFileSync(p, JSON.stringify(job({ name: "clifnstatus" })));
  assert.equal(await cliFn([p, "--status"]), 0);
});

test("cli(): default dispatch runs the loop and returns runLoop's own code", async () => {
  const j = job({ name: "clifndone" });
  board(j.workdir, j.statusFile, "DONE\n");
  const p = path.join(BASE, "cli-fn-done.json");
  fs.writeFileSync(p, JSON.stringify(j));
  assert.equal(await cliFn([p]), 0);
});

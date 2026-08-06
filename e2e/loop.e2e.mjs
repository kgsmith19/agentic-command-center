#!/usr/bin/env node
// PROOF TIER: drives a REAL Claude Code console through the ACC loop.
//
// The fast tier (node --test hooks/*.test.mjs) proves the pieces in isolation.
// This proves the promise: "it tracks the session, clears and re-prompts
// without fail." Only a real TUI can answer the three questions that matter -
// does a typed /clear really clear, does a typed kick really start a turn, does
// Esc really interrupt a turn that will not end - so those are what this runs.
//
// It is NOT hermetic and it SPENDS TOKENS. Run deliberately:
//   node e2e/loop.e2e.mjs            # all scenarios
//   node e2e/loop.e2e.mjs --only 2   # one scenario
//
// ISOLATION, and its deliberate limits:
//   ACC_ROOT   -> a throwaway runner tree (state, standing, clear-requests), so
//                 live sessions are untouched.
//   ACC_POLICY -> a sandbox policy file, so live dials cannot change what these
//                 scenarios mean.
//   CLAUDE_CONFIG_DIR is deliberately NOT sandboxed: a fresh config dir has no
//                 credentials and no registered hooks, so the session would
//                 either fail to start or run with no ACC hooks at all. The
//                 transcripts these sessions write are therefore real - that is
//                 the point, contextOf() reads them.
//   The sandbox watcher dir deliberately OMITS start-autopilot.cmd, so
//   ensureAutopilot() finds nothing to launch and no stray resident watcher is
//   left behind. Cycles are driven explicitly with `autopilot.ps1 -Once`.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withLaunchSlot } from "../hooks/lane.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MODEL = process.env.ACC_E2E_MODEL || "claude-haiku-4-5-20251001";

const sleep = (ms) =>
  execFileSync("powershell", ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`], { windowsHide: true });

function sandbox(hardK) {
  // Two levels on purpose: autopilot resolves ROUTING.md as <parent of $Root>,
  // so the routes table has to live one directory above the sandbox root. A
  // flat sandbox would make it look for it in the system temp directory.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "acc-e2e-"));
  const root = path.join(base, "acc");
  try {
    fs.copyFileSync(path.resolve(REPO, "..", "ROUTING.md"), path.join(base, "ROUTING.md"));
  } catch {}
  for (const d of [["runner", "state"], ["runner", "clear-requests"], ["runner", "standing"], ["watcher"]])
    fs.mkdirSync(path.join(root, ...d), { recursive: true });
  const policyPath = path.join(root, "policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      context: { softK: Math.max(1, hardK - 2), hardK },
      week: { amberTokens: 0, redTokens: 0, effectiveFrom: "" },
      subagents: { mode: "allowlist", allow: [], maxPerSession: 0, exploreMaxReportLines: 80 },
      review: { fullLeanReview: "manual-only", localFullSuiteInReview: false, maxFinders: 1 },
      runner: { stopOnRed: false, statusFile: "SLICE-RUNNER.md", waitingGuard: false },
      autoClear: { enabled: true },
      // Short windows: these scenarios must not wait 90s+ to observe a kick.
      standing: { autoResume: true, maxCycles: 0, kickSettleSeconds: 5, humanHoldMinutes: 0 },
      autoApprove: { enabled: false },
    })
  );
  // autopilot resolves its tree from its own location. sendconsole is required
  // by it; start-autopilot.cmd is deliberately absent (see header).
  for (const f of ["autopilot.ps1", "sendconsole.ps1"])
    fs.copyFileSync(path.join(REPO, "watcher", f), path.join(root, "watcher", f));
  // autopilot also shells to <root>/core/standing.mjs (pending kicks) and
  // hooks/usage.mjs (live context for the escalation guard). Without these the
  // watcher silently never kicks and never escalates - both calls are wrapped
  // in try/catch, so a missing file looks exactly like "nothing to do".
  fs.mkdirSync(path.join(root, "core"), { recursive: true });
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "core", "standing.mjs"), path.join(root, "core", "standing.mjs"));
  fs.copyFileSync(path.join(REPO, "hooks", "usage.mjs"), path.join(root, "hooks", "usage.mjs"));
  return { root, policyPath };
}

const node = (args, sb) =>
  execFileSync("node", args, {
    encoding: "utf8",
    env: { ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath, ACC_STANDING_DIR: "" },
    windowsHide: true,
  });

function newStanding(sb, text) {
  return JSON.parse(node([path.join(REPO, "core", "standing.mjs"), "new", "--text", text, "--cwd", REPO], sb));
}

// A real console running claude with the sandbox environment. `cmd /c start`
// gives it a genuine console (which the injector needs); the env is baked into
// a wrapper .cmd because `start` does not reliably pass an inherited block.
//
// The first turn is started by passing the prompt as an ARGUMENT, not by typing
// it. Typing it is unreliable and, worse, it is not what these scenarios test:
// SessionStart fires before the TUI can accept input (the same reason standing.mjs
// delays its kick), so an injected first prompt lands in a console that is
// still starting and no turn ever runs - the first version of this harness
// failed exactly that way. What IS under test is the typing autopilot does
// later: the /clear and the resume constant.
function startSession(sb, { standingId, prompt, cwd = REPO, extraEnv = {} }) {
  const wrapper = path.join(sb.root, `launch-${standingId || "x"}.cmd`);
  const sets = Object.entries({
    ACC_ROOT: sb.root,
    ACC_POLICY: sb.policyPath,
    ACC_STANDING: standingId || "",
    ACC_PROFILE: "",
    ...extraEnv,
  })
    .map(([k, v]) => `set "${k}=${v}"`)
    .join("\r\n");
  const arg = prompt ? ` "${String(prompt).replace(/"/g, "'")}"` : "";
  fs.writeFileSync(wrapper, `@echo off\r\n${sets}\r\ncd /d "${cwd}"\r\nclaude --model ${MODEL}${arg}\r\n`);
  spawn("cmd.exe", ["/c", "start", "/min", "cmd.exe", "/c", wrapper], { detached: true, stdio: "ignore" }).unref();
  return wrapper;
}

function standingJson(sb, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sb.root, "runner", "standing", `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

function windowOf(sb, sid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sb.root, "runner", "state", `${sid}.window`), "utf8"));
  } catch {
    return null;
  }
}

const autopilotLog = (sb) => {
  try {
    return fs.readFileSync(path.join(sb.root, "watcher", "autopilot.log"), "utf8");
  } catch {
    return "";
  }
};

// One autopilot cycle against the sandbox. Explicit rather than resident, so a
// scenario controls timing and nothing outlives the run.
function autopilotOnce(sb) {
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(sb.root, "watcher", "autopilot.ps1"), "-Once"],
      { encoding: "utf8", timeout: 120000, windowsHide: true }
    );
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");
  }
}

// A RESIDENT autopilot for the sandbox. Scenario 3 needs one: the escalation
// branch keys off $lastFire, which is in-process state, so a sequence of
// `-Once` cycles can never reach it - each run starts with an empty table.
function startResidentAutopilot(sb) {
  const child = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(sb.root, "watcher", "autopilot.ps1"),
     "-IntervalMs", "2000"],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();
  return child.pid;
}

// Type into the session's own console, the same way autopilot does.
function typeInto(consolePid, text) {
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(REPO, "watcher", "sendconsole.ps1"),
       "-TargetPid", String(consolePid), "-Text", text, "-ClearLineFirst"],
      { encoding: "utf8", windowsHide: true }
    );
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");
  }
}

// A session's transcript, wherever Claude Code filed it (the project folder is
// derived from cwd, which scenario 4 deliberately changes).
function findTranscript(sid) {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(projects, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// The cwd the session most recently recorded. Transcript entries carry it, so
// this is the session's own account of where it is - not an inference.
function cwdOf(transcript) {
  let last = null;
  try {
    for (const l of fs.readFileSync(transcript, "utf8").split("\n")) {
      if (!l || l.charCodeAt(0) !== 123) continue;
      try {
        const o = JSON.parse(l);
        if (o.cwd) last = o.cwd;
      } catch {}
    }
  } catch {}
  return last;
}

// A clear request in exactly the shape budget.mjs writes.
function writeClearRequest(sb, sid, consolePid, transcript) {
  fs.writeFileSync(
    path.join(sb.root, "runner", "clear-requests", `${sid}.json`),
    JSON.stringify({ sessionId: sid, kind: "clear", consolePid, transcript, ctx: 60000, ts: new Date().toISOString() })
  );
}

function waitFor(label, ms, fn) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = fn();
      if (v) return v;
    } catch {}
    sleep(2000);
  }
  console.log(`    ...timed out waiting for: ${label}`);
  return null;
}

// Kill the consoles a scenario started, so a failure does not leave a live
// claude session behind.
//
// BY PID, never by a command-line substring. A substring match on the sandbox
// name matches the matching command's OWN command line - the same self-match
// class as guards OI-001 - and an earlier version of this function killed the
// shell that invoked it (exit 255). The console pid is recorded by winfind in
// runner/state/<sid>.window, so it is known exactly; its parent wrapper cmd
// exits on its own once claude is gone.
function cleanup(pids) {
  for (const pid of pids.filter(Boolean)) {
    if (Number(pid) === process.pid) continue;
    try {
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `Stop-Process -Id ${Number(pid)} -Force -ErrorAction SilentlyContinue`],
        { encoding: "utf8", windowsHide: true, timeout: 20000 }
      );
    } catch {}
  }
}

const results = [];
function report(n, name, pass, evidence) {
  results.push({ n, name, pass });
  console.log(`\nSCENARIO ${n} ${pass ? "PASS" : "FAIL"} - ${name}`);
  console.log(String(evidence || "(no evidence captured)").split("\n").map((l) => "    " + l).join("\n"));
}

// ---------------------------------------------------------------- scenario 1
// The happy loop: a session goes over budget, autopilot types /clear, the fresh
// session adopts the standing order, autopilot types the resume constant, the cycle is
// logged. This is the whole promise in one run.
async function scenario1() {
  const sb = sandbox(5); // tiny ceiling: the first real turn is already over it
  const standing = newStanding(sb, "Reply with exactly: BANANA. Then stop.");
  startSession(sb, { standingId: standing.id, prompt: "say BANANA and nothing else" });
  const consoles = [];
  try {
    const sid = waitFor("session binds to the standing order", 180000, () => standingJson(sb, standing.id)?.sessionId);
    const win = sid && waitFor("console pid recorded", 60000, () => windowOf(sb, sid)?.consolePid);
    if (win) consoles.push(win);

    const cleared = win && waitFor("autopilot types /clear", 240000, () => {
      autopilotOnce(sb);
      return /CLEARED/.test(autopilotLog(sb));
    });
    const cycled = cleared && waitFor("cycle logged", 60000, () => (standingJson(sb, standing.id)?.cycles || 0) >= 1);
    const newSid = cycled && waitFor("a NEW session adopts the standing order", 180000, () => {
      const g = standingJson(sb, standing.id);
      return g && g.sessionId && g.sessionId !== sid ? g.sessionId : null;
    });
    const resumed = newSid && waitFor("autopilot re-prompts the new session", 120000, () => {
      autopilotOnce(sb);
      return /RESUMED standing/.test(autopilotLog(sb));
    });

    if (newSid) consoles.push(windowOf(sb, newSid)?.consolePid);
    report(1, "over-budget clear, adopt, resume", !!resumed,
      `first session : ${sid}\nsecond session: ${newSid}\ncycles        : ${standingJson(sb, standing.id)?.cycles}\n\n${autopilotLog(sb).trim()}`);
  } finally { cleanup(consoles); }
}

// ---------------------------------------------------------------- scenario 2
// THE 2026-07-31 REGRESSION. A turn that ends UNDER budget must still be
// re-prompted. Before the liveness fix this hung forever - observed twice, once
// for 18 minutes - because only an over-budget Stop could continue the loop.
async function scenario2() {
  const sb = sandbox(400); // high ceiling: this turn cannot go over budget
  const standing = newStanding(sb, "Reply with exactly: ok. Then stop.");
  startSession(sb, { standingId: standing.id, prompt: "say ok and nothing else" });
  const consoles = [];
  try {
    const sid = waitFor("session binds", 180000, () => standingJson(sb, standing.id)?.sessionId);
    const win = sid && waitFor("console pid recorded", 60000, () => windowOf(sb, sid)?.consolePid);
    if (win) consoles.push(win);

    // The Stop hook of that under-budget turn is what must re-arm the kick.
    const armed = win && waitFor("under-budget turn end re-arms the kick", 240000, () => {
      const g = standingJson(sb, standing.id);
      return g && g.needsKick === true && g.turnEndedAt ? g : null;
    });
    const kicked = armed && waitFor("autopilot re-prompts WITHOUT a clear", 180000, () => {
      autopilotOnce(sb);
      return /RESUMED standing/.test(autopilotLog(sb));
    });

    const g = standingJson(sb, standing.id);
    report(2, "under-budget turn end is re-prompted (guards OI-002)", !!kicked,
      `needsKick=${g?.needsKick} turnEndedAt=${g?.turnEndedAt} lastKickAt=${g?.lastKickAt}\n` +
      `no CLEARED expected here: ${/CLEARED/.test(autopilotLog(sb)) ? "BUT ONE HAPPENED" : "correct, none"}\n\n` +
      autopilotLog(sb).trim());
  } finally { cleanup(consoles); }
}

// ---------------------------------------------------------------- scenario 3
// ESCALATION (OI-011). When a typed /clear cannot execute because the turn will
// not end, autopilot must press Esc to interrupt it and then clear. This path
// had never fired outside a keystroke smoke test.
//
// The stuck turn is REAL and needs no contrivance: a long-running turn is one
// the typed /clear sits behind. What is asserted is that autopilot notices (the
// request is re-written while throttled and live context is still at the
// ceiling), presses Esc, and the clear then lands.
async function scenario3() {
  const sb = sandbox(5);
  const standing = newStanding(sb, "Counting task.");
  startSession(sb, {
    standingId: standing.id,
    prompt: "Count from 1 to 40, writing each number on its own line, slowly and one at a time.",
  });
  const consoles = [];
  try {
    const sid = waitFor("session binds", 180000, () => standingJson(sb, standing.id)?.sessionId);
    const win = sid && waitFor("console pid recorded", 60000, () => windowOf(sb, sid)?.consolePid);
    if (win) consoles.push(win);
    const transcript = sid && waitFor("transcript exists", 120000, () => findTranscript(sid));
    if (!transcript) {
      report(3, "Esc escalation when the turn refuses to end (OI-011)", false, "no transcript - session never ran");
      return;
    }

    // A RESIDENT watcher, because escalation depends on in-process throttle
    // state (see startResidentAutopilot).
    consoles.push(startResidentAutopilot(sb));

    // Request 1: the turn is mid-flight, so the typed /clear queues behind it
    // rather than executing - exactly the stuck case.
    writeClearRequest(sb, sid, win, transcript);
    const clearedOnce = waitFor("first /clear typed", 90000, () => /CLEARED/.test(autopilotLog(sb)));

    // Request 2, re-written inside the 60s throttle: the escalation trigger.
    // Live context is real (~40k) against a 5k ceiling, so the "did it shrink"
    // guard passes and Esc is the only way through.
    if (clearedOnce) {
      sleep(4000);
      writeClearRequest(sb, sid, win, transcript);
    }
    const escalated = clearedOnce && waitFor("autopilot escalates with Esc", 120000, () =>
      /ESCALATE/.test(autopilotLog(sb)));
    const cleared = escalated && waitFor("and the clear lands after the Esc", 90000, () => {
      const log = autopilotLog(sb);
      return /CLEARED/.test(log.slice(log.indexOf("ESCALATE")));
    });

    report(3, "Esc escalation when the turn refuses to end (OI-011)", !!cleared,
      autopilotLog(sb).trim() || "(no autopilot log)");
  } finally { cleanup(consoles); }
}

// ---------------------------------------------------------------- scenario 4
// /cd RELIABILITY (guards OI-003). On 2026-07-31 autopilot typed /cd twice and
// the session's cwd did not change either time. The assertion here is the thing
// that actually failed - not "was /cd typed" but "did the cwd MOVE" - read from
// the session's own transcript, which records cwd per entry.
async function scenario4() {
  const sb = sandbox(400);
  const standing = newStanding(sb, "Directory move test.");
  const from = path.resolve(REPO, ".."); // C:\code - on the routes table
  startSession(sb, { standingId: standing.id, prompt: "say one and nothing else", cwd: from });
  const consoles = [];
  try {
    const sid = waitFor("session binds", 180000, () => standingJson(sb, standing.id)?.sessionId);
    const win = sid && waitFor("console pid recorded", 60000, () => windowOf(sb, sid)?.consolePid);
    if (win) consoles.push(win);
    const transcript = sid && waitFor("transcript exists", 120000, () => findTranscript(sid));
    const before = transcript && waitFor("cwd recorded in the transcript", 120000, () => cwdOf(transcript));

    // Queue the cd exactly as route.mjs would, with a replay prompt - the
    // replay is what produces a transcript entry in the NEW directory.
    fs.writeFileSync(
      path.join(sb.root, "runner", "clear-requests", `${sid}.cd.json`),
      JSON.stringify({
        kind: "cd", sessionId: sid, consolePid: win, path: REPO,
        clear: false, replay: "say two and nothing else", queued: false,
      })
    );

    const typedCd = win && waitFor("autopilot types /cd", 120000, () => {
      autopilotOnce(sb);
      return /CD .* -> /.test(autopilotLog(sb));
    });
    // A successful /cd moves this session's transcript to a NEW project-scoped
    // directory (Claude Code namespaces transcripts by cwd) - the OLD path this
    // scenario cached in `transcript` before the cd stops being written to and
    // eventually stops existing at all. Re-resolving by session id on every poll
    // (not reusing the stale path) is what lets this scenario actually OBSERVE
    // a successful cd instead of reading ENOENT off a path the cd itself moved
    // away from and reporting a false failure the instant the real bug is fixed.
    const afterTranscript = () => findTranscript(sid) || transcript;
    const took = typedCd && waitFor("the cwd actually moved", 150000, () => {
      const now = cwdOf(afterTranscript());
      return now && path.resolve(now) === path.resolve(REPO) ? now : null;
    });

    report(4, "a typed /cd actually changes the session cwd (guards OI-003)", !!took,
      `cwd before: ${before}\ncwd after : ${cwdOf(afterTranscript())}\nwanted    : ${REPO}\n\n${autopilotLog(sb).trim()}`);
  } finally { cleanup(consoles); }
}

// ---------------------------------------------------------------- scenario 5
// EMBEDDED LAUNCH (spec 2026-07-31). ACC hosts claude on a ConPTY
// (gui/ptyhost.e2e.ps1 = the GUI's transport without the GUI) and autopilot
// drives it over the pty pipe - zero keystroke injection. The reported bug
// this locks against: the kick text "populates the prompt but never submits".
// Only a transcript entry proves a submit: text sitting unsubmitted in the
// TUI never reaches the transcript.
async function scenario5() {
  const sb = sandbox(400); // high ceiling: the kick, not a clear, is under test
  const standing = newStanding(sb, "Reply with exactly: PTY. Then stop.");
  const pipeName = `acc-term-e2e-${process.pid}`;
  const pidFile = path.join(sb.root, "pty.pid");
  // ATTACHED on purpose: agent-harness sandboxes kill detached grandchildren
  // (observed 2026-07-31 - the host never ran), and the scenario owns the
  // host's lifetime anyway. Its output lands in ptyhost.log for post-mortems.
  const hostLog = fs.openSync(path.join(sb.root, "ptyhost.log"), "w");
  const host = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(REPO, "gui", "ptyhost.e2e.ps1"),
     "-PipeName", pipeName, "-StandingId", standing.id, "-Cwd", REPO, "-PidFile", pidFile,
     "-TimeoutSeconds", "600", "-Model", MODEL],
    { env: { ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath, ACC_STANDING_DIR: "" },
      stdio: ["ignore", hostLog, hostLog], windowsHide: true }
  );
  host.unref();
  const consoles = [];
  try {
    const childPid = waitFor("pty child pid file", 90000, () =>
      fs.existsSync(pidFile) ? Number(String(fs.readFileSync(pidFile, "utf8")).trim()) : null);
    if (childPid) consoles.push(childPid);

    const sid = childPid && waitFor("session binds to the standing order", 180000, () => standingJson(sb, standing.id)?.sessionId);
    // Task 4 end-to-end: the record must say pty + THIS pipe. consolePid is
    // the claude node process (the SessionStart hook's parent), which is a
    // descendant of the cmd-shim child - never assumed equal to it.
    const win = sid && waitFor("pty window record with the pipe name", 90000, () => {
      const w = windowOf(sb, sid);
      return w && w.transport === "pty" && w.pipe === pipeName ? w : null;
    });
    if (win) consoles.push(win.consolePid);

    const kicked = win && waitFor("autopilot kicks over the pipe", 180000, () => {
      autopilotOnce(sb);
      return /via pty OK/.test(autopilotLog(sb));
    });

    // THE assertion - the reported failure: the kick must have SUBMITTED. The
    // transcript gains the kick as a user message AND an assistant turn after
    // it. An unsubmitted kick produces neither.
    const transcript = kicked && waitFor("transcript exists", 120000, () => findTranscript(sid));
    const submitted = transcript && waitFor("kick in the transcript, then an assistant turn", 240000, () => {
      const lines = fs.readFileSync(transcript, "utf8").split("\n");
      let kickAt = -1;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!l || l.charCodeAt(0) !== 123) continue;
        try {
          const o = JSON.parse(l);
          if (kickAt < 0 && o.type === "user" &&
              JSON.stringify(o.message?.content ?? "").includes("Continue the active ACC standing order.")) kickAt = i;
          else if (kickAt >= 0 && o.type === "assistant") return true;
        } catch {}
      }
      return false;
    });

    const log = autopilotLog(sb);
    const injected = /OK wrote=/.test(log); // sendconsole's success marker - must be absent
    report(5, "embedded pty launch: the kick submits with zero human input", !!submitted && !injected,
      `pty child   : ${childPid}\nsession     : ${sid}\nwindow      : ${JSON.stringify(windowOf(sb, sid))}\n` +
      `keystroke injection used: ${injected ? "YES - FAIL" : "none, pipe only"}\n\n${log.trim()}`);
  } finally {
    cleanup(consoles);
    try { host.kill(); } catch {}
  }
}

const only = process.argv.includes("--only") ? Number(process.argv[process.argv.indexOf("--only") + 1]) : 0;
const all = { 1: scenario1, 2: scenario2, 3: scenario3, 4: scenario4, 5: scenario5 };
// Each scenario holds a machine-wide lane slot for its whole life (session +
// autopilot cycles + cleanup). Scenarios were already sequential WITH EACH
// OTHER; the slot is what stops a proof run from overlapping the slice-runner
// or any other automated launch — the concurrent-stream jam behind the
// econnreset bursts. The NOTE the lane logs while waiting says who holds it.
for (const [n, fn] of Object.entries(all))
  if (!only || only === Number(n))
    await withLaunchSlot(`e2e:scenario${n}`, fn, { ttlMs: 25 * 60 * 1000, onLog: (l) => console.log(`    ${l}`) });

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} scenarios passed`);
process.exit(results.some((r) => !r.pass) ? 1 : 0);

#!/usr/bin/env node
// The kernel's PreToolUse hook. Registered ONLY in a run's generated settings,
// so nothing about interactive sessions changes.
//
// Exit 0 = allow, exit 2 = deny with the reason on stderr — the convention
// hooks/guard.mjs already uses, and the one Claude Code feeds back to the
// model. Every path that cannot read what it needs DENIES (AC-G11): a guard
// that fails open is not a guard.
//
// Everything is re-read on every fire (contract, pin, policy) because that is
// what makes a live GUI edit apply to the next tool call (AC-G9/AC-U2) and a
// mid-run settings tamper deny everything (AC-G6).
import fs from "node:fs";
import path from "node:path";
import { decide } from "./guard.mjs";
import { verifySettingsPin } from "./settings.mjs";
import { loadKernelPolicy, alwaysDenyWriteRoots } from "./policy.mjs";
import { appendDecision, decisionCounts } from "./ledger.mjs";

function deny(reason, runId, record) {
  if (runId && record) {
    try { appendDecision(runId, record); } catch { /* the denial still stands */ }
  }
  console.error(`kernel-guard: ${reason}`);
  process.exit(2);
}

// readFileSync(0) returns empty on Windows pipes — the same trap hooks/guard.mjs
// documents. Read asynchronously with a cap so a never-closing pipe cannot hold
// the tool call open until the hook timeout. The cap is env-overridable so a
// test can prove the timeout path fires without a real multi-second wait.
const STDIN_TIMEOUT_MS = Number(process.env.ACC_GUARDHOOK_STDIN_TIMEOUT_MS) || 4000;
const raw = await new Promise((resolve) => {
  let buf = "";
  const timer = setTimeout(() => resolve(buf), STDIN_TIMEOUT_MS);
  // "end" and "error" resolve identically (whatever is buffered so far) — one
  // shared handler, not two, because an unhandled stream "error" would
  // otherwise crash the process instead of failing closed via deny() below.
  const finish = () => { clearTimeout(timer); resolve(buf); };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
});

const dir = process.env.ACC_KERNEL_DIR;
if (!dir) deny("no ACC_KERNEL_DIR in the environment — refusing to allow an unguarded call");

let pin;
try {
  pin = JSON.parse(fs.readFileSync(path.join(dir, "pin.json"), "utf8"));
} catch (e) {
  deny(`cannot read the run pin (${e.message}) — failing closed`);
}

const integrity = verifySettingsPin(dir);
if (!integrity.ok) {
  deny(
    `settings integrity check FAILED (expected ${integrity.expected}, got ${integrity.actual}) — denying every action for run ${pin.runId}`,
    pin.runId,
    { tool: null, allow: false, rule: "integrity", reason: "generated settings changed mid-run", target: null, flagged: true }
  );
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  deny(`no readable hook payload on stdin (${raw.length} bytes) — failing closed`, pin.runId, {
    tool: null, allow: false, rule: "payload", reason: "unreadable stdin payload", target: null,
  });
}

let contract, policy;
try {
  contract = JSON.parse(fs.readFileSync(path.join(dir, "contract.json"), "utf8"));
  policy = loadKernelPolicy();
} catch (e) {
  deny(`cannot read the contract or kernel policy (${e.message}) — failing closed`, pin.runId, {
    tool: payload?.tool_name ?? null, allow: false, rule: "config", reason: "unreadable contract or policy", target: null,
  });
}

const ceiling = Number.isFinite(contract?.budget?.toolCalls)
  ? contract.budget.toolCalls
  : policy.budget.toolCalls;

// Attempts, not just successes: a harness looping on denied calls is burning a
// real budget and must hit the same ceiling.
const attempts = decisionCounts(pin.runId).total;

const d = decide(payload, {
  contract, policy, attempts, ceiling,
  denyRoots: alwaysDenyWriteRoots(),
  stagingDir: dir,
});

try {
  appendDecision(pin.runId, { tool: d.tool, allow: d.allow, rule: d.rule, reason: d.reason, target: d.target });
} catch (e) {
  // A decision that cannot be recorded is a decision that cannot be audited.
  deny(`cannot write the decision log (${e.message}) — failing closed`);
}

if (!d.allow) {
  console.error(`kernel-guard: ${d.reason} [${d.rule}]`);
  process.exit(2);
}
process.exit(0);

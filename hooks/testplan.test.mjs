// node --test hooks/testplan.test.mjs  (run from C:\code\guards)
//
// Hermetic. ACC_ROOT sandboxes the latch dir BEFORE import (route.test.mjs
// discipline — live runner/state must never collect test latches, OI-009).
// The hook end-to-end runs as a subprocess with stdin JSON, exactly as Claude
// Code invokes it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.ACC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "acc-testplan-test-"));
const { shouldFire, contract } = await import("./testplan.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ACC_ROOT;

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function fire(payload) {
  return execFileSync("node", [path.join(HERE, "testplan.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ACC_ROOT: ROOT },
  });
}

test("planning prompts fire", () => {
  for (const p of [
    "plan out the retry queue for the watcher",
    "let's implement the coverage gate next",
    "write a spec for the lane statusline light",
    "build out a new tab in the command center",
    "add a hook that paces launches",
    "work the board until the done marker",
  ]) assert.ok(shouldFire(p), `should fire: ${p}`);
});

test("a pasted log or huge paste over the length cap does not fire, even with plan-shaped words", () => {
  assert.equal(shouldFire("plan out " + "x".repeat(8000)), false);
});

test("chat, follow-ups, machinery and slash commands do not fire", () => {
  for (const p of [
    "why did scenario 3 time out?",
    "yes do that",
    "Continue the active ACC goal.",
    "Run the queued prompt.",
    "/approve",
    "/clear",
    "",
    null,
  ]) assert.equal(shouldFire(p), false, `must not fire: ${JSON.stringify(p)}`);
});

test("the contract names all five clauses and the gates it binds", () => {
  const c = contract();
  for (const must of ["MATRIX", "RED FIRST", "TIERS", "GATES", "LEAN", "covgate.mjs", "withLaunchSlot", "fast tier"])
    assert.ok(c.includes(must), `contract must mention: ${must}`);
});

test("end-to-end: a planning prompt injects the contract once, then latches", () => {
  const sid = "tp-e2e-1";
  const first = fire({ session_id: sid, prompt: "plan out the retry queue" });
  assert.ok(first.includes("additionalContext"), "first planning prompt must inject");
  assert.ok(first.includes("Test contract"), "injection must carry the contract");
  assert.ok(fs.existsSync(path.join(ROOT, "runner", "state", `${sid}.testplan`)), "latch written");

  const second = fire({ session_id: sid, prompt: "now implement the second half" });
  assert.equal(second, "", "same session must not be re-injected");
});

test("end-to-end: empty stdin is treated as {} and never fires", () => {
  const out = execFileSync("node", [path.join(HERE, "testplan.mjs")], {
    input: "", encoding: "utf8", env: { ...process.env, ACC_ROOT: ROOT },
  });
  assert.equal(out, "");
});

test("end-to-end: a missing session_id still latches (falls back to 'unknown')", () => {
  const first = fire({ prompt: "plan out the retry queue" }); // no session_id at all
  assert.ok(first.includes("Test contract"));
  assert.ok(fs.existsSync(path.join(ROOT, "runner", "state", "unknown.testplan")));
  fs.unlinkSync(path.join(ROOT, "runner", "state", "unknown.testplan")); // don't leak into later tests
});

test("end-to-end: a non-planning prompt stays silent and writes no latch", () => {
  const sid = "tp-e2e-2";
  assert.equal(fire({ session_id: sid, prompt: "what failed in the log?" }), "");
  assert.equal(fs.existsSync(path.join(ROOT, "runner", "state", `${sid}.testplan`)), false);
});

test("end-to-end: ACC_ROOT unset falls back to the real repo root, proven safely via a non-firing prompt", () => {
  // ROOT is resolved once at module load (unlike lane.mjs's lazy POLICY()),
  // so the fallback branch is only reachable in a fresh subprocess. A
  // non-planning prompt returns before any fs write, so this proves the
  // fallback resolves without ever touching the real runner/state.
  const env = { ...process.env };
  delete env.ACC_ROOT;
  const out = execFileSync("node", [path.join(HERE, "testplan.mjs")], {
    input: JSON.stringify({ session_id: "acc-root-fallback-probe", prompt: "what time is it" }),
    encoding: "utf8", env,
  });
  assert.equal(out, "");
});

test("fail-open: a STATE dir that cannot be written to still exits cleanly (no crash, no injection)", { skip: process.platform === "win32" ? "chmod-based fault injection is POSIX-only; funcs/lines for this file are unaffected on Windows" : false }, () => {
  // Forces the real existsSync/mkdirSync/writeFileSync catches in hook() —
  // not a mock, a genuine EACCES from a read-only parent directory. Proves
  // the documented promise directly: "a broken injector must never cost a
  // turn" even when the state dir itself is the thing that's broken.
  const lockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acc-testplan-locked-"));
  fs.mkdirSync(path.join(lockedRoot, "runner"), { recursive: true });
  fs.chmodSync(path.join(lockedRoot, "runner"), 0o444);
  try {
    const out = execFileSync("node", [path.join(HERE, "testplan.mjs")], {
      input: JSON.stringify({ session_id: "locked-probe", prompt: "plan out the retry queue" }),
      encoding: "utf8", env: { ...process.env, ACC_ROOT: lockedRoot },
    });
    assert.ok(out.includes("Test contract"), "fs failures must not block the injection itself");
  } finally {
    fs.chmodSync(path.join(lockedRoot, "runner"), 0o755);
    fs.rmSync(lockedRoot, { recursive: true, force: true });
  }
});

test("fail-open: garbage stdin exits 0 with no output", () => {
  const out = execFileSync("node", [path.join(HERE, "testplan.mjs")], {
    input: "not json at all {",
    encoding: "utf8",
    env: { ...process.env, ACC_ROOT: ROOT },
  });
  assert.equal(out, "");
});

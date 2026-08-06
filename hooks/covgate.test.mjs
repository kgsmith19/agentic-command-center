// node --test hooks/covgate.test.mjs  (run from C:\code\guards)
//
// Hermetic. The end-to-end tests gate a FIXTURE git repo (temp dir, own
// history), never this one — so the suite passes identically whether the real
// working tree is clean or mid-change. Nested `node --test` subprocesses are
// the gate's real mechanics, exercised for real.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { parseLcov, changedLibFiles, normPath, floors, parseRange } = await import("./covgate.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COVGATE = path.join(HERE, "covgate.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-covgate-test-"));

// Unlike clearbot.test.mjs's/runner.test.mjs's spawns, this file's `gate()`
// subprocess IS covgate.mjs itself (a gated file) — its main() only ever
// runs via this exact subprocess call, so it must keep inheriting a live
// NODE_V8_COVERAGE (when one exists) rather than have it stripped: that is
// how main()'s lines end up counted in the real run's own coverage report at
// all. Isolation from deeper nesting is covgate.mjs's OWN job (its internal
// spawnSync clears NODE_V8_COVERAGE before spawning ITS child) — fixing it
// here too would double-isolate and silently zero out main()'s coverage.

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("floors() falls back to defaults (100/100/90) when ACC_POLICY is unset, unreadable, or numbers are junk", () => {
  const saved = process.env.ACC_POLICY;
  delete process.env.ACC_POLICY; // lazy POLICY() re-reads per call — reads the real guards/policy.json, read-only
  try {
    const f = floors();
    assert.ok(f.lines > 0 && f.funcs > 0 && f.branches > 0);
  } finally { process.env.ACC_POLICY = saved; }

  const bad = path.join(BASE, "unreadable-policy.json");
  fs.writeFileSync(bad, "{not valid json");
  process.env.ACC_POLICY = bad;
  assert.deepEqual(floors(), { lines: 100, funcs: 100, branches: 90 });

  const junk = path.join(BASE, "junk-policy.json");
  fs.writeFileSync(junk, JSON.stringify({ tests: { changedLineCoverage: "not a number" } }));
  process.env.ACC_POLICY = junk;
  assert.equal(floors().lines, 100);
  process.env.ACC_POLICY = saved;
});

test("floors() falls back to defaults when the JSON is valid but has no 'tests' section at all", () => {
  const p = path.join(BASE, "no-tests-key-policy.json");
  fs.writeFileSync(p, JSON.stringify({ lane: { slots: 1 } })); // valid JSON, no "tests" key
  const saved = process.env.ACC_POLICY;
  process.env.ACC_POLICY = p;
  assert.deepEqual(floors(), { lines: 100, funcs: 100, branches: 90 });
  process.env.ACC_POLICY = saved;
});

test("floors(file) applies a per-file branchFloorOverrides entry; other files and the no-arg call stay on the default", () => {
  const p = path.join(BASE, "override-policy.json");
  fs.writeFileSync(p, JSON.stringify({ tests: { branchFloorOverrides: { "hooks/lane.mjs": 85 } } }));
  const saved = process.env.ACC_POLICY;
  process.env.ACC_POLICY = p;
  assert.equal(floors("hooks/lane.mjs").branches, 85);
  assert.equal(floors("hooks/other.mjs").branches, 90);
  assert.equal(floors().branches, 90);
  process.env.ACC_POLICY = saved;
});

test("floors() honors a real custom numeric override", () => {
  const custom = path.join(BASE, "custom-policy.json");
  fs.writeFileSync(custom, JSON.stringify({ tests: { changedLineCoverage: 42, changedFunctionCoverage: 55, changedBranchCoverage: 33 } }));
  const saved = process.env.ACC_POLICY;
  process.env.ACC_POLICY = custom;
  assert.deepEqual(floors(), { lines: 42, funcs: 55, branches: 33 });
  process.env.ACC_POLICY = saved;
});

test("parseRange accepts \"<oldrev> <newrev>\", tolerates extra whitespace", () => {
  assert.deepEqual(parseRange("abc123 def456"), { oldrev: "abc123", newrev: "def456" });
  assert.deepEqual(parseRange("  abc123   def456  "), { oldrev: "abc123", newrev: "def456" });
});

test("parseRange rejects anything that isn't exactly two tokens", () => {
  assert.equal(parseRange(""), null);
  assert.equal(parseRange("onlyone"), null);
  assert.equal(parseRange("one two three"), null);
  assert.equal(parseRange(undefined), null);
});

test("changedLibFiles keeps lib .mjs under hooks/ and runner/, drops tests, harnesses and noise", () => {
  const out = changedLibFiles([
    "hooks/lane.mjs",
    "runner/runner.mjs",
    "hooks/lane.test.mjs",
    "e2e/loop.e2e.mjs",
    "hooks\\covgate.mjs", // windows separators normalize
    "guards-gui.ps1",
    "AGENTS.md",
    "hooks/lane.mjs", // duplicate collapses
  ]);
  assert.deepEqual(out.sort(), ["hooks/covgate.mjs", "hooks/lane.mjs", "runner/runner.mjs"]);
});

// Kernel modules must be gated exactly like hooks/ and runner/ — the gate is
// what makes the kernel's 100/100/90 floors real. One level of nesting is
// allowed so kernel/adapters/<harness>.mjs is gated too.
test("changedLibFiles drops Playwright specs — a .spec.mjs is the harness, not a gated lib file", () => {
  assert.deepEqual(
    changedLibFiles(["gui/server.mjs", "gui/e2e/kernel-settings.spec.mjs"]),
    ["gui/server.mjs"]
  );
});

test("changedLibFiles gates kernel modules, including one level of nesting", () => {
  assert.deepEqual(
    changedLibFiles([
      "kernel/run.mjs",
      "kernel/adapters/claude-code.mjs",
      "hooks/guard.mjs",
      "kernel/run.test.mjs",
      "kernel/adapters/claude-code.test.mjs",
      "docs/superpowers/plans/x.md",
    ]),
    ["kernel/run.mjs", "kernel/adapters/claude-code.mjs", "hooks/guard.mjs"]
  );
});

test("parseLcov computes line, function and branch coverage per file", () => {
  const cov = parseLcov(
    [
      "TN:", "SF:/repo/hooks/a.mjs",
      "FNDA:1,add", "FNDA:0,sub",           // declared but never called
      "BRDA:3,0,0,1", "BRDA:3,0,1,-",       // "-" = block never entered = uncovered
      "DA:1,1", "DA:2,0", "DA:3,4",
      "end_of_record",
      "SF:/repo/hooks/b.mjs", "DA:1,1", "DA:2,1", "end_of_record",
    ].join("\n")
  );
  const a = cov.get(normPath("/repo/hooks/a.mjs")).pct;
  assert.deepEqual(a, { lines: 66.7, funcs: 50, branches: 50 });
  // No FNDA/BRDA records at all = vacuously 100, never a spurious failure.
  assert.deepEqual(cov.get(normPath("/repo/hooks/b.mjs")).pct, { lines: 100, funcs: 100, branches: 100 });
});

// Phase 7 (full-remediation-prompt.md), OI-017: node's own coverage reporter
// emits ONE SF: block per SUBPROCESS, so a file imported by N different test
// files gets N separate SF: blocks in a combined lcov report, each declaring
// the SAME static lines/functions/branches with DIFFERENT hit counts (which
// test happened to exercise which path). Confirmed for real: hooks/usage.mjs
// alone produced 19 SF: blocks in one fast-tier run, each with the identical
// 637 DA: records. Two wrong ways to merge that: (a) the pre-fix parser did
// `cur = blank(); files.set(path, cur)` on every SF: line unconditionally, so
// only the LAST block survived — arbitrary and undercounting (whichever test
// happened to be parsed last decided the file's entire reported coverage);
// (b) naive concatenation (sum every block's DA:/FNDA:/BRDA: counts) is
// WORSE — for usage.mjs it would inflate the true 637-line file to a reported
// 637*19 "total lines", diluting the percentage into meaninglessness no
// matter how well-tested the file actually is. The correct merge is identity
// keyed: a line/branch/function is COVERED if hit in ANY block, counted
// exactly ONCE either way.
//
// This fixture models that: two blocks for the same file, each covering only
// HALF of it (as two different importing test files plausibly would), with
// no overlap in what each one hits. Overwrite-last would report whichever
// block parsed last as if it were the file's ENTIRE coverage (50%, and
// wrongly named which half). Sum-blindly would report the right numerators
// over a doubled denominator (also 50%, but for the wrong reason — real
// review would show the sum-based bug on a file with OVERLAPPING blocks,
// which the next assertion below covers). The correct merge reports 100%:
// every line/branch/function this file has was hit by SOMETHING.
test("parseLcov merges per-file blocks by code-point identity: covered-in-any-block, counted-once", () => {
  const cov = parseLcov(
    [
      "SF:/repo/hooks/a.mjs",
      "FN:1,add", "FN:2,sub",
      "FNDA:1,add", "FNDA:0,sub",
      "DA:1,1", "DA:2,0",
      "BRDA:1,0,0,1", "BRDA:2,0,0,-",
      "end_of_record",
      // a second importing test file's own process report for the SAME file —
      // covers exactly the other half.
      "SF:/repo/hooks/a.mjs",
      "FN:1,add", "FN:2,sub",
      "FNDA:0,add", "FNDA:1,sub",
      "DA:1,0", "DA:2,1",
      "BRDA:1,0,0,-", "BRDA:2,0,0,1",
      "end_of_record",
    ].join("\n")
  );
  const a = cov.get(normPath("/repo/hooks/a.mjs"));
  assert.equal(a.lines.t, 2, "one file's 2 lines stay 2 lines, not 4, across 2 blocks");
  assert.equal(a.lines.c, 2, "line 1 (block 1) + line 2 (block 2) union to fully covered");
  assert.equal(a.funcs.t, 2);
  assert.equal(a.funcs.c, 2, "add (block 1) + sub (block 2) union to fully covered");
  assert.equal(a.branches.t, 2);
  assert.equal(a.branches.c, 2, "branch 1 (block 1) + branch 2 (block 2) union to fully covered");
  assert.deepEqual(a.pct, { lines: 100, funcs: 100, branches: 100 });
});

// The failure mode overwrite-last actually has in practice: whichever block
// is parsed LAST silently becomes the file's entire reported coverage, even
// though the FIRST block proved line 1 was hit by something.
test("parseLcov: a later block must not erase an earlier block's coverage of the same line", () => {
  const cov = parseLcov(
    [
      "SF:/repo/hooks/b.mjs", "DA:1,5", "DA:2,0", "end_of_record",
      "SF:/repo/hooks/b.mjs", "DA:1,0", "DA:2,0", "end_of_record",
    ].join("\n")
  );
  const b = cov.get(normPath("/repo/hooks/b.mjs"));
  assert.equal(b.lines.t, 2);
  assert.equal(b.lines.c, 1, "line 1's hit in block 1 must survive block 2 reporting it unhit");
});

// A fixture repo the gate can judge: one lib file, one test, git history so
// "changed since HEAD" means the uncommitted lib + test.
function fixture(name, { covered }) {
  const repo = path.join(BASE, name);
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  fs.writeFileSync(
    path.join(repo, "hooks", "lib.mjs"),
    "export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n"
  );
  fs.writeFileSync(
    path.join(repo, "hooks", "lib.test.mjs"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add' + (covered ? ", sub" : "") + ' } from "./lib.mjs";',
      'test("add", () => assert.equal(add(2, 3), 5));',
      covered ? 'test("sub", () => assert.equal(sub(5, 3), 2));' : "",
    ].join("\n")
  );
  return repo;
}

function gate(cwd) {
  try {
    const stdout = execFileSync("node", [COVGATE], {
      cwd, encoding: "utf8",
      env: { ...process.env, ACC_COVGATE_TESTS: "hooks/lib.test.mjs", ACC_POLICY: path.join(BASE, "nope.json") },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || "") + String(e.stderr || "") };
  }
}

test("end-to-end: not a git repo at all fails closed, naming why", () => {
  const dir = path.join(BASE, "notgit");
  fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "hooks", "x.mjs"), "export const x = 1;\n");
  let out;
  try {
    execFileSync("node", [COVGATE], { cwd: dir, encoding: "utf8", env: { ...process.env, ACC_COVGATE_TESTS: "hooks/none.test.mjs", ACC_POLICY: path.join(BASE, "nope.json") } });
    assert.fail("expected a non-zero exit");
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
    assert.notEqual(e.status, 0);
  }
  assert.ok(/cannot determine what changed/.test(out), out);
});

test("end-to-end: default discovery tolerates a missing sibling dir (only hooks/ exists)", () => {
  const repo = path.join(BASE, "onedir");
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true }); // no runner/ dir at all
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  fs.writeFileSync(path.join(repo, "hooks", "solo.mjs"), "export const solo = () => 1;\n");
  fs.writeFileSync(
    path.join(repo, "hooks", "solo.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { solo } from "./solo.mjs";\ntest("solo", () => assert.equal(solo(), 1));\n'
  );
  const out = execFileSync("node", [COVGATE], { cwd: repo, encoding: "utf8", env: { ...process.env, ACC_COVGATE_TESTS: undefined, ACC_POLICY: path.join(BASE, "nope.json") } });
  assert.ok(/PASS/.test(out), out);
});

test("end-to-end: a changed file with genuinely zero tests anywhere fails as no-coverage, not a crash", () => {
  const repo = path.join(BASE, "notests");
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(repo, "runner"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  fs.writeFileSync(path.join(repo, "hooks", "orphan.mjs"), "export const orphan = () => 1;\n");
  let out, status;
  try {
    execFileSync("node", [COVGATE], { cwd: repo, encoding: "utf8", env: { ...process.env, ACC_COVGATE_TESTS: undefined, ACC_POLICY: path.join(BASE, "nope.json") } });
    status = 0;
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
    status = e.status;
  }
  assert.notEqual(status, 0);
  assert.ok(/no coverage emitted/.test(out), out);
});

test("end-to-end: a file git reports as changed but that no longer exists on disk (deleted) is silently skipped", () => {
  const repo = path.join(BASE, "deleted");
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  fs.writeFileSync(path.join(repo, "hooks", "gone.mjs"), "export const gone = 1;\n");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add then remove");
  fs.rmSync(path.join(repo, "hooks", "gone.mjs"));
  const out = execFileSync("node", [COVGATE], { cwd: repo, encoding: "utf8", env: { ...process.env, ACC_COVGATE_TESTS: "", ACC_POLICY: path.join(BASE, "nope.json") } });
  assert.ok(/no changed lib files/.test(out), out); // "changed" per git, but gone from disk — nothing to gate
});

test("end-to-end: a genuinely failing fast tier fails the gate before coverage is even read", () => {
  const repo = path.join(BASE, "redtier");
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  fs.writeFileSync(path.join(repo, "hooks", "buggy.mjs"), "export const buggy = () => 1;\n");
  fs.writeFileSync(
    path.join(repo, "hooks", "buggy.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { buggy } from "./buggy.mjs";\ntest("buggy", () => assert.equal(buggy(), 999));\n' // deliberately wrong
  );
  let out, status;
  try {
    execFileSync("node", [COVGATE], { cwd: repo, encoding: "utf8", env: { ...process.env, ACC_COVGATE_TESTS: undefined, ACC_POLICY: path.join(BASE, "nope.json") } });
    status = 0;
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
    status = e.status;
  }
  assert.notEqual(status, 0);
  assert.ok(/fast tier is red/.test(out), out);
});

test("end-to-end: a fully covered changed file passes the gate", () => {
  const r = gate(fixture("full", { covered: true }));
  assert.equal(r.code, 0, r.stdout);
  assert.ok(/PASS/.test(r.stdout));
});

test("end-to-end: an untested function fails the gate even at 100% lines", () => {
  // THE hole this gate exists to close: sub() is never called, V8 still marks
  // its declaration line covered, so a line-only gate would pass this.
  const r = gate(fixture("partial", { covered: false }));
  assert.equal(r.code, 1, r.stdout);
  assert.ok(/FAIL.*hooks\/lib\.mjs/.test(r.stdout), `must name the offender: ${r.stdout}`);
  assert.ok(/under floor on:.*funcs/.test(r.stdout), `must name the metric that caught it: ${r.stdout}`);
});

test("end-to-end: gui/ is inside the coverage fence — default discovery finds gui/*.test.mjs and an uncovered function fails the gate", () => {
  const repo = path.join(BASE, "gui-partial");
  fs.mkdirSync(path.join(repo, "gui"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  fs.writeFileSync(
    path.join(repo, "gui", "x.mjs"),
    "export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n"
  );
  fs.writeFileSync(
    path.join(repo, "gui", "x.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./x.mjs";\ntest("add", () => assert.equal(add(2, 3), 5));\n'
  );
  let out, status;
  try {
    execFileSync("node", [COVGATE], { cwd: repo, encoding: "utf8", env: { ...process.env, ACC_COVGATE_TESTS: undefined, ACC_POLICY: path.join(BASE, "nope.json") } });
    status = 0;
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
    status = e.status;
  }
  assert.notEqual(status, 0);
  assert.ok(/FAIL.*gui\/x\.mjs/.test(out), `must name the offender: ${out}`);
});

test("end-to-end: default discovery covers BOTH hooks/ and runner/ (regression, 2026-08-01)", () => {
  // The bug this locks against: discovery once scanned only hooks/, so a
  // runner/ file could have a real, passing test suite and covgate would
  // still report it uncovered because the suite never ran.
  const repo = path.join(BASE, "two-dirs");
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(repo, "runner"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  fs.writeFileSync(path.join(repo, "hooks", "h.mjs"), "export const h = () => 1;\n");
  fs.writeFileSync(
    path.join(repo, "hooks", "h.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { h } from "./h.mjs";\ntest("h", () => assert.equal(h(), 1));\n'
  );
  fs.writeFileSync(path.join(repo, "runner", "r.mjs"), "export const r = () => 2;\n");
  fs.writeFileSync(
    path.join(repo, "runner", "r.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { r } from "./r.mjs";\ntest("r", () => assert.equal(r(), 2));\n'
  );
  // No ACC_COVGATE_TESTS override — this exercises the real default-discovery
  // path, so it must NOT inherit one from whatever invoked this suite itself
  // (found 2026-08-01: running covgate.mjs's own verification with
  // ACC_COVGATE_TESTS set in the shell leaked three levels deep into this
  // exact test and broke it for the wrong reason — the var must be actively
  // cleared, not just "not set by us").
  let out;
  try {
    out = execFileSync("node", [COVGATE], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, ACC_COVGATE_TESTS: undefined, ACC_POLICY: path.join(BASE, "nope.json") },
    });
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
    assert.fail(`expected PASS, got:\n${out}`);
  }
  assert.ok(/hooks\/h\.mjs/.test(out) && / ok /.test(out.match(/.*hooks\/h\.mjs.*/)[0]), out);
  assert.ok(/runner\/r\.mjs/.test(out) && / ok /.test(out.match(/.*runner\/r\.mjs.*/)[0]), out);
  assert.ok(/PASS/.test(out), out);
});

test("end-to-end: ACC_COVGATE_RANGE gates the commit range, ignoring uncommitted working-tree changes", () => {
  // Two real commits: root (lib.mjs, fully covered) then a second commit
  // that ADDS extra.mjs (also fully covered). After that, a THIRD,
  // deliberately UNCOVERED file is left dirty in the working tree — range
  // mode must gate only what the range actually touched (extra.mjs), never
  // the dirty file, proving it reads git history, not the working tree.
  const repo = path.join(BASE, "range-mode");
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  fs.writeFileSync(path.join(repo, "hooks", "lib.mjs"), "export const lib = () => 1;\n");
  fs.writeFileSync(
    path.join(repo, "hooks", "lib.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { lib } from "./lib.mjs";\ntest("lib", () => assert.equal(lib(), 1));\n'
  );
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "root");
  const oldrev = g("rev-parse", "HEAD").trim();

  fs.writeFileSync(path.join(repo, "hooks", "extra.mjs"), "export const extra = () => 2;\n");
  fs.writeFileSync(
    path.join(repo, "hooks", "extra.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { extra } from "./extra.mjs";\ntest("extra", () => assert.equal(extra(), 2));\n'
  );
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add extra");
  const newrev = g("rev-parse", "HEAD").trim();

  // Dirty, uncommitted, deliberately uncovered — must be invisible to range mode.
  fs.writeFileSync(path.join(repo, "hooks", "dirty.mjs"), "export const dirty = () => 3;\n");

  const rangeOut = execFileSync("node", [COVGATE], {
    cwd: repo, encoding: "utf8",
    env: { ...process.env, ACC_COVGATE_RANGE: `${oldrev} ${newrev}`, ACC_COVGATE_TESTS: undefined, ACC_POLICY: path.join(BASE, "nope.json") },
  });
  assert.ok(/hooks\/extra\.mjs/.test(rangeOut), rangeOut);
  assert.ok(!/hooks\/lib\.mjs/.test(rangeOut), `unchanged-in-range file must not appear: ${rangeOut}`);
  assert.ok(!/hooks\/dirty\.mjs/.test(rangeOut), `dirty working-tree file must not appear: ${rangeOut}`);
  assert.ok(/PASS/.test(rangeOut), rangeOut);

  // Same repo, default (working-tree) mode: the dirty file IS visible and,
  // being untested, fails — proving the two modes are genuinely different,
  // not that range mode happens to also see everything.
  let defaultOut, defaultStatus;
  try {
    defaultOut = execFileSync("node", [COVGATE], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, ACC_COVGATE_RANGE: undefined, ACC_COVGATE_TESTS: undefined, ACC_POLICY: path.join(BASE, "nope.json") },
    });
    defaultStatus = 0;
  } catch (e) {
    defaultOut = String(e.stdout || "") + String(e.stderr || "");
    defaultStatus = e.status;
  }
  assert.notEqual(defaultStatus, 0);
  assert.ok(/FAIL.*hooks\/dirty\.mjs/.test(defaultOut), defaultOut);
});

test("end-to-end: ACC_COVGATE_RANGE accepts the empty-tree hash as oldrev, for a brand-new ref push", () => {
  const repo = path.join(BASE, "range-newref");
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  fs.writeFileSync(path.join(repo, "hooks", "lib.mjs"), "export const lib = () => 1;\n");
  fs.writeFileSync(
    path.join(repo, "hooks", "lib.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { lib } from "./lib.mjs";\ntest("lib", () => assert.equal(lib(), 1));\n'
  );
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "root");
  const newrev = g("rev-parse", "HEAD").trim();
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  const out = execFileSync("node", [COVGATE], {
    cwd: repo, encoding: "utf8",
    env: { ...process.env, ACC_COVGATE_RANGE: `${EMPTY_TREE} ${newrev}`, ACC_COVGATE_TESTS: undefined, ACC_POLICY: path.join(BASE, "nope.json") },
  });
  assert.ok(/hooks\/lib\.mjs/.test(out), out);
  assert.ok(/PASS/.test(out), out);
});

test("end-to-end: a malformed ACC_COVGATE_RANGE fails closed, naming the expected shape", () => {
  const repo = fixture("badrange", { covered: true });
  let out, status;
  try {
    execFileSync("node", [COVGATE], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, ACC_COVGATE_RANGE: "onlyonetoken", ACC_COVGATE_TESTS: "hooks/lib.test.mjs", ACC_POLICY: path.join(BASE, "nope.json") },
    });
    status = 0;
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
    status = e.status;
  }
  assert.notEqual(status, 0);
  assert.ok(/ACC_COVGATE_RANGE must be/.test(out), out);
});

test("end-to-end: nothing changed means nothing to gate", () => {
  const repo = fixture("clean", { covered: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "all in");
  const r = gate(repo);
  assert.equal(r.code, 0, r.stdout);
  assert.ok(/no changed lib files/.test(r.stdout));
});

test("end-to-end: covgate never inherits an ancestor's NODE_V8_COVERAGE dir for its own spawned run (regression, 2026-08-02)", () => {
  // The bug: --experimental-test-coverage auto-sets NODE_V8_COVERAGE on the
  // first process that enables it. covgate.mjs's own suite invokes covgate.mjs
  // as a child process (this exact execFileSync, below) from INSIDE a fast
  // tier that is itself coverage-instrumented (the real `node hooks/covgate.mjs`
  // run gates covgate.test.mjs among other files) -- so `...process.env` here
  // already carries a live NODE_V8_COVERAGE. If covgate.mjs's own internal
  // spawnSync passed that through unmodified, its spawned coverage run would
  // write raw V8 profile JSON into the SAME directory as whatever ancestor
  // run is already using it, and two independent `node --test
  // --experimental-test-coverage` processes racing on one shared directory
  // corrupt each other's report generation/cleanup (observed for real: "
  // Warning: Could not report code coverage. SyntaxError: Unexpected end of
  // JSON input", covgate then FAILING a fully green fast tier).
  const inherited = path.join(BASE, "inherited-coverage-dir");
  fs.mkdirSync(inherited, { recursive: true });
  const repo = fixture("isolation", { covered: true });
  const stdout = execFileSync("node", [COVGATE], {
    cwd: repo, encoding: "utf8",
    env: {
      ...process.env,
      ACC_COVGATE_TESTS: "hooks/lib.test.mjs",
      ACC_POLICY: path.join(BASE, "nope.json"),
      NODE_V8_COVERAGE: inherited,
    },
  });
  assert.ok(/PASS/.test(stdout), stdout);
  // Proves isolation, not just a lucky pass: covgate.mjs's own bare process
  // may still drop one incidental self-coverage file into an inherited dir
  // (V8 dumps on any process that starts with NODE_V8_COVERAGE set — nothing
  // short of never inheriting it in the first place, i.e. gate()'s own env,
  // can prevent that), but the FIXTURE's spawned test run — its own separate
  // `node --test --experimental-test-coverage` process, the one that actually
  // races another such process for report generation/cleanup and corrupts it
  // — must never write there. None of whatever landed may mention the
  // fixture's files.
  const leaked = fs.readdirSync(inherited)
    .map((f) => fs.readFileSync(path.join(inherited, f), "utf8"))
    .filter((text) => /lib\.(test\.)?mjs/.test(text));
  assert.deepEqual(leaked, []);
});

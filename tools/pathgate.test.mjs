import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "./pathgate.mjs";

test("a hardcoded repo path in source is a finding", () => {
  const f = m.findHardcoded(["a.mjs"], () => 'const p = "C:/code/guards/policy.json";\n');
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 1);
});

test("backslash form is caught too", () => {
  const f = m.findHardcoded(["a.mjs"], () => 'const p = "C:\\\\code\\\\guards\\\\policy.json";\n');
  assert.equal(f.length, 1);
});

test("the post-rename path is caught as well - the gate must not expire", () => {
  const f = m.findHardcoded(["a.mjs"], () => 'const p = "C:/code/agentic-command-center/x";\n');
  assert.equal(f.length, 1);
});

test("an explicitly justified line is allowed", () => {
  const f = m.findHardcoded(["a.mjs"],
    () => 'const p = "C:/code/guards"; // pathgate-ok: fixture asserting the old path\n');
  assert.deepEqual(f, []);
});

test("a bare pathgate-ok with no reason is still a finding", () => {
  const f = m.findHardcoded(["a.mjs"], () => 'const p = "C:/code/guards"; // pathgate-ok\n');
  assert.equal(f.length, 1);
});

test("a deferred finding (exact file+text match) is excluded from the count", () => {
  const r = m.run({
    files: ["hooks/usage.mjs"],
    readFile: () => 'const POLICY_PATH = process.env.ACC_POLICY || "C:/code/guards/policy.json";\n',
  });
  assert.equal(r.code, 0, r.stdout);
});

test("a deferred entry stops matching (and the finding reappears) if the line's text changes", () => {
  const r = m.run({
    files: ["hooks/usage.mjs"],
    readFile: () => 'const POLICY_PATH = "C:/code/guards/policy.json"; // rewritten differently\n',
  });
  assert.equal(r.code, 1, "a deferral must not survive a change to the deferred line's own text");
});

test("run() passes with no findings", () => {
  const r = m.run({ files: ["a.mjs"], readFile: () => "const x = 1;\n" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no hardcoded repo roots/);
});

test("run() fails and lists every finding when there are any", () => {
  const r = m.run({
    files: ["a.mjs", "b.mjs"],
    readFile: (f) => (f === "a.mjs" ? 'const p = "C:/code/guards/x";\n' : "clean\n"),
  });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /1 hardcoded repo root/);
  assert.match(r.stdout, /a\.mjs:1/);
});

// realIo() walks THIS repo's own real tree (whichever worktree is running),
// so this also exercises its exclude filtering for coverage instead of
// duplicating a second fake file list here.
test("realIo() excludes OPEN-ISSUES.md, config.json, docs/, notes/, and its own test fixtures", () => {
  const io = m.realIo();
  assert.ok(!io.files.includes("OPEN-ISSUES.md"));
  assert.ok(!io.files.includes("config.json"));
  assert.ok(!io.files.includes("tools/pathgate.test.mjs"));
  assert.ok(!io.files.some((f) => f.startsWith("docs/")));
  assert.ok(!io.files.some((f) => f.startsWith("hooks/fixtures/")));
  assert.ok(io.files.includes("tools/pathgate.mjs"), "sanity: real source files ARE included");
});

test("realIo()'s readFile reads real file contents", () => {
  const io = m.realIo();
  assert.match(io.readFile("package.json"), /"name"/);
});

// main() is a spawned subprocess's entry point in real use, invisible to this
// file's own coverage instrumentation when spawned - called directly,
// in-process, the same way tools/inventory.test.mjs exercises main(). It
// writes real stdout as a side effect; that's expected.
test("main() runs against the real tree and returns run()'s exit code", () => {
  assert.equal(m.main(), m.run(m.realIo()).code);
});

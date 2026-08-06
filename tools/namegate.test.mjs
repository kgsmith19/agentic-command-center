// Tests for tools/namegate.mjs — retired identifier/path names must not
// creep back into source. Distinguishes identifier/path uses (which are
// flagged) from genuine English prose (which is allowed) - see the module
// header for the exact rule.
//
// Run: node --test tools/namegate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "./namegate.mjs";

test("the retired names are gone from source", () => {
  const f = m.findRetired(["a.mjs"], () => 'import x from "./clearbot.ps1";\n');
  assert.equal(f.length, 1);
});

test("a genuine English use of the word is allowed", () => {
  assert.deepEqual(m.findRetired(["a.mjs"], () => '// the goal of this function is to parse\n'), []);
});

test("the OS sense of kernel in a comment is allowed", () => {
  assert.deepEqual(m.findRetired(["a.mjs"], () => '// the Windows kernel schedules this\n'), []);
});

test("goal.mjs as a path is flagged", () => {
  const f = m.findRetired(["a.mjs"], () => 'const p = "hooks/goal.mjs";\n');
  assert.equal(f.length, 1);
});

test("goals/ as a path is flagged", () => {
  const f = m.findRetired(["a.mjs"], () => 'const p = "runner/goals/";\n');
  assert.equal(f.length, 1);
});

test("goalId as an identifier is flagged", () => {
  const f = m.findRetired(["a.mjs"], () => 'function bindSession({ goalId }) {}\n');
  assert.equal(f.length, 1);
});

test("kernel/ as a path prefix is flagged", () => {
  const f = m.findRetired(["a.mjs"], () => 'import x from "../kernel/adapter.mjs";\n');
  assert.equal(f.length, 1);
});

test("kernel\\\\ (Windows path separator) is flagged too", () => {
  const f = m.findRetired(["a.mjs"], () => "const p = 'kernel\\\\adapter.mjs';\n");
  assert.equal(f.length, 1);
});

test("an explicitly justified line is allowed", () => {
  const f = m.findRetired(["a.mjs"], () => '// renamed clearbot to autopilot // namegate-ok: historical record\n');
  assert.deepEqual(f, []);
});

// This gate scans .ps1 and .cmd as well as .mjs, and the only unavoidable uses
// of a retired name live in the PowerShell watchdog installers - they must name
// the pre-rename Startup launcher and Scheduled Task to remove them. An escape
// hatch that only speaks `//` is no escape hatch for the files that need it.
test("the justification is honoured in PowerShell and batch comment syntax too", () => {
  const ps = m.findRetired(["a.ps1"], () => "Remove-Item 'ACC clearbot.cmd'  # namegate-ok: removes the pre-rename launcher\n");
  assert.deepEqual(ps, []);
  const cmd = m.findRetired(["a.cmd"], () => "del clearbot.stop  rem namegate-ok: clears the pre-rename kill switch\n");
  assert.deepEqual(cmd, []);
});

// Found by a documentation review, not by this gate: AGENTS.md still named
// `budget.mjs reviveClearbotIfDead` after the rename, and the gate reported the
// tree clean, because `\bclearbot\b` needs a word boundary and camelCase has
// none between `revive` and `Clearbot`.
test("the retired name is caught inside a camelCase identifier", () => {
  const f = m.findRetired(["a.mjs"], () => "budget.mjs reviveClearbotIfDead restarts it\n");
  assert.equal(f.length, 1);
});

test("a comment marker without the namegate-ok token is still a finding", () => {
  const f = m.findRetired(["a.ps1"], () => "Remove-Item 'ACC clearbot.cmd'  # just a normal comment\n");
  assert.equal(f.length, 1);
});

test("multiple retired names on one line are each reported", () => {
  const f = m.findRetired(["a.mjs"], () => 'clearbot also called kernel/adapter.mjs\n');
  assert.equal(f.length, 2);
});

test("realIo() excludes docs/, notes/, OPEN-ISSUES.md and the files that must name what it catches", () => {
  const io = m.realIo();
  assert.ok(!io.files.some((f) => f.startsWith("docs/")), "docs/ excluded");
  assert.ok(!io.files.some((f) => f.startsWith("notes/")), "notes/ excluded");
  assert.ok(!io.files.includes("OPEN-ISSUES.md"), "OPEN-ISSUES.md excluded");
  assert.ok(!io.files.includes("tools/namegate.test.mjs"), "this gate's own test excluded");
  assert.ok(!io.files.includes("tools/namegate.mjs"), "this gate's own source excluded");
  assert.ok(!io.files.includes("core/migrate-standing.test.mjs"), "the legacy-layout migration test excluded");
  assert.ok(io.files.includes("core/standing.mjs"), "ordinary source is still in scope");
});

// The gate is only worth wiring into `npm run gates` if a clean tree really
// reports zero - otherwise it is a permanently-red check everyone learns to
// ignore. This is the assertion that keeps it honest.
test("the real tree is clean: every retired name left is deliberately excluded or justified", () => {
  const r = m.run(m.realIo());
  assert.equal(r.code, 0, r.stdout);
});

test("realIo()'s readFile reads real file contents", () => {
  const io = m.realIo();
  assert.match(io.readFile("tools/namegate.mjs"), /findRetired/);
});

test("run() reports zero findings and a PASS line when nothing is retired", () => {
  const r = m.run({ files: ["a.mjs"], readFile: () => "nothing retired here\n" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no retired names/);
});

test("run() reports every finding and a count when something is retired", () => {
  const r = m.run({ files: ["a.mjs"], readFile: () => 'x = "clearbot"\n' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /1 retired name/);
});

// main() is a spawned subprocess's entry point in real use, invisible to
// this run's own coverage instrumentation - exercised in-process instead,
// the same way tools/pathgate.test.mjs's matching test does.
test("main() runs against the real tree and returns run()'s exit code", () => {
  assert.equal(m.main(), m.run(m.realIo()).code);
});

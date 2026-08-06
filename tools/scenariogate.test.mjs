// node --test tools/scenariogate.test.mjs   (run from the repo root)
//
// OI-019: covgate's floors prove every line EXECUTES once. They do not prove
// the suite covers the scenario space. The first module audited under this
// program (core/guard.mjs) turned up a real, live path-traversal bypass -
// one module of twelve. A gate that enumerates modules cannot be forgotten;
// diligence can.
import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("./scenariogate.mjs");

const GOOD = `# core/guard.mjs — scenarios

## standard
- test: allows a write inside writeRoots

## non-standard
- test: a path with unicode segments resolves identically

## edge
- test: a path exactly equal to a writeRoots entry is allowed

## rare
- test: mixed backslash and forward-slash traversal is caught identically

## error
- test: a malformed path object is denied, not thrown

## fault-tolerance
- na: pure module, no I/O to fail underneath (2026-08-04)
`;

test("a complete record parses into six answered axes", () => {
  const r = m.parseRecord(GOOD);
  assert.equal(Object.keys(r.axes).length, 6);
  assert.deepEqual(r.axes.standard, [{ kind: "test", name: "allows a write inside writeRoots" }]);
  assert.deepEqual(r.axes["fault-tolerance"], [
    { kind: "na", reason: "pure module, no I/O to fail underneath", date: "2026-08-04" },
  ]);
});

test("a module with no record fails the gate", () => {
  const p = m.gate(["core/ledger.mjs"], () => null);
  assert.deepEqual(p, [{ kind: "no-record", module: "core/ledger.mjs", axis: null, detail: null }]);
});

test("an unanswered axis fails the gate", () => {
  const p = m.gate(["a.mjs"], () => GOOD.replace(/## rare[\s\S]*?\n\n/, ""));
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, "unanswered-axis");
  assert.equal(p[0].axis, "rare");
});

test("na without a reason fails", () => {
  const p = m.gate(["a.mjs"], () => GOOD.replace(/- na: pure module[^\n]*/, "- na: (2026-08-04)"));
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, "na-no-reason");
  assert.equal(p[0].axis, "fault-tolerance");
});

test("na without a date fails", () => {
  const p = m.gate(["a.mjs"], () => GOOD.replace(/ \(2026-08-04\)/, ""));
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, "na-no-date");
  assert.equal(p[0].axis, "fault-tolerance");
});

test("naRatio reports how much of a record is not-applicable", () => {
  assert.equal(m.naRatio(m.parseRecord(GOOD)), 1 / 6);
});

test("a record whose module heading is missing parses with module null and no axes", () => {
  const r = m.parseRecord("not a heading at all\n## standard\n- test: x\n");
  assert.equal(r.module, null);
  assert.deepEqual(r.axes, {});
});

// AC-G5, one of the two anti-trickery criteria - catches a record claiming
// coverage that does not exist.
test("a record naming a test nobody wrote fails the gate", () => {
  const p = m.gate(["a.mjs"], () => GOOD, { knownTests: new Set() });
  assert.ok(p.some((x) => x.kind === "missing-test"));
});

test("a record whose named tests all exist passes", () => {
  const names = new Set([
    "allows a write inside writeRoots",
    "a path with unicode segments resolves identically",
    "a path exactly equal to a writeRoots entry is allowed",
    "mixed backslash and forward-slash traversal is caught identically",
    "a malformed path object is denied, not thrown",
  ]);
  assert.deepEqual(m.gate(["a.mjs"], () => GOOD, { knownTests: names }), []);
});

// AC-G17: the failure this repo has already shipped once - `4af8cd6`
// regex-matched a scheduled task's own arguments and reported the result as
// behaviour.
test("a test whose only assertion reads back what it wrote is a finding", () => {
  const src = `
test("the dial saves", () => {
  writeConfig({ enabled: true });
  assert.equal(readConfig().enabled, true);
});`;
  assert.equal(m.selfAssertingTests(["a.test.mjs"], () => src).length, 1);
});

test("a test that exercises a consumer between write and assert is fine", () => {
  const src = `
test("the dial changes behaviour", () => {
  writeConfig({ enabled: true });
  const outcome = runConsumer();
  assert.equal(outcome, "re-scoped");
});`;
  assert.deepEqual(m.selfAssertingTests(["a.test.mjs"], () => src), []);
});

test("an explicitly justified round-trip test is allowed", () => {
  const src = `
// scenariogate-ok: persistence round-trip IS the behaviour under test
test("the store round-trips", () => {
  write(x); assert.deepEqual(read(), x);
});`;
  assert.deepEqual(m.selfAssertingTests(["a.test.mjs"], () => src), []);
});

test("selfAssertingTests skips a file it cannot read instead of throwing", () => {
  assert.deepEqual(
    m.selfAssertingTests(["missing.test.mjs"], () => { throw new Error("ENOENT"); }),
    []
  );
});

test("multiple tests in one file are each judged independently", () => {
  const src = `
test("bad", () => {
  writeConfig({ a: 1 });
  assert.equal(readConfig().a, 1);
});

test("good", () => {
  writeConfig({ a: 1 });
  const outcome = runConsumer();
  assert.equal(outcome, "ok");
});`;
  const findings = m.selfAssertingTests(["a.test.mjs"], () => src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].text, "bad");
});

// Task 4 Step 6 of the test-depth program (guards#OI-019): the completeness
// gate across all twelve real kernel modules is `node tools/scenariogate.mjs
// --check-all` (see that file's own CLI section) — a standalone command, NOT
// a node:test test in this file. Node's test runner detects "node:test run()
// is being called recursively within a test file" and silently SKIPS a
// nested `node --test` subprocess spawned from inside an already-running
// `node --test` (confirmed empirically: collectKnownTests' own inner
// `node --test --test-reporter=tap` produces zero output under the guard,
// so every named test in every record falsely reports missing-test). That
// guard applies transitively through any depth of subprocess nesting, so
// --check-all cannot be proven from inside this test file either — it must
// be run bare, the same reason `tools/inventory.mjs`'s own --check is never
// exercised via a node:test subprocess call in tools/inventory.test.mjs.
// Verified manually for this commit: `node tools/scenariogate.mjs
// --check-all` reports all 12 modules ok.

test("an axis with a blank body between headings counts as unanswered, not a crash", () => {
  const record = `# a.mjs — scenarios

## standard

## non-standard
- test: x

## edge
- test: x

## rare
- test: x

## error
- test: x

## fault-tolerance
- na: reason (2026-08-04)
`;
  const p = m.gate(["a.mjs"], () => record);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, "unanswered-axis");
  assert.equal(p[0].axis, "standard");
});

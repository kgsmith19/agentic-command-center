// node --test tools/scenariogate.test.mjs   (run from C:\code\guards)
//
// OI-019: covgate's floors prove every line EXECUTES once. They do not prove
// the suite covers the scenario space. The first module audited under this
// program (kernel/guard.mjs) turned up a real, live path-traversal bypass -
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

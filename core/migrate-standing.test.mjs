// Tests for core/migrate-standing.mjs — the one-time, idempotent move of the
// legacy `goal` store into the renamed `standing order` store (AC-J5, AC-J6,
// AC-J7). Moves rather than copies: two live stores would let the loop read
// the stale one.
//
// Directory shape mirrors core/standing.mjs's real contract: active records
// live directly in the base dir, done records live under done/ - there is
// no "active" subfolder on either side of the migration.
//
// Run: node --test core/migrate-standing.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as m from "./migrate-standing.mjs";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-migrate-standing-"));

beforeEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
});

test("migrate moves a legacy goal into the standing store with a new id prefix", () => {
  fs.mkdirSync(path.join(BASE, "goals"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "goals/g-20260804-1-abcd.json"),
    JSON.stringify({ id: "g-20260804-1-abcd", text: "keep tests green", status: "active" }));

  const r = m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") });

  assert.deepEqual(r.moved, ["g-20260804-1-abcd"]);
  const moved = JSON.parse(fs.readFileSync(path.join(BASE, "standing/so-20260804-1-abcd.json"), "utf8"));
  assert.equal(moved.id, "so-20260804-1-abcd");
  assert.equal(moved.text, "keep tests green");
  assert.equal(fs.existsSync(path.join(BASE, "goals/g-20260804-1-abcd.json")), false,
    "legacy file must be MOVED, not copied - two stores means the loop can read the stale one");
});

test("migrate is idempotent", () => {
  fs.mkdirSync(path.join(BASE, "goals"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "goals/g-1-a.json"), JSON.stringify({ id: "g-1-a" }));
  m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") });
  assert.deepEqual(m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") }).moved, []);
});

test("migrate preserves consoleStartedAt from B2b", () => {
  fs.mkdirSync(path.join(BASE, "goals"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "goals/g-1-a.json"),
    JSON.stringify({ id: "g-1-a", consolePid: 42, consoleStartedAt: "2026-08-04T10:00:00.000Z" }));
  m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") });
  const j = JSON.parse(fs.readFileSync(path.join(BASE, "standing/so-1-a.json"), "utf8"));
  assert.equal(j.consoleStartedAt, "2026-08-04T10:00:00.000Z");
});

test("migrate moves done goals too, preserving the done/ subfolder", () => {
  fs.mkdirSync(path.join(BASE, "goals/done"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "goals/done/g-1-a.json"), JSON.stringify({ id: "g-1-a", status: "done" }));
  const r = m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") });
  assert.deepEqual(r.moved, ["g-1-a"]);
  assert.ok(fs.existsSync(path.join(BASE, "standing/done/so-1-a.json")));
});

test("migrate reports skipped for a file whose id does not start with g-", () => {
  fs.mkdirSync(path.join(BASE, "goals"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "goals/weird.json"), JSON.stringify({ id: "weird" }));
  const r = m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") });
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.skipped, ["weird.json"]);
});

test("migrate is a no-op when the legacy dir does not exist", () => {
  const r = m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") });
  assert.deepEqual(r, { moved: [], skipped: [] });
});

test("main() with explicit --from/--to migrates and returns 0", () => {
  fs.mkdirSync(path.join(BASE, "goals"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "goals/g-1-a.json"), JSON.stringify({ id: "g-1-a" }));
  const code = m.main(["--from", path.join(BASE, "goals"), "--to", path.join(BASE, "standing")]);
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(BASE, "standing/so-1-a.json")));
});

test("main() with no args defaults to runner/goals -> runner/standing, relative to cwd", () => {
  const cwd = process.cwd();
  process.chdir(BASE);
  try {
    fs.mkdirSync(path.join(BASE, "runner", "goals"), { recursive: true });
    fs.writeFileSync(path.join(BASE, "runner", "goals", "g-1-a.json"), JSON.stringify({ id: "g-1-a" }));
    const code = m.main([]);
    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(BASE, "runner", "standing", "so-1-a.json")));
  } finally {
    process.chdir(cwd);
  }
});

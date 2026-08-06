// node --test core/paths.test.mjs   (run from the repo root)
//
// The point of this module: a repo that does not know its own absolute path
// cannot be broken by moving it. Tested by running it from a COPY at a
// different path and asserting it reports the copy, not the original.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const m = await import("./paths.mjs");

test("repoRoot is the directory containing package.json", () => {
  assert.ok(fs.existsSync(path.join(m.repoRoot(), "package.json")));
});

test("repoRoot uses forward slashes so string comparison is stable on Windows", () => {
  assert.doesNotMatch(m.repoRoot(), /\\/);
});

// resolve() is what every caller actually uses (hooks/budget.mjs,
// tools/install-hooks.mjs, tools/inventory.mjs all import it); repoRoot() is
// the part they never touch directly. It had no test of its own here.
test("resolve() joins onto the repo root, still forward-slashed", () => {
  const p = m.resolve("core", "paths.mjs");
  assert.equal(p, `${m.repoRoot()}/core/paths.mjs`);
  assert.doesNotMatch(p, /\\/);
  assert.ok(fs.existsSync(p), "resolve() must produce a path that really exists");
});

test("a copy of the repo at another path reports THAT path", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acc-paths-"));
  fs.mkdirSync(path.join(tmp, "core"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), "{}");
  fs.copyFileSync(path.join(m.repoRoot(), "core/paths.mjs"), path.join(tmp, "core/paths.mjs"));
  const copy = await import(`file://${path.join(tmp, "core/paths.mjs").replace(/\\/g, "/")}`);
  assert.equal(copy.repoRoot(), tmp.replace(/\\/g, "/"));
  assert.notEqual(copy.repoRoot(), m.repoRoot());
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The walk-up has to stop at the filesystem root or it spins forever. That
// guard is the one branch nothing else reaches, and "it throws" is the whole
// contract: a module that cannot find its repo must say so, not hang.
test("with no package.json anywhere above it, the walk stops and says so", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acc-paths-orphan-"));
  // Precondition, asserted rather than assumed: a stray package.json in any
  // ancestor of the temp dir would make this test silently prove nothing.
  for (let d = tmp; ; d = path.dirname(d)) {
    assert.ok(!fs.existsSync(path.join(d, "package.json")), `unexpected package.json at ${d}`);
    if (path.dirname(d) === d) break;
  }
  fs.mkdirSync(path.join(tmp, "core"), { recursive: true });
  fs.copyFileSync(path.join(m.repoRoot(), "core/paths.mjs"), path.join(tmp, "core/paths.mjs"));
  const orphan = await import(`file://${path.join(tmp, "core/paths.mjs").replace(/\\/g, "/")}`);
  assert.throws(() => orphan.repoRoot(), /no package\.json above/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

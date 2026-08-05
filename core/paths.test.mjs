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

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as m from "../core/paths.mjs";
import * as k from "./testkit.mjs";

test("assertNotLiveRoot throws when handed a live repo root", () => {
  assert.throws(() => k.assertNotLiveRoot(m.repoRoot()), /refusing to use the live repo/);
});

test("assertNotLiveRoot throws for a path INSIDE the live root, not just equal to it", () => {
  assert.throws(() => k.assertNotLiveRoot(m.resolve("runner/standing")), /refusing/);
});

test("assertNotLiveRoot allows a temp dir", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kit-"));
  assert.doesNotThrow(() => k.assertNotLiveRoot(t));
  fs.rmSync(t, { recursive: true, force: true });
});

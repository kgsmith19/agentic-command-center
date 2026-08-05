// node --test hooks/prompts.test.mjs  (run from the repo root)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ACC_PROMPTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acc-prompts-test-"));
const { listPrompts, readPrompt, addPrompt, updatePrompt, upsertPrompt, removePrompt, safeName, runCli } =
  await import("./prompts.mjs");

test("safeName rejects traversal and separators, accepts a plain name", () => {
  assert.equal(safeName("foo"), "foo");
  assert.throws(() => safeName("../etc"), /invalid prompt name/);
  assert.throws(() => safeName("a/b"), /invalid prompt name/);
  assert.throws(() => safeName(""), /invalid prompt name/);
});

test("add/read/update/remove round-trip", () => {
  addPrompt("p1", "hello world");
  assert.equal(readPrompt("p1"), "hello world");
  updatePrompt("p1", "changed");
  assert.equal(readPrompt("p1"), "changed");
  removePrompt("p1");
  assert.throws(() => readPrompt("p1"));
});

test("add refuses to overwrite an existing prompt", () => {
  addPrompt("p2", "a");
  assert.throws(() => addPrompt("p2", "b"), /already exists/);
});

test("update refuses a prompt that doesn't exist", () => {
  assert.throws(() => updatePrompt("nope", "x"), /no such prompt/);
});

test("remove refuses a prompt that doesn't exist", () => {
  assert.throws(() => removePrompt("nope"), /no such prompt/);
});

test("upsertPrompt creates or overwrites without the add/update distinction", () => {
  upsertPrompt("p3", "first");
  assert.equal(readPrompt("p3"), "first");
  upsertPrompt("p3", "second");
  assert.equal(readPrompt("p3"), "second");
});

test("listPrompts returns sorted names, empty when the dir doesn't exist yet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-prompts-list-"));
  const saved = process.env.ACC_PROMPTS_DIR;
  process.env.ACC_PROMPTS_DIR = path.join(dir, "not-yet-created");
  assert.deepEqual(listPrompts(), []);
  process.env.ACC_PROMPTS_DIR = dir;
  addPrompt("b", "x");
  addPrompt("a", "y");
  assert.deepEqual(listPrompts(), ["a", "b"]);
  process.env.ACC_PROMPTS_DIR = saved;
});

test("runCli dispatches add/show/update/remove/list and rejects an unknown command", () => {
  assert.deepEqual(runCli(["add", "cli1", "hello", "there"]), { ok: true });
  assert.equal(runCli(["show", "cli1"]), "hello there");
  assert.deepEqual(runCli(["update", "cli1", "bye"]), { ok: true });
  assert.equal(runCli(["show", "cli1"]), "bye");
  assert.deepEqual(runCli(["remove", "cli1"]), { ok: true });
  assert.throws(() => runCli(["bogus"]), /unknown command/);
});

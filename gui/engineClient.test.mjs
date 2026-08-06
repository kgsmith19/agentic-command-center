// node --test gui/engineClient.test.mjs  (run from C:\code\guards)
// Hermetic: each test gets its own ACC_ROOT sandbox (set just before calling
// into engineClient, which shells to hooks/engine.mjs as a fresh subprocess
// per call -- each one re-reads ACC_ROOT from its own env, so switching it
// between tests is enough, no shared state to reset by hand).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-engine-client-"));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const E = await import("./engineClient.mjs");

function sandbox(name) {
  const root = path.join(BASE, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ enabled: true, secrets: [], protected: [], projects: [] }));
  process.env.ACC_ROOT = root;
  return root;
}

test("status returns the parsed engine status block", () => {
  sandbox("status");
  assert.deepEqual(E.status(), { enabled: true, secrets: [], protected: [], projects: [], vaultKeys: [], pending: 0, trashed: 0 });
});

test("secretOp add/rm round-trips through status", () => {
  sandbox("secret");
  E.secretOp("add", "*.pfx");
  assert.deepEqual(E.status().secrets, ["*.pfx"]);
  E.secretOp("rm", "*.pfx");
  assert.deepEqual(E.status().secrets, []);
});

test("secretOp rejects an unknown op instead of shelling out with garbage", () => {
  sandbox("secret-bad-op");
  assert.throws(() => E.secretOp("delete", "*.pfx"), /unknown op/);
});

test("protectedOp add/rm round-trips through status", () => {
  const root = sandbox("protected");
  E.protectedOp("add", path.join(root, "important.yaml"));
  assert.ok(E.status().protected.length === 1);
  E.protectedOp("rm", path.join(root, "important.yaml"));
  assert.deepEqual(E.status().protected, []);
});

test("protectedOp rejects an unknown op instead of shelling out with garbage", () => {
  sandbox("protected-bad-op");
  assert.throws(() => E.protectedOp("delete", "C:/x"), /unknown op/);
});

test("projectOp rejects an unknown op instead of shelling out with garbage", () => {
  sandbox("project-bad-op");
  assert.throws(() => E.projectOp("delete", "C:/x"), /unknown op/);
});

test("projectOp add fails closed on a path that is not a real directory, and the error surfaces the engine.mjs message", () => {
  const root = sandbox("project-bad");
  assert.throws(() => E.projectOp("add", path.join(root, "does-not-exist")), /not a folder/);
});

test("projectOp add/rm round-trips through status", () => {
  const root = sandbox("project");
  const proj = path.join(root, "myproj");
  fs.mkdirSync(proj, { recursive: true });
  E.projectOp("add", proj);
  assert.deepEqual(E.status().projects, [proj]);
  E.projectOp("rm", proj);
  assert.deepEqual(E.status().projects, []);
});

test("vaultImport stores KEY=VALUE lines without ever returning the values", () => {
  sandbox("vault-import");
  const r = E.vaultImport("A=1\nB=2\n");
  assert.deepEqual(r.imported.sort(), ["A", "B"]);
  assert.equal(JSON.stringify(r).includes("=1"), false, "a value must never appear in the response");
  assert.deepEqual(E.status().vaultKeys.sort(), ["A", "B"]);
});

test("vaultImport with nothing usable on stdin throws the engine.mjs message", () => {
  sandbox("vault-import-empty");
  assert.throws(() => E.vaultImport("# only a comment\n"), /no KEY=VALUE lines/);
});

test("vaultRm removes a key; an unknown key throws by name", () => {
  sandbox("vault-rm");
  E.vaultImport("A=1\n");
  E.vaultRm("A");
  assert.deepEqual(E.status().vaultKeys, []);
  assert.throws(() => E.vaultRm("NOPE"), /not in vault: NOPE/);
});

test("runboxList returns pending scripts as parsed JSON; trash=true lists trash instead", () => {
  const root = sandbox("runbox-list");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "a.mjs"), "// does the thing\nprocess.exit(0);\n");
  const pending = E.runboxList(false);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].name, "a.mjs");
  assert.deepEqual(E.runboxList(true), []);
});

test("runboxRun reports success for a script that exits 0 and archives it", () => {
  const root = sandbox("runbox-run-ok");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "ok.mjs"), "process.exit(0);\n");
  const r = E.runboxRun("ok.mjs");
  assert.equal(r.ok, true);
  assert.match(r.out, /archived/);
  assert.equal(E.runboxList(false).length, 0);
});

test("runboxRun reports failure (not a throw) for a script that exits non-zero, and leaves it in place", () => {
  const root = sandbox("runbox-run-fail");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "bad.mjs"), "process.exit(3);\n");
  const r = E.runboxRun("bad.mjs");
  assert.equal(r.ok, false);
  assert.match(r.out, /FAILED/);
  assert.equal(E.runboxList(false).length, 1, "a failed script stays in the runbox");
});

test("runboxRun throws for real (not {ok:false}) when engine.mjs refuses the ref outright, e.g. no such script", () => {
  sandbox("runbox-run-refused");
  assert.throws(() => E.runboxRun("nope.mjs"), /no pending script named/);
});

test("runboxTrash/runboxRestore round-trip", () => {
  const root = sandbox("runbox-trash-restore");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "later.mjs"), "process.exit(0);\n");
  E.runboxTrash("later.mjs");
  assert.equal(E.runboxList(false).length, 0);
  assert.equal(E.runboxList(true).length, 1);
  E.runboxRestore("later.mjs");
  assert.equal(E.runboxList(false).length, 1);
  assert.equal(E.runboxList(true).length, 0);
});

test("runboxFlush permanently empties the trash", () => {
  const root = sandbox("runbox-flush");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "gone.mjs"), "process.exit(0);\n");
  E.runboxTrash("gone.mjs");
  E.runboxFlush();
  assert.equal(E.runboxList(true).length, 0);
});

// OI-019-style scenario coverage carried into this new module: the preview
// route has no engine.mjs command backing it (per the design spec, §4c) --
// it reads the file directly, but ONLY a path engine.mjs's own listing
// already named, refusing anything else. This is the one place this module
// adds real logic beyond "shell out and parse," so it gets the same
// adversarial-input attention as any other new surface tonight.
test("runboxPreview returns a pending script's real content", () => {
  const root = sandbox("runbox-preview");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "show-me.mjs"), "// hello\nprocess.exit(0);\n");
  assert.match(E.runboxPreview("show-me.mjs"), /hello/);
});

test("runboxPreview refuses a ref that isn't in the current pending/trash listing at all", () => {
  sandbox("runbox-preview-refuse");
  assert.throws(() => E.runboxPreview("../../../etc/passwd"), /not found/);
  assert.throws(() => E.runboxPreview("nonexistent.mjs"), /not found/);
});

test("runboxPreview finds a trashed script too, not only pending ones", () => {
  const root = sandbox("runbox-preview-trash");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "was-here.mjs"), "// trashed content\nprocess.exit(0);\n");
  E.runboxTrash("was-here.mjs");
  const [trashedName] = E.runboxList(true).map((i) => i.name);
  assert.match(E.runboxPreview(trashedName), /trashed content/);
});

test("runboxPreview accepts the label:name ref form, not only a bare name", () => {
  const root = sandbox("runbox-preview-label");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "labeled.mjs"), "// labeled content\nprocess.exit(0);\n");
  assert.match(E.runboxPreview("central:labeled.mjs"), /labeled content/);
});

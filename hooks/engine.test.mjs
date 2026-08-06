// Phase 7 (full-remediation-prompt.md), OI-033: engine.mjs had zero tests
// before this session, and covgate could never measure it for a second
// reason beyond the usual subprocess-coverage question -- its ROOT (and
// therefore CONFIG/VAULT/the runbox path) was hardcoded relative to this
// file's own location, not ACC_ROOT-overridable the way every sibling hooks/
// file already is, so a test could only ever operate against the real
// repo's own gitignored vault.json/config.json rather than a sandbox. Both
// are fixed now: ROOT reads ACC_ROOT when set, and every test below runs
// engine.mjs as a real subprocess (execFileSync -- this file has no
// exported functions and executes its CLI switch at the top level, so a
// direct import would run whatever command process.argv happened to carry)
// against its own throwaway ACC_ROOT.
//
// Scope, per the phase's own ask: vault read/write round-trip, corrupt-vault
// handling, runbox run/trash/restore -- plus the config-side commands
// (status/toggle/secret/protected/projects) and the corrupt-config case,
// since they're the same size of gap and cheap to cover once sandboxed.
//
// Run: node --test hooks/engine.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, "engine.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-engine-test-"));

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

function sandbox(name, { config } = {}) {
  const root = path.join(BASE, name);
  fs.mkdirSync(root, { recursive: true });
  if (config !== null) {
    fs.writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify(config ?? { enabled: true, secrets: [], protected: [], projects: [] })
    );
  }
  return root;
}

function run(root, args, opts = {}) {
  return execFileSync("node", [ENGINE, ...args], {
    encoding: "utf8",
    env: { ...process.env, ACC_ROOT: root },
    ...opts,
  });
}

function runFails(root, args, opts = {}) {
  try {
    run(root, args, opts);
    assert.fail("expected engine.mjs to exit non-zero");
  } catch (e) {
    return e;
  }
}

// ------------------------------------------------------------- vault

test("vault-keys reads a corrupt vault.json as empty, not a crash", () => {
  const root = sandbox("vault-corrupt");
  fs.writeFileSync(path.join(root, "vault.json"), "{ not valid json at all");
  assert.equal(run(root, ["vault-keys"]).trim(), "");
});

test("vault-keys reads a missing vault.json as empty, not a crash", () => {
  const root = sandbox("vault-missing");
  assert.equal(run(root, ["vault-keys"]).trim(), "");
});

test("vault-import writes atomically (no leftover .tmp- file) and the content round-trips through vault-keys", () => {
  const root = sandbox("vault-roundtrip");
  run(root, ["vault-import"], { input: "MY_KEY=my-value\nOTHER=2\n" });
  const keys = run(root, ["vault-keys"]).trim().split("\n").sort();
  assert.deepEqual(keys, ["MY_KEY", "OTHER"]);
  const leftovers = fs.readdirSync(root).filter((f) => f.startsWith("vault.json.tmp-"));
  assert.deepEqual(leftovers, [], "no temp file left behind after a successful atomic write");
});

test("vault-import skips blank lines and # comments, and fails when nothing usable was found", () => {
  const root = sandbox("vault-comments");
  run(root, ["vault-import"], { input: "# a comment\n\nREAL=1\n" });
  assert.equal(run(root, ["vault-keys"]).trim(), "REAL");
  const err = runFails(root, ["vault-import"], { input: "# only a comment\n\n" });
  assert.match(err.stderr.toString(), /no KEY=VALUE lines/);
});

test("vault-rm removes a key, and fails naming an unknown one", () => {
  const root = sandbox("vault-rm");
  run(root, ["vault-import"], { input: "A=1\nB=2\n" });
  run(root, ["vault-rm", "A"]);
  assert.equal(run(root, ["vault-keys"]).trim(), "B");
  const err = runFails(root, ["vault-rm", "NOPE"]);
  assert.match(err.stderr.toString(), /not in vault: NOPE/);
});

test("apply upserts KEY=value lines into a target file and fails closed on a key the vault doesn't have", () => {
  const root = sandbox("apply");
  run(root, ["vault-import"], { input: "A=1\nB=2\n" });
  const target = path.join(root, ".env");
  fs.writeFileSync(target, "A=old\nUNRELATED=keep\n");
  run(root, ["apply", target, "A", "B"]);
  const lines = fs.readFileSync(target, "utf8").trim().split("\n");
  assert.deepEqual(lines.sort(), ["A=1", "B=2", "UNRELATED=keep"]);

  const err = runFails(root, ["apply", target, "MISSING"]);
  assert.match(err.stderr.toString(), /not in vault: MISSING/);
});

test("apply strips a UTF-8 BOM from the target so the first KEY= line matches instead of duplicating", () => {
  const root = sandbox("apply-bom");
  run(root, ["vault-import"], { input: "A=new\n" });
  const target = path.join(root, ".env");
  fs.writeFileSync(target, "\uFEFFA=old\n");
  run(root, ["apply", target, "A"]);
  assert.deepEqual(fs.readFileSync(target, "utf8").trim().split("\n"), ["A=new"]);
});

// ------------------------------------------------------------- config-side commands

test("a corrupt config.json fails closed with a message, not a raw crash", () => {
  const root = sandbox("config-corrupt", { config: null });
  fs.writeFileSync(path.join(root, "config.json"), "{ not json");
  const err = runFails(root, ["status"]);
  assert.match(err.stderr.toString(), /no config\.json/);
});

test("a missing config.json fails closed with the same message", () => {
  const root = sandbox("config-missing", { config: null });
  const err = runFails(root, ["status"]);
  assert.match(err.stderr.toString(), /no config\.json/);
});

test("status reports enabled, secrets, protected, projects, vault keys, pending and trashed counts", () => {
  const root = sandbox("status");
  run(root, ["vault-import"], { input: "K=1\n" });
  const out = JSON.parse(run(root, ["status"]));
  assert.deepEqual(out, {
    enabled: true, secrets: [], protected: [], projects: [],
    vaultKeys: ["K"], pending: 0, trashed: 0,
  });
});

test("toggle on/off flips config.enabled and rejects a bad argument", () => {
  const root = sandbox("toggle");
  assert.match(run(root, ["toggle", "off"]), /DISABLED/);
  assert.equal(JSON.parse(run(root, ["status"])).enabled, false);
  assert.match(run(root, ["toggle", "on"]), /ENABLED/);
  const err = runFails(root, ["toggle", "sideways"]);
  assert.match(err.stderr.toString(), /usage: toggle on\|off/);
});

test("secret-add/rm and protected-add/rm dedupe on add and no-op on removing something absent", () => {
  const root = sandbox("secrets");
  run(root, ["secret-add", "*.env"]);
  run(root, ["secret-add", "*.env"]); // duplicate add must not double the entry
  assert.deepEqual(JSON.parse(run(root, ["status"])).secrets, ["*.env"]);
  run(root, ["secret-rm", "*.env"]);
  assert.deepEqual(JSON.parse(run(root, ["status"])).secrets, []);
  run(root, ["protected-add", "C:/code/guards"]);
  assert.deepEqual(JSON.parse(run(root, ["status"])).protected, ["C:/code/guards"]);
});

test("projects-add registers a folder, creates its .guards/runbox and self-ignoring .gitignore; projects-rm un-registers it without deleting .guards", () => {
  const root = sandbox("projects");
  const proj = path.join(root, "myproj");
  fs.mkdirSync(proj, { recursive: true });
  run(root, ["projects-add", proj]);
  run(root, ["projects-add", proj]); // re-adding the same folder must not duplicate the entry
  assert.deepEqual(JSON.parse(run(root, ["status"])).projects, [proj]);
  assert.ok(fs.existsSync(path.join(proj, ".guards", "runbox")));
  assert.equal(fs.readFileSync(path.join(proj, ".guards", ".gitignore"), "utf8").trim(), "*");

  run(root, ["projects-rm", proj]);
  assert.deepEqual(JSON.parse(run(root, ["status"])).projects, []);
  assert.ok(fs.existsSync(path.join(proj, ".guards")), "projects-rm leaves .guards on disk by design");
});

test("projects-add refuses a path that is not a real directory", () => {
  const root = sandbox("projects-bad");
  const err = runFails(root, ["projects-add", path.join(root, "does-not-exist")]);
  assert.match(err.stderr.toString(), /not a folder/);
});

// ------------------------------------------------------------- runbox: list / run / trash / restore / flush

function scriptText(exitCode) {
  return `// guards: keep-marker test fixture\nprocess.exit(${exitCode});\n`;
}

test("list is empty text and an empty JSON array when the runbox has nothing pending", () => {
  const root = sandbox("list-empty");
  assert.match(run(root, ["list"]), /runbox is empty/);
  assert.deepEqual(JSON.parse(run(root, ["list", "--json"])), []);
});

test("trash-list prints its own empty message in text mode, and one line per trashed script otherwise", () => {
  const root = sandbox("trash-list-text");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  assert.match(run(root, ["trash-list"]), /trash is empty/);
  fs.writeFileSync(path.join(runbox, "old.mjs"), "process.exit(0);\n");
  run(root, ["trash", "old.mjs"]);
  assert.match(run(root, ["trash-list"]), /central:.*_old\.mjs/);
});

test("run resolves a ref given as a full absolute path, and fails on an ambiguous bare name across two labels", () => {
  const root = sandbox("run-ref-forms");
  const central = path.join(root, "runbox");
  fs.mkdirSync(central, { recursive: true });
  const proj = path.join(root, "side");
  fs.mkdirSync(proj, { recursive: true });
  run(root, ["projects-add", proj]);
  const sideRunbox = path.join(proj, ".guards", "runbox");

  fs.writeFileSync(path.join(central, "abs.mjs"), "process.exit(0);\n");
  const out = run(root, ["run", path.join(central, "abs.mjs")]);
  assert.match(out, /archived to the runbox trash/);

  fs.writeFileSync(path.join(central, "dup.mjs"), "process.exit(0);\n");
  fs.writeFileSync(path.join(sideRunbox, "dup.mjs"), "process.exit(0);\n");
  const err = runFails(root, ["run", "dup.mjs"]);
  assert.match(err.stderr.toString(), /is ambiguous/);
});

test("run: a script that deletes itself before exiting 0 is reported as self-cleaned, not archived again", () => {
  const root = sandbox("run-self-clean");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  const full = path.join(runbox, "installer.mjs");
  fs.writeFileSync(full, `import fs from "node:fs"; fs.unlinkSync(${JSON.stringify(full)}); process.exit(0);\n`);
  const out = run(root, ["run", "installer.mjs"]);
  assert.match(out, /script cleaned itself up/);
});

test("no command at all, or an unrecognized one, prints usage and fails", () => {
  const root = sandbox("usage");
  for (const args of [[], ["bogus-command"]]) {
    const err = runFails(root, args);
    assert.match(err.stderr.toString(), /usage: engine\.mjs <command>/);
  }
});

test("list shows a pending script's summary from its first comment line, and the [keep] marker", () => {
  const root = sandbox("list-pending");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "a.mjs"), "// does the thing\nprocess.exit(0);\n");
  fs.writeFileSync(path.join(runbox, "b.mjs"), "// guards: keep\n// a standing script\nprocess.exit(0);\n");
  const text = run(root, ["list"]);
  assert.match(text, /does the thing/);
  assert.match(text, /b\.mjs\s+\[keep\]/);
  const json = JSON.parse(run(root, ["list", "--json"]));
  assert.deepEqual(json.map((i) => i.name).sort(), ["a.mjs", "b.mjs"]);
  assert.equal(json.find((i) => i.name === "b.mjs").keep, true);
});

test("run: a successful non-keep script is archived to .trash", () => {
  const root = sandbox("run-archive");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "ok.mjs"), "process.exit(0);\n");
  const out = run(root, ["run", "ok.mjs"]);
  assert.match(out, /archived to the runbox trash/);
  assert.equal(fs.existsSync(path.join(runbox, "ok.mjs")), false);
  const trashed = fs.readdirSync(path.join(runbox, ".trash")).filter((f) => f.endsWith("_ok.mjs"));
  assert.equal(trashed.length, 1);
});

test("run supports a plain .js runbox script the same way it does .mjs", () => {
  const root = sandbox("run-js-ext");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "ok.js"), "process.exit(0);\n");
  const out = run(root, ["run", "ok.js"]);
  assert.match(out, /archived to the runbox trash/);
});

test("run: a successful script with a 'guards: keep' marker stays in the runbox", () => {
  const root = sandbox("run-keep");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "standing.mjs"), scriptText(0));
  const out = run(root, ["run", "standing.mjs"]);
  assert.match(out, /kept in the runbox/);
  assert.ok(fs.existsSync(path.join(runbox, "standing.mjs")));
});

test("run: a failing script stays in the runbox and engine.mjs exits with the script's own code", () => {
  const root = sandbox("run-fail");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "bad.mjs"), "process.exit(3);\n");
  const err = runFails(root, ["run", "bad.mjs"]);
  assert.equal(err.status, 3);
  assert.match(err.stderr.toString(), /FAILED \(exit 3\)/);
  assert.ok(fs.existsSync(path.join(runbox, "bad.mjs")), "a failed script must not be archived");
});

test("run rejects an unknown extension and a ref matching nothing", () => {
  const root = sandbox("run-bad-ref");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "x.txt"), "not runnable\n");
  const err = runFails(root, ["run", "nope"]);
  assert.match(err.stderr.toString(), /no pending script named "nope"/);
});

test("trash moves a pending script out, and restore puts it back under its original name", () => {
  const root = sandbox("trash-restore");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "later.mjs"), "process.exit(0);\n");
  run(root, ["trash", "later.mjs"]);
  assert.equal(fs.existsSync(path.join(runbox, "later.mjs")), false);
  const trashList = JSON.parse(run(root, ["trash-list", "--json"]));
  assert.equal(trashList.length, 1);
  assert.match(trashList[0].name, /_later\.mjs$/);

  run(root, ["restore", "later.mjs"]); // bare name, stamp stripped automatically
  assert.ok(fs.existsSync(path.join(runbox, "later.mjs")));
  assert.deepEqual(JSON.parse(run(root, ["trash-list", "--json"])), []);
});

test("restoring a name trashed more than once picks the newest copy", () => {
  // moveToTrash's stamp is second-granularity, so two real `trash` calls in
  // the same wall-clock second would collide on one filename instead of
  // producing two -- write both stamped copies directly instead of racing
  // the clock, exactly the shape the real trash dir has after two trashes
  // on different seconds.
  const root = sandbox("restore-newest");
  const runbox = path.join(root, "runbox");
  const trash = path.join(runbox, ".trash");
  fs.mkdirSync(trash, { recursive: true });
  fs.writeFileSync(path.join(trash, "20260101-000000_again.mjs"), "// v1\nprocess.exit(0);\n");
  fs.writeFileSync(path.join(trash, "20260101-000001_again.mjs"), "// v2\nprocess.exit(0);\n");
  assert.equal(JSON.parse(run(root, ["trash-list", "--json"])).length, 2);

  run(root, ["restore", "again.mjs"]);
  assert.match(fs.readFileSync(path.join(runbox, "again.mjs"), "utf8"), /v2/, "the most recently trashed copy must win");
  assert.equal(JSON.parse(run(root, ["trash-list", "--json"])).length, 1, "the other stamped copy stays in trash");
});

test("restore refuses when a script of the same name already exists back in the runbox", () => {
  const root = sandbox("restore-collide");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "dup.mjs"), "process.exit(0);\n");
  run(root, ["trash", "dup.mjs"]);
  fs.writeFileSync(path.join(runbox, "dup.mjs"), "// a new one landed after the trash\nprocess.exit(0);\n");
  const err = runFails(root, ["restore", "dup.mjs"]);
  assert.match(err.stderr.toString(), /already exists in the runbox/);
});

test("restore fails naming what trash-list actually has, when nothing matches", () => {
  const root = sandbox("restore-nomatch");
  const err = runFails(root, ["restore", "ghost.mjs"]);
  assert.match(err.stderr.toString(), /nothing in trash matches "ghost\.mjs"/);
});

test("flush refuses without --really, and permanently deletes every trashed script with it", () => {
  const root = sandbox("flush");
  const runbox = path.join(root, "runbox");
  fs.mkdirSync(runbox, { recursive: true });
  fs.writeFileSync(path.join(runbox, "gone.mjs"), "process.exit(0);\n");
  run(root, ["trash", "gone.mjs"]);

  const err = runFails(root, ["flush"]);
  assert.match(err.stderr.toString(), /flush is permanent/);
  assert.equal(JSON.parse(run(root, ["trash-list", "--json"])).length, 1);

  const out = run(root, ["flush", "--really"]);
  assert.match(out, /flushed 1 archived script/);
  assert.deepEqual(JSON.parse(run(root, ["trash-list", "--json"])), []);
});

test("a ref of the form label:name resolves a script in a project's own .guards/runbox, distinct from the central one", () => {
  const root = sandbox("project-runbox");
  const proj = path.join(root, "side");
  fs.mkdirSync(proj, { recursive: true });
  run(root, ["projects-add", proj]);
  const projRunbox = path.join(proj, ".guards", "runbox");
  fs.writeFileSync(path.join(projRunbox, "task.mjs"), "process.exit(0);\n");
  const out = run(root, ["run", `side:task.mjs`]);
  assert.match(out, /archived to the runbox trash/);
});

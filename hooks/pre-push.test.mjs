// node --test hooks/pre-push.test.mjs  (run from C:\code\guards)
//
// Hermetic. Each fixture repo carries its OWN copy of the real hooks/covgate.mjs
// (a plain file copy -- covgate.mjs has zero npm deps, pure node built-ins),
// matching the real deployed shape: hooks/pre-push and hooks/covgate.mjs both
// live under the pushed repo's own hooks/ dir, exactly as `cd "$REPO_ROOT" &&
// node hooks/covgate.mjs` (inside hooks/pre-push) expects. A POSIX `sh` is
// required; it is resolved by resolveSh() below rather than assumed to be on
// PATH, because on Windows it usually is not (see that function's comment).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = path.join(HERE, "pre-push");
const COVGATE_SRC = path.join(HERE, "covgate.mjs");
const COVGATE_TEST_SRC = path.join(HERE, "covgate.test.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-prepush-test-"));

// `sh` is NOT reliably on PATH on Windows, and this file's header used to claim
// it was ("Git for Windows ships one"). True of the binary, false of the PATH:
// the installer puts git.exe in ...\Git\cmd (on PATH) and sh.exe in ...\Git\bin
// (not). So these 7 tests were green only when run from a Git Bash shell, and
// under `npm run test:windows` (PowerShell) every one of them failed with
// spawnSync -> ENOENT, status null, empty output - a red tier that then blocked
// `node hooks/covgate.mjs` for anything else being changed. Resolve sh from
// git's own install instead of trusting PATH, and THROW rather than skip if
// none is found: a silently skipped gate is worse than a loud one.
function resolveSh() {
  const works = (cmd) => {
    try { return spawnSync(cmd, ["-c", "exit 0"]).status === 0 ? cmd : null; } catch { return null; }
  };
  const onPath = works("sh");
  if (onPath) return onPath;
  let gitExe = "";
  try {
    gitExe = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
      .split(/\r?\n/)[0].trim();
  } catch {}
  if (gitExe) {
    for (const rel of [["..", "bin", "sh.exe"], ["..", "usr", "bin", "sh.exe"]]) {
      const cand = path.resolve(path.dirname(gitExe), ...rel);
      if (fs.existsSync(cand) && works(cand)) return cand;
    }
  }
  throw new Error(
    "pre-push.test.mjs needs a POSIX sh and found none (tried PATH, then git's own bin/ and usr/bin/). " +
      "Install Git for Windows or put sh on PATH."
  );
}
const SH = resolveSh();

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// A fixture repo shaped like the real deployment: hooks/covgate.mjs AND its
// own hooks/covgate.test.mjs (both real copies), plus hooks/pre-push
// installed at .git/hooks/pre-push, exactly where the runbox installer would
// put it. covgate.test.mjs must ship alongside covgate.mjs even in the
// fixture — a diff that includes covgate.mjs itself (e.g. a brand-new-ref
// push, diffed from the empty tree) correctly fails coverage otherwise; the
// real repo never hits that because covgate.mjs always carries its own test.
// Returns { repo, g(...), root: <sha> } after one fully-covered root commit.
function fixture(name) {
  const repo = path.join(BASE, name);
  fs.mkdirSync(path.join(repo, "hooks"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q");
  fs.copyFileSync(COVGATE_SRC, path.join(repo, "hooks", "covgate.mjs"));
  fs.copyFileSync(COVGATE_TEST_SRC, path.join(repo, "hooks", "covgate.test.mjs"));
  fs.writeFileSync(path.join(repo, "hooks", "lib.mjs"), "export const lib = () => 1;\n");
  fs.writeFileSync(
    path.join(repo, "hooks", "lib.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { lib } from "./lib.mjs";\ntest("lib", () => assert.equal(lib(), 1));\n'
  );
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "root");
  const root = g("rev-parse", "HEAD");

  fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
  fs.copyFileSync(HOOK_SRC, path.join(repo, ".git", "hooks", "pre-push"));
  try { fs.chmodSync(path.join(repo, ".git", "hooks", "pre-push"), 0o755); } catch {}

  return { repo, g, root };
}

// Simulates exactly what git feeds a pre-push hook on stdin, one line per ref.
// spawnSync (not execFileSync) so stdout+stderr are captured identically on
// BOTH a zero and a non-zero exit -- execFileSync silently drops stderr on
// success, which would hide this hook's own fail-open diagnostics.
function runHook(repo, lines) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-push");
  const r = spawnSync(SH, [hookPath], {
    cwd: repo, encoding: "utf8",
    input: lines.map((l) => l + "\n").join(""),
    env: { ...process.env, ACC_POLICY: path.join(BASE, "nope.json") },
  });
  return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}

test("a push to main with a genuine coverage-floor miss is refused, output shows covgate's FAIL", () => {
  const { repo, g, root } = fixture("red-push");
  // uncovered function, no test at all -- a real floor miss
  fs.writeFileSync(path.join(repo, "hooks", "broken.mjs"), "export const broken = () => 1;\n");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add broken");
  const head = g("rev-parse", "HEAD");

  const r = runHook(repo, [`refs/heads/main ${head} refs/heads/main ${root}`]);
  assert.notEqual(r.code, 0, r.out);
  assert.ok(/covgate: FAIL/.test(r.out), r.out);
  assert.ok(/refused this push to main/.test(r.out), r.out);
});

test("a clean push to main proceeds", () => {
  const { repo, g, root } = fixture("clean-push");
  fs.writeFileSync(path.join(repo, "hooks", "extra.mjs"), "export const extra = () => 2;\n");
  fs.writeFileSync(
    path.join(repo, "hooks", "extra.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { extra } from "./extra.mjs";\ntest("extra", () => assert.equal(extra(), 2));\n'
  );
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add extra, covered");
  const head = g("rev-parse", "HEAD");

  const r = runHook(repo, [`refs/heads/main ${head} refs/heads/main ${root}`]);
  assert.equal(r.code, 0, r.out);
  assert.ok(/covgate: PASS/.test(r.out), r.out);
});

test("a push targeting a non-main ref is a no-op -- the gate never runs, even on a broken commit", () => {
  const { repo, g, root } = fixture("feature-push");
  fs.writeFileSync(path.join(repo, "hooks", "broken.mjs"), "export const broken = () => 1;\n");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "broken, but not going to main");
  const head = g("rev-parse", "HEAD");

  const r = runHook(repo, [`refs/heads/feature ${head} refs/heads/feature ${root}`]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!/covgate:/.test(r.out), `gate must never even run: ${r.out}`);
});

test("a brand-new ref push to main (remote sha all-zero) gates against the empty tree, not a git error", () => {
  const { repo, g, root } = fixture("newref-push");
  const r = runHook(repo, [
    `refs/heads/main ${root} refs/heads/main 0000000000000000000000000000000000000000`,
  ]);
  assert.equal(r.code, 0, r.out);
  assert.ok(/covgate: PASS/.test(r.out), r.out);
});

test("a deleted ref (local sha all-zero) is a no-op", () => {
  const { repo, root } = fixture("delete-push");
  const r = runHook(repo, [
    `refs/heads/main 0000000000000000000000000000000000000000 refs/heads/main ${root}`,
  ]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!/covgate:/.test(r.out), r.out);
});

test("an unexpected covgate crash (not a recognized FAIL verdict) fails OPEN, not closed", () => {
  const { repo, g, root } = fixture("crash-push");
  // Corrupt covgate.mjs itself -- a syntax error crashes node with a stack
  // trace, never printing "covgate: FAIL". This is the asymmetry the whole
  // design hinges on: only a real, recognized verdict may refuse a push.
  fs.writeFileSync(path.join(repo, "hooks", "covgate.mjs"), "this is not valid javascript {{{");
  fs.writeFileSync(path.join(repo, "hooks", "harmless.mjs"), "export const harmless = () => 1;\n");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "corrupt covgate + an otherwise-uncovered file");
  const head = g("rev-parse", "HEAD");

  const r = runHook(repo, [`refs/heads/main ${head} refs/heads/main ${root}`]);
  assert.equal(r.code, 0, r.out);
  assert.ok(/fail-open/.test(r.out), r.out);
  assert.ok(!/refused this push/.test(r.out), r.out);
});

test("multiple ref lines: a refused main push still refuses even if a feature-branch line came first", () => {
  const { repo, g, root } = fixture("multi-line");
  fs.writeFileSync(path.join(repo, "hooks", "broken.mjs"), "export const broken = () => 1;\n");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add broken");
  const head = g("rev-parse", "HEAD");

  const r = runHook(repo, [
    `refs/heads/feature ${head} refs/heads/feature ${root}`,
    `refs/heads/main ${head} refs/heads/main ${root}`,
  ]);
  assert.notEqual(r.code, 0, r.out);
  assert.ok(/covgate: FAIL/.test(r.out), r.out);
});

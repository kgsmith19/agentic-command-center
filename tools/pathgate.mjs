// tools/pathgate.mjs — no source file may name a repo root absolutely.
//
// A hardcoded absolute repo path is exactly what made the folder rename in
// sub-project J's Task 12 a 15-site audit instead of one command. The gate
// also matches every post-rename repo name so it never expires once the
// rename lands.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS = /C:[\\/]{1,2}code[\\/]{1,2}(guards|agentic-command-center|agent-guardrails|claude-session-telemetry|agentic-command-center-ui|claude-launch-cap|agent-repo-gates)/i;
const OK = /\/\/\s*pathgate-ok:\s*\S+/;

export function findHardcoded(files, readFile) {
  const out = [];
  for (const file of files) {
    readFile(file).split(/\r?\n/).forEach((text, i) => {
      if (ROOTS.test(text) && !OK.test(text)) out.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return out;
}

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// docs/, notes/ and fixtures/ are documentation and test data, not live
// source that breaks on a move: docs/notes are dated historical records
// (rewriting them falsifies the log), and hooks/fixtures/ROUTING.md mirrors
// the CURRENT real routing config on purpose (its own header says so) and is
// exercised by hooks/route.test.mjs's assertions - it moves in lockstep with
// the real config, not on its own. config.json is data the installer
// rewrites (Task 4), not source. tools/pathgate.test.mjs is this gate's own
// test file and necessarily contains literal examples of the pattern it
// exists to catch. .github/workflows/ci.yml's fixture-directory step
// mirrors hooks/fixtures/ROUTING.md's paths for the same reason and moves
// with it, not on its own.
const EXCLUDE = /^(node_modules|docs|notes|\.git|runbox|runner|hooks[\\/]fixtures)([\\/]|$)/;
const EXCLUDE_FILES = new Set([
  "OPEN-ISSUES.md", "config.json", "tools/pathgate.test.mjs", ".github/workflows/ci.yml",
]);

export function realIo() {
  const files = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((f) => !EXCLUDE.test(f))
    .filter((f) => !EXCLUDE_FILES.has(f));
  return {
    files,
    readFile: (f) => readFileSync(path.join(REPO_ROOT, f), "utf8"),
  };
}

// Known, pre-existing findings deferred with a tracked reason - NOT a
// blanket allowlist. Keyed by file + the finding's own exact (trimmed) text,
// so a deferral silently stops applying the moment that line moves or
// changes, and the finding reappears instead of drifting unnoticed.
// Empty, and worth keeping that way. Its only entry was hooks/usage.mjs's
// hardcoded POLICY_PATH, deferred because fixing that one line dragged the
// file's pre-existing ~35% coverage gap under covgate's floor. That gap was
// closed on 2026-08-05 (guards OI-045), the line now derives from
// core/paths.mjs, and the deferral came out with it.
const DEFERRED = new Map([]);

// `deferred` is injectable so the deferral MECHANISM can be tested against a
// fixture rather than against whatever happens to be deferred today — the tests
// used to assert on the live map's one real entry, which meant closing that
// entry broke a test of unrelated machinery.
export function run(io, deferred = DEFERRED) {
  const all = findHardcoded(io.files, io.readFile);
  const findings = all.filter((f) => !deferred.has(`${f.file}|${f.text}`));
  if (findings.length === 0) return { code: 0, stdout: "pathgate: no hardcoded repo roots\n" };
  const list = findings.map((f) => `  ${f.file}:${f.line}: ${f.text}`).join("\n");
  return { code: 1, stdout: `pathgate: ${findings.length} hardcoded repo root(s):\n${list}\n` };
}

export function main() {
  const r = run(realIo());
  process.stdout.write(r.stdout);
  return r.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exit(main());

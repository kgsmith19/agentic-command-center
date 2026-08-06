// tools/namegate.mjs — the retired words must not creep back into source.
//
// Sub-project J renames three concepts: `goal` -> standing order,
// `clearbot` -> autopilot, `kernel/` -> `core/`. A plain word search would
// also flag genuine English ("the goal of this function", "the Windows
// kernel schedules this"), so this only flags IDENTIFIER and PATH uses:
// `goal`/`goals`/`goalId` immediately adjacent to `.`, `/`, `\`, or `_`
// (`goal.mjs`, `goals/`, `goalId`), bare `clearbot` anywhere (it is not an
// English word, so any appearance is the retired name), and `kernel`
// immediately adjacent to `/` or `\` (a path prefix, not the OS noun).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `goalId` is its own pattern (always flagged - it is a camelCase
// identifier, never a plain English word) rather than folded into the
// path-adjacency rule below, which only catches `goal`/`goals` immediately
// next to a path-shaped character (`goal.mjs`, `goals/`) - `goalId` alone
// is followed by whitespace or punctuation, not a path character.
const GOALID_RE = /\bgoalId\b/i;
const GOAL_PATH_RE = /\bgoals?(?=[./\\_])/i;
const CLEARBOT_RE = /\bclearbot\b/i;
const KERNEL_RE = /\bkernel(?=[/\\])/i;
const OK = /\/\/\s*namegate-ok:\s*\S+/;

export function findRetired(files, readFile) {
  const out = [];
  for (const file of files) {
    readFile(file).split(/\r?\n/).forEach((text, i) => {
      if (OK.test(text)) return;
      const hits = [GOALID_RE, GOAL_PATH_RE, CLEARBOT_RE, KERNEL_RE].filter((re) => re.test(text));
      for (const _ of hits) out.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return out;
}

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Same rationale as tools/pathgate.mjs's EXCLUDE: docs/ and notes/ are dated
// historical records that legitimately name the pre-rename words, and this
// gate's own test file necessarily contains literal examples of what it
// catches. OPEN-ISSUES.md ledger entries are historical too - an entry
// opened under the old name stays readable, per that file's own "IDs are
// per-file and never reused" rule.
const EXCLUDE = /^(node_modules|docs|notes|\.git|runbox)([\\/]|$)/;
const EXCLUDE_FILES = new Set(["OPEN-ISSUES.md", "tools/namegate.test.mjs"]);

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

export function run(io) {
  const findings = findRetired(io.files, io.readFile);
  if (findings.length === 0) return { code: 0, stdout: "namegate: no retired names in source\n" };
  const list = findings.map((f) => `  ${f.file}:${f.line}: ${f.text}`).join("\n");
  return { code: 1, stdout: `namegate: ${findings.length} retired name(s):\n${list}\n` };
}

export function main() {
  const r = run(realIo());
  process.stdout.write(r.stdout);
  return r.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exit(main());

// tools/scenariogate.mjs — the scenario-record gate for the test-depth program.
//
// OI-019: covgate's floors prove every line EXECUTES once. They do not prove
// the suite covers the scenario space. The first module audited under this
// program (kernel/guard.mjs) turned up a real, live path-traversal bypass -
// one module of twelve. A gate that enumerates modules cannot be forgotten;
// diligence can.
//
// Pure functions over text; the CLI at the bottom does the only I/O, matching
// tools/inventory.mjs's own split.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AXES = Object.freeze(["standard", "non-standard", "edge", "rare", "error", "fault-tolerance"]);

const HEADING = /^#\s+(\S+)\s+—\s+scenarios\s*$/;
const AXIS_HEADING = /^##\s+(\S+)\s*$/;
const TEST_LINE = /^-\s+test:\s*(.+?)\s*$/;
const NA_PREFIX = /^-\s+na:\s*(.*)$/;
const DATE_SUFFIX = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/;

// Answer = { kind: "test", name } | { kind: "na", reason, date }
// A malformed "- na:" line with no reason and/or no date still parses to an
// Answer so the gate (not the parser) is what reports na-no-reason/na-no-date
// - a parse failure here would report "unanswered-axis" instead, which points
// the reader at the wrong problem. reason/date are undefined (not "" / an
// empty-but-truthy string) when absent, so the gate's `!a.reason` check is
// exact, not fooled by a bare trailing space.
function parseAnswerLine(line) {
  const t = TEST_LINE.exec(line);
  if (t) return { kind: "test", name: t[1] };
  const naM = NA_PREFIX.exec(line);
  if (naM) {
    const rest = naM[1];
    const dateM = DATE_SUFFIX.exec(rest);
    const date = dateM ? dateM[1] : undefined;
    const reason = (dateM ? rest.slice(0, dateM.index) : rest).trim();
    return { kind: "na", reason: reason || undefined, date };
  }
  return null;
}

export function parseRecord(text) {
  const lines = String(text || "").split(/\r?\n/);
  let module = null;
  let axis = null;
  const axes = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!module) {
      const h = HEADING.exec(line);
      if (h) module = h[1];
      continue;
    }
    const ah = AXIS_HEADING.exec(line);
    if (ah) {
      axis = ah[1];
      if (!axes[axis]) axes[axis] = [];
      continue;
    }
    if (!axis || !line) continue;
    const ans = parseAnswerLine(line);
    if (ans) axes[axis].push(ans);
  }
  return { module, axes };
}

// gate(modules, readRecord, opts) -> Problem[]
// Problem = { kind, module, axis, detail }
// readRecord(modulePath) -> string | null (null/throw means no record found)
// opts.knownTests: Set of test names actually executed (Task 2); when absent,
// missing-test is never reported (Task 1 has no test inventory to check yet).
export function gate(modules, readRecord, opts = {}) {
  const problems = [];
  for (const mod of modules) {
    let text = null;
    try { text = readRecord(mod); } catch { text = null; }
    if (!text) {
      problems.push({ kind: "no-record", module: mod, axis: null, detail: null });
      continue;
    }
    const record = parseRecord(text);
    for (const axis of AXES) {
      const answers = record.axes[axis];
      if (!answers || !answers.length) {
        problems.push({ kind: "unanswered-axis", module: mod, axis, detail: null });
        continue;
      }
      for (const a of answers) {
        if (a.kind === "na") {
          if (!a.reason) problems.push({ kind: "na-no-reason", module: mod, axis, detail: null });
          if (!a.date) problems.push({ kind: "na-no-date", module: mod, axis, detail: null });
        } else if (a.kind === "test" && opts.knownTests && !opts.knownTests.has(a.name)) {
          problems.push({ kind: "missing-test", module: mod, axis, detail: a.name });
        }
      }
    }
  }
  return problems;
}

export function naRatio(record) {
  let total = 0;
  let na = 0;
  for (const axis of AXES) {
    for (const a of record.axes[axis] || []) {
      total++;
      if (a.kind === "na") na++;
    }
  }
  return total ? na / total : 0;
}

// AC-G17. The failure this repo has already shipped once: `4af8cd6`
// regex-matched a scheduled task's own arguments and reported the result as
// behaviour. Finding = { file, line, text } - one finding shape across every
// gate in the programme (matches J's pathgate, E's uigate).
//
// Heuristic, not a real parser: flags a test whose LAST statement before an
// `assert.*` call is a bare `write*(...)` call, and that assert's own source
// text calls a `read*(...)` getter - i.e. nothing ran in between except the
// assertion reading back what was just written. Any other statement between
// them (a consumer call, an assignment used for its own sake) breaks the
// chain and is not flagged. `// scenariogate-ok: <why>` on the line directly
// above `test(...)` opts a test out - the persistence tier (Task 6) is
// exactly a round-trip, and the gate demands the justification be written
// down, not that the pattern never appear.
const WRITE_CALL = /^[\w$.]*\bwrite\w*\s*\(/i;
const READ_CALL = /\bread\w*\s*\(/i;
const ASSERT_STMT = /^assert\b/;
const TEST_CALL = /\btest\(\s*(["'`])((?:\\.|(?!\1).)*)\1\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{/g;

function extractTestBodies(src) {
  const tests = [];
  const re = new RegExp(TEST_CALL.source, "g");
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    const body = src.slice(re.lastIndex, i - 1);
    const before = src.slice(0, m.index);
    const prevLine = before.split(/\r?\n/).filter((l) => l.trim() !== "").pop() || "";
    tests.push({ name: m[2], body, justified: /^\s*\/\/\s*scenariogate-ok\b/.test(prevLine) });
  }
  return tests;
}

export function selfAssertingTests(files, readFile) {
  const findings = [];
  for (const file of files) {
    let src;
    try { src = readFile(file); } catch { continue; }
    for (const t of extractTestBodies(src)) {
      if (t.justified) continue;
      let lastWasWrite = false;
      for (const stmt of t.body.split(";").map((s) => s.trim()).filter(Boolean)) {
        if (WRITE_CALL.test(stmt)) { lastWasWrite = true; continue; }
        if (ASSERT_STMT.test(stmt)) {
          if (lastWasWrite && READ_CALL.test(stmt)) findings.push({ file, line: null, text: t.name });
          continue; // an assert neither extends nor breaks the write streak on its own
        }
        lastWasWrite = false; // any other statement is a real consumer - chain broken
      }
    }
  }
  return findings;
}

// ------------------------------------------------------------- CLI

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function recordPath(modulePath) {
  return path.join(ROOT, modulePath.replace(/\.mjs$/, ".scenarios.md"));
}

function readRecordFile(modulePath) {
  try {
    return readFileSync(recordPath(modulePath), "utf8");
  } catch {
    return null;
  }
}

// Real execution, not a source grep - a test that exists but is skipped must
// not count as covering the scenario it is named for.
function collectKnownTests(testFile) {
  try {
    const out = execFileSync(process.execPath, ["--test", "--test-reporter=tap", testFile], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const names = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = /^ok \d+ - (.+?)(?:\s*#.*)?$/.exec(line.trim());
      if (m) names.add(m[1].trim());
    }
    return names;
  } catch (e) {
    // A red suite still emits TAP on stdout; execFileSync throws on nonzero
    // exit, so recover the output it already captured rather than losing it.
    const out = String(e.stdout || "");
    const names = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = /^ok \d+ - (.+?)(?:\s*#.*)?$/.exec(line.trim());
      if (m) names.add(m[1].trim());
    }
    return names;
  }
}

function checkOne(modulePath) {
  const testFile = modulePath.replace(/\.mjs$/, ".test.mjs");
  const knownTests = collectKnownTests(testFile);
  return gate([modulePath], readRecordFile, { knownTests });
}

// Task 4 Step 6 of guards#OI-019: the completeness gate over every real
// kernel module. Deliberately a bare CLI mode, not a node:test test — this
// spawns `node --test` per module (via collectKnownTests), and Node's own
// test runner silently skips a nested `node --test` when the OUTER process
// is already one (warns "run() is being called recursively within a test
// file" and produces zero output), which would make every module falsely
// report missing-test if this ran from inside the fast tier. Run bare:
// `node tools/scenariogate.mjs --check-all`.
function realKernelModules() {
  const isModule = (f) => f.endsWith(".mjs") && !f.includes(".test.") && !f.endsWith(".e2e.mjs");
  const top = readdirSync(path.join(ROOT, "kernel")).filter(isModule).map((f) => `kernel/${f}`);
  const adapters = readdirSync(path.join(ROOT, "kernel", "adapters")).filter(isModule).map((f) => `kernel/adapters/${f}`);
  return [...top, ...adapters];
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--check-all")) {
    const mods = realKernelModules();
    let anyFail = false;
    for (const mod of mods) {
      const problems = checkOne(mod);
      if (problems.length) {
        anyFail = true;
        for (const p of problems) {
          console.log(`scenariogate: ${p.kind} — ${p.module}${p.axis ? ` [${p.axis}]` : ""}${p.detail ? `: ${p.detail}` : ""}`);
        }
      }
    }
    if (anyFail) process.exit(1);
    console.log(`scenariogate: ok — all ${mods.length} kernel modules`);
    process.exit(0);
  }

  const idx = argv.indexOf("--module");
  const modules = idx >= 0 ? [argv[idx + 1]] : [];
  if (!modules.length) {
    console.error("usage: scenariogate.mjs --module <path/to/module.mjs> | --check-all");
    process.exit(1);
  }
  const problems = checkOne(modules[0]);
  if (!problems.length) {
    console.log(`scenariogate: ok — ${modules[0]}`);
    process.exit(0);
  }
  for (const p of problems) {
    console.log(`scenariogate: ${p.kind} — ${p.module}${p.axis ? ` [${p.axis}]` : ""}${p.detail ? `: ${p.detail}` : ""}`);
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

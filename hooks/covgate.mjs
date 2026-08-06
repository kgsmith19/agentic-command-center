#!/usr/bin/env node
// covgate.mjs — the changed-file coverage gate the test contract binds.
//
//   node hooks/covgate.mjs          (run from C:\code\guards)
//
// WHAT IT PROVES: every lib file you TOUCHED this change is fully exercised by
// the fast tier. Scope is deliberate — repo-wide 100% is a vanity number that
// punishes whoever touches the oldest file, while changed-file 100% is cheap
// the day you write the code and only ever gates the author of the change.
// Coverage is a floor, not the goal: it proves the tests VISIT the code, the
// red-first rule proves they can FAIL, and only both together gate honestly.
//
// Mechanics: node's built-in coverage (>= 22) with the lcov reporter, no
// dependencies. Changed = git diff against HEAD plus untracked, filtered to
// lib .mjs under hooks/ and runner/ (tests and the e2e harness are exempt —
// they are the instrument, not the subject). The gate fails CLOSED: a red
// fast tier, a git error, or a changed file no test ever imports all exit 1.
//
// Dials: policy.json tests.changedLineCoverage (default 100). Test list
// override: ACC_COVGATE_TESTS (comma/space separated, relative to cwd) — used
// by covgate's own suite to gate a fixture repo instead of this one.
// Range override: ACC_COVGATE_RANGE="<oldrev> <newrev>" gates a commit range
// instead of the working tree (git diff between the two revs, no untracked
// files, no mutation of the caller's repo) — used by hooks/pre-push (OI-030)
// to gate a push before it leaves the machine.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = () => process.env.ACC_POLICY || path.join(HERE, "..", "policy.json");

// Three floors, because line coverage alone lies: V8 marks a function's
// DECLARATION line covered even when nothing ever calls it, so a one-line
// helper can sit untested behind "100% lines" (caught by this gate's own
// suite, 2026-08-01: sub() untested, lines 100%, functions 50%). Lines and
// functions default to 100. Branches default to 90 — the last few branch
// points are usually defensive catch-paths that need fault injection to
// reach; raise the dial to 100 when a file warrants that spend.
//
// `file` (gate-relative, forward slashes) is optional: when given, and
// `tests.branchFloorOverrides[file]` is a finite number, it replaces the
// branch floor for THAT file only. Escape hatch for a proven tooling
// limitation, not a way to duck real gaps — see OPEN-ISSUES.md OI-017.
// Phase 7 (full-remediation-prompt.md) re-verified this after fixing a real
// parseLcov merge bug (below): that bug was real, but is a DIFFERENT
// phenomenon from what these two overrides paper over — hooks/lane.mjs and
// kernel/run.mjs never produce more than one SF: block each, so the parser
// fix changes neither file's reported number. Their branch % is genuinely
// unstable run to run (node's own --experimental-test-coverage instrumenting
// differently depending on total file/process count in one invocation,
// bisected in OI-017), sometimes landing above 90%, sometimes below — a real
// tooling limitation, still not fixable by a parser change.
export function floors(file) {
  let t = {};
  try { t = JSON.parse(fs.readFileSync(POLICY(), "utf8").replace(/^﻿/, "")).tests || {}; } catch {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const override = file && t.branchFloorOverrides ? t.branchFloorOverrides[file] : undefined;
  return {
    lines: num(t.changedLineCoverage, 100),
    funcs: num(t.changedFunctionCoverage, 100),
    branches: num(override, num(t.changedBranchCoverage, 90)),
  };
}

// Separator- and case-insensitive (Windows), so lcov SF paths and git paths
// meet in the middle regardless of who emitted which slash.
export const normPath = (p) => path.resolve(String(p)).replaceAll("\\", "/").toLowerCase();

// Lib files only: .mjs directly under hooks/, runner/, kernel/, or gui/
// (kernel/ allows one level of nesting for kernel/adapters/<harness>.mjs, gui/
// for gui/e2e/<spec>.mjs), minus tests and harnesses — .test.mjs (node:test),
// .e2e.mjs (kernel/loop proof runs), and .spec.mjs (Playwright, gui/e2e/) are
// all the instrument, never the gated subject. The GATE'S OWN SUBJECT,
// exported for its suite.
export function changedLibFiles(names) {
  return [...new Set(names)]
    .map((n) => String(n).replaceAll("\\", "/"))
    .filter((n) => /^(hooks|runner|kernel|gui)\/(?:[^/]+\/)?[^/]+\.mjs$/.test(n) && !/\.(test|e2e|spec)\.mjs$/.test(n));
}

// lcov per file: FN:<line>,<name> + FNDA:<hits>,<name> (functions, paired in
// matching order within a block), DA:<line>,<hits> (lines),
// BRDA:<line>,<block>,<branch>,<hits|-> (branches; "-" = block never entered,
// which is an UNCOVERED branch, not a missing one).
//
// A file imported by N different test files gets N separate SF: blocks in one
// combined lcov report — one per subprocess node spawns per test file, each
// reporting hits for the WHOLE file (found while fixing OI-017: hooks/usage.mjs
// alone produced 19 SF: blocks, each declaring the identical 637 DA: lines).
// Merging those by blind concatenation double(-N)-counts every line/branch/
// function that appears in more than one block — a file imported everywhere
// would read as having 19x its real branch count, each copy 1/19th "covered".
// The correct merge is per-code-point identity: a line/branch/function is
// COVERED if hit in ANY block, and counted exactly ONCE in the total either
// way. DA: and BRDA: carry that identity directly (line number; line+block+
// branch). FNDA: does not carry a line number itself, but the FN: declaration
// immediately preceding each block's FNDA: run does, in the same order —
// paired by position within the block to build a line-qualified key, since a
// bare function NAME alone can repeat across a file (two same-named methods
// on different objects).
export function parseLcov(text) {
  const files = new Map();
  const blank = () => ({ lines: new Map(), funcs: new Map(), branches: new Map() });
  let cur = null;
  let fnDecls = [];
  let fnIdx = 0;
  const bump = (map, key, hits) => { if (hits > (map.get(key) ?? -1)) map.set(key, hits); };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const key = normPath(line.slice(3).trim());
      cur = files.get(key) || blank();
      files.set(key, cur);
      fnDecls = [];
      fnIdx = 0;
    } else if (cur && line.startsWith("FN:")) {
      fnDecls.push(line.slice(3)); // "<line>,<name>" — the identity key itself
    } else if (cur && line.startsWith("FNDA:")) {
      const rest = line.slice(5);
      const comma = rest.indexOf(",");
      const hits = Number(rest.slice(0, comma));
      const name = rest.slice(comma + 1);
      // No FN: pairing (e.g. a hand-built fixture) — fall back to position +
      // name, which still dedupes correctly as long as the same function
      // occupies the same position in every block for this file (true for
      // any two blocks node itself emits for one static file).
      const key = fnDecls[fnIdx] ?? `?:${fnIdx}:${name}`;
      fnIdx++;
      bump(cur.funcs, key, hits);
    } else if (cur && line.startsWith("DA:")) {
      const [ln, hits] = line.slice(3).split(",");
      bump(cur.lines, ln, Number(hits));
    } else if (cur && line.startsWith("BRDA:")) {
      const parts = line.slice(5).split(",");
      const key = parts.slice(0, 3).join(",");
      const hits = parts[3] === "-" ? 0 : Number(parts[3]);
      bump(cur.branches, key, hits);
    } else if (line === "end_of_record") { cur = null; fnDecls = []; fnIdx = 0; }
  }
  const tc = (m) => ({ t: m.size, c: [...m.values()].filter((h) => h > 0).length });
  const pct = (m) => (m.t ? Math.round((m.c / m.t) * 1000) / 10 : 100);
  const result = new Map();
  for (const [path, f] of files) {
    const lines = tc(f.lines), funcs = tc(f.funcs), branches = tc(f.branches);
    result.set(path, { lines, funcs, branches, pct: { lines: pct(lines), funcs: pct(funcs), branches: pct(branches) } });
  }
  return result;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
}

// OI-030: a local pre-push hook must gate the COMMIT RANGE being pushed, not
// the working tree — `git diff --name-only HEAD` (the default, above) is
// always empty for already-committed work. Parses "<oldrev> <newrev>"
// (whitespace-separated — the exact two fields a pre-push hook already reads
// off its own stdin, so the caller passes them straight through with no
// translation). Never mutates the caller's repo (no reset/checkout) — the
// range is one `git diff` between two revs the caller names. Exported so its
// parsing can be unit-tested without a subprocess.
export function parseRange(raw) {
  const parts = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return null;
  return { oldrev: parts[0], newrev: parts[1] };
}

function main() {
  const cwd = process.cwd();

  let changed;
  try {
    const rangeRaw = process.env.ACC_COVGATE_RANGE;
    if (rangeRaw !== undefined) {
      const range = parseRange(rangeRaw);
      if (!range) {
        console.error(`covgate: FAIL — ACC_COVGATE_RANGE must be "<oldrev> <newrev>", got: ${JSON.stringify(rangeRaw)}`);
        process.exit(1);
      }
      changed = changedLibFiles(
        git(["diff", "--name-only", range.oldrev, range.newrev], cwd)
      ).filter((f) => fs.existsSync(path.join(cwd, f)));
    } else {
      changed = changedLibFiles([
        ...git(["diff", "--name-only", "HEAD"], cwd),
        ...git(["ls-files", "--others", "--exclude-standard"], cwd),
      ]).filter((f) => fs.existsSync(path.join(cwd, f)));
    }
  } catch (e) {
    console.error(`covgate: FAIL — cannot determine what changed (${String(e.message || e).trim()})`);
    process.exit(1);
  }
  if (!changed.length) {
    console.log("covgate: PASS — no changed lib files to gate");
    process.exit(0);
  }

  // Default discovery scans BOTH lib dirs the gate scopes to (changedLibFiles,
  // above) — scanning only hooks/ was a real bug (found 2026-08-01, closing
  // OI-013): runner/runner.test.mjs existed but a plain `node
  // hooks/covgate.mjs` never ran it, so runner.mjs read 0% forever no matter
  // how good its suite was.
  // Relative to CWD (the repo being gated), never to HERE (this script's own
  // location) — those differ for every fixture repo covgate's own suite
  // gates, and conflating them was the actual bug: discovery silently listed
  // the REAL guards/hooks tests while gating a throwaway fixture.
  const tests = process.env.ACC_COVGATE_TESTS
    ? process.env.ACC_COVGATE_TESTS.split(/[ ,]+/).filter(Boolean)
    : ["hooks", "runner", "kernel", "kernel/adapters", "gui"].flatMap((d) => {
        let files = [];
        try { files = fs.readdirSync(path.join(cwd, d)).filter((f) => f.endsWith(".test.mjs")); } catch {}
        return files.map((f) => path.join(d, f));
      });

  const lcovFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acc-covgate-")), "cov.lcov");
  const run = spawnSync(
    process.execPath,
    [
      "--test", "--experimental-test-coverage",
      "--test-reporter=spec", "--test-reporter-destination=stdout",
      "--test-reporter=lcov", `--test-reporter-destination=${lcovFile}`,
      ...tests,
    ],
    // NODE_TEST_CONTEXT must not leak in: a covgate invoked from inside any
    // node:test process (its own suite does exactly this) would otherwise make
    // the inner runner think it is recursing and silently skip every file.
    // NODE_V8_COVERAGE must not leak in either: --experimental-test-coverage
    // auto-sets it on whichever process first enables coverage, so a covgate
    // invoked from inside an ALREADY-coverage-instrumented process (its own
    // suite spawns covgate up to three levels deep: real run -> covgate.test.mjs
    // -> fixture covgate.mjs -> fixture's own test run) would otherwise inherit
    // that dir and reuse it instead of getting a fresh one. Concurrent runs
    // sharing one raw-coverage directory race on each other's report generation
    // and cleanup, corrupting each other's JSON mid-write (found 2026-08-02,
    // real Windows run: "Warning: Could not report code coverage. SyntaxError:
    // Unexpected end of JSON input", 100% reproducible with the full fast tier).
    // ACC_COVGATE_RANGE must not leak in either, for the identical reason as
    // the other two: a range-mode covgate invocation (hooks/pre-push, OI-030)
    // spawns THIS test run, which in turn spawns covgate.test.mjs's own
    // fixture covgate.mjs invocations three levels deep — those fixtures
    // gate unrelated, isolated repos with their own unrelated commit shas, so
    // inheriting the outer range would hand them oldrev/newrev that don't
    // exist in their history at all ("fatal: bad object", found while writing
    // hooks/pre-push.test.mjs, 2026-08-04).
    { cwd, encoding: "utf8", stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: undefined, ACC_COVGATE_RANGE: undefined } }
  );
  if (run.status !== 0) {
    console.error("covgate: FAIL — the fast tier is red; coverage of failing tests proves nothing");
    process.exit(1);
  }

  let lcov = "";
  try { lcov = fs.readFileSync(lcovFile, "utf8"); } catch {}
  const cov = parseLcov(lcov);
  if (!cov.size) {
    console.error("covgate: FAIL — no coverage emitted (node >= 22 with --experimental-test-coverage required)");
    process.exit(1);
  }

  let bad = 0;
  for (const f of changed) {
    const min = floors(f);
    const c = cov.get(normPath(path.join(cwd, f)));
    const pct = c ? c.pct : { lines: 0, funcs: 0, branches: 0 };
    const misses = ["lines", "funcs", "branches"].filter((k) => pct[k] < min[k]);
    if (misses.length) bad++;
    console.log(
      `covgate: ${misses.length ? "FAIL" : " ok "} ${f} — lines ${pct.lines}% funcs ${pct.funcs}% branches ${pct.branches}%` +
        (c ? "" : " (no test imports it)") +
        (misses.length ? ` — under floor on: ${misses.join(", ")} (min ${misses.map((k) => min[k]).join("/")})` : "")
    );
  }
  if (bad) {
    const d = floors();
    console.error(
      `covgate: FAIL — ${bad} changed file(s) under the floors (lines ${d.lines}% / funcs ${d.funcs}% / branches ${d.branches}% — some files may carry a documented per-file override)`
    );
    process.exit(1);
  }
  console.log(`covgate: PASS — ${changed.length} changed file(s) at or above the floors`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

// node --test tools/workflows.test.mjs   (run from the repo root)
//
// Keeps WORKFLOWS.md honest the way tools/inventory.mjs's --check keeps the
// ledgers honest: every test-file path it cites must exist on disk, so a
// renamed or deleted test file fails the build instead of leaving a stale
// citation nobody notices.
//
// package.json's test scripts are the same class of citation and get the same
// treatment here, because `node --test` does NOT fail on a path that does not
// exist — it silently runs the remaining files and exits 0. Sub-project J's
// watcher rename hit exactly that: test:windows kept naming the retired test
// filename, the renamed hooks/autopilot.test.mjs was in no suite at all, and
// the tier still reported green with a whole file unrun.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const TEST_FILE = /`([\w./-]+\.(?:test\.mjs|test\.ps1|e2e\.mjs|e2e\.ps1))`/g;

test("every test file WORKFLOWS.md cites actually exists", () => {
  const doc = fs.readFileSync("WORKFLOWS.md", "utf8");
  const cited = [...doc.matchAll(TEST_FILE)].map((m) => m[1]);
  assert.ok(cited.length > 0, "no test-file citations found — the extraction regex may be broken");
  for (const path of new Set(cited)) {
    assert.ok(fs.existsSync(path), `WORKFLOWS.md cites ${path}, which does not exist`);
  }
});

test("every test file package.json's test scripts name actually exists", () => {
  const scripts = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts;
  const named = Object.entries(scripts).filter(([, cmd]) => cmd.includes("--test"));
  assert.ok(named.length > 0, "no --test scripts found — package.json's shape may have changed");
  for (const [name, cmd] of named) {
    const cited = cmd.match(/[\w./-]+\.test\.mjs/g) || [];
    assert.ok(cited.length > 0, `script "${name}" runs --test but names no test file`);
    for (const path of new Set(cited)) {
      assert.ok(fs.existsSync(path), `package.json "${name}" names ${path}, which does not exist`);
    }
  }
});

test("every workflow row names a Tests value, never a bare dash", () => {
  const doc = fs.readFileSync("WORKFLOWS.md", "utf8");
  const rows = doc.split(/\r?\n/).filter((l) => /^\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|$/.test(l) && !/^\|\s*Workflow\s*\|/.test(l) && !/^\|---/.test(l));
  assert.ok(rows.length > 0, "no workflow table rows found — the table shape may have changed");
  for (const row of rows) {
    const testsCol = row.split("|")[4].trim();
    assert.notEqual(testsCol, "", `row has no Tests value: ${row}`);
    assert.doesNotMatch(testsCol, /^-$/, `row has a placeholder Tests value: ${row}`);
  }
});

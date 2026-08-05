// node --test tools/workflows.test.mjs   (run from C:\code\guards)
//
// Keeps WORKFLOWS.md honest the way tools/inventory.mjs's --check keeps the
// ledgers honest: every test-file path it cites must exist on disk, so a
// renamed or deleted test file fails the build instead of leaving a stale
// citation nobody notices.
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

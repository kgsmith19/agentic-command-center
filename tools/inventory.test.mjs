// node --test tools/inventory.test.mjs   (run from C:\code\guards)
//
// Hermetic: every case is an inline ledger fragment. Only Task 9 reads the
// real ledgers on disk.
import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("./inventory.mjs");

const ONE_ENTRY = `# Open issues

## OI-034 A console PID is treated as a console IDENTITY
- opened: 2026-08-04
- rank: reliability
- where: hooks/goal.mjs
- what: liveness is a bare process.kill(pid, 0) existence test.
`;

test("parses id, qualified id, title and fields from one entry", () => {
  const [e] = m.parseLedger(ONE_ENTRY, "guards");
  assert.equal(e.id, "OI-034");
  assert.equal(e.qualifiedId, "guards#OI-034");
  assert.equal(e.ledger, "guards");
  assert.equal(e.title, "A console PID is treated as a console IDENTITY");
  assert.equal(e.marker, null);
  assert.equal(e.fields.rank, "reliability");
  assert.equal(e.fields.opened, "2026-08-04");
});

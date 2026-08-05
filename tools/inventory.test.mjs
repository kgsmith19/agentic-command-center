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

const MARKERS = `
## OI-001 [RESOLVED 2026-08-03] done thing
- rank: reliability
## OI-002 [RETIRED 2026-08-04] not doing it
- rank: roi
## OI-003 [SUPERSEDED 2026-08-03] replaced
- rank: roi
## OI-015 [SHRUNK — needs Kyle for the rest] half done
- rank: control
## OI-034 still open
- rank: reliability
`;

test("RESOLVED, RETIRED and SUPERSEDED close an entry; SHRUNK does not", () => {
  const open = m.parseLedger(MARKERS, "guards").filter(m.isOpen).map((e) => e.id);
  assert.deepEqual(open, ["OI-015", "OI-034"]);
});

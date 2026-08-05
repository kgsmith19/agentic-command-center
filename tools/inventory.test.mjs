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

test("entries sort by rank ordinal, then ledger, then id", () => {
  const es = m.parseLedger(`
## OI-009 later id
- rank: safety
## OI-002 low priority
- rank: roi
## OI-001 high priority
- rank: safety
`, "guards");
  assert.deepEqual(m.sortEntries(es).map((e) => e.id), ["OI-001", "OI-009", "OI-002"]);
});

test("an entry with no rank is UNRANKED and sorts first", () => {
  const es = m.parseLedger(`
## OI-001 ranked
- rank: safety
## OI-002 unranked
- opened: 2026-08-04
`, "guards");
  const sorted = m.sortEntries(es);
  assert.equal(sorted[0].id, "OI-002");
  assert.equal(m.rankOrdinal(sorted[0]), -1);
});

test("an unknown rank value fails loudly instead of defaulting", () => {
  const [e] = m.parseLedger("## OI-001 t\n- rank: urgent\n", "guards");
  assert.throws(() => m.rankOrdinal(e), /unknown rank "urgent"/);
});

test("duplicate-of collapses entries into one row listing every id", () => {
  const a = m.parseLedger("## OI-031 reaping\n- rank: reliability\n", "guards");
  const b = m.parseLedger(
    "## OI-007 same thing\n- rank: reliability\n- duplicate-of: guards#OI-031\n", "code");
  const rows = m.dedupe([...a, ...b]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].ids, ["guards#OI-031", "code#OI-007"]);
});

test("duplicate-of naming a nonexistent id fails the run", () => {
  const es = m.parseLedger("## OI-007 t\n- rank: roi\n- duplicate-of: guards#OI-999\n", "code");
  assert.throws(() => m.dedupe(es), /guards#OI-999 does not exist/);
});

test("identical ids in different ledgers never collide", () => {
  const es = [
    ...m.parseLedger("## OI-001 guards one\n- rank: safety\n", "guards"),
    ...m.parseLedger("## OI-001 lifeos one\n- rank: safety\n", "lifeos"),
  ];
  assert.equal(m.dedupe(es).length, 2);
});

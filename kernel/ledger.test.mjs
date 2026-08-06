// node --test kernel/ledger.test.mjs  (run from C:\code\guards)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, "ledger.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-ledger-"));
process.env.ACC_ROOT = path.join(BASE, "root");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
fs.writeFileSync(process.env.ACC_POLICY, "{}");

const L = await import("./ledger.mjs");

beforeEach(() => fs.rmSync(L.ledgerDir(), { recursive: true, force: true }));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const started = (runId) => ({
  runId, startedAt: "2026-08-03T10:00:00.000Z",
  contract: { goal: "g", acceptanceCriteria: [{ id: "AC1" }] }, settingsSha256: "abc",
});
const finalized = (runId, outcome = "accepted") => ({
  runId, finishedAt: "2026-08-03T10:05:00.000Z", outcome,
  harness: { name: "claude-code", version: "9.9.9" },
  criteria: [{ id: "AC1", status: "pass" }],
  decisions: { allow: 3, deny: 1 }, tokens: 1234, wallClockMs: 300000,
});

test("one run writes exactly one started and one finalized line (AC-L1)", () => {
  L.appendStarted(started("r1"));
  L.appendFinalized(finalized("r1"));
  const rows = L.readRuns();
  assert.equal(rows.filter((r) => r.event === "run_started" && r.runId === "r1").length, 1);
  assert.equal(rows.filter((r) => r.event === "run_finalized" && r.runId === "r1").length, 1);
});

test("a repeated append with the same runId applies exactly once (AC-G4)", () => {
  assert.equal(L.appendStarted(started("r2")), true);
  assert.equal(L.appendStarted(started("r2")), false, "second append must be a no-op");
  L.appendFinalized(finalized("r2"));
  assert.equal(L.appendFinalized(finalized("r2", "rejected")), false);
  const rows = L.readRuns().filter((r) => r.runId === "r2");
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.event === "run_finalized").outcome, "accepted",
    "the first finalize wins; a duplicate must not rewrite the outcome");
});

test("an abort still writes a finalized line (AC-L1 covers failure and abort)", () => {
  L.appendStarted(started("r3"));
  L.appendFinalized(finalized("r3", "aborted-by-budget"));
  assert.equal(L.readRuns().find((r) => r.event === "run_finalized").outcome, "aborted-by-budget");
});

test("finalized carries outcome, harness, per-criterion results, counts, cost, wall-clock (AC-L5)", () => {
  L.appendStarted(started("r4"));
  L.appendFinalized(finalized("r4"));
  const f = L.readRuns().find((r) => r.event === "run_finalized");
  for (const k of ["outcome", "harness", "criteria", "decisions", "tokens", "wallClockMs"]) {
    assert.ok(f[k] !== undefined, `finalized must carry ${k}`);
  }
  assert.equal(f.harness.version, "9.9.9");
});

test("the contract is stored byte-identically alongside the run (AC-C3)", () => {
  const c = { goal: "exact", nested: { list: [1, 2, 3] }, acceptanceCriteria: [{ id: "AC1" }] };
  L.appendStarted({ ...started("r5"), contract: c });
  assert.deepEqual(L.readRuns().find((r) => r.event === "run_started").contract, c);
});

test("guard decisions stream to a per-run sidecar and are counted", () => {
  L.appendDecision("r6", { tool: "Bash", allow: false, rule: "bashPatterns", reason: "no match", target: "rm -rf /" });
  L.appendDecision("r6", { tool: "Read", allow: true, rule: "readRoots", target: "C:/x/a.txt" });
  assert.deepEqual(L.decisionCounts("r6"), { allow: 1, deny: 1, total: 2 });
  assert.equal(fs.existsSync(L.decisionsFile("r6")), true);
});

test("readDecisions returns the full parsed rows, not just counts", () => {
  L.appendDecision("r7", { tool: "Edit", allow: false, rule: "writeRoots", reason: "not granted", target: "C:/x/b.txt" });
  assert.deepEqual(L.readDecisions("r7").map((d) => [d.tool, d.allow, d.rule, d.target]),
    [["Edit", false, "writeRoots", "C:/x/b.txt"]]);
  assert.equal(L.readDecisions("nope-no-such-run").length, 0, "a run with no decisions reads as empty, not an error");
});

test("autonomyFile lives beside the runs file, under the ledger dir", () => {
  assert.equal(path.dirname(L.autonomyFile()), L.ledgerDir());
  assert.equal(path.basename(L.autonomyFile()), "autonomy.json");
});

test("a truncated trailing line does not lose the records before it", () => {
  L.appendStarted(started("r7"));
  fs.appendFileSync(L.runsFile(), '{"event":"run_fina');
  assert.equal(L.readRuns().length, 1);
});

// Fault injection (pre-approved, 2026-08-06): a process killed mid-
// appendFileSync — power loss, OOM kill, a lane-timeout SIGKILL — leaves
// exactly the truncated-line state the test above proves readLines()
// tolerates. What was NOT tested: what happens on the NEXT retry after that
// crash. This file's own header comment states the contract explicitly
// ("the launch lane retries transport failures and a resumed kernel must
// not double-write, so the FIRST record for a run wins", AC-G4), and the
// clean-duplicate case is tested above — but a torn first write is
// INVISIBLE to appendOnce's own readRuns()-based existence check (the
// truncated line is silently skipped, same as any reader), so the crashed
// write doesn't count as "already recorded." The retry must therefore
// still succeed and land a clean, complete, USABLE record — proving actual
// crash recovery, not just "reading a torn file doesn't throw."
test("fault injection: a crash mid-appendStarted (torn line) does not block the retry from landing a real record", () => {
  fs.mkdirSync(L.ledgerDir(), { recursive: true });
  // Simulates the exact byte-level state a SIGKILL mid-fs.appendFileSync
  // leaves: a syntactically incomplete JSON line, no trailing newline.
  fs.appendFileSync(L.runsFile(), '{"event":"run_started","runId":"r-crash","started');
  assert.equal(L.readRuns().length, 0, "the torn write is invisible, same as any other reader");

  const retried = L.appendStarted(started("r-crash"));
  assert.equal(retried, true, "the retry must not be treated as a duplicate of an unreadable torn write");

  const rows = L.readRuns().filter((r) => r.runId === "r-crash");
  assert.equal(rows.length, 1, "exactly one USABLE record must exist after the retry");
  assert.equal(rows[0].event, "run_started");
  assert.equal(rows[0].contract.goal, "g", "the retried record must be the real, complete payload, not more torn data");

  // The crash must not have wedged idempotency for the record that DID
  // land cleanly: a second real retry after the successful one is still
  // correctly treated as a duplicate.
  assert.equal(L.appendStarted(started("r-crash")), false);
  assert.equal(L.readRuns().filter((r) => r.runId === "r-crash").length, 1);
});

function seed() {
  L.appendStarted({ runId: "q1", startedAt: "2026-08-01T00:00:00.000Z", contract: {}, settingsSha256: "a" });
  L.appendFinalized({ runId: "q1", finishedAt: "2026-08-01T01:00:00.000Z", outcome: "accepted",
    harness: { name: "claude-code", version: "1" }, criteria: [], decisions: {}, tokens: 1, wallClockMs: 1 });
  L.appendStarted({ runId: "q2", startedAt: "2026-08-05T00:00:00.000Z", contract: {}, settingsSha256: "a" });
  L.appendFinalized({ runId: "q2", finishedAt: "2026-08-05T01:00:00.000Z", outcome: "rejected",
    harness: { name: "codex", version: "2" }, criteria: [], decisions: {}, tokens: 1, wallClockMs: 1 });
  L.appendStarted({ runId: "q3", startedAt: "2026-08-06T00:00:00.000Z", contract: {}, settingsSha256: "a" });
}

test("query filters by status, harness, and date range (AC-L3)", () => {
  seed();
  assert.deepEqual(L.query({ status: "rejected" }).map((r) => r.runId), ["q2"]);
  assert.deepEqual(L.query({ harness: "claude-code" }).map((r) => r.runId), ["q1"]);
  assert.deepEqual(L.query({ since: "2026-08-04" }).map((r) => r.runId), ["q2", "q3"]);
  assert.deepEqual(L.query({ since: "2026-08-04", until: "2026-08-05T23:59:59Z" }).map((r) => r.runId), ["q2"]);
});

test("a started run with no finalized line reads as interrupted (AC-L2)", () => {
  seed();
  assert.equal(L.query({}).find((r) => r.runId === "q3").status, "interrupted");
  assert.deepEqual(L.query({ status: "interrupted" }).map((r) => r.runId), ["q3"]);
});

test("the CLI returns the same rows the API does", () => {
  seed();
  assert.deepEqual(
    L.runCli(["query", "--status", "accepted"]).map((r) => r.runId),
    L.query({ status: "accepted" }).map((r) => r.runId)
  );
  assert.throws(() => L.runCli(["bogus"]), /usage: ledger\.mjs query/);
});

// The isMain guard only runs via a real process invocation, never via
// `node --test` import — proven here as an actual subprocess (inherits
// process.env, including a live NODE_V8_COVERAGE, so it counts toward this
// file's own coverage the same way hooks/covgate.mjs proves itself).
test("end-to-end: the CLI prints JSON lines and exits 0 for a real query", () => {
  seed();
  const out = execFileSync("node", [LEDGER, "query", "--status", "accepted"], {
    encoding: "utf8", env: process.env,
  });
  assert.deepEqual(out.trim().split("\n").map((l) => JSON.parse(l).runId), ["q1"]);
});

test("end-to-end: an unknown CLI command prints usage to stderr and exits 1", () => {
  assert.throws(
    () => execFileSync("node", [LEDGER, "bogus"], { encoding: "utf8", env: process.env }),
    /usage: ledger\.mjs query/
  );
});

test("OI-019: withDecisionLock excludes a second acquirer until the first releases", () => {
  const seen = [];
  const result = L.withDecisionLock("r-lock", () => {
    seen.push("outer-start");
    // A second acquire attempt from INSIDE the held lock must not succeed
    // instantly — proves the lock file created by the outer call is real,
    // not a no-op. A short timeout keeps the test itself fast.
    assert.throws(
      () => L.withDecisionLock("r-lock", () => {}, { timeoutMs: 80 }),
      /still held/,
      "a nested acquire on the SAME lock must not succeed while it's held"
    );
    seen.push("outer-end");
    return "outer-result";
  });
  assert.equal(result, "outer-result");
  assert.deepEqual(seen, ["outer-start", "outer-end"]);
});

test("OI-019: withDecisionLock reclaims a stale lock instead of deadlocking forever", () => {
  const lockPath = L.decisionsFile("r-stale") + ".lock";
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "");
  const oldTime = new Date(Date.now() - 10_000);
  fs.utimesSync(lockPath, oldTime, oldTime); // simulate a crashed holder's lock, 10s old
  const result = L.withDecisionLock("r-stale", () => "reclaimed", { staleMs: 100 });
  assert.equal(result, "reclaimed");
  assert.equal(fs.existsSync(lockPath), false, "the lock is released after the callback runs");
});

test("OI-019: withDecisionLock releases the lock even when the callback throws", () => {
  const lockPath = L.decisionsFile("r-throw") + ".lock";
  assert.throws(() => L.withDecisionLock("r-throw", () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(lockPath), false, "a throwing callback must not leak the lock file");
});

// Full-repo review (2026-08-06): the stale-reclaim path (previous test) has
// its own latent race. A holder that is merely SLOW -- not crashed -- can
// have its lock look "stale" to an observer purely from wall-clock elapsed
// time. A second process then legitimately reclaims it (rmSync + its own
// fresh create) and enters its OWN critical section. When the ORIGINAL
// (still-running, not-crashed) holder finally finishes and hits its own
// `finally { fs.rmSync(lockPath) }`, it deletes whatever file is AT THAT
// PATH NOW -- which is the SECOND holder's lock, not its own. A third
// process can then acquire while the second is still inside its critical
// section: a genuine double-acquisition, defeating the whole point of the
// lock, even though the atomic "wx" create itself was never bypassed.
test("a lock's release never deletes it if another holder has since reclaimed and rewritten it (fencing token, not just an atomic create)", () => {
  const runId = "fencing-test";
  const lockPath = L.decisionsFile(runId) + ".lock";
  L.withDecisionLock(runId, () => {
    // Simulate a second process having reclaimed this lock as stale WHILE
    // this holder was legitimately (not crashed) still inside its own
    // critical section, and written its own token in place of ours.
    fs.writeFileSync(lockPath, "someone-elses-token");
  });
  assert.equal(
    fs.readFileSync(lockPath, "utf8"),
    "someone-elses-token",
    "the original holder's release must not delete a lock another holder has since reclaimed and is still using"
  );
});

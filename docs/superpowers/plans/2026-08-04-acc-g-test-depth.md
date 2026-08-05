# Sub-project G — Test-Depth Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every module a documented scenario pass across six axes, enforced by a gate so an unaudited module fails rather than being forgotten — and add the five test tiers Kyle named that do not exist yet.

**Architecture:** Same mechanism as A and F: a registry the gate enumerates. Every module carries `<module>.scenarios.md`; the gate walks the source tree and fails on a module with no record or an unanswered axis. "Not applicable" is a legitimate answer requiring a reason and a date, and the gate reports the N/A ratio per module so an all-N/A record is visible rather than green.

**Tech Stack:** Node 20+ ESM, `node:test`, a seeded generator for property tests (no dependency — `mulberry32` in ~5 lines).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-acc-test-depth-design.md` (18 ACs). Ledger: `OI-019`, `OI-025`.
- Standard: `docs/superpowers/specs/2026-08-04-acc-standards-design.md`.
- Worktrees: **two.** `acc/g-kernel-scenarios` runs in **wave 1** (already created, off `main`) and covers the modules that only move in J. `acc/g-rest` is created at the wave 3 boundary for everything else. Concurrent with I and F.
- **No test may be added or loosened to turn red green.** Every test must be able to fail against a genuine regression. `OI-019`'s own wording, and AC-G17 gates it.
- Coverage floors are **not** raised. Line coverage is not the constraint; scenario breadth is, and a higher floor buys motion instead of assurance.
- Property tests print their seed on failure and the failing case is pinned into a regression test.
- `guard.mjs` is already done (`OI-019`, 1/12). Its record is written **retroactively** in Task 2, so the template is proven against a completed audit before eleven more are written.

## The six axes

Every record answers all six. This is `OI-019`'s own vocabulary made into a form.

| Axis | The question |
|---|---|
| `standard` | the documented happy path, for every entry point |
| `non-standard` | valid but unusual input: empty, huge, unicode, deeply nested, wrong-but-parseable type |
| `edge` | boundaries: zero, one, max, off-by-one on every threshold and window |
| `rare` | timing and ordering: concurrent calls, reentrancy, out-of-order arrival, clock jumps, PID reuse |
| `error` | every failure the module can raise, and every failure it can receive |
| `fault-tolerance` | the environment breaking underneath: disk full, file locked, permission denied, killed mid-write, corrupt state on disk |

---

### Task 1: The scenario-record gate

**Files:**
- Create: `tools/scenariogate.mjs`, `tools/scenariogate.test.mjs`

**Interfaces:**
- Produces: `parseRecord(text) -> { module, axes: { [axis]: Answer[] } }`,
  `Answer = { kind: "test", name } | { kind: "na", reason, date }`.
- `gate(modules, readRecord) -> Problem[]`,
  `Problem = { kind: "no-record"|"unanswered-axis"|"na-no-reason"|"na-no-date"|"missing-test", module, axis, detail }`.
- `naRatio(record) -> number`.

- [ ] **Step 1: Write the failing test**

```javascript
// node --test tools/scenariogate.test.mjs
//
// OI-019: covgate's floors prove every line EXECUTES once. They do not prove the
// suite covers the scenario space. The first module audited under this program
// (kernel/guard.mjs) turned up a real, live path-traversal bypass - one module of
// twelve. A gate that enumerates modules cannot be forgotten; diligence can.
import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("./scenariogate.mjs");

const GOOD = `# core/guard.mjs — scenarios

## standard
- test: allows a write inside writeRoots

## non-standard
- test: a path with unicode segments resolves identically

## edge
- test: a path exactly equal to a writeRoots entry is allowed

## rare
- test: mixed backslash and forward-slash traversal is caught identically

## error
- test: a malformed path object is denied, not thrown

## fault-tolerance
- na: pure module, no I/O to fail underneath (2026-08-04)
`;

test("a complete record parses into six answered axes", () => {
  const r = m.parseRecord(GOOD);
  assert.equal(Object.keys(r.axes).length, 6);
  assert.deepEqual(r.axes.standard, [{ kind: "test", name: "allows a write inside writeRoots" }]);
  assert.deepEqual(r.axes["fault-tolerance"],
    [{ kind: "na", reason: "pure module, no I/O to fail underneath", date: "2026-08-04" }]);
});

test("a module with no record fails the gate", () => {
  const p = m.gate(["core/ledger.mjs"], () => null);
  assert.deepEqual(p, [{ kind: "no-record", module: "core/ledger.mjs", axis: null, detail: null }]);
});

test("an unanswered axis fails the gate", () => {
  const p = m.gate(["a.mjs"], () => GOOD.replace(/## rare[\s\S]*?\n\n/, ""));
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, "unanswered-axis");
  assert.equal(p[0].axis, "rare");
});

test("na without a reason fails", () => {
  const p = m.gate(["a.mjs"], () => GOOD.replace(/- na: pure module[^\n]*/, "- na: (2026-08-04)"));
  assert.equal(p[0].kind, "na-no-reason");
});

test("na without a date fails", () => {
  const p = m.gate(["a.mjs"], () => GOOD.replace(/ \(2026-08-04\)/, ""));
  assert.equal(p[0].kind, "na-no-date");
});

test("naRatio reports how much of a record is not-applicable", () => {
  assert.equal(m.naRatio(m.parseRecord(GOOD)), 1 / 6);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tools/scenariogate.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**, then:

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tools/scenariogate.test.mjs`
Expected: PASS, 6/6

- [ ] **Step 5: Commit**

```bash
git add tools/scenariogate.mjs tools/scenariogate.test.mjs
git commit -m "feat(gates): scenario records, six axes, enumerated not remembered (AC-G1, AC-G2, AC-G3, AC-G4)"
```

---

### Task 2: The retroactive record for `guard.mjs`, and the named-test check

**Files:**
- Create: `core/guard.scenarios.md`
- Modify: `tools/scenariogate.mjs`, `tools/scenariogate.test.mjs`

**Interfaces:**
- Adds `missing-test`: a record naming a test that no suite executes.

AC-G5 is one of the two anti-trickery criteria — it catches a record claiming coverage that does not exist.

- [ ] **Step 1: Write the failing test**

```javascript
test("a record naming a test nobody wrote fails the gate", () => {
  const p = m.gate(["a.mjs"], () => GOOD, { knownTests: new Set() });
  assert.ok(p.some((x) => x.kind === "missing-test"));
});

test("a record whose named tests all exist passes", () => {
  const names = new Set([
    "allows a write inside writeRoots",
    "a path with unicode segments resolves identically",
    "a path exactly equal to a writeRoots entry is allowed",
    "mixed backslash and forward-slash traversal is caught identically",
    "a malformed path object is denied, not thrown",
  ]);
  assert.deepEqual(m.gate(["a.mjs"], () => GOOD, { knownTests: names }), []);
});
```

`knownTests` is collected by running `node --test --test-reporter=tap` and parsing test names — real execution, not a source grep, so a test that exists but is skipped does not count.

- [ ] **Step 2: Run to verify it fails**, implement, then:

- [ ] **Step 3: Write `guard.mjs`'s record retroactively**

It is the one completed audit. Its 21 tests include the four regression tests for the real bypass: the exact traversal now denied and re-classified as `alwaysDeny` with the target shown resolved; the same class on a READ path; a `..` resolving back inside an allowed root still allowed; and a mixed-slash traversal caught identically.

- [ ] **Step 4: Run the gate against it**

```bash
node tools/scenariogate.mjs --module core/guard.mjs
```
Expected: exit 0. If the template does not fit a completed audit, fix the template now — before eleven more are written against it.

- [ ] **Step 5: Commit**

```bash
git add core/guard.scenarios.md tools/scenariogate.mjs tools/scenariogate.test.mjs
git commit -m "feat(gates): named tests must really execute; guard.mjs's record, retroactively (AC-G5, AC-G7)"
```

---

### Task 3: The anti-trickery gate

**Files:**
- Modify: `tools/scenariogate.mjs`, `tools/scenariogate.test.mjs`

**Interfaces:**
- `selfAssertingTests(files, readFile) -> Finding[]` — flags a test whose only
  assertion compares against a value the test itself just wrote, with no
  intervening behaviour.

AC-G17. This is the failure this repo has already shipped once: `4af8cd6` regex-matched a scheduled task's own arguments and reported the result as behaviour.

- [ ] **Step 1: Write the failing test**

```javascript
test("a test whose only assertion reads back what it wrote is a finding", () => {
  const src = `
test("the dial saves", () => {
  writeConfig({ enabled: true });
  assert.equal(readConfig().enabled, true);
});`;
  assert.equal(m.selfAssertingTests(["a.test.mjs"], () => src).length, 1);
});

test("a test that exercises a consumer between write and assert is fine", () => {
  const src = `
test("the dial changes behaviour", () => {
  writeConfig({ enabled: true });
  const outcome = runConsumer();
  assert.equal(outcome, "re-scoped");
});`;
  assert.deepEqual(m.selfAssertingTests(["a.test.mjs"], () => src), []);
});

test("an explicitly justified round-trip test is allowed", () => {
  const src = `
// scenariogate-ok: persistence round-trip IS the behaviour under test
test("the store round-trips", () => {
  write(x); assert.deepEqual(read(), x);
});`;
  assert.deepEqual(m.selfAssertingTests(["a.test.mjs"], () => src), []);
});
```

The justified case is real and must be allowed — Task 6's persistence tier is exactly a round-trip. The gate demands the justification be written down, not that the pattern never appear.

- [ ] **Step 2: Run to verify it fails**, implement, run, commit

```bash
git commit -am "feat(gates): flag tests that assert on what they themselves wrote (AC-G17)"
```

---

### Task 4: Audit the eleven remaining kernel modules

**Files:**
- Create: `core/{guardhook,run,ledger,verifier,autonomy,policy,contract,credentials,adapter,settings}.scenarios.md`, `core/adapters/claude-code.scenarios.md`
- Modify: the corresponding `*.test.mjs`

**Interfaces:**
- Eleven slices, one per module, **in `OI-019`'s stated risk order**. Each is its
  own RED→GREEN→commit cycle.

Order: `guardhook`, `run`, `ledger`, `verifier`, `autonomy`, `policy`, `contract`, `credentials`, `adapter`, `adapters/claude-code`, `settings`.

Per module, repeat:

- [ ] **Step 1: Write the record first, answering all six axes**

Write the *questions* before writing any test. The audit's value is in enumerating scenarios nobody thought of; writing tests first and describing them afterwards inverts that and finds nothing new.

- [ ] **Step 2: Run the gate to see which named tests do not exist**

```bash
node tools/scenariogate.mjs --module core/<name>.mjs
```
Expected: exit 1, listing `missing-test` for every scenario not yet covered. **This is the RED and it is also the work list.**

- [ ] **Step 3: Write each missing test, watching it fail first**

For each: write it, run it, record the failure, then fix the module if it is a real defect. A scenario that passes immediately is still recorded — but check it can fail by breaking the module deliberately for one run.

- [ ] **Step 4: Run the gate to green**

```bash
node tools/scenariogate.mjs --module core/<name>.mjs
node --test core/<name>.test.mjs
npx repo-gates
```

- [ ] **Step 5: Commit per module**

```bash
git commit -am "test(<name>): scenario audit across six axes (AC-G6, OI-019 n/12)"
```

**Any real defect found is fixed in the same slice and gets a ledger entry**, exactly as `guard.mjs`'s traversal bypass did. Expect defects: that is what this task is for, and finding none across eleven modules is a signal the records are shallow, not that the code is clean.

- [ ] **Step 6: After all eleven, the completeness gate**

```javascript
test("all twelve kernel modules have complete records", () => {
  const mods = fs.readdirSync("core").filter((f) => f.endsWith(".mjs") && !f.includes(".test."));
  assert.deepEqual(m.gate(mods.map((f) => `core/${f}`), readRecord, { knownTests }), []);
});
```

---

### Task 5: Property tests for every invariant

**Files:**
- Create: `tools/property.mjs`, `tools/property.test.mjs`
- Modify: the test file of each module in the invariant table

**Interfaces:**
- Produces: `forAll(gen, prop, { seed, runs = 200 })` — on failure throws with the
  seed and the failing case in the message.
- `mulberry32(seed)` — a five-line seeded PRNG. No dependency.

Invariant table, from the standard:

| Module | Invariant |
|---|---|
| `guard.mjs` | no input string resolves to a write outside `writeRoots` |
| `standing.mjs` | `(pid, startTime)` never matches a different console |
| `lane.mjs` | never more than `max` holders, for any interleaving |
| `budget.mjs` | band is monotonic in token count |
| `ledger.mjs` | append-only; no observable sequence loses or reorders a record |
| every store | `parse(write(x))` deep-equals `x` |

- [ ] **Step 1: Write the failing test for the harness itself**

```javascript
test("a property failure reports a reproducible seed and the failing case", () => {
  try {
    m.forAll(m.ints(0, 100), (n) => n !== 42, { seed: 7, runs: 500 });
    assert.fail("should have found n === 42");
  } catch (e) {
    assert.match(e.message, /seed=7/);
    assert.match(e.message, /42/);
  }
});

test("the same seed produces the same sequence", () => {
  const a = [], b = [];
  m.forAll(m.ints(0, 1e6), (n) => (a.push(n), true), { seed: 99, runs: 50 });
  m.forAll(m.ints(0, 1e6), (n) => (b.push(n), true), { seed: 99, runs: 50 });
  assert.deepEqual(a, b);
});
```

- [ ] **Step 2: Run to verify it fails**, implement, then:

- [ ] **Step 3: One property per invariant, one slice each**

Example, the one with the most history behind it:

```javascript
test("PROPERTY: no generated path resolves to a write outside writeRoots", () => {
  m.forAll(m.paths(), (p) => {
    const d = guard.decide({ tool: "Write", file_path: p });
    if (!d.allow) return true;
    return resolvedInsideAny(p, CONFIG.writeRoots);
  }, { seed: 1 });
});
```

`m.paths()` must generate traversals (`../`), mixed separators, unicode, URL-encoded segments, UNC prefixes and very long paths — the shapes the real bypass came from.

- [ ] **Step 4: Pin every failure found**

A property failure becomes a named regression test with the exact failing input, plus a ledger entry. The property stays.

- [ ] **Step 5: Commit per invariant**

```bash
git commit -am "test(<module>): property - <invariant> (AC-G8, AC-G9)"
```

---

### Task 6: Persistence, failure-recovery, stability and security tiers

**Files:**
- Create: `test/persistence.test.mjs`, `test/recovery.test.mjs`, `test/soak.mjs`, `test/security.test.mjs`

- [ ] **Step 6a: Persistence** (AC-G10, AC-G11, AC-G12)

```javascript
test("every store round-trips over generated content", () => {
  // scenariogate-ok: round-trip IS the behaviour under test for a store
  for (const store of STORES) {
    m.forAll(store.gen, (x) => deepEqual(store.parse(store.write(x)), x), { seed: 3 });
  }
});

test("a store survives a kill mid-write with no silent corruption", async () => {
  for (const store of STORES) {
    const child = spawn(process.execPath, ["-e", store.slowWriteScript]);
    await waitFor(() => fs.existsSync(store.path));
    child.kill("SIGKILL");
    assert.throws(() => store.load(), /corrupt|incomplete|unexpected/i,
      `${store.name} loaded a truncated file as if it were valid`);
  }
});

test("a corrupt store file fails loudly, never loads as empty", () => {
  for (const store of STORES) {
    fs.writeFileSync(store.path, "{not json");
    assert.throws(() => store.load(), /./, `${store.name} swallowed a corrupt file`);
  }
});
```

Loading a corrupt store as empty is the worst outcome: it looks like "no work to do".

- [ ] **Step 6b: Failure recovery** (AC-G13)

Kill each long-running process at each phase — autopilot, pty host, UI server, runner — and assert it converges to a **defined end state**, not merely "does not crash".

- [ ] **Step 6c: Long-running stability** (AC-G14)

```javascript
// node test/soak.mjs --hours 2     (on demand; output archived, never inferred)
// Bounds asserted: standing store entry count, log bytes, RSS.
// This tier is where the six accumulated stale orders would have been caught
// before Kyle noticed them.
```

- [ ] **Step 6d: Security negatives** (AC-G15)

Guardrails deny traversal; the UI refuses a foreign origin and a missing token; the runbox refuses what it should not run; **no secret reaches stdout or any log**. That last one is asserted by seeding a canary value into the vault and grepping every log and stdout after a full cycle.

Commit each sub-tier separately.

---

### Task 7: Finish `OI-025` — the 1/5 real-token run

**Files:**
- Modify: `e2e/loop.e2e.mjs`
- Modify: `OPEN-ISSUES.md`

**Interfaces:**
- Every scenario green, or re-classified with recorded evidence. AC-G16.

- [ ] **Step 1: Fix the stale label first**

Scenario 3 reports `OI-011` in its own output; the currently-open `OI-011` is an unrelated self-protection issue. A test that reports the wrong issue id sends the next reader to the wrong place. Correct it before running anything.

- [ ] **Step 2: Re-run the suite**

```bash
node e2e/loop.e2e.mjs 2>&1 | tee runbox/loop-e2e-$(git rev-parse --short HEAD).txt
```
15–20 minutes, real tokens. **Archive the output** — the previous run's archive was not committed and had to be regenerated.

- [ ] **Step 3: Take each failure to a conclusion**

- **Scenario 1** (over-budget clear/adopt/resume, timed out waiting for "cycle logged"): B2b and J both changed adoption. Re-run first; if it still fails, root-cause it.
- **Scenario 3** (Esc escalation, "(no clearbot log)"): the log path is now `watcher/autopilot.log` after J. Likely a stale path in the suite — fix the suite, do not weaken the wait.
- **Scenario 4** (typed `/cd` does not change cwd): this is `OI-003`, marked `[RESOLVED 2026-08-05]`. Re-run and confirm; if it fails, `OI-003` reopens.
- **Scenario 5**: whatever it reports, to a conclusion.

- [ ] **Step 4: Record the outcome**

Each scenario ends green, or re-classified with evidence and a ledger entry. **Not "flaky".**

- [ ] **Step 5: Close `OI-025` and commit**

---

### Task 8: Every repo carries the gate

**Files:**
- Modify: each of the six repos' `package.json` and CI workflow

- [ ] **Step 1: Write the failing test**

```javascript
test("every repo runs the scenario gate in CI", () => {
  for (const repo of REPOS) {
    const ci = fs.readFileSync(`${repo}/.github/workflows/ci.yml`, "utf8");
    assert.match(ci, /scenariogate/, `${repo} does not run the scenario gate`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**, wire each repo, run, then:

- [ ] **Step 3: Audit the non-kernel modules**

`standing`, `autopilot`, `lane`, `budget`, `usage`, `engine`, `tamper`, `traceability`, `runner`, the UI server. Same per-module cycle as Task 4. `OI-019` never listed these because they were outside the kernel, and they carry at least as much risk.

- [ ] **Step 4: Merge both worktrees**

```bash
git checkout main
git merge --no-ff acc/g-kernel-scenarios -m "merge: sub-project G, kernel scenario audits"
git merge --no-ff acc/g-rest -m "merge: sub-project G, remaining modules and tiers"
```

Close `OI-019` only when the gate is green across every repo with no module missing a record.

---

## Self-Review

**Spec coverage:** AC-G1..G4→T1, AC-G5→T2, AC-G6→T4, AC-G7→T2, AC-G8/G9→T5, AC-G10/G11/G12→T6a, AC-G13→T6b, AC-G14→T6c, AC-G15→T6d, AC-G16→T7, AC-G17→T3, AC-G18→T8. All eighteen covered.

**Placeholder scan:** Task 4 is eleven repetitions of one cycle rather than eleven written-out task bodies — deliberate, because the record must be written before the tests and enumerating the scenarios here would pre-empt the audit that is the entire point. Task 6c's soak script is described by its assertions rather than shown; the three bounds are named exactly.

**Type consistency:** `Problem = { kind, module, axis, detail }` across Tasks 1–4. `Answer` is the union fixed in Task 1. `Finding = { file, line, text }` in Task 3, matching J's `pathgate` and E's `uigate` — one finding shape across every gate in the programme.

**Ordering note:** Task 3's anti-trickery gate lands before Task 4's eleven audits, so every record written is checked by it from the start rather than retrofitted. Task 5's properties come after Task 4 because the audits surface which invariants are worth generating over.

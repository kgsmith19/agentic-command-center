# Sub-project I — Autonomy Posture and Tamper-Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Albert's real authority and make every use of it impossible to miss — so `AGENTS.md` stops claiming a boundary the system does not have, and a runbox script that edits a protected file is detected, attributed and reported within one autopilot cycle.

**Architecture:** `core/tamper.mjs` keeps a SHA-256 baseline of every `config.protected` path, hashes the baseline file into its own record so editing the baseline is itself detectable, and correlates findings against `watcher/approvals.log` to name the script responsible. Nothing blocks, nothing reverts, nothing re-baselines automatically. Detection that is provable beats prevention that is not.

**Tech Stack:** Node 20+ ESM, `node:crypto`, `node:test`, `node:assert/strict`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-acc-autonomy-posture-design.md` (14 ACs). Ledger: `OI-032`.
- Standard: `docs/superpowers/specs/2026-08-04-acc-standards-design.md`.
- Worktree: `git worktree add -b acc/i-tamper ../acc-i-tamper main` at the wave 3 boundary — **after J merges**. Runs concurrently with F and G-rest.
- Post-J names throughout: `core/`, `standing.mjs`, `autopilot.ps1`, `watcher/autopilot.log`.
- **Prevention is out of scope and must not creep in.** No blocking, no reverting, no script-text scanning. Kyle chose acceptance plus evidence, 2026-08-04, and the two preventive designs were rejected on the merits in the spec.
- Hashing is over **raw bytes**, never normalised text. This repo has been bitten by line endings before (`d8e7ed8` pinned `hooks/pre-push` to LF), and a CRLF-only change to a protected file is a real change.
- Performance budget: the check adds **under 50 ms** per autopilot cycle for the real protected set. Asserted, not assumed (AC-I11).
- `config.json` is added to its own protected list. The check must survive its own configuration being the thing that changed.
- Coverage floor: 100/100/90.

## File Structure

| File | Responsibility |
|---|---|
| `core/tamper.mjs` | baseline, check, attribute, accept. Pure functions plus a thin CLI. |
| `core/tamper.test.mjs` | unit + integration coverage |
| `e2e/tamper.e2e.mjs` | AC-I14 — the 2026-08-04 incident, replayed |
| `runner/state/tamper-baseline.json` | the baseline (gitignored — machine state) |
| `runner/logs/tamper.log` | append-only findings |
| `config.json` | widened `protected` list |
| `AGENTS.md` | the sentence that is currently false |

---

### Task 1: Baseline every protected path

**Files:**
- Create: `core/tamper.mjs`, `core/tamper.test.mjs`

**Interfaces:**
- Produces: `baseline(paths, io) -> BaselineRecord` where
  `BaselineRecord = { takenAt, reason, entries: { [path]: { sha256, bytes } | { missing: true } } }`.
  `io = { readBytes(path) -> Buffer|null, now() -> string }`.
- A path missing from disk records `{ missing: true }` — a finding later, never a crash.

- [ ] **Step 1: Write the failing test**

```javascript
// node --test core/tamper.test.mjs   (run from the repo root)
//
// OI-032: guard.mjs refused an agent's edit to settings.json, the agent wrote a
// runbox script as AGENTS.md instructs, and autopilot ran it 30s later with
// Kyle's authority - deleting the hook the guard had just protected. We keep the
// authority and make its use impossible to miss.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const m = await import("./tamper.mjs");

const io = (files) => ({
  readBytes: (p) => (p in files ? Buffer.from(files[p]) : null),
  now: () => "2026-08-04T23:00:00.000Z",
});
const sha = (s) => crypto.createHash("sha256").update(Buffer.from(s)).digest("hex");

test("baseline records a sha256 and byte length for every protected path", () => {
  const b = m.baseline(["a.json", "b.md"], io({ "a.json": "{}", "b.md": "hi" }));
  assert.equal(b.entries["a.json"].sha256, sha("{}"));
  assert.equal(b.entries["a.json"].bytes, 2);
  assert.equal(b.entries["b.md"].sha256, sha("hi"));
  assert.equal(b.takenAt, "2026-08-04T23:00:00.000Z");
});

test("a protected path missing from disk is recorded as missing, not a crash", () => {
  const b = m.baseline(["gone.json"], io({}));
  assert.deepEqual(b.entries["gone.json"], { missing: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test core/tamper.test.mjs`
Expected: FAIL — `Cannot find module './tamper.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// core/tamper.mjs — the record IS the control.
//
// With autoApprove on, an agent that can write a file is an agent that can run
// code with Kyle's authority (OI-032). Blocking that was rejected: text-scanning
// a script is assertion-on-configuration, and a restricted execution identity
// defeats the runbox's whole purpose. So: keep the authority, hash what it may
// touch, and make every change loud.
import crypto from "node:crypto";

const hash = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export function baseline(paths, io, reason = "initial") {
  const entries = {};
  for (const p of paths) {
    const buf = io.readBytes(p);
    entries[p] = buf === null ? { missing: true } : { sha256: hash(buf), bytes: buf.length };
  }
  return { takenAt: io.now(), reason, entries };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test core/tamper.test.mjs`
Expected: PASS, 2/2

- [ ] **Step 5: Commit**

```bash
git add core/tamper.mjs core/tamper.test.mjs
git commit -m "feat(tamper): sha256 baseline of every protected path (AC-I2, AC-I3)"
```

---

### Task 2: Detect changes, including to the baseline itself

**Files:**
- Modify: `core/tamper.mjs`, `core/tamper.test.mjs`

**Interfaces:**
- Consumes: `baseline` from Task 1.
- Produces: `seal(record) -> record` (adds `selfSha256`, the hash of the record
  with `selfSha256` removed) and
  `check(record, paths, io) -> Finding[]`,
  `Finding = { path, kind: "changed"|"appeared"|"disappeared"|"baseline-tampered", was, now }`.

Sealing is what stops the obvious evasion: change the file, then change the baseline to match. The seal makes that a second, separate finding.

- [ ] **Step 1: Write the failing test**

```javascript
test("modifying a protected file is a finding on the next check", () => {
  const b = m.seal(m.baseline(["a.json"], io({ "a.json": "{}" })));
  const f = m.check(b, ["a.json"], io({ "a.json": '{"changed":true}' }));
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "changed");
  assert.equal(f[0].path, "a.json");
});

test("a line-ending-only change is still a finding - bytes, not normalised text", () => {
  const b = m.seal(m.baseline(["a.md"], io({ "a.md": "one\ntwo\n" })));
  const f = m.check(b, ["a.md"], io({ "a.md": "one\r\ntwo\r\n" }));
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "changed");
});

test("an unchanged file produces no finding", () => {
  const b = m.seal(m.baseline(["a.json"], io({ "a.json": "{}" })));
  assert.deepEqual(m.check(b, ["a.json"], io({ "a.json": "{}" })), []);
});

test("a file that disappears, and one that appears, are both findings", () => {
  const b = m.seal(m.baseline(["a.json", "b.json"], io({ "a.json": "{}" })));
  const f = m.check(b, ["a.json", "b.json"], io({ "b.json": "{}" }));
  const kinds = Object.fromEntries(f.map((x) => [x.path, x.kind]));
  assert.equal(kinds["a.json"], "disappeared");
  assert.equal(kinds["b.json"], "appeared");
});

test("editing the baseline itself is a finding - the evasion is closed", () => {
  const b = m.seal(m.baseline(["a.json"], io({ "a.json": "{}" })));
  b.entries["a.json"].sha256 = sha('{"changed":true}');   // forge it to match
  const f = m.check(b, ["a.json"], io({ "a.json": '{"changed":true}' }));
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "baseline-tampered");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test core/tamper.test.mjs`
Expected: FAIL — `m.seal is not a function`

- [ ] **Step 3: Implement**

```javascript
export function seal(record) {
  const { selfSha256, ...rest } = record;
  return { ...rest, selfSha256: hash(Buffer.from(JSON.stringify(rest))) };
}

export function check(record, paths, io) {
  // The seal is verified FIRST. If the baseline was edited, every per-path
  // comparison below is meaningless, and reporting "all clean" from a forged
  // baseline is the worst output this file could produce.
  const { selfSha256, ...rest } = record;
  if (selfSha256 !== hash(Buffer.from(JSON.stringify(rest)))) {
    return [{ path: "<baseline>", kind: "baseline-tampered", was: selfSha256, now: null }];
  }
  const findings = [];
  for (const p of paths) {
    const was = record.entries[p];
    const buf = io.readBytes(p);
    if (!was) { findings.push({ path: p, kind: "appeared", was: null, now: buf && hash(buf) }); continue; }
    if (was.missing && buf) { findings.push({ path: p, kind: "appeared", was: null, now: hash(buf) }); continue; }
    if (was.missing && !buf) continue;
    if (!buf) { findings.push({ path: p, kind: "disappeared", was: was.sha256, now: null }); continue; }
    const now = hash(buf);
    if (now !== was.sha256) findings.push({ path: p, kind: "changed", was: was.sha256, now });
  }
  return findings;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test core/tamper.test.mjs`
Expected: PASS, 7/7

- [ ] **Step 5: Commit**

```bash
git add core/tamper.mjs core/tamper.test.mjs
git commit -m "feat(tamper): sealed baseline, byte-exact change detection (AC-I4, AC-I5, AC-I13)"
```

---

### Task 3: Attribute findings to approved runs

**Files:**
- Modify: `core/tamper.mjs`, `core/tamper.test.mjs`

**Interfaces:**
- Produces: `attribute(findings, approvals, { windowMs = 120000 }) -> Finding[]`
  with each finding gaining `attribution: { script, at } | null` and
  `unattributed: boolean`.
- `approvals` is parsed from `watcher/approvals.log`, which already records every
  auto-approved run with its script name and time.

An unattributed finding is the serious case — something changed a protected file and no approved run explains it — so it is labelled distinctly rather than lumped in.

- [ ] **Step 1: Write the failing test**

```javascript
const APPROVALS = `
2026-08-04 18:42:02 AUTO-APPROVE central:disable-route-hook.mjs -> OK
2026-08-04 19:10:00 AUTO-APPROVE central:something-else.mjs -> OK
`;

test("a finding inside an approved run's window names that script", () => {
  const f = m.attribute(
    [{ path: "settings.json", kind: "changed", at: "2026-08-04T18:42:30.000Z" }],
    m.parseApprovals(APPROVALS),
    { windowMs: 120000 });
  assert.equal(f[0].attribution.script, "central:disable-route-hook.mjs");
  assert.equal(f[0].unattributed, false);
});

test("a finding with no corresponding approved run is unattributed", () => {
  const f = m.attribute(
    [{ path: "settings.json", kind: "changed", at: "2026-08-04T23:59:00.000Z" }],
    m.parseApprovals(APPROVALS),
    { windowMs: 120000 });
  assert.equal(f[0].attribution, null);
  assert.equal(f[0].unattributed, true);
});

test("the nearest approved run wins when two are in range", () => {
  const f = m.attribute(
    [{ path: "x", kind: "changed", at: "2026-08-04T19:09:50.000Z" }],
    m.parseApprovals(APPROVALS),
    { windowMs: 3600000 });
  assert.equal(f[0].attribution.script, "central:something-else.mjs");
});
```

- [ ] **Step 2: Run to verify it fails**, implement `parseApprovals` + `attribute`, then:

- [ ] **Step 3: Run to verify it passes**

Run: `node --test core/tamper.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add core/tamper.mjs core/tamper.test.mjs
git commit -m "feat(tamper): attribute findings to approved runs, flag the unattributed (AC-I6, AC-I7)"
```

---

### Task 4: Findings never decay, and `accept` demands a reason

**Files:**
- Modify: `core/tamper.mjs`, `core/tamper.test.mjs`

**Interfaces:**
- Produces: `accept(record, paths, io, reason) -> BaselineRecord` — throws when
  `reason` is empty. Nothing else re-baselines, ever.

A system that silently accepts the new state detects nothing. This task is what makes the previous three worth having.

- [ ] **Step 1: Write the failing test**

```javascript
test("a finding is still reported on the second check - nothing decays", () => {
  const b = m.seal(m.baseline(["a.json"], io({ "a.json": "{}" })));
  const changed = io({ "a.json": '{"x":1}' });
  assert.equal(m.check(b, ["a.json"], changed).length, 1);
  assert.equal(m.check(b, ["a.json"], changed).length, 1, "must not self-heal");
});

test("accept re-baselines and records the reason", () => {
  const b = m.seal(m.baseline(["a.json"], io({ "a.json": "{}" })));
  const nb = m.accept(b, ["a.json"], io({ "a.json": '{"x":1}' }), "Kyle approved the hook change");
  assert.equal(m.check(nb, ["a.json"], io({ "a.json": '{"x":1}' })).length, 0);
  assert.equal(nb.reason, "Kyle approved the hook change");
});

test("accept without a reason is refused", () => {
  const b = m.seal(m.baseline(["a.json"], io({ "a.json": "{}" })));
  assert.throws(() => m.accept(b, ["a.json"], io({}), ""), /accept requires a reason/);
});
```

- [ ] **Step 2: Run to verify it fails**, implement, then:

- [ ] **Step 3: Run to verify it passes**, then commit

```bash
git add core/tamper.mjs core/tamper.test.mjs
git commit -m "feat(tamper): findings persist; accept --why is the only re-baseline (AC-I8, AC-I9)"
```

---

### Task 5: Widen `config.protected`

**Files:**
- Modify: `config.json`
- Modify: `core/guard.test.mjs` (in `agent-guardrails` post-J)

**Interfaces:**
- The protected set becomes: `~/.claude/settings.json`, `~/.claude/CLAUDE.md`,
  `C:/code/CLAUDE.md`, `C:/code/ROUTING.md`, each repo's `AGENTS.md`,
  `config.json`, `policy.json`, `~/.claude/skills/**`.

- [ ] **Step 1: Write the failing test**

```javascript
test("the guard refuses a direct agent edit to every protected path class", () => {
  for (const p of [
    "C:/Users/kyleg/.claude/settings.json",
    "C:/Users/kyleg/.claude/CLAUDE.md",
    "C:/code/CLAUDE.md",
    "C:/code/ROUTING.md",
    "C:/code/agentic-command-center/AGENTS.md",
    "C:/code/agentic-command-center/config.json",
    "C:/code/agentic-command-center/policy.json",
    "C:/Users/kyleg/.claude/skills/approve-kgs/SKILL.md",
  ]) {
    const d = g.decide({ tool: "Write", file_path: p });
    assert.equal(d.allow, false, `${p} must be protected`);
  }
});

test("config.json protecting itself still lets the check load it", () => {
  const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
  assert.ok(cfg.protected.some((p) => p.endsWith("config.json")),
    "config.json is in its own protected list");
  assert.ok(m.baseline(cfg.protected, realIo).entries[cfg.protected[0]],
    "the check reads its own config without recursing");
});
```

Match `g.decide`'s real signature from `core/guard.test.mjs` before writing this.

- [ ] **Step 2: Run to verify it fails**, add the paths to `config.json`, then:

- [ ] **Step 3: Run to verify it passes**, then commit

```bash
git add config.json core/guard.test.mjs
git commit -m "feat(guard): protect the rules that constrain agents, not just settings.json (AC-I12)"
```

---

### Task 6: Wire the check into the autopilot cycle and the statusline

**Files:**
- Modify: `watcher/autopilot.ps1`
- Modify: `core/tamper.mjs` (CLI: `check`, `accept --why`, `baseline`)
- Modify: `claude-session-telemetry`'s `statusline.mjs`
- Modify: `core/tamper.test.mjs`

**Interfaces:**
- `node core/tamper.mjs check` exits 0 when clean, 1 with findings, and appends
  every finding to `runner/logs/tamper.log`.
- The statusline reads the last line of `tamper.log` and renders a marker when
  the newest finding is unresolved.

- [ ] **Step 1: Write the failing performance test**

```javascript
test("the check adds under 50ms for the real protected set", () => {
  const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
  const b = m.seal(m.baseline(cfg.protected, realIo));
  const t0 = process.hrtime.bigint();
  m.check(b, cfg.protected, realIo);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, `check took ${ms.toFixed(1)}ms, budget is 50ms`);
});
```

- [ ] **Step 2: Write the failing integration test for the statusline**

```javascript
test("a finding appears in the statusline within one cycle", () => {
  fs.writeFileSync(LOG, JSON.stringify({
    at: "2026-08-04T23:00:00.000Z", path: "settings.json",
    kind: "changed", unattributed: true,
  }) + "\n");
  const out = execFileSync(process.execPath, ["statusline.mjs"], {
    input: JSON.stringify({ session_id: "x" }), encoding: "utf8",
    env: { ...process.env, ACC_TAMPER_LOG: LOG },
  });
  assert.match(out, /TAMPER/);
});
```

- [ ] **Step 3: Run both to verify they fail**, implement the CLI, the autopilot call and the statusline marker, then:

- [ ] **Step 4: Run to verify they pass**

Run: `node --test core/tamper.test.mjs`
Expected: PASS, all

- [ ] **Step 5: Take the real baseline and observe a clean check**

```bash
node core/tamper.mjs baseline --why "initial baseline, sub-project I"
node core/tamper.mjs check
```
Expected: exit 0. Paste into the commit body.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tamper): check each autopilot cycle, surface findings in the statusline (AC-I10, AC-I11)"
```

---

### Task 7: Make `AGENTS.md` true

**Files:**
- Modify: `AGENTS.md`
- Modify: `policy.json` (note recording Kyle's decision and its date)
- Modify: `core/tamper.test.mjs`

**Interfaces:**
- Produces: a grep gate asserting the retired sentence is gone and the honest one
  is present.

- [ ] **Step 1: Write the failing test**

```javascript
test("AGENTS.md no longer claims agents cannot edit the rules that constrain them", () => {
  const md = fs.readFileSync("AGENTS.md", "utf8");
  assert.doesNotMatch(md, /may not edit the rules that constrain (it|them)/i,
    "that sentence is false while autoApprove is on - OI-032");
  assert.match(md, /does not prevent an agent from asking the runbox/i);
  assert.match(md, /baselined, detected, and reported/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test core/tamper.test.mjs`
Expected: FAIL — the false sentence is still there.

- [ ] **Step 3: Replace the sentence**

```markdown
The guard prevents an agent from editing protected files **directly**. It does
not prevent an agent from asking the runbox to do it, and with
`autoApprove.enabled: true` the runbox will. Every such change is baselined,
detected, and reported (`node core/tamper.mjs check`, run each autopilot cycle
and surfaced in the statusline). This is a deliberate posture, decided by Kyle
on 2026-08-04: Albert holds real authority, and the record of its use is the
control.
```

Add the matching note to `policy.json` beside the existing 2026-07-31 one.

- [ ] **Step 4: Run to verify it passes**, then commit

```bash
git add AGENTS.md policy.json core/tamper.test.mjs
git commit -m "docs: state the real boundary instead of one we do not have (AC-I1, OI-032)"
```

---

### Task 8: Replay the 2026-08-04 incident end to end

**Files:**
- Create: `e2e/tamper.e2e.mjs`

**Interfaces:**
- The criterion that matters. An agent writes a runbox script that edits
  `settings.json`, autopilot runs it, and the change is reported as **attributed**
  within one cycle.

- [ ] **Step 1: Write the failing e2e**

```javascript
// node --test e2e/tamper.e2e.mjs
//
// AC-I14. This is the real 2026-08-04 incident, replayed: guard.mjs refuses a
// direct edit, the agent goes through the runbox as AGENTS.md instructs,
// autopilot auto-approves it, and the protected file changes. The system's job
// is to NOTICE this time. It runs against a sandboxed settings fixture and a
// sandboxed runbox - never the live ones.
test("a runbox script editing a protected file is detected and attributed", async () => {
  // 1. baseline the fixture
  execFileSync(process.execPath, ["core/tamper.mjs", "baseline", "--why", "e2e"],
    { env: { ...process.env, ACC_CONFIG: FIXTURE_CONFIG } });

  // 2. the guard refuses the direct edit
  const denied = guard.decide({ tool: "Write", file_path: FIXTURE_SETTINGS });
  assert.equal(denied.allow, false);

  // 3. the agent writes a runbox script instead, exactly as AGENTS.md instructs
  fs.writeFileSync(path.join(SANDBOX_RUNBOX, "edit-settings.mjs"),
    `// guards: e2e - edit the protected fixture\n` +
    `import fs from "node:fs";\n` +
    `fs.writeFileSync(${JSON.stringify(FIXTURE_SETTINGS)}, '{"hooks":{}}');\n`);

  // 4. autopilot auto-approves and runs it
  execFileSync(process.execPath, ["hooks/engine.mjs", "run", "edit-settings.mjs"],
    { env: { ...process.env, ACC_RUNBOX: SANDBOX_RUNBOX } });

  // 5. the check must notice, and must name the script
  const r = spawnSync(process.execPath, ["core/tamper.mjs", "check", "--json"],
    { env: { ...process.env, ACC_CONFIG: FIXTURE_CONFIG }, encoding: "utf8" });
  assert.equal(r.status, 1, "a changed protected file must exit non-zero");
  const findings = JSON.parse(r.stdout);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "changed");
  assert.equal(findings[0].unattributed, false);
  assert.match(findings[0].attribution.script, /edit-settings\.mjs/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test e2e/tamper.e2e.mjs`
Expected: FAIL — whichever wiring is missing. Record it.

- [ ] **Step 3: Fix the wiring until it passes**

Do not weaken the assertions. If attribution does not work against the real `approvals.log` format, fix `parseApprovals`, not the test.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test e2e/tamper.e2e.mjs`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
npm test && npx repo-gates
git add e2e/tamper.e2e.mjs
git commit -m "test(tamper): replay the 2026-08-04 incident end to end (AC-I14)"
```

---

### Task 9: Close `OI-032` and merge

- [ ] **Step 1: Full gate set**

```bash
npm test && npx repo-gates && node core/tamper.mjs check
```

- [ ] **Step 2: Close the ledger entry**

`## OI-032 [RESOLVED 2026-08-04] ...` with a `- resolved:` line recording: Kyle chose acceptance plus tamper-evidence; prevention rejected on the merits (text-scanning is assertion-on-configuration; a restricted identity defeats the runbox); `AGENTS.md` corrected; the protected set widened from 1 path to 8; the incident is replayed by `e2e/tamper.e2e.mjs`.

- [ ] **Step 3: Merge**

```bash
git checkout main
git merge --no-ff acc/i-tamper -m "merge: sub-project I, autonomy posture and tamper-evidence"
git worktree remove ../acc-i-tamper
```

---

## Self-Review

**Spec coverage:** AC-I1→T7, AC-I2/I3→T1, AC-I4→T2, AC-I5→T2, AC-I6/I7→T3, AC-I8/I9→T4, AC-I10→T6, AC-I11→T6, AC-I12→T5, AC-I13→T2, AC-I14→T8. All fourteen covered.

**Placeholder scan:** Tasks 3 and 4 say "implement" between a red test and a green one rather than showing the body — the tests fully specify `parseApprovals`, `attribute` and `accept`, which is the contract. Task 5's `g.decide` signature must be read from the real `core/guard.test.mjs` first; that is an instruction to check, not a deferred decision.

**Type consistency:** `BaselineRecord = { takenAt, reason, entries, selfSha256 }` fixed in Tasks 1–2 and used unchanged. `Finding = { path, kind, was, now }` from Task 2, extended by Task 3 with `attribution` and `unattributed` — extended, never reshaped. `io = { readBytes, now }` identical across all tasks.

**Scope discipline:** every task was checked against the spec's "prevention is out of scope". Task 5 widens what is *watched* and what the guard refuses **directly** — it adds no new blocking of the runbox lane, which is the line Kyle drew.

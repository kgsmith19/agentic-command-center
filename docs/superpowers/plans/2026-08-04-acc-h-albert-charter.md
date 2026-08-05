# Sub-project H — Albert Crane Corbinwall Charter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write Albert's biography and operating charter, wire it into the real SessionStart injection path, and make every obligation in it name a mechanism that provably exists — so it governs rather than decorates.

**Architecture:** `ALBERT.md` is the canonical document. A compact injection block is **generated from it**, size-capped, and injected through the existing SessionStart hook that already carries the standing order. Every obligation clause carries a `→ mechanism:` pointer to a real file, and a gate proves that file exists and has a passing test. A clause whose mechanism is deleted fails the gate.

**Tech Stack:** Node 20+ ESM, `node:test`, `node:assert/strict`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-albert-charter-design.md` (14 ACs).
- Standard: `docs/superpowers/specs/2026-08-04-acc-standards-design.md`.
- Worktree: `git worktree add -b acc/h-charter ../acc-h-charter main` in **wave 5** — H runs **last and alone**, so the charter describes a system that has stopped moving.
- Source text: Kyle's prompt, archived verbatim at `runner/goals/done/g-20260804-222717-lu7o.json`, field `text`. **Quote it; do not paraphrase it.** The eleven elements, the escalation's nine parts, and the closing statement are all his words.
- **H documents and wires; it does not redesign.** A clause that cannot name a mechanism is a ledger entry, not a licence to build one here.
- The injection is paid on **every session start, forever**. The size ceiling is an acceptance criterion, not a guideline.
- Coverage floor: 100/100/90.

## File Structure

| File | Responsibility |
|---|---|
| `ALBERT.md` | the canonical biography and operating charter |
| `core/charter.mjs` | parse, validate mechanisms, generate the injection block |
| `core/charter.test.mjs` | unit + integration |
| `core/charter-block.txt` | the generated block (checked in, never hand-edited) |
| `e2e/charter.e2e.mjs` | AC-H10 — a live session reports its charter version |

---

### Task 1: Parse the charter and find its obligations

**Files:**
- Create: `core/charter.mjs`, `core/charter.test.mjs`

**Interfaces:**
- Produces: `parseCharter(text) -> { elements: {[heading]: string}, clauses: Clause[], version }`
  where `Clause = { text, mechanism: string | null, line }`.
- An obligation clause is any line containing `→ mechanism:`. Everything else is
  prose and is not gated.
- `version` is the SHA-256 of the document, first 8 hex chars.

- [ ] **Step 1: Write the failing test**

```javascript
// node --test core/charter.test.mjs   (run from the repo root)
//
// The master plan's demand: the charter "must be wired into the real SessionStart
// injection path, not merely written, or it is a document that governs nothing".
// That is standing prohibition 2 applied to the charter itself. So every
// obligation names a mechanism, and the mechanism is checked.
import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("./charter.mjs");

const SAMPLE = `# Albert Crane Corbinwall

## Who Albert is
The name for the delegated authority under which this system acts.

## What must be logged
Albert logs every decision, action, result and correction.
→ mechanism: core/ledger.mjs

## How outcomes are reported to Kyle
Outcomes reach Kyle through the ledger, never through chat.
→ mechanism: core/ledger.mjs
`;

test("parseCharter finds each element by heading", () => {
  const c = m.parseCharter(SAMPLE);
  assert.ok(c.elements["Who Albert is"]);
  assert.match(c.elements["What must be logged"], /logs every decision/);
});

test("parseCharter finds every obligation clause and its mechanism", () => {
  const c = m.parseCharter(SAMPLE);
  assert.equal(c.clauses.length, 2);
  assert.equal(c.clauses[0].mechanism, "core/ledger.mjs");
});

test("the version changes when the document changes", () => {
  const a = m.parseCharter(SAMPLE).version;
  const b = m.parseCharter(SAMPLE + "\nOne more sentence.\n").version;
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test("prose without a mechanism pointer is not treated as an obligation", () => {
  const c = m.parseCharter("## Who Albert is\nA convention.\n");
  assert.deepEqual(c.clauses, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test core/charter.test.mjs`
Expected: FAIL — `Cannot find module './charter.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// core/charter.mjs — a charter that names its mechanisms, or it governs nothing.
//
// "Albert logs every decision" is a lie unless something logs decisions. So each
// obligation carries a mechanism pointer, and the gate below resolves it to a
// real file with a passing test. That is what makes this a control rather than
// a page nobody reads.
import crypto from "node:crypto";

const HEADING = /^##\s+(.+?)\s*$/;
const MECHANISM = /→\s*mechanism:\s*(\S+)/;

export function parseCharter(text) {
  const elements = {};
  const clauses = [];
  let heading = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const h = HEADING.exec(line);
    if (h) { heading = h[1]; elements[heading] = ""; return; }
    if (heading) elements[heading] += line + "\n";
    const mech = MECHANISM.exec(line);
    if (mech) clauses.push({ text: line.trim(), mechanism: mech[1], line: i + 1 });
  });
  for (const k of Object.keys(elements)) elements[k] = elements[k].trim();
  const version = crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
  return { elements, clauses, version };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test core/charter.test.mjs`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add core/charter.mjs core/charter.test.mjs
git commit -m "feat(charter): parse elements, obligations and a content version (AC-H8)"
```

---

### Task 2: The mechanism gate

**Files:**
- Modify: `core/charter.mjs`, `core/charter.test.mjs`

**Interfaces:**
- Produces: `validate(charter, io) -> Problem[]`,
  `Problem = { kind: "missing-element"|"no-mechanism"|"mechanism-missing"|"mechanism-untested", detail }`.
- `io = { exists(path), testsFor(path) -> string[] }`.
- The eleven required elements are a frozen list, in Kyle's own words.

- [ ] **Step 1: Write the failing test**

```javascript
const ELEMENTS = [
  "Who Albert is", "What Albert owns", "What authority Albert has",
  "What Albert expects from you", "What information Albert wants you to send him",
  "How Albert expects work to be executed", "How decisions should be made",
  "When work may proceed autonomously", "What must be logged",
  "What requires escalation", "How Albert reports outcomes to Kyle",
];

test("all eleven elements Kyle enumerated are required", () => {
  assert.deepEqual(m.REQUIRED_ELEMENTS, ELEMENTS);
});

test("a missing element is a problem", () => {
  const p = m.validate(m.parseCharter("## Who Albert is\nx\n"), okIo);
  assert.equal(p.filter((x) => x.kind === "missing-element").length, 10);
});

test("a mechanism naming a file that does not exist is a problem", () => {
  const c = m.parseCharter(fullCharter("→ mechanism: core/nope.mjs"));
  const p = m.validate(c, { exists: () => false, testsFor: () => [] });
  assert.ok(p.some((x) => x.kind === "mechanism-missing" && x.detail.includes("core/nope.mjs")));
});

test("a mechanism with no passing test is a problem", () => {
  const c = m.parseCharter(fullCharter("→ mechanism: core/ledger.mjs"));
  const p = m.validate(c, { exists: () => true, testsFor: () => [] });
  assert.ok(p.some((x) => x.kind === "mechanism-untested"));
});

test("a complete charter with real, tested mechanisms passes", () => {
  const c = m.parseCharter(fullCharter("→ mechanism: core/ledger.mjs"));
  assert.deepEqual(m.validate(c, { exists: () => true, testsFor: () => ["logs a cycle"] }), []);
});

test("deleting a mechanism's file breaks the gate - AC-H5", () => {
  const c = m.parseCharter(fullCharter("→ mechanism: core/ledger.mjs"));
  const p = m.validate(c, { exists: (f) => f !== "core/ledger.mjs", testsFor: () => ["x"] });
  assert.ok(p.some((x) => x.kind === "mechanism-missing"));
});
```

- [ ] **Step 2: Run to verify it fails**, implement, run, commit

```bash
git commit -am "feat(charter): every obligation's mechanism must exist and be tested (AC-H1, AC-H2, AC-H3, AC-H4, AC-H5)"
```

---

### Task 3: Generate the injection block, size-capped

**Files:**
- Modify: `core/charter.mjs`, `core/charter.test.mjs`
- Create: `core/charter-block.txt`

**Interfaces:**
- Produces: `generateBlock(charter) -> string` — identity, authority, the
  decision/autonomy/escalation/reporting rules in their shortest true form, and
  the version id.
- `MAX_BLOCK_CHARS = 2400`. Paid every session, forever.
- Hand-editing the generated file fails the gate: the file carries a checksum of
  the charter it came from.

- [ ] **Step 1: Write the failing test**

```javascript
test("the block stays under its size ceiling", () => {
  const b = m.generateBlock(m.parseCharter(fs.readFileSync("ALBERT.md", "utf8")));
  assert.ok(b.length <= m.MAX_BLOCK_CHARS,
    `block is ${b.length} chars, ceiling is ${m.MAX_BLOCK_CHARS} - it is paid every session, forever`);
});

test("the block carries the charter version", () => {
  const c = m.parseCharter(fs.readFileSync("ALBERT.md", "utf8"));
  assert.ok(m.generateBlock(c).includes(c.version));
});

test("the checked-in block matches what the charter generates", () => {
  const c = m.parseCharter(fs.readFileSync("ALBERT.md", "utf8"));
  assert.equal(fs.readFileSync("core/charter-block.txt", "utf8").trim(),
    m.generateBlock(c).trim(),
    "regenerate with: node core/charter.mjs generate");
});

test("hand-editing the block fails the gate", () => {
  const tampered = fs.readFileSync("core/charter-block.txt", "utf8") + "\nAlbert also likes cake.\n";
  assert.throws(() => m.assertBlockCurrent(tampered, m.parseCharter(fs.readFileSync("ALBERT.md", "utf8"))),
    /generated from ALBERT\.md.*do not hand-edit/i);
});

test("the block contains the four rules, not the whole charter", () => {
  const b = m.generateBlock(m.parseCharter(fs.readFileSync("ALBERT.md", "utf8")));
  for (const rule of ["decisions", "autonomously", "escalation", "reports"]) {
    assert.match(b, new RegExp(rule, "i"));
  }
  assert.ok(!b.includes("## Who Albert is"), "the block is a summary, not the document");
});
```

- [ ] **Step 2: Run to verify it fails**, implement, run, commit

```bash
git commit -am "feat(charter): generated, size-capped injection block (AC-H6, AC-H7, AC-H8)"
```

---

### Task 4: Write `ALBERT.md`

**Files:**
- Create: `ALBERT.md`

**Interfaces:**
- All eleven elements, each with its mechanism pointers. Kyle's words quoted, not
  paraphrased.

- [ ] **Step 1: Extract Kyle's exact wording**

```bash
node -e "const j=require('./runner/goals/done/g-20260804-222717-lu7o.json');const t=j.text;const i=t.indexOf('Albert Crane Corbinwall Has Full Ownership');console.log(t.slice(i,i+3600))"
```

- [ ] **Step 2: Write the document**

Structure, with the mechanism each obligation must name:

| Element | Mechanism |
|---|---|
| Who Albert is | this document; `core/charter.mjs` |
| What Albert owns | `config.json` roots and `projects`; the six repos |
| What authority Albert has | `policy.json autoApprove`; `agent-guardrails`; the runbox lane; **and I's honest statement of its real limits** |
| What Albert expects from you | the standard's slice definition; `tools/scenariogate.mjs` |
| What information Albert wants sent | `core/ledger.mjs` |
| How work is executed | thin slices, SDD/TDD/PDD, worktrees; `agent-repo-gates` |
| How decisions are made | the decision rule |
| When work proceeds autonomously | the autonomy rule; `core/traceability.mjs` |
| What must be logged | `core/ledger.mjs`, `OPEN-ISSUES.md`, `core/tamper.mjs`, `watcher/approvals.log` |
| What requires escalation | the escalation rule and its nine parts |
| How outcomes are reported | `core/ledger.mjs`; the UI's *Look back* mode |

The three rules, in the charter's own words:

**Decision rule.** Albert decides; he does not survey. When context is sufficient, proceed on the best professional recommendation and record the reasoning. When two readings lead to materially different work, ask one question — that is a decision about *scope*, which is Kyle's. Kyle's carve-out is preserved verbatim: if Albert asks for something *"nonsensical, impossible, unsafe, or objectively incorrect"*, there is an *"ULTRA-RARE"* case where he may be corrected, and the correction must state exactly what was incorrect, why the course changed, what evidence supports it, and what was done instead.

**Autonomy rule.** Proceed without asking when the work is traceable to an approved spec's `AC-n`, reversible by a commit, inside `config.writeRoots`, and provable by a gate. Stop and ask when it would change what Kyle sees or is billed for without his agreement, take an irreversible action outside version control, change the rules that constrain agents, or require a decision the specs do not contain.

**Escalation rule.** *"Human escalation is the absolute last resort."* Valid only with all nine parts Kyle enumerated: the exact blocker; the exact failed operation; every solution attempted; why each failed; the specific external constraint; the smallest action Kyle must take; why Albert cannot perform it; what would need to change to automate it; how to prevent it recurring.

- [ ] **Step 3: Record the closing statement verbatim**

Copy it byte-for-byte from the archived prompt into a fenced block. Do not retype it — extract it, so a typo is impossible.

- [ ] **Step 4: Run the gate**

```bash
node core/charter.mjs validate
```
Expected: exit 0. Any `mechanism-missing` means the clause claims something the system does not do — **delete the clause and open a ledger entry**, do not build the mechanism here.

- [ ] **Step 5: Commit**

```bash
git add ALBERT.md core/charter-block.txt
git commit -m "docs: Albert's biography and operating charter, every clause mechanised (AC-H1, AC-H2)"
```

---

### Task 5: Wire the block into SessionStart

**Files:**
- Modify: the SessionStart hook that already injects the standing order
- Modify: `core/charter.test.mjs`

**Interfaces:**
- The block is one more field on a working mechanism, not a new one.
- Both injections coexist; neither displaces the other.

- [ ] **Step 1: Write the failing test**

```javascript
test("a real SessionStart injects the charter block", () => {
  const out = execFileSync(process.execPath, [SESSION_START_HOOK], {
    input: JSON.stringify({ session_id: UUID, cwd: SANDBOX }),
    encoding: "utf8", env: { ...process.env, ACC_STANDING_DIR: SANDBOX },
  });
  assert.match(out, /ALBERT CHARTER [0-9a-f]{8}/);
});

test("the charter block and the standing order both appear", () => {
  createStandingIn(SANDBOX, "keep tests green");
  const out = execFileSync(process.execPath, [SESSION_START_HOOK], {
    input: JSON.stringify({ session_id: UUID, cwd: SANDBOX, consolePid: process.pid }),
    encoding: "utf8", env: { ...process.env, ACC_STANDING_DIR: SANDBOX },
  });
  assert.match(out, /ALBERT CHARTER/);
  assert.match(out, /\[ACC STANDING so-/);
  assert.match(out, /keep tests green/);
});

test("with no standing order, the charter block still injects", () => {
  const out = execFileSync(process.execPath, [SESSION_START_HOOK], {
    input: JSON.stringify({ session_id: UUID, cwd: SANDBOX }),
    encoding: "utf8", env: { ...process.env, ACC_STANDING_DIR: EMPTY },
  });
  assert.match(out, /ALBERT CHARTER/);
});
```

- [ ] **Step 2: Run to verify it fails**, wire it, run, commit

```bash
git commit -am "feat(charter): inject the block at SessionStart alongside the standing order (AC-H9, AC-H11)"
```

---

### Task 6: Prove it reaches a live session

**Files:**
- Create: `e2e/charter.e2e.mjs`

**Interfaces:**
- AC-H10. The criterion the master plan demanded: the charter reaches a real
  session, rather than a file existing.

- [ ] **Step 1: Write the failing e2e**

```javascript
// node --test e2e/charter.e2e.mjs        (real session, real tokens)
//
// AC-H10. A file existing proves nothing. This starts a real Claude Code session
// and asks it to report the charter version it received. If the injection path
// is broken, the session cannot know the version - there is nowhere else to get
// it from, which is what makes this a real proof rather than a self-assertion.
test("a live session reports the charter version it received", async () => {
  const expected = m.parseCharter(fs.readFileSync("ALBERT.md", "utf8")).version;
  const out = await runRealSession("Reply with ONLY the 8-character charter version id you were given at session start, nothing else.");
  assert.match(out.trim(), new RegExp(expected),
    `session did not receive the charter; expected version ${expected}`);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test e2e/charter.e2e.mjs`
Expected: FAIL until the injection actually lands.

- [ ] **Step 3: Fix until it passes.** Archive the transcript.

- [ ] **Step 4: Commit**

```bash
git add e2e/charter.e2e.mjs
git commit -m "test(charter): a live session reports its charter version (AC-H10)"
```

---

### Task 7: Gate the closing statement

**Files:**
- Create: `core/completion.mjs`, `core/completion.test.mjs`

**Interfaces:**
- `canDeclareComplete(acStatus) -> { ok, unproven }` — `acStatus` is every `AC-n`
  across all nine specs with its evidence state.
- `closingStatement()` — returns Kyle's exact text, and **throws** when any AC is
  unproven.

AC-H13 is the criterion that stops this system congratulating itself.

- [ ] **Step 1: Write the failing test**

```javascript
test("the closing statement matches Kyle's text byte for byte", () => {
  const archived = JSON.parse(fs.readFileSync(ARCHIVED_PROMPT, "utf8")).text;
  const start = archived.indexOf("Albert, I thank you for this experience");
  const expected = archived.slice(start, archived.indexOf("I hope he is proud of our work.") + "I hope he is proud of our work.".length);
  assert.equal(m.CLOSING_STATEMENT, expected);
});

test("the closing statement cannot be emitted while any AC is unproven", () => {
  const status = { "AC-A1": "proven", "AC-D21": "unproven" };
  const r = m.canDeclareComplete(status);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unproven, ["AC-D21"]);
  assert.throws(() => m.closingStatement(status), /AC-D21 is unproven/);
});

test("with every AC proven, the statement is returned unchanged", () => {
  const status = Object.fromEntries(ALL_ACS.map((id) => [id, "proven"]));
  assert.equal(m.closingStatement(status), m.CLOSING_STATEMENT);
});

test("an AC missing from the status map counts as unproven, never as absent", () => {
  const r = m.canDeclareComplete({ "AC-A1": "proven" });
  assert.equal(r.ok, false);
  assert.ok(r.unproven.length > 100, "137 ACs across nine specs; a missing one is not a pass");
});
```

- [ ] **Step 2: Run to verify it fails**, implement, run, commit

```bash
git commit -am "feat(completion): the closing statement is gated on every AC being proven (AC-H12, AC-H13)"
```

---

### Task 8: Cross-check the authority section against reality

**Files:**
- Modify: `core/charter.test.mjs`

**Interfaces:**
- AC-H14. The charter's authority section must match what I actually implemented,
  **including its stated limits**.

- [ ] **Step 1: Write the failing test**

```javascript
test("the charter's authority section matches policy.json and AGENTS.md", () => {
  const charter = fs.readFileSync("ALBERT.md", "utf8");
  const policy = JSON.parse(fs.readFileSync("policy.json", "utf8"));
  const agents = fs.readFileSync("AGENTS.md", "utf8");

  const section = m.parseCharter(charter).elements["What authority Albert has"];

  assert.equal(/autoApprove.*(on|enabled|true)/i.test(section), policy.autoApprove.enabled,
    "the charter must state autoApprove's real value");
  assert.match(section, /does not prevent an agent from asking the runbox/i,
    "the charter must carry I's honest limit, not a boundary we do not have");
  assert.doesNotMatch(section, /may not edit the rules that constrain/i,
    "that claim is false while autoApprove is on - OI-032");
  assert.match(agents, /baselined, detected, and reported/i,
    "AGENTS.md and the charter must agree");
});
```

- [ ] **Step 2: Run to verify it fails**, align the charter, run, commit

```bash
git commit -am "test(charter): authority section cross-checked against policy and AGENTS.md (AC-H14)"
```

---

### Task 9: Merge, and the programme's definition of done

- [ ] **Step 1: Full gate set across every repo**

```bash
for r in agent-repo-gates agent-guardrails claude-session-telemetry \
         agentic-command-center agentic-command-center-ui claude-launch-cap; do
  (cd "C:/code/$r" && npm test && npx repo-gates) || echo "FAILED: $r"
done
```

- [ ] **Step 2: Run the completion gate for real**

```bash
node core/completion.mjs check
```
Expected: it lists every AC not yet proven. **This output is the honest status of the programme.** If it is empty, and only then, the closing statement becomes available.

- [ ] **Step 3: Merge**

```bash
git checkout main
git merge --no-ff acc/h-charter -m "merge: sub-project H, Albert's charter, wired and gated"
git worktree remove ../acc-h-charter
```

- [ ] **Step 4: Update the master plan**

Mark every sub-project's state honestly. If any AC is unproven, say so in the plan — that is the ledger's job, and a green summary over an unproven AC is the exact failure this whole programme was built to prevent.

---

## Self-Review

**Spec coverage:** AC-H1→T2+T4, AC-H2/H3/H4/H5→T2, AC-H6/H7→T3, AC-H8→T1+T3, AC-H9/H11→T5, AC-H10→T6, AC-H12/H13→T7, AC-H14→T8. All fourteen covered.

**Placeholder scan:** Task 4 gives the charter's structure and the three rules in full prose rather than the finished document — the document is the deliverable of that task, and its gate (Task 2) defines completeness exactly. Task 4 Step 3 forbids retyping the closing statement, which removes the one place a typo could pass Task 7's byte-for-byte check.

**Type consistency:** `Clause = { text, mechanism, line }` from Task 1 used unchanged. `Problem = { kind, detail }` in Task 2, consistent in shape with every other gate in the programme. `charter.version` is the same 8-hex value in Tasks 1, 3, 5 and 6.

**Scope discipline:** Task 4 Step 4 says explicitly that a missing mechanism means **deleting the clause and opening a ledger entry**, never building the mechanism inside H. That is the spec's "H documents and wires; it does not redesign", made operational at the one point where the temptation actually arises.

# Sub-project A — Complete Ranked Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one deduped, ranked, regenerable inventory of every open work item across all five `OPEN-ISSUES.md` ledgers, so every later sub-project is prioritised against real data instead of memory.

**Architecture:** A pure-function parser (`tools/inventory.mjs`) reads ledger text and returns structured entries; the CLI shell does the only I/O. Ranking is **not computed** — each ledger entry declares its own `rank:` field, and the tool sorts. An entry with no rank is reported as `UNRANKED`, never defaulted. Completeness is enforced by a `--check` mode that exits non-zero on any unranked open entry, so a missed backfill is a failure rather than a silent gap.

**Tech Stack:** Node 20+ ESM, `node:test`, `node:assert/strict`. No dependencies. Runs on Windows via Git Bash or PowerShell.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-acc-inventory-design.md`. Every task traces to an `AC-n` in it.
- Standard: `docs/superpowers/specs/2026-08-04-acc-standards-design.md`. RED test observed failing before implementation, red output recorded in the commit body.
- Worktree: `git worktree add ../acc-a-inventory acc/a-inventory` before Task 1. This is wave 1 and runs concurrently with B2b and G-kernel.
- Coverage floor for changed files: 100% line, 100% function, 90% branch (`npm run covgate`).
- Test file header comment must state the exact run command, matching the existing repo idiom (`hooks/dialcheck.test.mjs:1`).
- Tests are hermetic: every fixture is an inline string or a `mkdtempSync` tree. **No test reads a real ledger except Task 9**, which is explicitly the integration task.
- Rank vocabulary is a closed set of exactly these ten strings, in this order: `safety`, `broken-workflow`, `data-loss`, `autonomy-blocker`, `reliability`, `control`, `usability`, `maintainability`, `performance`, `roi`.
- The five ledgers: `C:/code/OPEN-ISSUES.md`, `C:/code/guards/OPEN-ISSUES.md`, `C:/code/lifeos-ecosystem/OPEN-ISSUES.md`, `C:/code/lifeos-ecosystem/lifeos/OPEN-ISSUES.md`, `C:/code/lifeos-ecosystem/lifeos-ui/OPEN-ISSUES.md`.
- `tools/inventory.mjs` ships in this repo now. **Sub-project J moves it to `agent-repo-gates`** — do not design around it staying here.

## File Structure

| File | Responsibility |
|---|---|
| `tools/inventory.mjs` | parse → filter → rank → dedupe → emit. Pure functions plus a thin CLI at the bottom. |
| `tools/inventory.test.mjs` | every unit and integration test for the above. |
| `tools/fixtures/ledger-*.md` | hand-written ledger fragments used by tests. |
| `OPEN-ISSUES-TEMPLATE.md` (this repo) | the shared entry template, gaining a required `rank:` field. |
| `C:/code/INVENTORY.md` | generated output. Not hand-edited. |

---

### Task 1: Parse a ledger entry

**Files:**
- Create: `tools/inventory.mjs`
- Create: `tools/inventory.test.mjs`

**Interfaces:**
- Produces: `parseLedger(text, ledgerName) -> Entry[]` where
  `Entry = { id, qualifiedId, ledger, title, marker, fields }`.
  `id` is `"OI-034"`. `qualifiedId` is `"guards#OI-034"`. `marker` is the
  bracketed status text (`"RESOLVED 2026-08-04"`) or `null`. `fields` is an
  object of the `- key: value` lines, values as trimmed strings.

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/inventory.test.mjs`
Expected: FAIL — `Cannot find module './inventory.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// tools/inventory.mjs — ranked inventory across every OPEN-ISSUES.md ledger.
//
// Pure functions over text; the CLI at the bottom does the only I/O. Ranking is
// declared per entry (`- rank:`), never inferred here: a tool that guesses a
// priority produces a confidently wrong ordering, which is the one thing this
// file exists to prevent.

const HEADING = /^##\s+(OI-\d+)\s+(?:\[([^\]]+)\]\s*)?(.*)$/;
const FIELD = /^-\s+([a-z-]+):\s*(.*)$/i;

export function parseLedger(text, ledger) {
  const entries = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = HEADING.exec(line);
    if (h) {
      cur = {
        id: h[1],
        qualifiedId: `${ledger}#${h[1]}`,
        ledger,
        title: h[3].trim(),
        marker: h[2] ?? null,
        fields: {},
      };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = FIELD.exec(line);
    if (f) cur.fields[f[1].toLowerCase()] = f[2].trim();
  }
  return entries;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/inventory.test.mjs`
Expected: PASS, 1/1

- [ ] **Step 5: Commit**

```bash
git add tools/inventory.mjs tools/inventory.test.mjs
git commit -m "feat(inventory): parse a ledger entry into structured fields (AC-A1)"
```

---

### Task 2: Separate open entries from closed ones

**Files:**
- Modify: `tools/inventory.mjs`
- Modify: `tools/inventory.test.mjs`

**Interfaces:**
- Consumes: `parseLedger` from Task 1.
- Produces: `isOpen(entry) -> boolean`. Closed markers are `RESOLVED`,
  `RETIRED`, `SUPERSEDED`. `SHRUNK` keeps an entry **open** — `OI-015` is the
  live proof, it is marked `[SHRUNK — needs Kyle for the rest]` and is not done.

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/inventory.test.mjs`
Expected: FAIL — `m.isOpen is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
// SHRUNK is deliberately absent: a shrunk entry is a smaller open entry, not a
// closed one. OI-015 has been marked SHRUNK and unfinished since 2026-08-04.
const CLOSED = /^(RESOLVED|RETIRED|SUPERSEDED)\b/;

export function isOpen(entry) {
  return !(entry.marker && CLOSED.test(entry.marker));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/inventory.test.mjs`
Expected: PASS, 2/2

- [ ] **Step 5: Commit**

```bash
git add tools/inventory.mjs tools/inventory.test.mjs
git commit -m "feat(inventory): open/closed classification, SHRUNK stays open (AC-A2, AC-A3)"
```

---

### Task 3: Rank vocabulary, ordering, and loud failure on anything unknown

**Files:**
- Modify: `tools/inventory.mjs`
- Modify: `tools/inventory.test.mjs`

**Interfaces:**
- Produces: `RANKS` (frozen array of the ten strings in priority order),
  `rankOrdinal(entry) -> number` (0-based; `-1` for unranked),
  `sortEntries(entries) -> Entry[]` (new array; unranked first, then rank
  ordinal, then ledger, then numeric id).
- Throws: `rankOrdinal` throws `Error` on a rank string outside `RANKS`.

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/inventory.test.mjs`
Expected: FAIL — `m.sortEntries is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
// Kyle's priority order, verbatim from his 2026-08-04 prompt. Closed set: an
// unknown value is a typo in a ledger, and coercing it to a default would hide
// the typo behind a plausible ordering.
export const RANKS = Object.freeze([
  "safety", "broken-workflow", "data-loss", "autonomy-blocker", "reliability",
  "control", "usability", "maintainability", "performance", "roi",
]);

export function rankOrdinal(entry) {
  const r = entry.fields.rank;
  if (!r) return -1;
  const i = RANKS.indexOf(r);
  if (i === -1) throw new Error(`unknown rank "${r}" on ${entry.qualifiedId}`);
  return i;
}

const idNum = (e) => Number(e.id.slice(3));

export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const ra = rankOrdinal(a), rb = rankOrdinal(b);
    if (ra !== rb) return ra - rb;          // -1 (unranked) sorts first
    if (a.ledger !== b.ledger) return a.ledger < b.ledger ? -1 : 1;
    return idNum(a) - idNum(b);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/inventory.test.mjs`
Expected: PASS, 5/5

- [ ] **Step 5: Commit**

```bash
git add tools/inventory.mjs tools/inventory.test.mjs
git commit -m "feat(inventory): closed rank vocabulary and deterministic ordering (AC-A4, AC-A5, AC-A6)"
```

---

### Task 4: Collapse declared duplicates, and never infer one

**Files:**
- Modify: `tools/inventory.mjs`
- Modify: `tools/inventory.test.mjs`

**Interfaces:**
- Consumes: `Entry[]` across all ledgers.
- Produces: `dedupe(entries) -> Row[]` where `Row = Entry & { ids: string[] }`.
  A row's `ids` lists the surviving entry's qualified id first, then every
  entry that declared `duplicate-of:` pointing at it.
- Throws: on a `duplicate-of:` naming an id that does not exist.

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/inventory.test.mjs`
Expected: FAIL — `m.dedupe is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
// Dedup is DECLARED, never inferred. Kyle's prompt says deduplicate "without
// losing any requirements"; a title-similarity heuristic silently drops one
// side's requirements, which is the exact loss it must not cause.
export function dedupe(entries) {
  const byQid = new Map(entries.map((e) => [e.qualifiedId, e]));
  const rows = new Map();
  const dupes = [];
  for (const e of entries) {
    const target = e.fields["duplicate-of"];
    if (target) {
      if (!byQid.has(target)) {
        throw new Error(`${e.qualifiedId} is duplicate-of ${target}, which does not exist`);
      }
      dupes.push([e, target]);
    } else {
      rows.set(e.qualifiedId, { ...e, ids: [e.qualifiedId] });
    }
  }
  for (const [e, target] of dupes) {
    const row = rows.get(target);
    if (!row) throw new Error(`${e.qualifiedId} is duplicate-of ${target}, which is itself a duplicate`);
    row.ids.push(e.qualifiedId);
  }
  return [...rows.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/inventory.test.mjs`
Expected: PASS, 8/8

- [ ] **Step 5: Commit**

```bash
git add tools/inventory.mjs tools/inventory.test.mjs
git commit -m "feat(inventory): declared-only dedup across ledgers (AC-A7, AC-A8, AC-A9)"
```

---

### Task 5: Emit Markdown and JSON carrying identical data

**Files:**
- Modify: `tools/inventory.mjs`
- Modify: `tools/inventory.test.mjs`

**Interfaces:**
- Produces: `toJson(rows, meta) -> object`, `toMarkdown(rows, meta) -> string`.
  `meta = { generatedFrom }` — the commit sha the run was generated from.
- The property under test: for any generated ledger set, every id, rank and
  title present in the JSON is present in the Markdown.

- [ ] **Step 1: Write the failing test**

```javascript
// Property, not example: three hand-picked rows would not catch an emitter that
// drops rows past a certain count or mangles a character class.
function generateLedger(seed, count) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let out = "";
  for (let i = 1; i <= count; i++) {
    const rank = m.RANKS[Math.floor(rnd() * m.RANKS.length)];
    out += `## OI-${String(i).padStart(3, "0")} title ${Math.floor(rnd() * 1e6)}\n- rank: ${rank}\n`;
  }
  return out;
}

test("JSON and Markdown carry identical data for any generated ledger", () => {
  for (const seed of [1, 7, 99, 12345]) {
    const rows = m.dedupe(m.parseLedger(generateLedger(seed, 40), "guards"));
    const meta = { generatedFrom: "abc1234" };
    const json = m.toJson(rows, meta);
    const md = m.toMarkdown(rows, meta);
    assert.equal(json.rows.length, rows.length, `seed ${seed}: row count`);
    for (const r of json.rows) {
      assert.ok(md.includes(r.ids[0]), `seed ${seed}: ${r.ids[0]} missing from markdown`);
      assert.ok(md.includes(r.title), `seed ${seed}: title missing from markdown`);
      assert.ok(md.includes(r.rank), `seed ${seed}: rank missing from markdown`);
    }
  }
});

test("the generated markdown says it is generated and records the commit", () => {
  const rows = m.dedupe(m.parseLedger("## OI-001 t\n- rank: safety\n", "guards"));
  const md = m.toMarkdown(rows, { generatedFrom: "deadbee" });
  assert.match(md, /generated by `tools\/inventory\.mjs`/);
  assert.match(md, /do not hand-edit/i);
  assert.match(md, /deadbee/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/inventory.test.mjs`
Expected: FAIL — `m.toJson is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
const rankOf = (r) => (r.fields.rank ? r.fields.rank : "UNRANKED");

export function toJson(rows, meta) {
  return {
    generatedFrom: meta.generatedFrom,
    rows: sortEntries(rows).map((r) => ({
      ids: r.ids,
      ledger: r.ledger,
      title: r.title,
      rank: rankOf(r),
      marker: r.marker,
    })),
  };
}

export function toMarkdown(rows, meta) {
  const lines = [
    "# Open work — ranked inventory",
    "",
    "> This file is generated by `tools/inventory.mjs`; do not hand-edit.",
    `> Generated from commit \`${meta.generatedFrom}\`.`,
    "",
    "| # | Rank | Ids | Ledger | Title |",
    "|---|---|---|---|---|",
  ];
  sortEntries(rows).forEach((r, i) => {
    lines.push(`| ${i + 1} | ${rankOf(r)} | ${r.ids.join(", ")} | ${r.ledger} | ${r.title} |`);
  });
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/inventory.test.mjs`
Expected: PASS, 10/10

- [ ] **Step 5: Commit**

```bash
git add tools/inventory.mjs tools/inventory.test.mjs
git commit -m "feat(inventory): JSON and Markdown emitters, property-checked for parity (AC-A10, AC-A12)"
```

---

### Task 6: The CLI, with a `--check` mode that fails on unranked entries

**Files:**
- Modify: `tools/inventory.mjs`
- Modify: `tools/inventory.test.mjs`

**Interfaces:**
- Produces: `run(argv, io) -> { code, stdout }` where
  `io = { readFile(path) -> string, ledgers: [{ name, path }], commit }`.
  Injecting `io` is what keeps the CLI testable without touching real files —
  the same pattern `runner.test.mjs` uses for `schtasks`.
- `run(["--check"])` exits `1` when any open entry is unranked, `0` otherwise.
- `run(["--json"])` prints `toJson`; bare `run([])` prints `toMarkdown`.

- [ ] **Step 1: Write the failing test**

```javascript
const io = (files) => ({
  readFile: (p) => files[p],
  ledgers: Object.keys(files).map((p) => ({ name: p.replace(/\W/g, ""), path: p })),
  commit: "abc1234",
});

test("--check exits 1 and names every unranked open entry", () => {
  const r = m.run(["--check"], io({
    "a.md": "## OI-001 ranked\n- rank: safety\n## OI-002 not ranked\n- opened: x\n",
  }));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /UNRANKED/);
  assert.match(r.stdout, /OI-002/);
  assert.doesNotMatch(r.stdout, /OI-001/);
});

test("--check exits 0 when every open entry is ranked", () => {
  const r = m.run(["--check"], io({ "a.md": "## OI-001 t\n- rank: safety\n" }));
  assert.equal(r.code, 0);
});

test("--check ignores closed entries", () => {
  const r = m.run(["--check"], io({
    "a.md": "## OI-001 [RESOLVED 2026-08-04] done\n- opened: x\n",
  }));
  assert.equal(r.code, 0);
});

test("--json emits parseable JSON with the commit stamp", () => {
  const r = m.run(["--json"], io({ "a.md": "## OI-001 t\n- rank: safety\n" }));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).generatedFrom, "abc1234");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/inventory.test.mjs`
Expected: FAIL — `m.run is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
export function run(argv, io) {
  const all = io.ledgers.flatMap((l) => parseLedger(io.readFile(l.path), l.name));
  const open = all.filter(isOpen);

  if (argv.includes("--check")) {
    const unranked = open.filter((e) => !e.fields.rank);
    if (unranked.length === 0) return { code: 0, stdout: "inventory: every open entry is ranked\n" };
    const list = unranked.map((e) => `  UNRANKED ${e.qualifiedId} ${e.title}`).join("\n");
    return { code: 1, stdout: `inventory: ${unranked.length} open entr(ies) have no rank:\n${list}\n` };
  }

  const rows = dedupe(open);
  const meta = { generatedFrom: io.commit };
  return {
    code: 0,
    stdout: argv.includes("--json")
      ? JSON.stringify(toJson(rows, meta), null, 2)
      : toMarkdown(rows, meta),
  };
}
```

Then append the real CLI entry point:

```javascript
// Real CLI. Kept to the edges so every rule above stays unit-testable.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const { readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const LEDGERS = [
    { name: "code", path: "C:/code/OPEN-ISSUES.md" },
    { name: "guards", path: "C:/code/guards/OPEN-ISSUES.md" },
    { name: "ecosystem", path: "C:/code/lifeos-ecosystem/OPEN-ISSUES.md" },
    { name: "lifeos", path: "C:/code/lifeos-ecosystem/lifeos/OPEN-ISSUES.md" },
    { name: "lifeos-ui", path: "C:/code/lifeos-ecosystem/lifeos-ui/OPEN-ISSUES.md" },
  ];
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: "C:/code/guards", encoding: "utf8",
  }).trim();
  const r = run(process.argv.slice(2), {
    readFile: (p) => readFileSync(p, "utf8"),
    ledgers: LEDGERS,
    commit,
  });
  process.stdout.write(r.stdout);
  process.exit(r.code);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/inventory.test.mjs`
Expected: PASS, 14/14

- [ ] **Step 5: Commit**

```bash
git add tools/inventory.mjs tools/inventory.test.mjs
git commit -m "feat(inventory): CLI with injected io and a --check completeness gate (AC-A11)"
```

---

### Task 7: Add `rank:` to the shared entry template

**Files:**
- Modify: `OPEN-ISSUES.md` (the `## OI-NNN Short title` template block at the top, line ~11)

**Interfaces:**
- Produces: the template every new entry is copied from, now requiring `rank:`.

- [ ] **Step 1: Read the current template block**

Run: `sed -n '1,25p' OPEN-ISSUES.md`
This is the block every other ledger's template was copied from.

- [ ] **Step 2: Add the rank line and its vocabulary**

Insert `- rank:` immediately after `- opened:` in the template, plus this note directly beneath the template block:

```markdown
`rank:` is required and must be exactly one of, best first:
`safety`, `broken-workflow`, `data-loss`, `autonomy-blocker`, `reliability`,
`control`, `usability`, `maintainability`, `performance`, `roi`.
`tools/inventory.mjs --check` fails on any open entry without one. Optional
`duplicate-of: <ledger>#OI-nnn` folds this entry into another; it is never
inferred from titles.
```

- [ ] **Step 3: Verify the template itself does not break the parser**

Run: `node -e "const m=await import('./tools/inventory.mjs');const fs=await import('node:fs');console.log(m.parseLedger(fs.readFileSync('OPEN-ISSUES.md','utf8'),'guards').length)"`
Expected: prints the entry count (36 including the template stub), no throw.

- [ ] **Step 4: Commit**

```bash
git add OPEN-ISSUES.md
git commit -m "docs(ledger): require rank: on every entry, document the vocabulary"
```

---

### Task 8: Backfill `rank:` across all five ledgers

**Files:**
- Modify: all five `OPEN-ISSUES.md` files, open entries only

**Interfaces:**
- Consumes: `run(["--check"])` from Task 6 as the completion signal.
- Produces: zero unranked open entries.

This is the human-judgment pass the tool deliberately refuses to do. Work it with the checker, not by eye.

- [ ] **Step 1: List what needs ranking**

Run: `node tools/inventory.mjs --check`
Expected: exit 1, listing every unranked open entry across all five ledgers.

- [ ] **Step 2: Rank each entry against Kyle's definitions**

For each listed entry, add `- rank: <value>` directly beneath its `- opened:` line. Use the entry's own `what:` text to choose; when two ranks both fit, pick the **higher** (earlier in the list) — under-ranking hides work, over-ranking only reorders it.

Known assignments, from the entries' own text:

| Entry | Rank | Why |
|---|---|---|
| `guards#OI-032` | `safety` | autoApprove means an agent writing a file is an agent running code |
| `guards#OI-034` | `safety` | a recycled PID means typing into an unrelated process |
| `guards#OI-033` | `broken-workflow` | real prompts were being eaten |
| `guards#OI-025` | `reliability` | the proof suite came back 1/5 |
| `guards#OI-019` | `reliability` | scenario breadth on the reliability kernel |
| `guards#OI-015` | `control` | the GUI half Kyle still needs |
| `guards#OI-026` | `maintainability` | terminology collision, no behaviour at risk |

- [ ] **Step 3: Re-run the checker until it is clean**

Run: `node tools/inventory.mjs --check`
Expected: exit 0, `inventory: every open entry is ranked`

- [ ] **Step 4: Commit (this repo's ledger only)**

```bash
git add OPEN-ISSUES.md
git commit -m "docs(ledger): rank every open entry (AC-A13)"
```

The four ledgers outside this repo are not in this git repo. Commit each in its own repo with the same message; `C:/code/OPEN-ISSUES.md` is untracked and needs no commit.

---

### Task 9: Run against the real ledgers and generate `INVENTORY.md`

**Files:**
- Modify: `tools/inventory.test.mjs`
- Create: `C:/code/INVENTORY.md`

**Interfaces:**
- Consumes: everything above, against real files.
- This is the **only** task whose tests read real ledgers. It is guarded so it
  skips cleanly rather than failing when a ledger is absent (a fresh clone, or
  CI without the sibling repos).

- [ ] **Step 1: Write the failing integration test**

```javascript
import fs from "node:fs";

const LEDGERS = [
  { name: "code", path: "C:/code/OPEN-ISSUES.md" },
  { name: "guards", path: "C:/code/guards/OPEN-ISSUES.md" },
  { name: "ecosystem", path: "C:/code/lifeos-ecosystem/OPEN-ISSUES.md" },
  { name: "lifeos", path: "C:/code/lifeos-ecosystem/lifeos/OPEN-ISSUES.md" },
  { name: "lifeos-ui", path: "C:/code/lifeos-ecosystem/lifeos-ui/OPEN-ISSUES.md" },
];
const haveAll = LEDGERS.every((l) => fs.existsSync(l.path));

test("every open entry in all five real ledgers is ranked", { skip: !haveAll }, () => {
  const r = m.run(["--check"], {
    readFile: (p) => fs.readFileSync(p, "utf8"),
    ledgers: LEDGERS,
    commit: "test",
  });
  assert.equal(r.code, 0, r.stdout);
});

test("the real ledgers parse and rank without throwing", { skip: !haveAll }, () => {
  const r = m.run(["--json"], {
    readFile: (p) => fs.readFileSync(p, "utf8"),
    ledgers: LEDGERS,
    commit: "test",
  });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.ok(j.rows.length > 0);
  assert.ok(j.rows.every((row) => row.rank !== "UNRANKED"));
});
```

- [ ] **Step 2: Run it**

Run: `node --test tools/inventory.test.mjs`
Expected: PASS if Task 8 is complete. A failure here means Task 8 missed an entry — go back, do not weaken this test.

- [ ] **Step 3: Generate the inventory**

```bash
node tools/inventory.mjs > C:/code/INVENTORY.md
head -20 C:/code/INVENTORY.md
```
Expected: a ranked table, `safety` rows first, with the generated-from commit in the header.

- [ ] **Step 4: Run the coverage gate**

Run: `npm run covgate`
Expected: `tools/inventory.mjs` at 100% line, 100% function, ≥90% branch.

- [ ] **Step 5: Commit**

```bash
git add tools/inventory.test.mjs
git commit -m "test(inventory): integration run against all five real ledgers (AC-A11, AC-A13)"
```

---

### Task 10: Map the 22 Definition-of-Done conditions to ledger entries

**Files:**
- Create: `docs/dod-mapping.md`
- Modify: `OPEN-ISSUES.md` (new entries for any condition with no home)
- Modify: `tools/inventory.test.mjs`

**Interfaces:**
- Consumes: the archived prompt at `runner/goals/done/g-20260804-222717-lu7o.json`, field `text`, section "Definition of Done".
- Produces: `docs/dod-mapping.md`, a table of all 22 conditions → the ledger id or spec AC that covers each.

This is the task that turns "don't miss a single thing" from an intention into something checkable.

- [ ] **Step 1: Extract the 22 conditions verbatim**

```bash
node -e "const j=require('C:/code/guards/runner/goals/done/g-20260804-222717-lu7o.json');const t=j.text;const i=t.indexOf('Continue looping until:');console.log(t.slice(i, i+1400))"
```

- [ ] **Step 2: Write the mapping table**

Create `docs/dod-mapping.md` with one row per condition:

```markdown
# Definition of Done — condition mapping

Source: Kyle's 2026-08-04 prompt, archived at
`runner/goals/done/g-20260804-222717-lu7o.json`. Every condition maps to a
ledger entry or a spec acceptance criterion. A condition with neither is a gap,
and the fix is a new ledger entry — never a dash.

| # | Condition | Covered by |
|---|---|---|
| 1 | Every known issue is resolved. | `INVENTORY.md` reaching zero open |
| 2 | Every previously documented task is addressed. | A, this table |
| ... | ... | ... |
```

Fill every row. For each condition with no existing coverage, open a new ledger entry in `OPEN-ISSUES.md` with a `rank:` and reference it here.

- [ ] **Step 3: Write the test that keeps the mapping honest**

```javascript
test("every Definition-of-Done condition maps to a real ledger id or spec AC", () => {
  const map = fs.readFileSync("docs/dod-mapping.md", "utf8");
  const rows = map.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l));
  assert.equal(rows.length, 22, "all 22 conditions must be listed");
  for (const row of rows) {
    const covered = row.split("|")[3].trim();
    assert.notEqual(covered, "", `row has no coverage: ${row}`);
    assert.notMatch(covered, /^(TBD|TODO|-|\?)$/i, `row has a placeholder coverage: ${row}`);
  }
});
```

- [ ] **Step 4: Run it**

Run: `node --test tools/inventory.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Full gate and commit**

```bash
npm run test:windows && npm run covgate
git add docs/dod-mapping.md OPEN-ISSUES.md tools/inventory.test.mjs
git commit -m "docs: map all 22 Definition-of-Done conditions to ledger entries (AC-A14)"
```

---

### Task 11: Merge the worktree

- [ ] **Step 1: Confirm the whole gate set is green**

```bash
npm run test:windows
npm run covgate
node tools/inventory.mjs --check
```
Expected: all pass, `--check` exits 0.

- [ ] **Step 2: Merge and clean up**

```bash
git checkout main
git merge --no-ff acc/a-inventory -m "merge: sub-project A, complete ranked inventory"
git worktree remove ../acc-a-inventory
```

- [ ] **Step 3: Record completion in the master plan**

Mark **A** as `[DONE <sha>]` in `docs/superpowers/plans/2026-08-04-acc-completion-plan.md`, then commit.

---

## Self-Review

**Spec coverage:** AC-A1→T1, AC-A2/A3→T2, AC-A4/A5/A6→T3, AC-A7/A8/A9→T4, AC-A10/A12→T5, AC-A11→T6+T9, AC-A13→T8+T9, AC-A14→T10. All fourteen have a task.

**Placeholder scan:** The only `...` is inside Task 10's illustrative table, whose Step 2 explicitly instructs filling every row and whose Step 3 test fails on any unfilled or placeholder row.

**Type consistency:** `Entry` shape is fixed in Task 1 and used unchanged throughout. `parseLedger`, `isOpen`, `rankOrdinal`, `sortEntries`, `dedupe`, `toJson`, `toMarkdown`, `run` are each defined once and referenced by those exact names. `Row = Entry & { ids }` from Task 4 is what Task 5's emitters consume.

**Known gap, deliberate:** the spec's "unfinished items in `docs/`" sweep is handled by Task 10's mapping rather than by tooling, because checkbox state in this repo is already proven unreliable (the kernel plan reads 0/119 checked and is fully landed). The spec says this is a human pass and the tool only lists candidates; this plan does the human pass and skips building the candidate lister, which would be a tool with one use.

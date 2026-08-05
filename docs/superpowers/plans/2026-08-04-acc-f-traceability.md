# Sub-project F — Setting-Traceability Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible to ship a setting that does not reach its real consumer and change behaviour — and resolve `OI-033` honestly, so no dial is left pointing at a hook that is not registered.

**Architecture:** A registry (`core/traceability.mjs`) declares every control: its authoritative source, its consumer, the documented intent of each value, and a probe. The gate walks the **real** config files and fails on any key not in the registry. That inversion is the whole point — a new dial cannot ship untraced, because the gate finds the key before anyone remembers to write a test for it. `hooks/dialcheck.mjs` is absorbed rather than duplicated.

**Tech Stack:** Node 20+ ESM, `node:test`, `node:assert/strict`, Playwright for the one UI-driven link.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-acc-traceability-design.md` (15 ACs). Ledger: `OI-033`.
- Standard: `docs/superpowers/specs/2026-08-04-acc-standards-design.md`.
- Worktree: `git worktree add -b acc/f-traceability ../acc-f-traceability main` at the wave 3 boundary — after J merges. Concurrent with I and G-rest.
- Post-J names: `core/`, `standing.*` policy keys, `autopilot`.
- **L5 is satisfied only by A/B observation**: set the dial one way, observe outcome X; set it the other, observe outcome Y; assert X ≠ Y *and* that each matches the declared intent. Reading a value back at any layer satisfies L1–L3 and proves nothing about L5.
- `dialcheck.mjs`'s ten existing tests must all still pass after absorption (AC-F11). They move; they do not get rewritten.
- `OI-033` ends in exactly one of two states. A dial left permanently `false` pointing at an unregistered hook is **not** an acceptable end state and fails AC-F13.
- Coverage floor: 100/100/90.

## The seven links

Every traced control must demonstrate all seven. Referenced by number throughout.

| Link | Claim |
|---|---|
| L1 | writing the control saves the value |
| L2 | the value persists across process exit |
| L3 | the authoritative source holds it |
| L4 | the consumer reads that source |
| L5 | behaviour changes, per declared intent |
| L6 | the whole path works UI → execution |
| L7 | restart does not lose or ignore it |

## File Structure

| File | Responsibility |
|---|---|
| `core/traceability.mjs` | registry, gate, probe runner. Absorbs `dialcheck.mjs`. |
| `core/traceability.test.mjs` | unit + integration |
| `core/registry/*.mjs` | one registry entry per control, co-located by owner |
| `e2e/traceability.e2e.mjs` | L6, Playwright |

---

### Task 1: Enumerate every key in the real config files

**Files:**
- Create: `core/traceability.mjs`, `core/traceability.test.mjs`

**Interfaces:**
- Produces: `flattenKeys(obj, prefix) -> string[]` — dotted leaf paths.
  `{a:{b:1}}` → `["a.b"]`. Arrays are leaves (`writeRoots`, not `writeRoots.0`),
  because the control is the list, not each element.
- Underscore-prefixed keys (`_note`) are excluded: they are documentation, and
  `policy.json` already uses that convention.

- [ ] **Step 1: Write the failing test**

```javascript
// node --test core/traceability.test.mjs   (run from the repo root)
//
// The inversion this file exists for: the gate enumerates the REAL config files
// and fails on anything not declared. A suite of hand-written traceability tests
// decays the moment someone adds a dial and forgets one; a gate that reads the
// files cannot be forgotten.
import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("./traceability.mjs");

test("flattenKeys returns dotted leaf paths", () => {
  assert.deepEqual(m.flattenKeys({ autoCd: { enabled: true, note: "x" } }).sort(),
    ["autoCd.enabled", "autoCd.note"]);
});

test("an array is one leaf - the control is the list, not each element", () => {
  assert.deepEqual(m.flattenKeys({ writeRoots: ["a", "b"] }), ["writeRoots"]);
});

test("underscore keys are documentation, not controls", () => {
  assert.deepEqual(m.flattenKeys({ _note: "why", enabled: true }), ["enabled"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test core/traceability.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```javascript
// core/traceability.mjs — the enforcement arm of "every control must reach its
// real consumer".
//
// Kyle: "Do not stop after proving that a UI control changed a database value.
// Prove that the final agentic system consumed it and behaved accordingly."
export function flattenKeys(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;              // policy.json's doc convention
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flattenKeys(v, key));
    else out.push(key);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test core/traceability.test.mjs`
Expected: PASS, 3/3

- [ ] **Step 5: Commit**

```bash
git add core/traceability.mjs core/traceability.test.mjs
git commit -m "feat(traceability): enumerate every leaf key in a config file"
```

---

### Task 2: The completeness gate — undeclared keys fail

**Files:**
- Modify: `core/traceability.mjs`, `core/traceability.test.mjs`

**Interfaces:**
- Produces: `gate(registry, sources) -> Problem[]`,
  `Problem = { kind: "undeclared"|"orphan"|"no-reason", id }`.
  `sources` is `{ [file]: parsedJson }`.
- `undeclared` — a key in a file with no registry entry.
- `orphan` — a registry entry naming a key that does not exist.
- `no-reason` — an `untraceable` entry with no reason.
- `untraceable` entries pass but are always listed in the run's output.

This is AC-F1, AC-F2, AC-F3, AC-F4 and the reason F is a harness rather than a test suite.

- [ ] **Step 1: Write the failing test**

```javascript
const reg = (entries) => entries;

test("a key present in a real config file and absent from the registry fails", () => {
  const p = m.gate(reg([{ id: "autoCd.enabled", source: "policy.json", key: "autoCd.enabled" }]),
    { "policy.json": { autoCd: { enabled: true }, brandNewDial: 3 } });
  assert.deepEqual(p, [{ kind: "undeclared", id: "policy.json:brandNewDial" }]);
});

test("a registry entry naming a key that does not exist fails", () => {
  const p = m.gate(reg([{ id: "gone.dial", source: "policy.json", key: "gone.dial" }]),
    { "policy.json": {} });
  assert.deepEqual(p, [{ kind: "orphan", id: "gone.dial" }]);
});

test("an untraceable entry passes but is reported", () => {
  const r = reg([{ id: "x.y", source: "policy.json", key: "x.y",
                   untraceable: "read only by a vendored binary; 2026-08-04" }]);
  assert.deepEqual(m.gate(r, { "policy.json": { x: { y: 1 } } }), []);
  assert.deepEqual(m.untraceable(r).map((e) => e.id), ["x.y"]);
});

test("untraceable without a reason fails", () => {
  const p = m.gate(reg([{ id: "x.y", source: "policy.json", key: "x.y", untraceable: "" }]),
    { "policy.json": { x: { y: 1 } } });
  assert.deepEqual(p, [{ kind: "no-reason", id: "x.y" }]);
});
```

- [ ] **Step 2: Run to verify it fails**, implement `gate` and `untraceable`, then:

- [ ] **Step 3: Run to verify it passes**

Run: `node --test core/traceability.test.mjs`
Expected: PASS, 7/7

- [ ] **Step 4: Commit**

```bash
git add core/traceability.mjs core/traceability.test.mjs
git commit -m "feat(traceability): fail on any undeclared config key (AC-F1, AC-F2, AC-F3, AC-F4)"
```

---

### Task 3: The probe runner, L1 through L3

**Files:**
- Modify: `core/traceability.mjs`, `core/traceability.test.mjs`

**Interfaces:**
- Produces: `runLinks(entry, links, harness) -> LinkResult[]`,
  `LinkResult = { link, pass, detail }`.
- `harness = { write(id, value), readAuthoritative(source, key), restart(name), observe(entry, value) }`.
- L1: `write` then `readAuthoritative` returns the value.
- L2: same after a simulated process boundary.
- L3: the value is in the real file, not a cache.

- [ ] **Step 1: Write the failing test**

```javascript
const entry = {
  id: "autoCd.enabled", source: "policy.json", key: "autoCd.enabled",
  intent: { true: "prompts are re-scoped", false: "prompts pass through unchanged" },
};

test("L1-L3 fail when a value is written but the authoritative file is unchanged", () => {
  const cache = {};
  const harness = {
    write: (id, v) => { cache[id] = v; },              // writes only to a cache
    readAuthoritative: () => undefined,                 // the file never changes
    restart: () => {},
    observe: () => "same",
  };
  const r = m.runLinks(entry, ["L1", "L2", "L3"], harness);
  assert.deepEqual(r.filter((x) => x.pass).map((x) => x.link), []);
});

test("L1-L3 pass when the authoritative file really holds the value", () => {
  const file = {};
  const harness = {
    write: (id, v) => { file[id] = v; },
    readAuthoritative: (s, k) => file[`${k}`],
    restart: () => {},
    observe: () => "x",
  };
  const r = m.runLinks(entry, ["L1", "L2", "L3"], harness);
  assert.ok(r.every((x) => x.pass), JSON.stringify(r));
});
```

- [ ] **Step 2: Run to verify it fails**, implement, then:

- [ ] **Step 3: Run to verify it passes**, commit

```bash
git commit -am "feat(traceability): L1-L3 probes over an injected harness (AC-F5)"
```

---

### Task 4: L4 — the consumer actually reads that source

**Files:**
- Modify: `core/traceability.mjs`, `core/traceability.test.mjs`
- Move: `hooks/dialcheck.mjs` → absorbed here; `hooks/dialcheck.test.mjs` → `core/traceability.test.mjs`

**Interfaces:**
- Produces: `consumerReads(entry, harness) -> boolean` and the standard
  **registered-hook** consumer class, which is `dialcheck`'s existing rule:
  a dial claiming a hook is enabled while that hook is absent from
  `settings.json` fails, and the reverse fails too.

`dialcheck.mjs` is absorbed, not kept alongside. Two files answering "does this dial point at a real consumer" is the parallel-implementation pattern the repo standard forbids.

- [ ] **Step 1: Move dialcheck's ten tests in unchanged**

Copy every test from `hooks/dialcheck.test.mjs` into `core/traceability.test.mjs`, changing only the import. **Do not rewrite them** — they encode the real 2026-08-04 divergence and re-deriving them would lose that.

- [ ] **Step 2: Write the failing test for the general case**

```javascript
test("L4 fails when the consumer never opens the authoritative source", () => {
  const harness = {
    ...baseHarness,
    opened: [],
    exerciseConsumer: function () { this.opened.push("some/other/file.json"); },
  };
  assert.equal(m.consumerReads(entry, harness), false);
});

test("L4 passes when the consumer opens the authoritative source", () => {
  const harness = {
    ...baseHarness,
    opened: [],
    exerciseConsumer: function () { this.opened.push("policy.json"); },
  };
  assert.equal(m.consumerReads(entry, harness), true);
});
```

- [ ] **Step 3: Run to verify it fails**, implement, delete `hooks/dialcheck.mjs`, then:

- [ ] **Step 4: Prove nothing was lost**

```bash
node --test core/traceability.test.mjs
grep -rn "dialcheck" --include=*.mjs --include=*.ps1 --include=*.json . | grep -v node_modules
```
Expected: all tests pass including the ten moved ones; no stale reference to `dialcheck` outside the ledger.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(traceability): absorb dialcheck as the registered-hook L4 probe (AC-F6, AC-F11, AC-F12)"
```

---

### Task 5: L5 — the link that catches a dial doing nothing

**Files:**
- Modify: `core/traceability.mjs`, `core/traceability.test.mjs`

**Interfaces:**
- Produces: `behaviourChanges(entry, harness) -> { pass, outcomes }`.
  For each declared value: set it, exercise the consumer, capture an observable
  outcome. Fails when any two values produce the **same** outcome, and fails when
  an outcome does not match the declared intent.

This is the load-bearing link and the defect class F exists for.

- [ ] **Step 1: Write the failing test**

```javascript
test("L5 fails when both values produce the same outcome - the dial does nothing", () => {
  const harness = { ...baseHarness, observe: () => "identical outcome" };
  const r = m.behaviourChanges(entry, harness);
  assert.equal(r.pass, false);
  assert.match(r.detail, /produced the same outcome/);
});

test("L5 fails when an outcome does not match the declared intent", () => {
  const harness = {
    ...baseHarness,
    // true and false differ, but true's outcome contradicts its stated intent
    observe: (e, v) => (v === true ? "prompts pass through unchanged" : "prompts are re-scoped"),
  };
  assert.equal(m.behaviourChanges(entry, harness).pass, false);
});

test("L5 passes when each value produces its declared outcome", () => {
  const harness = {
    ...baseHarness,
    observe: (e, v) => (v === true ? "prompts are re-scoped" : "prompts pass through unchanged"),
  };
  assert.equal(m.behaviourChanges(entry, harness).pass, true);
});
```

- [ ] **Step 2: Run to verify it fails**, implement, then:

- [ ] **Step 3: Run to verify it passes**, commit

```bash
git commit -am "feat(traceability): L5 A/B observation against declared intent (AC-F7, AC-F8)"
```

---

### Task 6: L7 — restart does not lose or ignore it

**Files:**
- Modify: `core/traceability.mjs`, `core/traceability.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
test("L7 fails when a value is ignored after restart", () => {
  let restarted = false;
  const harness = {
    ...baseHarness,
    restart: () => { restarted = true; },
    observe: (e, v) => (restarted ? "default outcome" : (v === true ? "prompts are re-scoped" : "prompts pass through unchanged")),
  };
  assert.equal(m.survivesRestart(entry, harness).pass, false);
});

test("L7 passes when the outcome is identical before and after restart", () => {
  const harness = {
    ...baseHarness,
    restart: () => {},
    observe: (e, v) => (v === true ? "prompts are re-scoped" : "prompts pass through unchanged"),
  };
  assert.equal(m.survivesRestart(entry, harness).pass, true);
});
```

- [ ] **Step 2: Run to verify it fails**, implement, run, commit

```bash
git commit -am "feat(traceability): L7 restart survival (AC-F9)"
```

---

### Task 7: Register every real control

**Files:**
- Create: `core/registry/policy.mjs`, `core/registry/config.mjs`
- Modify: `core/traceability.test.mjs`

**Interfaces:**
- One entry per key the gate enumerates from the real `policy.json` and
  `config.json`. Known at time of writing: `autoCd.*`, `autoApprove.*`,
  `standing.reapGraceSeconds`, `standing.humanHoldMinutes`, budget bands, lane
  concurrency and pacing, launch cap, `protected`, `writeRoots`, `denyRoots`,
  `projects`.

The gate defines the list, not this paragraph. Run it first and register what it reports.

- [ ] **Step 1: Run the gate against the real files to get the true list**

```bash
node core/traceability.mjs gate
```
Expected: exit 1 listing every undeclared key. **This is the RED. Paste the full output into the Task 7 commit body** — it is the work list.

- [ ] **Step 2: Write the failing completeness test**

```javascript
test("every key in the real policy.json and config.json is traced or declared untraceable", () => {
  const problems = m.gate(REGISTRY, {
    "policy.json": JSON.parse(fs.readFileSync("policy.json", "utf8")),
    "config.json": JSON.parse(fs.readFileSync("config.json", "utf8")),
  });
  assert.deepEqual(problems, [], JSON.stringify(problems, null, 1));
});
```

- [ ] **Step 3: Write one entry per key**

Each entry needs a real `intent` for every value and a real `probe`. Where a probe is genuinely impossible, use `untraceable` with a dated reason — and expect to justify it, because the gate lists them every run.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test core/traceability.test.mjs && node core/traceability.mjs gate`
Expected: gate exits 0; the untraceable list is printed and short.

- [ ] **Step 5: Commit**

```bash
git add core/registry core/traceability.test.mjs
git commit -m "feat(traceability): register every control in the real config files (AC-F10)"
```

---

### Task 8: Resolve `OI-033` honestly

**Files:**
- Modify: `core/registry/policy.mjs` (`autoCd.enabled`)
- Modify: `claude-session-telemetry`'s `route.mjs` (if restored)
- Modify: `OPEN-ISSUES.md`

**Interfaces:**
- Produces: `autoCd.enabled` in one of exactly two end states. AC-F13 fails on
  any third.

Background: the `UserPromptSubmit` route hook was removed at 18:42 on 2026-08-04 because it was eating real prompts — the **second** time (`OI-029` was the first, closed by re-enabling it on a theory that proved wrong). The dial is now `false`, so `dialcheck` reports clean. Agreeing that a feature is off is not the same as the feature working.

- [ ] **Step 1: Write the failing test that forbids the third state**

```javascript
test("autoCd.enabled is not left false pointing at an unregistered hook", () => {
  const policy = JSON.parse(fs.readFileSync("policy.json", "utf8"));
  const settings = JSON.parse(fs.readFileSync(SETTINGS_FIXTURE, "utf8"));
  const registered = JSON.stringify(settings.hooks?.UserPromptSubmit ?? []).includes("route.mjs");
  if ("autoCd" in policy) {
    assert.equal(registered, true,
      "either root-cause and restore the hook, or delete the dial - a permanently-false dial pointing at nothing is not an end state");
  }
});
```

- [ ] **Step 2: Reproduce the prompt-eating**

The store is trustworthy now (B2b) and the vocabulary is settled (J), so this is finally reproducible. Register `route.mjs` against a **fixture** settings file, drive prompts through it, and find the case where a prompt does not arrive. Record the repro.

- [ ] **Step 3: Take the branch the evidence supports**

**If root-caused:** fix it, re-register `route.mjs`, set the dial `true`, and make L1–L7 pass for `autoCd.enabled` with the hook live.

**If not:** delete `route.mjs`'s registration permanently, **delete the `autoCd` key from `policy.json`** rather than leaving it `false`, and make `ROUTING.md`'s advisory-line fallback the only mechanism. Record why in the ledger.

Either branch is honest. Leaving it as it is, is not.

- [ ] **Step 4: Run the whole harness**

```bash
node core/traceability.mjs probe --all
node --test core/traceability.test.mjs
```
Expected: every traced control passes L1–L5 and L7; `autoCd` either passes fully or no longer exists.

- [ ] **Step 5: Close `OI-033` and commit**

---

### Task 9: L6 — one control driven through the real UI

**Files:**
- Create: `e2e/traceability.e2e.mjs`
- Modify: `core/traceability.mjs` (control manifest cross-check)

**Interfaces:**
- Produces: `manifestGate(uiControls, registry) -> Problem[]` — every UI control
  maps to a registry id (AC-F14). This is a **design constraint on sub-project
  E**, not an afterthought: a control E builds that changes nothing observable
  cannot ship.

- [ ] **Step 1: Write the failing manifest test**

```javascript
test("every UI control maps to a traceability registry id", () => {
  const controls = JSON.parse(fs.readFileSync("../agentic-command-center-ui/controls.json", "utf8"));
  assert.deepEqual(m.manifestGate(controls, REGISTRY), []);
});
```

If the UI repo is not yet present (E has not started), skip cleanly with `{ skip: !fs.existsSync(...) }` and record that AC-F14 completes in E rather than pretending it passes here.

- [ ] **Step 2: Write the failing Playwright test**

```javascript
test("L6: a control driven through the real UI changes real behaviour", async ({ page }) => {
  await page.goto(UI_URL + "/set-up");
  const before = await observeConsumerOutcome();
  await page.getByLabel("Re-scope prompts that do not match the folder").click();
  await page.getByRole("button", { name: /save/i }).click();
  const after = await observeConsumerOutcome();
  assert.notEqual(before, after, "L6: the UI control must change observable behaviour");
});
```

- [ ] **Step 3: Run to verify they fail**, implement, run, commit

```bash
git commit -am "feat(traceability): UI control manifest gate and the L6 e2e (AC-F14, AC-F15)"
```

---

### Task 10: Merge

- [ ] **Step 1: Full gate set**

```bash
npm test && npx repo-gates
node core/traceability.mjs gate
node core/traceability.mjs probe --all
```

- [ ] **Step 2: Merge and close**

```bash
git checkout main
git merge --no-ff acc/f-traceability -m "merge: sub-project F, setting-traceability harness"
git worktree remove ../acc-f-traceability
```

Update the master plan and close `OI-033`.

---

## Self-Review

**Spec coverage:** AC-F1/F2/F3/F4→T2, AC-F5→T3, AC-F6→T4, AC-F7/F8→T5, AC-F9→T6, AC-F10→T7, AC-F11/F12→T4, AC-F13→T8, AC-F14/F15→T9. All fifteen covered.

**Placeholder scan:** Tasks 3–6 say "implement" between red and green rather than showing bodies; the tests fully specify each function's contract. Task 7 Step 3 cannot enumerate entries in advance **by design** — the gate produces the list at Step 1, which is the mechanism, not an omission.

**Type consistency:** `Problem = { kind, id }` in Tasks 2 and 9. `LinkResult = { link, pass, detail }` in Tasks 3–6. `harness` gains fields across tasks (`observe`, `restart`, `exerciseConsumer`) but no field changes shape. `entry` shape is fixed in Task 3 and reused unchanged.

**Cross-sub-project dependency, flagged:** AC-F14 and AC-F15 need the UI repo, which E builds. Task 9 skips cleanly and records the gap rather than asserting a pass — if E is not done when F merges, F is complete except those two, and that must be stated in the merge commit, not glossed.

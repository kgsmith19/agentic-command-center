# Sub-project D — Emergency STOP and Intervention Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A red STOP that kills exactly what this session started — nothing else, ever — plus pause, resume, redirect, interrupt, and a separate control for the autopilot daemon.

**Architecture:** Scope is decided by **provenance, not process name**. The session records an anchor — the pty child's `(pid, startTime)`, the same composite identity B2b established — and STOP kills the tree rooted at it. `killTree` already exists in `runner/runner.mjs` and `OI-014` already proves its Windows branch on every platform, so D wires proven parts to a button rather than inventing a kill path. Protection against accidental activation is a 600 ms press-and-hold, with a keyboard-only equivalent that is tested, not assumed.

**Tech Stack:** Node 20+ ESM, `node:test`, Playwright for the interaction and accessibility criteria, plain ES modules + CSS in the UI repo (no framework, per E's tech decision).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-acc-stop-intervention-design.md` (21 ACs).
- Standard: `docs/superpowers/specs/2026-08-04-acc-standards-design.md`.
- Worktree: `git worktree add -b acc/d-stop ../acc-d-stop main` in **`agentic-command-center-ui`**, at the wave 4 boundary — after J, I and F. D runs **before** E and not beside it: they share a screen, and two agents designing one screen produces two designs.
- Supersedes the control-strip section of `2026-07-31-acc-terminal-control-deck-design.md`, which targeted the WinForms host `OI-022` retired. Do not port its WinForms code.
- **Never match by process name or command line.** `OI-001` was a kill query that matched its own probe process. A grep gate enforces this (AC-D3).
- A stale anchor kills **nothing**. Killing a recycled PID is `OI-034`; the emergency control is the last place to reintroduce it.
- STOP reports what actually died, verified per pid after the kill. Survivors mean `partial`, never `success`.
- `interrupted` is a fourth standing-order status, distinct from `done`, `blocked` and `abandoned`.
- Coverage floor: 100/100/90. Playwright for AC-D8 through AC-D13 and AC-D20.

## File Structure

| File | Responsibility |
|---|---|
| `core/anchor.mjs` (command-center) | record and resolve the session anchor |
| `core/stop.mjs` (command-center) | descendants, kill, verify, report |
| `core/intervene.mjs` (command-center) | pause, resume, redirect, interrupt |
| `src/controls/stop-button.mjs` (ui) | the hold gesture, the ring, the a11y path |
| `src/controls/take-over.mjs` (ui) | the Take over region |
| `e2e/stop.spec.mjs` (ui) | AC-D8–D13, D20, D21 |

---

### Task 1: Record and resolve the session anchor

**Files:**
- Create: `core/anchor.mjs`, `core/anchor.test.mjs`

**Interfaces:**
- Produces: `recordAnchor(session, { pid, startedAt }) -> Anchor`,
  `resolveAnchor(anchor, consoles) -> "live" | "stale" | "unknown"`.
- `consoles` is the same `{ [pid]: startedAtIso }` table B2b established. Reused
  deliberately: one identity mechanism, not two.

- [ ] **Step 1: Write the failing test**

```javascript
// node --test core/anchor.test.mjs   (run from the repo root)
//
// The anchor is what makes STOP precise. guards-gui.ps1:1426 already warned when
// a consolePid "does not descend from pty child", so descendancy is a proven
// idea here - this makes it the basis of the kill instead of a warning.
import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("./anchor.mjs");

test("an anchor whose start time matches the live table is live", () => {
  const a = m.recordAnchor("s1", { pid: 4242, startedAt: "2026-08-04T10:00:00.000Z" });
  assert.equal(m.resolveAnchor(a, { 4242: "2026-08-04T10:00:00.000Z" }), "live");
});

test("a recycled pid is stale, not live - OI-034 must not come back through STOP", () => {
  const a = m.recordAnchor("s1", { pid: 4242, startedAt: "2026-08-04T10:00:00.000Z" });
  assert.equal(m.resolveAnchor(a, { 4242: "2026-08-04T18:30:00.000Z" }), "stale");
});

test("a pid absent from the table is stale", () => {
  const a = m.recordAnchor("s1", { pid: 4242, startedAt: "2026-08-04T10:00:00.000Z" });
  assert.equal(m.resolveAnchor(a, { 999: "x" }), "stale");
});

test("no table means unknown - STOP must not act on a guess", () => {
  const a = m.recordAnchor("s1", { pid: 4242, startedAt: "2026-08-04T10:00:00.000Z" });
  assert.equal(m.resolveAnchor(a, undefined), "unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test core/anchor.test.mjs`
Expected: FAIL — `Cannot find module './anchor.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// core/anchor.mjs — what did THIS session start?
//
// Kyle, 2026-08-04: "If the process is booted up via the start of the terminal
// session/agentic session then stop should kill that process too. If it's not
// related to that bootup it should not be killed that way at all."
//
// So scope is provenance. Name-matching is rejected outright: OI-001 was a kill
// query that matched its own probe process.
export function recordAnchor(sessionId, { pid, startedAt }) {
  if (!pid || !startedAt) throw new Error("an anchor needs both a pid and a start time");
  return { sessionId, pid: Number(pid), startedAt: String(startedAt) };
}

export function resolveAnchor(anchor, consoles) {
  if (!consoles) return "unknown";
  const seen = consoles[String(anchor.pid)];
  if (!seen) return "stale";
  return seen === anchor.startedAt ? "live" : "stale";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test core/anchor.test.mjs`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add core/anchor.mjs core/anchor.test.mjs
git commit -m "feat(anchor): identify what a session started by (pid, startTime) (AC-D4)"
```

---

### Task 2: Walk descendants — and only descendants

**Files:**
- Create: `core/stop.mjs`, `core/stop.test.mjs`

**Interfaces:**
- Produces: `descendants(anchorPid, table) -> number[]` where `table` is
  `[{ pid, ppid, startedAt }]`. Returns the anchor plus every transitive child,
  never a sibling, never a name match.
- Cycle-safe: a malformed table where a process appears to be its own ancestor
  must terminate, not hang.

- [ ] **Step 1: Write the failing test**

```javascript
const TREE = [
  { pid: 100, ppid: 1,   startedAt: "t0" },   // the anchor
  { pid: 101, ppid: 100, startedAt: "t1" },   // child
  { pid: 102, ppid: 101, startedAt: "t2" },   // grandchild
  { pid: 103, ppid: 102, startedAt: "t3" },   // great-grandchild
  { pid: 200, ppid: 1,   startedAt: "t4" },   // unrelated, same exe
];

test("descendants returns the anchor and every transitive child", () => {
  assert.deepEqual(m.descendants(100, TREE).sort((a, b) => a - b), [100, 101, 102, 103]);
});

test("an identical process not descended from the anchor is never included", () => {
  assert.equal(m.descendants(100, TREE).includes(200), false);
});

test("a cyclic parent chain terminates instead of hanging", () => {
  const cyclic = [
    { pid: 1, ppid: 2, startedAt: "t" },
    { pid: 2, ppid: 1, startedAt: "t" },
  ];
  assert.deepEqual(m.descendants(1, cyclic).sort(), [1, 2]);
});

test("an anchor with no children is just itself", () => {
  assert.deepEqual(m.descendants(200, TREE), [200]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test core/stop.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```javascript
// core/stop.mjs
export function descendants(anchorPid, table) {
  const kids = new Map();
  for (const p of table) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const out = [];
  const seen = new Set();                 // a malformed table must not hang
  const queue = [Number(anchorPid)];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const k of kids.get(pid) ?? []) queue.push(k);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test core/stop.test.mjs`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add core/stop.mjs core/stop.test.mjs
git commit -m "feat(stop): descendants only, cycle-safe, never a name match (AC-D1, AC-D2)"
```

---

### Task 3: Kill, verify each pid, and report honestly

**Files:**
- Modify: `core/stop.mjs`, `core/stop.test.mjs`

**Interfaces:**
- Consumes: `killTree` from `runner/runner.mjs` — imported, not reimplemented.
  `OI-014` already proves its Windows branch's pid-liveness check on every
  platform.
- Produces: `stop(anchor, io) -> StopReport`,
  `StopReport = { outcome: "stopped"|"partial"|"already-gone"|"unknown", killed: number[], survivors: number[], anchor }`.
- `io = { consoles(), processTable(), kill(pid), alive(pid), now() }`.

- [ ] **Step 1: Write the failing test**

```javascript
test("stop kills the whole tree and reports every pid it confirmed dead", () => {
  const dead = new Set();
  const r = m.stop(anchor, {
    consoles: () => ({ 100: "t0" }),
    processTable: () => TREE,
    kill: (pid) => dead.add(pid),
    alive: (pid) => !dead.has(pid),
    now: () => "2026-08-04T23:00:00.000Z",
  });
  assert.equal(r.outcome, "stopped");
  assert.deepEqual(r.killed.sort((a, b) => a - b), [100, 101, 102, 103]);
  assert.deepEqual(r.survivors, []);
});

test("a surviving pid means partial, and it is named - never reported as success", () => {
  const dead = new Set();
  const r = m.stop(anchor, {
    consoles: () => ({ 100: "t0" }),
    processTable: () => TREE,
    kill: (pid) => { if (pid !== 102) dead.add(pid); },   // 102 refuses to die
    alive: (pid) => !dead.has(pid),
    now: () => "t",
  });
  assert.equal(r.outcome, "partial");
  assert.deepEqual(r.survivors, [102]);
});

test("a stale anchor kills nothing and says the session is already gone", () => {
  let kills = 0;
  const r = m.stop(anchor, {
    consoles: () => ({ 100: "DIFFERENT-START-TIME" }),
    processTable: () => TREE,
    kill: () => { kills++; },
    alive: () => false,
    now: () => "t",
  });
  assert.equal(r.outcome, "already-gone");
  assert.equal(kills, 0, "a recycled pid must never be killed");
  assert.deepEqual(r.killed, []);
});

test("no console table means unknown and nothing is killed", () => {
  let kills = 0;
  const r = m.stop(anchor, {
    consoles: () => undefined, processTable: () => TREE,
    kill: () => { kills++; }, alive: () => false, now: () => "t",
  });
  assert.equal(r.outcome, "unknown");
  assert.equal(kills, 0);
});
```

- [ ] **Step 2: Run to verify it fails**, implement, then:

- [ ] **Step 3: Run to verify it passes**

Run: `node --test core/stop.test.mjs`
Expected: PASS, 8/8

- [ ] **Step 4: Write the grep gate for AC-D3**

```javascript
test("stop.mjs never matches a process by name or command line", () => {
  const src = fs.readFileSync("core/stop.mjs", "utf8");
  for (const bad of [/ProcessName/i, /CommandLine/i, /Get-Process\s+-Name/i, /taskkill\s+\/IM/i]) {
    assert.doesNotMatch(src, bad, "OI-001 was a kill query that matched its own probe process");
  }
});
```

- [ ] **Step 5: Commit**

```bash
git add core/stop.mjs core/stop.test.mjs
git commit -m "feat(stop): kill the tree, verify each pid, report partial honestly (AC-D3, AC-D4, AC-D5)"
```

---

### Task 4: Integration — a real three-deep tree, and a bystander that survives

**Files:**
- Create: `core/stop.integration.test.mjs`

**Interfaces:**
- The criterion that proves precision on real processes rather than a fixture.

- [ ] **Step 1: Write the failing integration test**

```javascript
// Spawns a real 3-deep tree plus an unrelated process running the SAME
// executable. AC-D2 is the one that matters: the bystander must survive.
test("a real tree dies and an identical bystander survives", async () => {
  const root = spawn(process.execPath, ["-e", `
    const { spawn } = require("child_process");
    const mid = spawn(process.execPath, ["-e", \`
      require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
      setInterval(()=>{},1000);
    \`]);
    setInterval(()=>{},1000);
  `], { detached: process.platform !== "win32" });

  const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  await waitFor(() => processTable().filter((p) => isDescendant(p.pid, root.pid)).length >= 3);

  const anchor = m.recordAnchor("s1", { pid: root.pid, startedAt: startTimeOf(root.pid) });
  const r = m.stop(anchor, realIo);

  assert.equal(r.outcome, "stopped");
  assert.ok(r.killed.length >= 3, `expected >=3 pids, got ${r.killed.length}`);
  assert.equal(alive(bystander.pid), true, "AC-D2: the bystander must survive");
  bystander.kill();
});
```

- [ ] **Step 2: Run to verify it fails**, wire `realIo` to the OS, then:

- [ ] **Step 3: Run to verify it passes**

Run: `node --test core/stop.integration.test.mjs`
Expected: PASS. If the bystander dies, the scoping is wrong — fix the scoping, never the assertion.

- [ ] **Step 4: Commit**

```bash
git commit -am "test(stop): real 3-deep tree dies, identical bystander survives (AC-D1, AC-D2)"
```

---

### Task 5: Record every activation in the ledger

**Files:**
- Modify: `core/stop.mjs`, `core/stop.test.mjs`

**Interfaces:**
- Produces: a ledger record per activation:
  `{ at, who, anchor, killed, survivors, outcome, standingOrderId }`.
- Marks the standing order `interrupted` — the fourth status.

- [ ] **Step 1: Write the failing test**

```javascript
test("every activation records who, when, the anchor, the pid list and each post-kill state", () => {
  const written = [];
  m.stop(anchor, { ...baseIo, appendLedger: (r) => written.push(r), who: "kyle" });
  assert.equal(written.length, 1);
  const r = written[0];
  assert.equal(r.who, "kyle");
  assert.ok(r.at);
  assert.deepEqual(r.anchor, anchor);
  assert.ok(Array.isArray(r.killed));
  assert.ok(Array.isArray(r.survivors));
  assert.ok(["stopped", "partial", "already-gone", "unknown"].includes(r.outcome));
});

test("the standing order is marked interrupted, distinct from abandoned and done", () => {
  const statuses = [];
  m.stop(anchor, { ...baseIo, setStatus: (id, s) => statuses.push([id, s]), standingOrderId: "so-1" });
  assert.deepEqual(statuses, [["so-1", "interrupted"]]);
});

test("a stale anchor does not mark the order interrupted - nothing was interrupted", () => {
  const statuses = [];
  m.stop(anchor, { ...staleIo, setStatus: (id, s) => statuses.push([id, s]), standingOrderId: "so-1" });
  assert.deepEqual(statuses, []);
});
```

- [ ] **Step 2: Run to verify it fails**, implement, run, commit

```bash
git commit -am "feat(stop): ledger every activation, mark the order interrupted (AC-D6, AC-D7)"
```

---

### Task 6: Pause, resume, redirect, interrupt

**Files:**
- Create: `core/intervene.mjs`, `core/intervene.test.mjs`

**Interfaces:**
- `pause(id)` / `resume(id)` — status only, kills nothing. `pendingKicks` skips a
  paused order; **other orders are unaffected**.
- `redirect(id, text)` — replaces the condition, pushes the previous text onto
  `history`.
- `interrupt(anchor, io)` — sends `Esc` over the pty; the session survives.

- [ ] **Step 1: Write the failing test**

```javascript
test("pause stops kicks for that order only", () => {
  const a = m.createStanding({ text: "a" }), b = m.createStanding({ text: "b" });
  bindLive(a); bindLive(b);
  iv.pause(a.id);
  const kicks = m.pendingKicks(Date.now(), { consoles: LIVE }).map((g) => g.id);
  assert.deepEqual(kicks, [b.id], "pausing one order must not pause the others");
});

test("resume restores kicking without restarting the session", () => {
  const a = m.createStanding({ text: "a" }); bindLive(a);
  iv.pause(a.id); iv.resume(a.id);
  assert.deepEqual(m.pendingKicks(Date.now(), { consoles: LIVE }).map((g) => g.id), [a.id]);
});

test("redirect replaces the condition and keeps the previous text in history", () => {
  const a = m.createStanding({ text: "keep tests green" });
  iv.redirect(a.id, "ship the release");
  const after = m.readStanding(a.id);
  assert.equal(after.text, "ship the release");
  assert.deepEqual(after.history.map((h) => h.text), ["keep tests green"]);
});

test("pause kills nothing", () => {
  let kills = 0;
  const a = m.createStanding({ text: "a" }); bindLive(a);
  iv.pause(a.id, { kill: () => { kills++; } });
  assert.equal(kills, 0);
});
```

- [ ] **Step 2: Run to verify it fails**, implement, run, commit

```bash
git commit -am "feat(intervene): pause, resume, redirect - none of them kill (AC-D14, AC-D15, AC-D16)"
```

---

### Task 7: The autopilot control, and its honest limit

**Files:**
- Modify: `core/intervene.mjs`, `core/intervene.test.mjs`

**Interfaces:**
- `stopAutopilot(io) -> { stopped, ownedByAcc }` — drives the existing
  `watcher/stop-autopilot.cmd` sentinel mechanism, not a new kill path.
- When autopilot was **not** ACC-started, the result says so. Per Kyle: *"If
  there is some sort of execution or starting of the [autopilot] via the Agentic
  Command Center there should be a stop for it but that answer would depend on
  how it starts. If it's completely outside of it then not there at all."*

- [ ] **Step 1: Write the failing test**

```javascript
test("stopping autopilot halts the daemon and touches no standing order's status", () => {
  const a = m.createStanding({ text: "a" }); bindLive(a);
  const r = iv.stopAutopilot({ ...baseIo, startedByAcc: true });
  assert.equal(r.stopped, true);
  assert.equal(r.ownedByAcc, true);
  assert.equal(m.readStanding(a.id).status, "active", "stopping the driver must not change the work");
});

test("an out-of-band autopilot is reported as not ACC-owned, not silently claimed", () => {
  const r = iv.stopAutopilot({ ...baseIo, startedByAcc: false });
  assert.equal(r.ownedByAcc, false);
  assert.match(r.detail, /not started by the Command Center/i);
});

test("stopping autopilot uses the existing sentinel, not a new kill path", () => {
  const src = fs.readFileSync("core/intervene.mjs", "utf8");
  assert.match(src, /stop-autopilot|autopilot\.stop/);
  assert.doesNotMatch(src, /killTree/, "the daemon has a stop mechanism already");
});
```

- [ ] **Step 2: Run to verify it fails**, implement, run, commit

```bash
git commit -am "feat(intervene): stop autopilot via its own sentinel, state ownership honestly (AC-D18, AC-D19)"
```

---

### Task 8: The hold-to-STOP control

**Files:**
- Create: `src/controls/stop-button.mjs`, `src/controls/stop-button.css` (ui repo)
- Create: `e2e/stop.spec.mjs`

**Interfaces:**
- 600 ms press-and-hold with a filling ring and a live-region countdown.
- Keyboard: focus + `Enter` opens a single-button confirm, default-focused.
- Global: `Ctrl`+`Shift`+`.` held 600 ms, working from inside the terminal.

Chosen over a modal because under stress people dismiss modals reflexively, and because a hold can be aborted by releasing — a confirm cannot without a second decision.

- [ ] **Step 1: Write the failing Playwright tests**

```javascript
test("a click does not fire STOP", async ({ page }) => {
  await page.goto(UI + "/work");
  await page.getByRole("button", { name: "Emergency stop" }).click();
  expect(await stopCalls(page)).toBe(0);
});

test("a double-click does not fire STOP", async ({ page }) => {
  await page.getByRole("button", { name: "Emergency stop" }).dblclick();
  expect(await stopCalls(page)).toBe(0);
});

test("a 599ms hold does not fire; a 600ms hold does", async ({ page }) => {
  const btn = page.getByRole("button", { name: "Emergency stop" });
  await btn.hover(); await page.mouse.down();
  await page.waitForTimeout(599); await page.mouse.up();
  expect(await stopCalls(page)).toBe(0);

  await btn.hover(); await page.mouse.down();
  await page.waitForTimeout(700); await page.mouse.up();
  expect(await stopCalls(page)).toBe(1);
});

test("holding for 5s still fires exactly once", async ({ page }) => {
  const btn = page.getByRole("button", { name: "Emergency stop" });
  await btn.hover(); await page.mouse.down();
  await page.waitForTimeout(5000); await page.mouse.up();
  expect(await stopCalls(page)).toBe(1);
});

test("releasing early aborts and the session survives", async ({ page }) => {
  const btn = page.getByRole("button", { name: "Emergency stop" });
  await btn.hover(); await page.mouse.down();
  await page.waitForTimeout(300); await page.mouse.up();
  expect(await stopCalls(page)).toBe(0);
  await expect(page.getByTestId("session-state")).toHaveText("running");
});

test("keyboard only: focus, Enter, confirm - no pointer at all", async ({ page }) => {
  await page.getByRole("button", { name: "Emergency stop" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "STOP NOW" })).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await stopCalls(page)).toBe(1);
});

test("Ctrl+Shift+. held fires STOP while focus is inside the terminal", async ({ page }) => {
  await page.getByTestId("terminal").click();
  await page.keyboard.down("Control"); await page.keyboard.down("Shift");
  await page.keyboard.down("Period"); await page.waitForTimeout(700);
  await page.keyboard.up("Period"); await page.keyboard.up("Shift"); await page.keyboard.up("Control");
  expect(await stopCalls(page)).toBe(1);
});

test("the hold countdown is announced to assistive technology", async ({ page }) => {
  const live = page.getByRole("status");
  await expect(live).toHaveAttribute("aria-live", "assertive");
  const btn = page.getByRole("button", { name: "Emergency stop" });
  await btn.hover(); await page.mouse.down();
  await page.waitForTimeout(300);
  await expect(live).toContainText(/holding/i);
  await page.mouse.up();
  await expect(live).toContainText(/cancelled/i);
});

test("STOP is reachable and operable at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const btn = page.getByRole("button", { name: "Emergency stop" });
  await expect(btn).toBeInViewport();
  const box = await btn.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);   // touch target floor
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test e2e/stop.spec.mjs`
Expected: FAIL — no control exists.

- [ ] **Step 3: Implement the control**

Pointer/keyboard hold with `requestAnimationFrame` for the ring, a single `fired` latch so a long hold cannot repeat, `aria-live="assertive"` status region, and a ≥44 px target at every width.

- [ ] **Step 4: Run to verify they pass**

Run: `npx playwright test e2e/stop.spec.mjs`
Expected: PASS, 9/9

- [ ] **Step 5: Commit**

```bash
git add src/controls/stop-button.mjs src/controls/stop-button.css e2e/stop.spec.mjs
git commit -m "feat(ui): hold-to-STOP with a tested keyboard-only equivalent (AC-D8, AC-D9, AC-D10, AC-D11, AC-D12, AC-D13, AC-D20)"
```

---

### Task 9: The Take over region

**Files:**
- Create: `src/controls/take-over.mjs` (ui repo)
- Modify: `controls.json` (the manifest F's AC-F14 gate reads)

**Interfaces:**
- STOP, Interrupt, Pause, Resume, Redirect, and — **visually separated** — Stop
  autopilot. Different blast radii, different regions; putting them together is
  how someone hits the wrong one.

- [ ] **Step 1: Write the failing test**

```javascript
test("Stop autopilot is not adjacent to the emergency STOP", async ({ page }) => {
  const stop = await page.getByRole("button", { name: "Emergency stop" }).boundingBox();
  const auto = await page.getByRole("button", { name: /stop autopilot/i }).boundingBox();
  expect(Math.abs(stop.y - auto.y) > 80 || Math.abs(stop.x - auto.x) > 200).toBe(true);
});

test("every control in the Take over region is in controls.json", async ({ page }) => {
  const rendered = await page.getByTestId("take-over").getByRole("button").allInnerTexts();
  const manifest = JSON.parse(fs.readFileSync("controls.json", "utf8"));
  for (const label of rendered) {
    expect(manifest.some((c) => c.label === label)).toBe(true);
  }
});
```

- [ ] **Step 2: Run to verify they fail**, implement, run, commit

```bash
git commit -am "feat(ui): the Take over region, dangerous actions separated (AC-D13, AC-D17)"
```

---

### Task 10: The real end-to-end stop

**Files:**
- Modify: `e2e/stop.spec.mjs`

**Interfaces:**
- AC-D21, the criterion that proves it works on the real thing.

- [ ] **Step 1: Write the failing e2e**

```javascript
test("a real session running a real turn is stopped by a real hold", async ({ page }) => {
  await page.goto(UI + "/work");
  await page.getByLabel("What should this session work on?").fill("count slowly to one hundred");
  await page.getByRole("button", { name: "Start work" }).click();
  await expect(page.getByTestId("session-state")).toHaveText("running", { timeout: 60000 });

  const anchorPid = Number(await page.getByTestId("anchor-pid").innerText());
  const before = descendantsOf(anchorPid);
  expect(before.length).toBeGreaterThan(1);

  const btn = page.getByRole("button", { name: "Emergency stop" });
  await btn.hover(); await page.mouse.down();
  await page.waitForTimeout(700); await page.mouse.up();

  await expect(page.getByTestId("stop-outcome")).toHaveText("stopped", { timeout: 15000 });
  for (const pid of before) expect(alive(pid)).toBe(false);
  expect(await standingStatus()).toBe("interrupted");
});
```

- [ ] **Step 2: Run to verify it fails**, wire it, run until green.

- [ ] **Step 3: Full gate set and merge**

```bash
npm test && npx repo-gates && npx playwright test
git checkout main
git merge --no-ff acc/d-stop -m "merge: sub-project D, emergency STOP and intervention"
git worktree remove ../acc-d-stop
```

---

## Self-Review

**Spec coverage:** AC-D1/D2→T2+T4, AC-D3→T3, AC-D4→T1+T3, AC-D5→T3, AC-D6/D7→T5, AC-D8–D12→T8, AC-D13→T8+T9, AC-D14/D15/D16→T6, AC-D17→T9, AC-D18/D19→T7, AC-D20→T8, AC-D21→T10. All twenty-one covered.

**Placeholder scan:** Task 4's `realIo`, `startTimeOf`, `isDescendant` and Task 10's `descendantsOf`, `alive`, `standingStatus` are named helpers the task instructs you to wire to the OS — the assertions define them completely. Task 8 Step 3 describes the control rather than showing it; the nine Playwright tests are the specification, which is the stricter contract.

**Type consistency:** `Anchor = { sessionId, pid, startedAt }` fixed in Task 1, used unchanged. `StopReport` fixed in Task 3 and only read afterwards. `consoles` is the same `{ [pid]: startedAtIso }` shape B2b established — one identity mechanism across both sub-projects, deliberately.

**Reuse check:** `killTree` is imported from `runner/runner.mjs`, never reimplemented; the autopilot stop drives the existing sentinel; the anchor reuses B2b's identity. D adds `descendants`, the report, and the control — nothing else.

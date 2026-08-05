# Sub-project B2b — Console Identity by (pid, startTime) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop treating a console PID as a console identity, so autopilot can never type a standing-order prompt into an unrelated process that inherited a recycled PID.

**Architecture:** A console is identified by `(pid, startTime)`. `hooks/goal.mjs` stays pure — it never queries the OS. Autopilot already enumerates processes, so it builds a `pid → startTime` table once per cycle and passes it in on stdin. Without a table, `pendingKicks` returns nothing: typing into a process you cannot identify is precisely the hazard, so the failure mode is fail-closed, not best-effort.

**Tech Stack:** Node 20+ ESM, `node:test`, `node:assert/strict`, PowerShell 5.1 for `watcher/clearbot.ps1`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-acc-known-defects-design.md`, section **B2**. Ledger: `OI-034`.
- Standard: `docs/superpowers/specs/2026-08-04-acc-standards-design.md`.
- Worktree: `git worktree add ../acc-b2b-identity acc/b2b-console-identity`. Wave 1, concurrent with A and G-kernel.
- **This lands before J.** J renames `goal.mjs` → `standing.mjs`; doing B2b after would mean rewriting it. Every name below is the pre-J name and J migrates it.
- Existing behaviour that must not regress: `reapDeadGoals()` (shipped `773005e`, `OI-031`), the grace window `goals.reapGraceSeconds` (default 120), `humanHoldMinutes`, and the `abandoned` status.
- Start times are ISO-8601 UTC strings (`2026-08-04T23:11:07.412Z`) on both sides. PowerShell emits `.StartTime.ToUniversalTime().ToString('o')`.
- Coverage floor for changed files: 100/100/90 (`npm run covgate`).
- `hooks/goal.mjs` must remain free of `child_process` and of any OS query. A grep gate in Task 6 enforces it.

## File Structure

| File | Responsibility |
|---|---|
| `hooks/goal.mjs` | identity comparison, stamping, reaping, kick eligibility — all pure |
| `hooks/goal.test.mjs` | unit coverage for the above |
| `watcher/clearbot.ps1` | builds the console table and pipes it to `goal.mjs pending` |
| `hooks/clearbot.test.mjs` | asserts the table's shape and the stdin contract |

---

### Task 1: Compare console identity, given a table

**Files:**
- Modify: `hooks/goal.mjs:129-137` (`consoleAlive`)
- Modify: `hooks/goal.test.mjs`

**Interfaces:**
- Produces: `consoleState(goal, consoles) -> "alive" | "dead" | "unknown"`.
  `consoles` is `{ [pid: string]: startedAtIso }` or `undefined`.
  - no table → `"unknown"` (we cannot tell, so we do nothing)
  - pid absent from table → `"dead"`
  - pid present, `goal.consoleStartedAt` absent → `"unstamped"` handled in Task 2; here it returns `"unknown"`
  - pid present, start times equal → `"alive"`
  - pid present, start times differ → `"dead"` (recycled)
- `consoleAlive(pid)` is **kept unchanged** for now; Task 4 removes its last caller. Deleting it in this task would break `main()` mid-plan.

- [ ] **Step 1: Write the failing test**

```javascript
// Appended to hooks/goal.test.mjs. The bug this reproduces: OI-034, a PID that
// exists but belongs to a different process than the one we bound to.
test("a recycled pid is dead, not alive - the OI-034 mistarget, reproduced", () => {
  const goal = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  const consoles = { 4242: "2026-08-04T18:30:00.000Z" }; // same pid, new process
  assert.equal(m.consoleState(goal, consoles), "dead");
});

test("a live console whose start time matches is alive", () => {
  const goal = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  assert.equal(m.consoleState(goal, { 4242: "2026-08-04T10:00:00.000Z" }), "alive");
});

test("a pid absent from the table is dead", () => {
  const goal = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  assert.equal(m.consoleState(goal, { 999: "2026-08-04T10:00:00.000Z" }), "dead");
});

test("no table means unknown - never a guess in either direction", () => {
  const goal = { consolePid: 4242, consoleStartedAt: "2026-08-04T10:00:00.000Z" };
  assert.equal(m.consoleState(goal, undefined), "unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/goal.test.mjs`
Expected: FAIL — `m.consoleState is not a function`

- [ ] **Step 3: Write minimal implementation**

Insert directly above `consoleAlive` in `hooks/goal.mjs`:

```javascript
// OI-034. A pid is not an identity: Windows recycles them, and the comment above
// consoleAlive has named that hazard since the file was written while the check
// below it did nothing about it. A console is (pid, startTime).
//
// This function does NOT query the OS. Autopilot already enumerates processes
// every cycle and gets StartTime free, so it passes the table in. That keeps
// this module pure and keeps every kick-safety rule in this one file, which is
// what its header promises.
export function consoleState(goal, consoles) {
  if (!consoles) return "unknown";            // cannot tell -> do nothing
  const pid = Number(goal.consolePid || 0);
  if (!pid) return "dead";
  const seen = consoles[String(pid)];
  if (!seen) return "dead";                   // pid is gone
  if (!goal.consoleStartedAt) return "unknown"; // not stamped yet - Task 2
  return goal.consoleStartedAt === seen ? "alive" : "dead";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/goal.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hooks/goal.mjs hooks/goal.test.mjs
git commit -m "feat(goal): identify a console by (pid, startTime), not pid (OI-034, AC-5, AC-6)"
```

---

### Task 2: Stamp `consoleStartedAt` on first sighting, inside the grace window

**Files:**
- Modify: `hooks/goal.mjs`
- Modify: `hooks/goal.test.mjs`

**Interfaces:**
- Consumes: `consoleState` from Task 1.
- Produces: `stampConsoles(consoles, { now, graceMs }) -> string[]` — stamps every
  active goal that has a pid in the table, no `consoleStartedAt`, and was created
  inside the grace window. Returns the ids it stamped.
- An unstamped goal **older** than the grace window is left unstamped, so Task 3
  reaps it. That is the legacy reap: a goal recorded before this change cannot
  have its identity reconstructed, and guessing one would re-create the bug.

**Why stamping happens here and not in `bindSession`:** the SessionStart hook that calls `bindSession` has the pid but no cheap way to read a start time, and node has no built-in for it. Autopilot has the table. Inside the grace window the goal was created seconds ago, so a recycle in that window is not a credible risk — and the spec already accepts exactly this window (AC-9).

- [ ] **Step 1: Write the failing test**

```javascript
test("a goal inside the grace window is stamped from the table on first sighting", () => {
  const g = m.createGoal({ text: "keep tests green", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: UUID, consolePid: 4242, goalId: g.id });
  const stamped = m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" },
    { now: Date.now(), graceMs: 120000 });
  assert.deepEqual(stamped, [g.id]);
  assert.equal(m.readGoal(g.id).consoleStartedAt, "2026-08-04T10:00:00.000Z");
});

test("stamping is idempotent - an already stamped goal is left alone", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: UUID, consolePid: 4242, goalId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const again = m.stampConsoles({ 4242: "2026-08-04T99:00:00.000Z" },
    { now: Date.now(), graceMs: 120000 });
  assert.deepEqual(again, []);
  assert.equal(m.readGoal(g.id).consoleStartedAt, "2026-08-04T10:00:00.000Z");
});

test("a goal older than the grace window is never stamped - legacy stays unidentifiable", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: UUID, consolePid: 4242, goalId: g.id });
  const later = Date.now() + 10 * 60 * 1000;
  assert.deepEqual(m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" },
    { now: later, graceMs: 120000 }), []);
  assert.equal(m.readGoal(g.id).consoleStartedAt, undefined);
});
```

Use the existing test file's UUID constant and its sandboxed goals dir; do not introduce a second sandbox mechanism.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/goal.test.mjs`
Expected: FAIL — `m.stampConsoles is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
// Stamped by autopilot on first sighting rather than at bind time: bindSession's
// caller has the pid but no cheap way to read a start time. Inside the grace
// window the goal is seconds old, so a recycle here is not credible - and this
// is the same window reapDeadGoals already protects.
export function stampConsoles(consoles, { now = Date.now(), graceMs = REAP_GRACE_MS_DEFAULT } = {}) {
  if (!consoles) return [];
  const stamped = [];
  for (const g of activeGoals()) {
    if (g.consoleStartedAt) continue;
    const seen = consoles[String(Number(g.consolePid || 0))];
    if (!seen) continue;
    const createdMs = Date.parse(g.createdAt || 0);
    if (!Number.isFinite(createdMs) || now - createdMs > graceMs) continue;
    g.consoleStartedAt = seen;
    write(g);
    stamped.push(g.id);
  }
  return stamped;
}
```

If the created-at field is named something other than `createdAt`, use the existing name — check `createGoal` before writing this.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/goal.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hooks/goal.mjs hooks/goal.test.mjs
git commit -m "feat(goal): stamp consoleStartedAt on first sighting inside the grace window (AC-7)"
```

---

### Task 3: Reap on identity, and refuse to kick what cannot be identified

**Files:**
- Modify: `hooks/goal.mjs` (`reapDeadGoals`, `pendingKicks`)
- Modify: `hooks/goal.test.mjs`

**Interfaces:**
- `reapDeadGoals({ now, graceMs, consoles })` — reaps a goal only when
  `consoleState` is `"dead"`. With no table it reaps nothing.
- `pendingKicks(now, { consoles, ...dials })` — returns `[]` when `consoles` is
  absent, and otherwise only goals whose `consoleState` is `"alive"`.

The fail-closed choice is the point: no table means we cannot prove which process owns that pid, and typing a prompt into an unproven process is the whole defect.

- [ ] **Step 1: Write the failing test**

```javascript
test("pendingKicks returns nothing without a console table - fail closed", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: UUID, consolePid: process.pid, goalId: g.id });
  assert.deepEqual(m.pendingKicks(Date.now(), {}), []);
});

test("pendingKicks skips a goal whose console was recycled", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: UUID, consolePid: 4242, goalId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const kicks = m.pendingKicks(Date.now(), { consoles: { 4242: "2026-08-04T18:30:00.000Z" } });
  assert.deepEqual(kicks, []);
});

test("pendingKicks returns a goal whose console identity matches", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: UUID, consolePid: 4242, goalId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const kicks = m.pendingKicks(Date.now(), { consoles: { 4242: "2026-08-04T10:00:00.000Z" } });
  assert.equal(kicks.length, 1);
  assert.equal(kicks[0].id, g.id);
});

test("a recycled console is reaped as abandoned and leaves activeGoals", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: UUID, consolePid: 4242, goalId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const reaped = m.reapDeadGoals({
    now: Date.now() + 10 * 60 * 1000,
    graceMs: 120000,
    consoles: { 4242: "2026-08-04T18:30:00.000Z" },
  });
  assert.deepEqual(reaped, [g.id]);
  assert.equal(m.readGoal(g.id).status, "abandoned");
  assert.equal(m.activeGoals().find((x) => x.id === g.id), undefined);
});

test("reapDeadGoals with no table reaps nothing - it never destroys on a guess", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: UUID, consolePid: 4242, goalId: g.id });
  assert.deepEqual(m.reapDeadGoals({ now: Date.now() + 10 * 60 * 1000, graceMs: 120000 }), []);
  assert.equal(m.readGoal(g.id).status, "active");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/goal.test.mjs`
Expected: FAIL — `pendingKicks` still returns the goal without a table, and `reapDeadGoals` ignores `consoles`.

- [ ] **Step 3: Write minimal implementation**

In `reapDeadGoals`, replace the `consoleAlive(g.consolePid)` liveness test with:

```javascript
    if (consoleState(g, consoles) !== "dead") continue;
```

and add `consoles` to its destructured options. In `pendingKicks`, add at the top:

```javascript
  // No table means we cannot prove which process owns that pid. Typing into an
  // unproven process is OI-034 itself, so this fails closed rather than
  // best-effort.
  if (!opts.consoles) return [];
```

and in its per-goal filter, replace the existing liveness check with:

```javascript
    if (consoleState(g, opts.consoles) !== "alive") continue;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/goal.test.mjs`
Expected: PASS, whole file

- [ ] **Step 5: Commit**

```bash
git add hooks/goal.mjs hooks/goal.test.mjs
git commit -m "feat(goal): reap and kick on console identity, fail closed without a table (AC-8, AC-9, AC-11)"
```

---

### Task 4: `bindSession` never adopts a goal whose console identity does not match

**Files:**
- Modify: `hooks/goal.mjs:195-225` (`bindSession`)
- Modify: `hooks/goal.test.mjs`

**Interfaces:**
- `bindSession({ sessionId, consolePid, cwd, goalId, consoles })` — the pid-match
  fallback now requires `consoleState(g, consoles) === "alive"`. With no table,
  the fallback does not adopt at all; an explicit `goalId` still binds, because
  that is a caller naming a specific goal rather than the store guessing.

This is the criterion that reproduces the wrong-goal adoption directly (AC-10).

- [ ] **Step 1: Write the failing test**

```javascript
test("bindSession never adopts a goal whose console identity does not match", () => {
  const stale = m.createGoal({ text: "last week's task", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: UUID, consolePid: 4242, goalId: stale.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });

  // A brand new session lands on the same pid, now owned by a different process.
  const adopted = m.bindSession({
    sessionId: UUID2,
    consolePid: 4242,
    consoles: { 4242: "2026-08-04T18:30:00.000Z" },
  });
  assert.equal(adopted, null, "must not inherit last week's task");
});

test("bindSession adopts by pid when the console identity matches", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  m.bindSession({ sessionId: UUID, consolePid: 4242, goalId: g.id });
  m.stampConsoles({ 4242: "2026-08-04T10:00:00.000Z" }, { now: Date.now(), graceMs: 120000 });
  const adopted = m.bindSession({
    sessionId: UUID2,
    consolePid: 4242,
    consoles: { 4242: "2026-08-04T10:00:00.000Z" },
  });
  assert.equal(adopted.id, g.id);
});

test("an explicit goalId still binds without a table", () => {
  const g = m.createGoal({ text: "t", cwd: "C:/code/guards" });
  assert.equal(m.bindSession({ sessionId: UUID, consolePid: 4242, goalId: g.id }).id, g.id);
});
```

Add a second UUID constant `UUID2` alongside the existing `UUID` if the file has only one.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/goal.test.mjs`
Expected: FAIL — the first test adopts the stale goal, exactly as OI-034 describes.

- [ ] **Step 3: Write minimal implementation**

In `bindSession`, change the signature to accept `consoles`, pass it to `reapDeadGoals`, and replace the fallback:

```javascript
  reapDeadGoals({ consoles });
  let goal = goalId ? readGoal(goalId) : null;
  if (goal && goal.status !== "active") goal = null;
  if (!goal && consolePid) {
    // OI-034: matching on pid alone is how a fresh session inherited last
    // week's task. Identity, or no adoption.
    goal = activeGoals().find(
      (g) => Number(g.consolePid) === Number(consolePid) &&
             consoleState(g, consoles) === "alive",
    ) || null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/goal.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hooks/goal.mjs hooks/goal.test.mjs
git commit -m "feat(goal): bindSession requires console identity to adopt (AC-10)"
```

---

### Task 5: Autopilot builds the table and pipes it in

**Files:**
- Modify: `watcher/clearbot.ps1:376-400` (`Invoke-Kicks`)
- Modify: `hooks/goal.mjs` (`main()` — read the table from stdin)
- Modify: `hooks/clearbot.test.mjs`
- Modify: `hooks/goal.test.mjs`

**Interfaces:**
- `goal.mjs pending` reads a JSON object from **stdin**: `{ "4242": "2026-08-04T10:00:00.000Z" }`. Empty stdin means no table, which Task 3 already makes fail-closed.
- Stdin, not argv: a machine with hundreds of processes would blow the Windows command-line length limit, and the pid list is unbounded.

**Note this is cheaper than what it replaces.** `clearbot.ps1` currently calls `Get-Process -Id` per pid at five separate sites; one enumeration per cycle replaces several.

- [ ] **Step 1: Write the failing test for the node side**

```javascript
test("main() pending reads the console table from stdin", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["hooks/goal.mjs", "pending"], {
    input: JSON.stringify({ 4242: "2026-08-04T10:00:00.000Z" }),
    encoding: "utf8",
    env: { ...process.env, ACC_GOALS_DIR: SANDBOX },
  });
  assert.doesNotThrow(() => JSON.parse(out));
});

test("main() pending with empty stdin returns an empty list, not a crash", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["hooks/goal.mjs", "pending"], {
    input: "",
    encoding: "utf8",
    env: { ...process.env, ACC_GOALS_DIR: SANDBOX },
  });
  assert.deepEqual(JSON.parse(out), []);
});
```

Use whatever env var the existing tests already use to redirect the goals dir; do not add a new one.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test hooks/goal.test.mjs`
Expected: FAIL — `pending` ignores stdin and returns goals regardless.

- [ ] **Step 3: Implement the node side**

In `main()`, before the `pending` branch:

```javascript
  // The console table arrives on stdin, not argv: the pid list is unbounded and
  // Windows caps command lines. Empty stdin -> no table -> pendingKicks fails
  // closed, which is the intended behaviour, not a degraded one.
  const readTable = () => {
    try {
      const raw = readFileSync(0, "utf8").trim();
      return raw ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
  };
```

and in the `pending` branch:

```javascript
    const consoles = readTable();
    stampConsoles(consoles, dials);
    console.log(JSON.stringify(pendingKicks(Date.now(), { ...dials, consoles })));
```

- [ ] **Step 4: Implement the PowerShell side**

In `clearbot.ps1`, replace the `goal.mjs pending` invocation at line ~381:

```powershell
# One enumeration per cycle replaces the per-pid Get-Process calls this loop
# used to make. StartTime throws AccessDenied on protected processes; those are
# skipped, and a console we cannot read the start time of is one we must not
# type into anyway (guards OI-034).
$table = @{}
foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
    try { $table[[string]$p.Id] = $p.StartTime.ToUniversalTime().ToString('o') } catch { }
}
$json = $table | ConvertTo-Json -Compress
if (-not $json) { $json = '{}' }

try {
    $raw = $json | & node (Join-Path $Root 'hooks\goal.mjs') 'pending' 2>$null | Out-String
} catch { return }
```

- [ ] **Step 5: Write the failing test for the PowerShell contract**

```javascript
test("clearbot pipes a console table into goal.mjs pending", () => {
  const ps = fs.readFileSync("watcher/clearbot.ps1", "utf8");
  assert.match(ps, /ToUniversalTime\(\)\.ToString\('o'\)/, "start times must be ISO-8601 UTC");
  assert.match(ps, /\$json \| & node .*goal\.mjs.*'pending'/,
    "the table must reach goal.mjs on stdin");
});

test("clearbot no longer gates a kick on a bare Get-Process existence check", () => {
  const ps = fs.readFileSync("watcher/clearbot.ps1", "utf8");
  const kicks = ps.slice(ps.indexOf("function Invoke-Kicks"), ps.indexOf("function Invoke-Kicks") + 2000);
  assert.doesNotMatch(kicks, /if \(-not \(Get-Process -Id \$cpid/,
    "existence is not identity - goal.mjs decides, per its own header");
});
```

- [ ] **Step 6: Run everything**

```bash
node --test hooks/goal.test.mjs hooks/clearbot.test.mjs
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add hooks/goal.mjs hooks/goal.test.mjs watcher/clearbot.ps1 hooks/clearbot.test.mjs
git commit -m "feat(clearbot): pass the live console table into goal.mjs (OI-034)"
```

---

### Task 6: Remove the old existence check and gate its return

**Files:**
- Modify: `hooks/goal.mjs` (delete `consoleAlive`)
- Modify: `hooks/goal.test.mjs`

**Interfaces:**
- `consoleAlive` is deleted. Every caller now uses `consoleState`.

- [ ] **Step 1: Write the failing test**

```javascript
test("consoleAlive is gone - existence is not identity", () => {
  assert.equal(m.consoleAlive, undefined);
});

test("goal.mjs never queries the OS - purity is what keeps kick rules in one file", () => {
  const src = fs.readFileSync("hooks/goal.mjs", "utf8");
  assert.doesNotMatch(src, /child_process/);
  assert.doesNotMatch(src, /process\.kill\(/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test hooks/goal.test.mjs`
Expected: FAIL — `consoleAlive` still exported, `process.kill(` still present.

- [ ] **Step 3: Delete it**

Remove the `consoleAlive` function and its comment block from `hooks/goal.mjs`. Find and fix any remaining caller:

```bash
grep -rn "consoleAlive" --include=*.mjs --include=*.ps1 . | grep -v node_modules
```
Expected after the fix: only the test asserting its absence.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test hooks/goal.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hooks/goal.mjs hooks/goal.test.mjs
git commit -m "refactor(goal): delete consoleAlive, identity replaces existence (AC-5)"
```

---

### Task 7: Reap the six real stale goals, and close the ledger

**Files:**
- Modify: `OPEN-ISSUES.md` (`OI-034`)
- Modify: `docs/superpowers/plans/2026-08-04-acc-completion-plan.md`

- [ ] **Step 1: Full gate set**

```bash
npm run test:windows
npm run covgate
```
Expected: all green; `hooks/goal.mjs` at 100/100/≥90.

- [ ] **Step 2: Observe the real store**

```bash
node hooks/goal.mjs list
```
Record the output. The six stale goals from 2026-08-04 (oldest 2026-07-31) have no `consoleStartedAt`, so they are unidentifiable and outside the grace window.

- [ ] **Step 3: Reap them for real**

```bash
node hooks/goal.mjs reap
node hooks/goal.mjs list
```
Expected: the stale goals now show `abandoned`; `activeGoals` contains only genuinely live consoles. Paste both outputs into the commit body — this is the evidence, and reading back a config value would not be.

- [ ] **Step 4: Close `OI-034`**

Change its heading to `## OI-034 [RESOLVED 2026-08-04] ...` and add a `- resolved:` line stating: identity is `(pid, startTime)`; the table is supplied by autopilot so `goal.mjs` stays pure; `pendingKicks` fails closed without a table; the recycled-PID mistarget is reproduced directly by a test in `hooks/goal.test.mjs`.

- [ ] **Step 5: Merge**

```bash
git add OPEN-ISSUES.md docs/superpowers/plans/2026-08-04-acc-completion-plan.md
git commit -m "docs: close OI-034, console identity is (pid, startTime)"
git checkout main
git merge --no-ff acc/b2b-console-identity -m "merge: sub-project B2b, console identity"
git worktree remove ../acc-b2b-identity
```

---

## Self-Review

**Spec coverage:** B2's AC-5→T1+T6, AC-6→T1, AC-7→T2, AC-8→T3, AC-9→T2+T3, AC-10→T4, AC-11→T3. All seven covered.

**Placeholder scan:** None. Two steps say "use the existing constant/env var rather than adding a new one" — that is an instruction to read neighbouring code, not a deferred decision.

**Type consistency:** `consoles` is `{ [pidString]: isoUtcString }` in every task, node and PowerShell. `consoleState` returns exactly `"alive" | "dead" | "unknown"` throughout. `stampConsoles` and `reapDeadGoals` both return `string[]` of ids, matching `reapDeadGoals`'s existing shipped contract.

**Deliberate behaviour change, flagged:** `pendingKicks` now returns `[]` without a table, so any caller other than autopilot stops producing kicks until it supplies one. `grep -rn "pending" watcher/ runner/ e2e/` during Task 5 to confirm autopilot is the only caller; if another exists, it gets the table in the same task rather than a fallback, because a fallback here is the bug.

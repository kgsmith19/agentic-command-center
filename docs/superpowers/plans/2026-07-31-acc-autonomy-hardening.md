# ACC Autonomy Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Agentic Command Center track, clear, and re-prompt a goal session without fail — including the case that stalls today (a turn ending *under* the context budget) — and prove it with tests that cannot pass unless the loop actually works.

**Architecture:** Extend in place. Liveness decisions live in `hooks/goal.mjs` (one auditable place, as today); `hooks/budget.mjs` reports turn ends into the goal store; `watcher/clearbot.ps1` stays a dumb executor that re-derives every safety check itself. Supervision is external (a Windows Scheduled Task re-running the existing start script). Tests come in two tiers: a hermetic fast tier in the standard gate, and a real-`claude` proof tier that drives an actual throwaway console.

**Tech Stack:** Node 24 ESM (`node --test`, no dependencies), Windows PowerShell 5.1, Win32 `WriteConsoleInput` via `watcher/sendconsole.ps1`, Windows Task Scheduler (`schtasks`).

**Spec:** `docs/superpowers/specs/2026-07-31-acc-autonomy-hardening-design.md`

## Global Constraints

- Run every command from the repo root `C:\code\guards`.
- **Test gate command** (never `node --test hooks/` — the runner grades the directory as one bogus failing test):
  `node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs`
  Currently 56 pass / 0 fail. Add new hook test files to this list as they are created.
- Tests that touch runner state MUST sandbox via `ACC_ROOT` (redirects `runner/`) and `ACC_POLICY` (policy file path). A test that writes to live `runner/state` deletes `.window` files running sessions depend on.
- Hooks and helpers **fail open**: a broken goal store costs auto-resume and nothing else. Never add a Stop-hook gate — the budget gate is the only Stop authority (OI-011).
- Never introduce a code path that types caller-chosen free text. `watcher/clearbot.ps1` invariant 1 (lines 14–40) is the authority on what may ever be typed; read it before editing that file.
- Do not test typing against a real working session. Use a throwaway console.
- Policy dials are read fresh on every fire from `policy.json`; never cache them across invocations.
- Commit after each task. Branch: `master`. Sign commits with the trailer used in this repo:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `hooks/goal.mjs` (modify) | `recordTurnEnd()` + hybrid `pendingKicks()` rules — the ONLY place kick-safety is decided | 1 |
| `hooks/goal.test.mjs` (modify) | Unit tests for the rules matrix | 1 |
| `hooks/budget.mjs` (modify) | Report under-budget turn ends + classify human/machine; heartbeat warning line | 2, 5 |
| `hooks/budget.test.mjs` (modify) | Stop-path classification tests | 2 |
| `policy.json` (modify) | `goals.kickSettleSeconds`, `goals.humanHoldMinutes` dials | 1 |
| `watcher/stop-clearbot.cmd` (modify) | Self-exclusion in the kill query (OI-001) | 3 |
| `watcher/clearbot.ps1` (modify) | Heartbeat write; request binding check; policy-sourced hardK | 4, 6 |
| `watcher/sendconsole.ps1` (modify) | Self-defense: reject control chars / oversize text | 6 |
| `hooks/statusline.mjs` (modify) | `bot DEAD` segment when heartbeat is stale | 5 |
| `hooks/statusline.test.mjs` (modify) | Heartbeat display tests | 5 |
| `hooks/clearbot.test.mjs` (create) | Fast-tier suite: drives `clearbot.ps1 -Once` against a stub console | 7 |
| `watcher/stubconsole.ps1` (create) | Test double: a hidden console whose received keystrokes land in a log file | 7 |
| `runbox/acc-watchdog-register.ps1` (create) | Registers the Scheduled Task (needs Kyle's authority) | 8 |
| `runbox/acc-watchdog-unregister.ps1` (create) | Removes it | 8 |
| `e2e/loop.e2e.mjs` (create) | Proof tier: real `claude`, 4 scenarios | 9, 10 |
| `AGENTS.md` (modify) | Document liveness, watchdog, both test tiers | 11 |

---

### Task 1: Hybrid kick rules in the goal store

**Files:**
- Modify: `hooks/goal.mjs` (add `recordTurnEnd`; rewrite `pendingKicks`, currently lines 240–247)
- Modify: `hooks/goal.test.mjs`
- Modify: `policy.json` (add two dials under `goals`)

**Interfaces:**
- Consumes: existing `readGoal(id)`, `write(goal)`, `activeGoals()`, `consoleAlive(pid)`, `goalForSession(sessionId)` from `hooks/goal.mjs`.
- Produces:
  - `recordTurnEnd(id, { human }) -> goal | null` — sets `needsKick = true`, `turnEndedAt = ISO now`, and when `human === true` also `humanPromptAt = ISO now`.
  - `pendingKicks(now = Date.now(), opts = {}) -> Array<{id, consolePid, cycles, sessionId}>` — `opts` accepts `{ kickSettleSeconds, humanHoldMinutes }`; omitted values default to 90 and 10.
  - Goal JSON gains fields `turnEndedAt` (string ISO or "") and `humanPromptAt` (string ISO or "").
  - `policy.json` gains `goals.kickSettleSeconds` (number) and `goals.humanHoldMinutes` (number).

- [ ] **Step 1: Write the failing tests**

Append to `hooks/goal.test.mjs`:

```js
// --- hybrid re-kick rules (autonomy hardening) -----------------------------
// The loop stalled twice on 2026-07-31 because only an OVER-budget stop could
// continue it. These pin the rules that make an under-budget turn end resume.

test("recordTurnEnd re-arms the kick and stamps the turn end", () => {
  const g = createGoal({ text: "t", cwd: "." });
  bindSession({ sessionId: "s1", consolePid: process.pid, goalId: g.id });
  markKicked(g.id); // clears needsKick, as a real kick would
  assert.equal(readGoal(g.id).needsKick, false);

  recordTurnEnd(g.id, { human: false });
  const after = readGoal(g.id);
  assert.equal(after.needsKick, true);
  assert.ok(after.turnEndedAt, "turnEndedAt stamped");
  assert.ok(!after.humanPromptAt, "machine turn does not stamp humanPromptAt");
});

test("a human-prompted turn end records the human timestamp", () => {
  const g = createGoal({ text: "t", cwd: "." });
  bindSession({ sessionId: "s2", consolePid: process.pid, goalId: g.id });
  recordTurnEnd(g.id, { human: true });
  assert.ok(readGoal(g.id).humanPromptAt, "humanPromptAt stamped");
});

test("kick waits for the settle window, then fires", () => {
  const g = createGoal({ text: "t", cwd: "." });
  bindSession({ sessionId: "s3", consolePid: process.pid, goalId: g.id });
  markKicked(g.id);
  recordTurnEnd(g.id, { human: false });
  const t0 = Date.parse(readGoal(g.id).turnEndedAt);

  const tooSoon = pendingKicks(t0 + 30_000, { kickSettleSeconds: 90 });
  assert.equal(tooSoon.find((k) => k.id === g.id), undefined, "30s < 90s settle");

  // Past settle AND past the 60s kick cooldown from markKicked.
  const ready = pendingKicks(t0 + 120_000, { kickSettleSeconds: 90 });
  assert.ok(ready.find((k) => k.id === g.id), "fires once settled");
});

test("a human prompt holds the kick off, and the hold expires", () => {
  const g = createGoal({ text: "t", cwd: "." });
  bindSession({ sessionId: "s4", consolePid: process.pid, goalId: g.id });
  markKicked(g.id);
  recordTurnEnd(g.id, { human: true });
  const t0 = Date.parse(readGoal(g.id).humanPromptAt);

  const held = pendingKicks(t0 + 120_000, { kickSettleSeconds: 90, humanHoldMinutes: 10 });
  assert.equal(held.find((k) => k.id === g.id), undefined, "quiet while Kyle is engaged");

  const freed = pendingKicks(t0 + 11 * 60_000, { kickSettleSeconds: 90, humanHoldMinutes: 10 });
  assert.ok(freed.find((k) => k.id === g.id), "self-heals after the hold");
});

test("a finished goal is never kicked", () => {
  const g = createGoal({ text: "t", cwd: "." });
  bindSession({ sessionId: "s5", consolePid: process.pid, goalId: g.id });
  recordTurnEnd(g.id, { human: false });
  setStatus(g.id, "done", "finished");
  const t = Date.now() + 86_400_000;
  assert.equal(pendingKicks(t).find((k) => k.id === g.id), undefined);
});

test("a dead console is never kicked", () => {
  const g = createGoal({ text: "t", cwd: "." });
  bindSession({ sessionId: "s6", consolePid: 999999, goalId: g.id });
  recordTurnEnd(g.id, { human: false });
  const t = Date.now() + 86_400_000;
  assert.equal(pendingKicks(t).find((k) => k.id === g.id), undefined);
});
```

Update that file's import line to include the new and used symbols. The existing import is at the top of `hooks/goal.test.mjs`; ensure it reads:

```js
import {
  createGoal, bindSession, readGoal, setStatus, markKicked,
  pendingKicks, recordTurnEnd,
} from "./goal.mjs";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test hooks/goal.test.mjs`
Expected: FAIL — `recordTurnEnd is not a function` (and the settle/hold assertions fail).

- [ ] **Step 3: Implement `recordTurnEnd` and the new rules**

In `hooks/goal.mjs`, add these two constants next to the existing `KICK_DELAY_MS` / `KICK_COOLDOWN_MS` block (around line 39):

```js
// A turn that ends UNDER budget used to end the loop: nothing re-armed the
// kick, so an active goal sat dead until a human typed (observed twice on
// 2026-07-31, once for 18 minutes). These two windows are what make an
// under-budget turn end resume instead of stall. Both are policy dials.
const KICK_SETTLE_MS_DEFAULT = 90_000;
// While Kyle is actively prompting this console, stay out of his way; the hold
// expires so walking away still self-heals.
const HUMAN_HOLD_MS_DEFAULT = 10 * 60_000;
```

Add the new writer next to `markKicked` (after line 255):

```js
// Called from the Stop hook on every turn end of a goal session that did NOT
// go over budget (the over-budget path has its own clear/resume chain). This
// is the liveness trigger: it re-arms the kick that pendingKicks() then gates.
export function recordTurnEnd(id, { human } = {}) {
  const goal = readGoal(id);
  if (!goal || goal.status !== "active") return null;
  goal.needsKick = true;
  goal.turnEndedAt = nowIso();
  if (human) goal.humanPromptAt = nowIso();
  return write(goal);
}
```

Replace `pendingKicks` (lines 240–247) with:

```js
export function pendingKicks(now = Date.now(), opts = {}) {
  const settleMs =
    opts.kickSettleSeconds != null ? Number(opts.kickSettleSeconds) * 1000 : KICK_SETTLE_MS_DEFAULT;
  const holdMs =
    opts.humanHoldMinutes != null ? Number(opts.humanHoldMinutes) * 60000 : HUMAN_HOLD_MS_DEFAULT;
  return activeGoals()
    .filter((g) => g.needsKick)
    .filter((g) => consoleAlive(g.consolePid))
    .filter((g) => !g.boundAt || now - Date.parse(g.boundAt) >= KICK_DELAY_MS)
    // Turn-end settle: the TUI needs a moment after a turn ends, and an
    // instant kick would race the model's own last tool call.
    .filter((g) => !g.turnEndedAt || now - Date.parse(g.turnEndedAt) >= settleMs)
    // Human hold: quiet while he is typing, self-healing once he stops.
    .filter((g) => !g.humanPromptAt || now - Date.parse(g.humanPromptAt) >= holdMs)
    .filter((g) => !g.lastKickAt || now - Date.parse(g.lastKickAt) >= KICK_COOLDOWN_MS)
    .map((g) => ({ id: g.id, consolePid: g.consolePid, cycles: g.cycles, sessionId: g.sessionId }));
}
```

Add the two fields to the `createGoal` goal object (after `lastKickAt: "",` at line 142):

```js
    turnEndedAt: "",
    humanPromptAt: "",
```

Make the CLI pass the dials through. Replace the `pending` branch in `main()` (lines 301–304) with:

```js
  if (cmd === "pending") {
    // Dials live in policy.json so they can be tuned without a restart; a
    // missing/broken policy just uses the defaults (fail open).
    let dials = {};
    try {
      const pol = JSON.parse(
        fs.readFileSync(process.env.ACC_POLICY || path.join(ROOT, "policy.json"), "utf8")
      );
      dials = {
        kickSettleSeconds: pol?.goals?.kickSettleSeconds,
        humanHoldMinutes: pol?.goals?.humanHoldMinutes,
      };
    } catch {}
    console.log(JSON.stringify(pendingKicks(Date.now(), dials)));
    return;
  }
```

- [ ] **Step 4: Add the dials to policy.json**

In `policy.json`, inside the `"goals"` object (which currently holds `autoResume`, `maxCycles`, `_note`), add:

```json
"kickSettleSeconds": 90,
"humanHoldMinutes": 10,
```

Append to that object's `_note` value, in the same string: `Liveness (2026-07-31): a turn ending UNDER budget re-arms the kick; kickSettleSeconds is how long after a turn end a kick may fire, humanHoldMinutes is how long a human prompt suppresses it.`

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test hooks/goal.test.mjs`
Expected: PASS, all tests (14 pre-existing + 6 new = 20).

- [ ] **Step 6: Verify the CLI still emits valid JSON**

Run: `node hooks/goal.mjs pending`
Expected: a JSON array printed (very likely `[]` or the live goal). Not an error, not empty output.

- [ ] **Step 7: Commit**

```bash
git add hooks/goal.mjs hooks/goal.test.mjs policy.json
git commit -m "feat: under-budget turn ends re-arm the goal kick, with a human back-off (guards OI-002)"
```

---

### Task 2: Report turn ends from the Stop hook

**Files:**
- Modify: `hooks/budget.mjs` (the under-hard early return at line 503: `if (ctx < hardK * 1000) allow();`)
- Modify: `hooks/budget.test.mjs`

**Interfaces:**
- Consumes: `recordTurnEnd` and `goalForSession` from `./goal.mjs` (Task 1). `hooks/budget.mjs` already imports `goalForSession, appendCycle` — extend that import.
- Produces: on a Stop under the hard ceiling with an active bound goal, the goal JSON has `needsKick: true` and a correct `humanPromptAt` classification. No stdout change (the hook still allows silently).

- [ ] **Step 1: Write the failing tests**

Append to `hooks/budget.test.mjs`:

```js
// --- liveness: an under-budget turn end must re-arm the kick ---------------
// This is the 2026-07-31 stall, pinned. The session ends its turn normally,
// well under the ceiling, and nothing in the old code re-armed anything.

// The classifier reads the last user message, so transcripts need one.
function writeTranscriptWithUser(sb, sid, ctxTokens, userText) {
  const f = path.join(sb.root, `${sid}.jsonl`);
  const user = JSON.stringify({
    type: "user",
    timestamp: "2026-07-31T12:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: userText }] },
  });
  fs.writeFileSync(f, user + "\n" + turn(ctxTokens, "did the work") + "\n");
  return f;
}

async function seedGoal(sb, sid) {
  process.env.ACC_ROOT = sb.root;
  process.env.ACC_GOALS_DIR = "";
  const gm = await import(`./goal.mjs?t=live-${Math.floor(Math.random() * 1e9)}`);
  const g = gm.createGoal({ text: "keep going", cwd: sb.root });
  gm.bindSession({ sessionId: sid, consolePid: process.pid, goalId: g.id });
  gm.markKicked(g.id); // a kick already fired; needsKick is false
  return { gm, g };
}

test("under budget with an active goal: the turn end re-arms the kick", async () => {
  const sb = sandbox();
  const sid = "s-live-machine";
  const { gm, g } = await seedGoal(sb, sid);
  const t = writeTranscriptWithUser(sb, sid, 10000, "Continue the active ACC goal.");

  const out = runStop(sb, { sid, transcript: t, active: false });
  assert.equal(out.trim(), "", "still silent - liveness must not add output");

  const after = gm.readGoal(g.id);
  assert.equal(after.needsKick, true, "kick re-armed");
  assert.ok(after.turnEndedAt, "turn end stamped");
  assert.ok(!after.humanPromptAt, "the kick constant is a MACHINE turn");
});

test("a human-prompted turn end is classified as human", async () => {
  const sb = sandbox();
  const sid = "s-live-human";
  const { gm, g } = await seedGoal(sb, sid);
  const t = writeTranscriptWithUser(sb, sid, 10000, "actually, do this other thing first");

  runStop(sb, { sid, transcript: t, active: false });
  assert.ok(gm.readGoal(g.id).humanPromptAt, "human prompt stamped -> kick backs off");
});

test("no goal: an under-budget stop still does nothing at all", () => {
  const sb = sandbox();
  const sid = "s-live-nogoal";
  const t = writeTranscriptWithUser(sb, sid, 10000, "hello");
  assert.equal(runStop(sb, { sid, transcript: t, active: false }).trim(), "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test hooks/budget.test.mjs`
Expected: FAIL — `needsKick` is still `false` (the hook returns before touching the goal).

- [ ] **Step 3: Implement the reporting**

In `hooks/budget.mjs`, extend the goal import (currently `import { goalForSession, appendCycle } from "./goal.mjs";` — match the existing line exactly and add the symbol):

```js
import { goalForSession, appendCycle, recordTurnEnd } from "./goal.mjs";
```

Add this helper next to the other transcript readers (near `lastAssistantText`):

```js
// The last user message of the transcript. Used ONLY to tell a machine
// continuation from something Kyle typed - see KICK_CONSTANTS below.
function lastUserText(transcriptPath) {
  let last = "";
  try {
    const text = fs.readFileSync(transcriptPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line || line.charCodeAt(0) !== 123) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "user" || !o.message) continue;
      const c = o.message.content;
      last = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.filter((b) => b && b.type === "text").map((b) => b.text).join("")
          : "";
    }
  } catch {}
  return String(last || "").trim();
}

// Exactly the constants clearbot types (watcher/clearbot.ps1 $KICK and
// $QUEUEKICK). Anything else came from a human, so the kick backs off.
const KICK_CONSTANTS = ["Continue the active ACC goal.", "Run the queued prompt."];
```

Then replace the under-hard early return (line 503):

```js
  if (ctx < hardK * 1000) allow();
```

with:

```js
  if (ctx < hardK * 1000) {
    // LIVENESS (guards OI-002): a goal session that ends its turn under the
    // ceiling gets no clear and therefore no resume - the loop used to die
    // here. Re-arm the kick and let goal.mjs decide when it is safe to fire.
    // Fails open: liveness must never cost a turn its clean exit.
    try {
      const g = goalForSession(p.session_id);
      if (g) {
        const human = !KICK_CONSTANTS.includes(lastUserText(p.transcript_path));
        recordTurnEnd(g.id, { human });
      }
    } catch {}
    allow();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test hooks/budget.test.mjs`
Expected: PASS (6 pre-existing + 3 new = 9).

- [ ] **Step 5: Run the full gate**

Run: `node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs`
Expected: 65 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add hooks/budget.mjs hooks/budget.test.mjs
git commit -m "feat: Stop hook reports under-budget turn ends to the goal store"
```

---

### Task 3: Fix stop-clearbot's self-matching kill query (OI-001)

**Files:**
- Modify: `watcher/stop-clearbot.cmd`

**Interfaces:**
- Consumes: nothing.
- Produces: `stop-clearbot.cmd` that kills only real clearbot instances. No API.

**Context (verified 2026-07-31):** `start-clearbot.cmd` is already correct — it requires the `-File*clearbot.ps1` token and excludes `$PID`, and reported "clearbot already running (1)" against one live instance. The stop script still uses the naive pattern and can `Stop-Process` its own probe.

- [ ] **Step 1: Read the current file**

Run: `type watcher\stop-clearbot.cmd`
Note the kill line: `... | Where-Object { $_.CommandLine -like '*clearbot.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force };`

- [ ] **Step 2: Apply the fix**

Replace the whole `powershell` invocation in `watcher/stop-clearbot.cmd` with:

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$me=$PID;" ^
  "$hits=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*clearbot.ps1*' });" ^
  "$hits | ForEach-Object { Stop-Process -Id $_.ProcessId -Force };" ^
  "Write-Host \"clearbot stopped ($($hits.Count) killed), kill switch engaged\""
```

Add this note under the existing header comment:

```cmd
rem The query MUST exclude $PID and require the -File token: this script's own
rem powershell command line contains 'clearbot.ps1' (it is inside the filter
rem string), so the naive pattern enumerated ITSELF and could Stop-Process its
rem own probe before reaching the real watcher - Stop silently not stopping.
```

- [ ] **Step 3: Verify with a decoy, not the live watcher**

Do NOT kill the running clearbot (the goal loop depends on it). Prove the discrimination instead:

```bash
powershell -NoProfile -Command "$me=$PID; @(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*clearbot.ps1*' }).Count"
```
Expected: `1` (the live clearbot) — and critically, the probing process did not count itself.

- [ ] **Step 4: Commit**

```bash
git add watcher/stop-clearbot.cmd
git commit -m "fix: stop-clearbot kill query excludes its own probe process (guards OI-001)"
```

---

### Task 4: Clearbot heartbeat

**Files:**
- Modify: `watcher/clearbot.ps1` (the `Step` function, which begins at line 268)

**Interfaces:**
- Produces: `watcher/clearbot.heartbeat` — a file whose **mtime** is the liveness signal (content is a human-readable timestamp line, not parsed by anything). Written on every `Step`, i.e. every `$IntervalMs` (2s default). Consumers (Tasks 5) treat > 30s stale as dead.

- [ ] **Step 1: Add the heartbeat write**

In `watcher/clearbot.ps1`, add near the other path variables (after `$LogFile` on line 50):

```powershell
# Liveness signal for the statusline and the SessionStart warning. The MTIME is
# the signal; the content is for a human reading the file. Written every Step,
# so "older than ~30s" means this process is gone or wedged.
$HeartbeatFile = Join-Path $PSScriptRoot 'clearbot.heartbeat'
```

Then make it the first statement inside `function Step {` — **before** the kill-switch return, so a stopped-but-alive watcher still proves it is running:

```powershell
function Step {
    try { Set-Content -Path $HeartbeatFile -Value ("alive {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding ascii } catch {}
    if (Test-Path $StopFile) { return }                       # invariant 6
```

- [ ] **Step 2: Add the heartbeat to .gitignore**

Append to `.gitignore`:

```
watcher/clearbot.heartbeat
```

- [ ] **Step 3: Verify the file parses and the heartbeat appears**

```bash
powershell -NoProfile -Command "$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content C:\code\guards\watcher\clearbot.ps1 -Raw), [ref]$null); 'parse OK'"
powershell -NoProfile -ExecutionPolicy Bypass -File C:\code\guards\watcher\clearbot.ps1 -Once
```
Then confirm freshness:
```bash
powershell -NoProfile -Command "((Get-Date) - (Get-Item C:\code\guards\watcher\clearbot.heartbeat).LastWriteTime).TotalSeconds"
```
Expected: parse OK, and a value under 30.

- [ ] **Step 4: Restart the live watcher so it runs the new code**

```bash
cmd /c C:\code\guards\watcher\stop-clearbot.cmd
cmd /c C:\code\guards\watcher\start-clearbot.cmd
```
Expected: `clearbot stopped (1 killed), kill switch engaged` then `clearbot started (1 running)`.

- [ ] **Step 5: Commit**

```bash
git add watcher/clearbot.ps1 .gitignore
git commit -m "feat: clearbot writes a heartbeat file every cycle"
```

---

### Task 5: Surface a dead watcher (statusline + SessionStart)

**Files:**
- Modify: `hooks/statusline.mjs`
- Modify: `hooks/statusline.test.mjs`
- Modify: `hooks/budget.mjs` (`onSessionStart`, the `lines.push(...)` block at lines 393–399)

**Interfaces:**
- Consumes: `watcher/clearbot.heartbeat` (Task 4).
- Produces: a `botDead(root)` behavior in both places. Staleness threshold is a shared literal `30_000` ms; a **missing** heartbeat file is treated as dead only when clearbot is expected — see Step 3's rule.

- [ ] **Step 1: Write the failing tests**

Append to `hooks/statusline.test.mjs`:

```js
// A dead watcher means no clears and no resumes - silent today, visible now.
function heartbeat(sb, ageMs) {
  const dir = path.join(sb.root, "watcher");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "clearbot.heartbeat");
  fs.writeFileSync(f, "alive");
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(f, when, when);
  return f;
}

test("a fresh heartbeat shows no warning", () => {
  const sb = sandbox(BASE_POLICY);
  heartbeat(sb, 2000);
  const t = writeTranscript(sb, 10000);
  assert.doesNotMatch(run(sb, t), /bot DEAD/);
});

test("a stale heartbeat shows bot DEAD", () => {
  const sb = sandbox(BASE_POLICY);
  heartbeat(sb, 120000);
  const t = writeTranscript(sb, 10000);
  assert.match(run(sb, t), /bot DEAD/);
});
```

The statusline reads its root from `ACC_ROOT` for this check, so extend the `run()` helper in that file to pass it:

```js
    env: { ...process.env, ACC_POLICY: sb.policyPath, ACC_PROFILE: profile || "", ACC_ROOT: sb.root },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test hooks/statusline.test.mjs`
Expected: FAIL — "bot DEAD" never appears.

- [ ] **Step 3: Implement in the statusline**

In `hooks/statusline.mjs`, the `STATE` constant is derived from `HERE`. Add an ACC_ROOT-aware root and the check. Replace:

```js
const STATE = path.resolve(HERE, "..", "runner", "state");
```

with:

```js
const ROOT = process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.resolve(HERE, "..");
const STATE = path.join(ROOT, "runner", "state");

// The watcher is what types /clear and the resume prompt. If it is dead the
// session has no autonomy at all and nothing else says so out loud.
const HEARTBEAT_STALE_MS = 30_000;
function botDead() {
  try {
    const f = path.join(ROOT, "watcher", "clearbot.heartbeat");
    return Date.now() - fs.statSync(f).mtimeMs > HEARTBEAT_STALE_MS;
  } catch {
    return false; // absent file = never started here; do not cry wolf
  }
}
```

Then add the segment in `main()`, immediately after the context-bar `parts.push(...)` block (after line 73's closing brace):

```js
  if (botDead()) parts.push(`${RED}bot DEAD${RESET}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test hooks/statusline.test.mjs`
Expected: PASS (3 pre-existing + 2 new = 5).

- [ ] **Step 5: Add the SessionStart warning**

In `hooks/budget.mjs` `onSessionStart`, insert this immediately before the final `lines.push(...[...])` block (line 393):

```js
  // If the watcher is down, this session has no auto-clear and no auto-resume.
  // Say so once, at the top, rather than letting the goal loop fail silently.
  try {
    const hb = path.join(ROOT, "watcher", "clearbot.heartbeat");
    if (Date.now() - fs.statSync(hb).mtimeMs > 30_000) {
      lines.push(
        `[ACC] WARNING: the clearbot watcher looks DEAD (stale heartbeat). Auto-clear and auto-resume will not fire. Start it: guards\\watcher\\start-clearbot.cmd`
      );
    }
  } catch {}
```

- [ ] **Step 6: Verify the SessionStart path still emits — SANDBOXED**

**Never run this hook against live state.** `bindSession` adopts a goal by
console PID, so a hand-run SessionStart from a console that owns a goal
rebinds that goal to the fake session id and breaks the real session's loop
(guards OI-006 — this happened during implementation). Always set `ACC_ROOT`:

```bash
SB="$(mktemp -d)"; mkdir -p "$SB/watcher" "$SB/runner/state"
echo '{"hook_event_name":"SessionStart","session_id":"t1","cwd":"C:/code/guards"}' | ACC_ROOT="$SB" node hooks/budget.mjs
```
Expected: JSON with `additionalContext` containing the `[ACC] Context budget:` line, and no `WARNING ... DEAD` (no heartbeat file in the sandbox = do not cry wolf).

To verify the warning path, backdate a sandbox heartbeat first:
```bash
echo alive > "$SB/watcher/clearbot.heartbeat"
powershell -NoProfile -Command "(Get-Item '<windows path to $SB>\watcher\clearbot.heartbeat').LastWriteTime = (Get-Date).AddMinutes(-5)"
echo '{"hook_event_name":"SessionStart","session_id":"t1","cwd":"C:/code/guards"}' | ACC_ROOT="$SB" node hooks/budget.mjs
```
Expected: the `[ACC] WARNING: the clearbot watcher looks DEAD` line.

**If you hijacked a live goal anyway**, repair it: re-run SessionStart from
the real console with the true session id, then `node hooks/goal.mjs kicked <goalId>`
to clear the spurious kick.

- [ ] **Step 7: Commit**

```bash
git add hooks/statusline.mjs hooks/statusline.test.mjs hooks/budget.mjs
git commit -m "feat: a dead clearbot is visible in the statusline and at session start"
```

---

### Task 6: Harden the typing channel (guards OI-004)

**Files:**
- Modify: `watcher/sendconsole.ps1` (the guard block at lines 34–39)
- Modify: `watcher/clearbot.ps1` (`Invoke-Clear` line 165, `Invoke-Cd` line 91, escalation branch line 299)

**Interfaces:**
- Produces:
  - `sendconsole.ps1` exits 1 printing `FAIL unsafe -Text` when `-Text` contains control characters (`\x00-\x1f\x7f`) or exceeds 2100 characters. Nothing is typed.
  - `clearbot.ps1` gains `Test-Binding($req)` → `$true` when `runner/state/<sessionId>.window` records a `consolePid` equal to `$req.consolePid`; `$false` (logged `REFUSE`) otherwise. Applied to `clear` and `cd` requests.
  - Escalation reads `hardK` from `policy.json`, not from the request.

- [ ] **Step 1: Harden sendconsole**

In `watcher/sendconsole.ps1`, replace the existing guard (lines 34–39):

```powershell
if (-not $Esc -and [string]::IsNullOrEmpty($Text)) {
    Write-Output 'FAIL -Text is required unless -Esc'
    exit 1
}
```

with:

```powershell
if (-not $Esc -and [string]::IsNullOrEmpty($Text)) {
    Write-Output 'FAIL -Text is required unless -Esc'
    exit 1
}
# Self-defense (guards OI-004). The closed set of typeable strings is enforced
# by clearbot's invariant 1, one layer up - but this process is what actually
# presses keys, so it refuses the two shapes that turn one injection into many:
# control characters (a newline SUBMITS, so a multi-line string is several
# prompts) and absurd length. It does not try to judge content.
if ($Text -match '[\x00-\x1f\x7f]') {
    Write-Output 'FAIL unsafe -Text: control characters (a newline would submit)'
    exit 1
}
if ($Text.Length -gt 2100) {
    Write-Output "FAIL unsafe -Text: $($Text.Length) chars exceeds 2100"
    exit 1
}
```

- [ ] **Step 2: Verify the refusals by hand**

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File C:\code\guards\watcher\sendconsole.ps1 -TargetPid 4 -Text "two`nlines"
```
Expected: `FAIL unsafe -Text: control characters (a newline would submit)`, exit 1, nothing typed. (PID 4 is System; the guard fires before any attach.)

- [ ] **Step 3: Add the binding check to clearbot**

In `watcher/clearbot.ps1`, add after `Test-Replayable` (line 75):

```powershell
# invariant 2, enforced rather than trusted (guards OI-004): a request names the
# console to type into, but the SESSION recorded its own console in
# runner/state/<sid>.window. If they disagree, someone else wrote that request -
# refuse, do not type. Missing window record = cannot verify = refuse.
function Test-Binding($req) {
    $sid = [string]$req.sessionId
    if (-not $sid) { return $false }
    $wf = Join-Path $Root ("runner\state\{0}.window" -f $sid)
    if (-not (Test-Path -LiteralPath $wf)) { return $false }
    try {
        $win = Get-Content $wf -Raw | ConvertFrom-Json
    } catch { return $false }
    return ([int]$win.consolePid -ne 0 -and [int]$win.consolePid -eq [int]$req.consolePid)
}
```

Add the check as the first statement of `Invoke-Clear` (immediately after the `function Invoke-Clear($req) {` line at 165):

```powershell
    if (-not (Test-Binding $req)) {
        Log "REFUSE $($req.sessionId): consolePid $($req.consolePid) does not match the session's own window record"
        return $false
    }
```

And in `Invoke-Cd`, immediately after the two path checks (after the `does not exist` return at line 102), before `$cpid = [int]$req.consolePid`:

```powershell
    if (-not (Test-Binding $req)) {
        Log "REFUSE cd $($req.sessionId): consolePid $($req.consolePid) does not match the session's own window record"
        return $false
    }
```

- [ ] **Step 4: Source the escalation threshold from policy**

In `watcher/clearbot.ps1`, add next to `Get-AllowedPaths` (after line 68):

```powershell
# The escalation threshold must not come from the request file - that would let
# a writer choose when Esc gets pressed. policy.json is the authority.
function Get-HardK {
    try {
        $pol = Get-Content (Join-Path $Root 'policy.json') -Raw | ConvertFrom-Json
        $v = [int]$pol.context.hardK
        if ($v -gt 0) { return $v }
    } catch {}
    return 600
}
```

Replace the escalation threshold line (line 299):

```powershell
            if ($live -lt ([int]$req.hardK * 1000 * 0.8)) { continue } # shrank or unknown
```

with:

```powershell
            if ($live -lt ((Get-HardK) * 1000 * 0.8)) { continue } # shrank or unknown
```

- [ ] **Step 5: Verify it parses and one cycle still runs clean**

```bash
powershell -NoProfile -Command "$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content C:\code\guards\watcher\clearbot.ps1 -Raw), [ref]$null); 'parse OK'"
powershell -NoProfile -ExecutionPolicy Bypass -File C:\code\guards\watcher\clearbot.ps1 -Once
```
Expected: parse OK; the `-Once` run prints nothing alarming (it may print AUTO-APPROVE lines). No `ERROR`.

- [ ] **Step 6: Restart the live watcher and commit**

```bash
cmd /c C:\code\guards\watcher\stop-clearbot.cmd
cmd /c C:\code\guards\watcher\start-clearbot.cmd
git add watcher/clearbot.ps1 watcher/sendconsole.ps1
git commit -m "fix: verify request bindings, refuse unsafe text, source hardK from policy (guards OI-004)"
```

---

### Task 7: Fast-tier clearbot suite with a stub console

**Files:**
- Create: `watcher/stubconsole.ps1`
- Create: `hooks/clearbot.test.mjs`

**Interfaces:**
- Consumes: `watcher/clearbot.ps1 -Once`, `Test-Binding` (Task 6), the heartbeat (Task 4).
- Produces:
  - `watcher/stubconsole.ps1 -LogFile <path>`: starts a console process that appends every line it reads from stdin to `<path>`, then exits when it reads `__STUBEXIT__`. Its PID is the injection target.
  - `hooks/clearbot.test.mjs`: a `node:test` suite. **Add it to the gate command everywhere it appears** (`AGENTS.md`, this plan's Global Constraints).

- [ ] **Step 1: Write the stub console**

Create `watcher/stubconsole.ps1`:

```powershell
# Test double for a Claude Code console. It owns a real console (so
# WriteConsoleInput has somewhere to write) and appends every line it reads to
# -LogFile, which is what the clearbot tests assert on. Exits on __STUBEXIT__ or
# after -TimeoutSeconds, so a failing test can never leave a process behind.
param(
    [Parameter(Mandatory=$true)][string]$LogFile,
    [int]$TimeoutSeconds = 60
)
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
New-Item -ItemType File -Path $LogFile -Force | Out-Null
while ((Get-Date) -lt $deadline) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { Start-Sleep -Milliseconds 50; continue }
    if ($line -eq '__STUBEXIT__') { break }
    Add-Content -Path $LogFile -Value $line -Encoding ascii
}
```

- [ ] **Step 2: Write the failing tests**

Create `hooks/clearbot.test.mjs`:

```js
// Fast-tier tests for watcher/clearbot.ps1 - the process that physically types.
// Until now it had ZERO automated tests, which is backwards: it is the part of
// the loop whose failure is silent and whose blast radius is a real keyboard.
//
// These drive `clearbot.ps1 -Once` against a throwaway ACC_ROOT and a stub
// console (watcher/stubconsole.ps1) whose received keystrokes land in a log
// file. They assert BOTH directions: the valid request is typed, and each
// refusal case types NOTHING.
//
// Run: node --test hooks/clearbot.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLEARBOT = path.join(REPO, "watcher", "clearbot.ps1");
const STUB = path.join(REPO, "watcher", "stubconsole.ps1");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-clearbot-"));
  for (const d of [["runner", "state"], ["runner", "clear-requests"], ["watcher"]])
    fs.mkdirSync(path.join(root, ...d), { recursive: true });
  // clearbot resolves $Root from its own location, so the sandbox needs the
  // files it reads: policy.json (hardK) and a routes table for cd requests.
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({ context: { hardK: 50 } }));
  return root;
}

// Starts the stub and returns {pid, log, kill}. The stub owns a real console
// because it is spawned detached with its own window (hidden).
function startStub() {
  const log = path.join(os.tmpdir(), `stub-${process.pid}-${Date.now()}.log`);
  const child = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", STUB, "-LogFile", log, "-TimeoutSeconds", "60"],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  // Give the console time to exist before anything attaches to it.
  execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 1200"]);
  return {
    pid: child.pid,
    log,
    kill: () => { try { process.kill(child.pid); } catch {} },
  };
}

function writeWindow(root, sid, consolePid) {
  fs.writeFileSync(
    path.join(root, "runner", "state", `${sid}.window`),
    JSON.stringify({ ok: true, hwnd: 0, consolePid, title: "stub" })
  );
}

function writeRequest(root, sid, req) {
  fs.writeFileSync(
    path.join(root, "runner", "clear-requests", `${sid}.json`),
    JSON.stringify({ sessionId: sid, kind: "clear", ctx: 60000, ...req })
  );
}

// Runs one clearbot cycle against the sandbox. clearbot derives $Root from its
// own path, so the sandbox is injected by copying the script into it.
function runOnce(root) {
  const dest = path.join(root, "watcher", "clearbot.ps1");
  fs.copyFileSync(CLEARBOT, dest);
  fs.copyFileSync(path.join(REPO, "watcher", "sendconsole.ps1"), path.join(root, "watcher", "sendconsole.ps1"));
  return execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", dest, "-Once"],
    { encoding: "utf8", timeout: 60000, windowsHide: true }
  );
}

const typed = (stub) => { try { return fs.readFileSync(stub.log, "utf8"); } catch { return ""; } };

test("a validly-bound clear request types /clear", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    writeWindow(root, "s-ok", stub.pid);
    writeRequest(root, "s-ok", { consolePid: stub.pid });
    const out = runOnce(root);
    assert.match(out, /CLEARED/);
    assert.match(typed(stub), /\/clear/);
  } finally { stub.kill(); }
});

test("a request whose consolePid does not match the session's window is refused", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    writeWindow(root, "s-bad", stub.pid + 1); // session recorded a DIFFERENT console
    writeRequest(root, "s-bad", { consolePid: stub.pid });
    const out = runOnce(root);
    assert.match(out, /REFUSE/);
    assert.equal(typed(stub).trim(), "", "nothing typed into the wrong console");
  } finally { stub.kill(); }
});

test("a request with no window record at all is refused", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    writeRequest(root, "s-nowin", { consolePid: stub.pid });
    const out = runOnce(root);
    assert.match(out, /REFUSE/);
    assert.equal(typed(stub).trim(), "");
  } finally { stub.kill(); }
});

test("an off-table cd destination is refused and never typed", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    writeWindow(root, "s-cd", stub.pid);
    writeRequest(root, "s-cd", { kind: "cd", consolePid: stub.pid, path: "C:\\Windows\\System32", replay: "hi" });
    const out = runOnce(root);
    assert.match(out, /REFUSE cd/);
    assert.equal(typed(stub).trim(), "");
  } finally { stub.kill(); }
});

test("a stale request is discarded, not executed", () => {
  const root = sandbox();
  const stub = startStub();
  try {
    writeWindow(root, "s-stale", stub.pid);
    writeRequest(root, "s-stale", { consolePid: stub.pid });
    const f = path.join(root, "runner", "clear-requests", "s-stale.json");
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(f, old, old);
    const out = runOnce(root);
    assert.match(out, /STALE/);
    assert.equal(typed(stub).trim(), "");
  } finally { stub.kill(); }
});

test("sendconsole itself refuses multi-line text", () => {
  const stub = startStub();
  try {
    let code = 0;
    try {
      execFileSync(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(REPO, "watcher", "sendconsole.ps1"),
         "-TargetPid", String(stub.pid), "-Text", "one\ntwo"],
        { encoding: "utf8", windowsHide: true }
      );
    } catch (e) { code = e.status; }
    assert.equal(code, 1, "exits 1");
    assert.equal(typed(stub).trim(), "", "nothing typed");
  } finally { stub.kill(); }
});

test("each cycle writes a heartbeat", () => {
  const root = sandbox();
  runOnce(root);
  const hb = path.join(root, "watcher", "clearbot.heartbeat");
  assert.ok(fs.existsSync(hb), "heartbeat written");
  assert.ok(Date.now() - fs.statSync(hb).mtimeMs < 30_000, "and it is fresh");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test hooks/clearbot.test.mjs`
Expected: FAIL — `stubconsole.ps1` behavior and/or the refusal paths are not yet proven. Note which cases fail and why before fixing anything.

- [ ] **Step 4: Make them pass**

Fix whatever the failures reveal, in the smallest way. Likely adjustments:
- clearbot resolves `$RoutingMd` as `<parent of $Root>\ROUTING.md`; for the sandbox, copy the real `C:\code\ROUTING.md` to `<sandbox parent>` or accept that cd tests only exercise the refusal branch (the test above only asserts refusal, which needs no table).
- If the stub's console cannot be attached to, spawn it via `cmd /c start` instead of `spawn` so it gets a genuine console; adjust `startStub` accordingly and keep the same return shape.

Do NOT weaken an assertion to make a test pass. If a refusal is not logged as `REFUSE`, fix the log line in clearbot.

- [ ] **Step 5: Run the full gate (now six files)**

Run: `node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs hooks/clearbot.test.mjs`
Expected: all pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add watcher/stubconsole.ps1 hooks/clearbot.test.mjs
git commit -m "test: fast-tier clearbot suite - typing, refusals and heartbeat against a stub console"
```

---

### Task 8: Watchdog (Scheduled Task)

**Files:**
- Create: `runbox/acc-watchdog-register.ps1`
- Create: `runbox/acc-watchdog-unregister.ps1`

**Interfaces:**
- Produces: a Windows Scheduled Task named `ACC clearbot watchdog` that runs `watcher/start-clearbot.cmd` at logon and every 2 minutes. `start-clearbot.cmd` is already idempotent (verified: prints "clearbot already running (N)" and exits 0), so repeated runs are no-ops.
- These are runbox scripts: they need Kyle's authority and are executed by the ACC auto-approve flow (or `/approve`). Per `AGENTS.md`, the leading comment IS the preview summary, and standing re-runnable scripts carry `# guards: keep` in the first 10 lines — these are one-shot, so do NOT add that marker.

- [ ] **Step 1: Write the register script**

Create `runbox/acc-watchdog-register.ps1`:

```powershell
# Registers the "ACC clearbot watchdog" Scheduled Task so the clear-watcher is
# restarted automatically at logon and every 2 minutes if it is not running.
# Without this, one crash or one reboot silently ends ALL ACC autonomy: no
# auto-clear, no goal resume. start-clearbot.cmd is idempotent, so the repeat
# trigger is a no-op whenever the watcher is already up.
$ErrorActionPreference = 'Stop'
$name = 'ACC clearbot watchdog'
$cmd  = 'C:\code\guards\watcher\start-clearbot.cmd'
if (-not (Test-Path $cmd)) { throw "missing $cmd" }

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $cmd + '"')
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
            -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($atLogon, $repeat) `
    -Settings $settings -Description 'Keeps the ACC clear-watcher alive (see C:\code\guards\AGENTS.md)' -Force | Out-Null

Write-Host "registered: $name"
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-List
```

- [ ] **Step 2: Write the unregister script**

Create `runbox/acc-watchdog-unregister.ps1`:

```powershell
# Removes the "ACC clearbot watchdog" Scheduled Task. Autonomy stops being
# self-healing after this: a crashed clear-watcher stays down until started by
# hand (guards\watcher\start-clearbot.cmd or the Command Center button).
$ErrorActionPreference = 'Stop'
$name = 'ACC clearbot watchdog'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "removed: $name"
} else {
    Write-Host "not registered: $name"
}
```

- [ ] **Step 3: Have the register script run**

The ACC auto-approve watcher runs pending runbox scripts itself (`policy.json autoApprove.enabled` is true). Wait for it, or tell Kyle to type `/approve`. Confirm from the approvals log:

```bash
powershell -NoProfile -Command "Get-Content C:\code\guards\watcher\approvals.log -Tail 6"
```
Expected: an `OK` entry for `acc-watchdog-register.ps1`.

- [ ] **Step 4: Verify the task exists and the no-op path is clean**

```bash
powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'ACC clearbot watchdog' | Select-Object TaskName,State | Format-List"
cmd /c C:\code\guards\watcher\start-clearbot.cmd
```
Expected: `State: Ready`; the start script prints `clearbot already running (1)` and does not spawn a second instance.

- [ ] **Step 5: Prove it actually heals a crash**

```bash
powershell -NoProfile -Command "Start-ScheduledTask -TaskName 'ACC clearbot watchdog'"
```
Then kill the watcher and let the task restore it:
```bash
cmd /c C:\code\guards\watcher\stop-clearbot.cmd
powershell -NoProfile -Command "Remove-Item C:\code\guards\watcher\clearbot.stop -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName 'ACC clearbot watchdog'; Start-Sleep -Seconds 6; $me=$PID; @(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*clearbot.ps1*' }).Count"
```
Expected: `1` — the watcher is back without a human starting it. **Note:** `stop-clearbot.cmd` writes the kill switch, which the command above removes; if you skip that removal the restarted watcher will idle.

- [ ] **Step 6: Commit**

Runbox scripts are auto-archived to the runbox trash after a successful run and `runbox/` is gitignored, so copy them to a tracked location for the record:

```bash
mkdir -p watcher/watchdog
cp runbox/acc-watchdog-register.ps1 watcher/watchdog/ 2>/dev/null || powershell -NoProfile -Command "Copy-Item C:\code\guards\runbox\.trash\*acc-watchdog-*.ps1 C:\code\guards\watcher\watchdog\ -ErrorAction SilentlyContinue"
git add watcher/watchdog
git commit -m "feat: scheduled-task watchdog keeps the clear-watcher alive across crashes and reboots"
```

---

### Task 9: Proof-tier harness — happy loop and the stall regression

**Files:**
- Create: `e2e/loop.e2e.mjs`

**Interfaces:**
- Produces: `node e2e/loop.e2e.mjs [--only <n>]` — runs numbered scenarios, prints `SCENARIO n PASS|FAIL` plus the log excerpt each verdict rests on, exits non-zero if any fail. Scenarios 1 and 2 here; 3 and 4 in Task 10.
- Consumes: everything above. Uses a sandboxed `ACC_ROOT`, `ACC_POLICY` (hardK ~5), and `CLAUDE_CONFIG_DIR` so it never touches live state, and spawns a REAL `claude` in a hidden console.

**Cost note:** this tier spends tokens. Keep prompts tiny and the model cheap (`--model claude-haiku-4-5-20251001`).

- [ ] **Step 1: Write the harness skeleton and scenario 1**

Create `e2e/loop.e2e.mjs`:

```js
#!/usr/bin/env node
// PROOF TIER: drives a REAL Claude Code console through the ACC loop.
//
// The fast tier proves the pieces in isolation; this proves the promise Kyle
// actually made: "it tracks the session, clears and re-prompts without fail."
// Nothing else in the repo exercises the TUI semantics - whether /clear really
// clears, whether the kick really starts a turn - so this is the gate that
// decides the loop is done.
//
// It is NOT hermetic and it SPENDS TOKENS. Run deliberately:
//   node e2e/loop.e2e.mjs            # all scenarios
//   node e2e/loop.e2e.mjs --only 2   # one scenario
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MODEL = "claude-haiku-4-5-20251001";

function sandbox(hardK) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-e2e-"));
  for (const d of [["runner", "state"], ["runner", "clear-requests"], ["runner", "goals"], ["watcher"], ["cfg"]])
    fs.mkdirSync(path.join(root, ...d), { recursive: true });
  const policyPath = path.join(root, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({
    context: { softK: Math.max(1, hardK - 2), hardK },
    week: { amberTokens: 0, redTokens: 0, effectiveFrom: "" },
    subagents: { mode: "allowlist", allow: [], maxPerSession: 0, exploreMaxReportLines: 80 },
    review: { fullLeanReview: "manual-only", localFullSuiteInReview: false, maxFinders: 1 },
    runner: { stopOnRed: false, statusFile: "SLICE-RUNNER.md", waitingGuard: false },
    autoClear: { enabled: true },
    goals: { autoResume: true, maxCycles: 0, kickSettleSeconds: 5, humanHoldMinutes: 0 },
    autoApprove: { enabled: false },
  }));
  return { root, policyPath };
}

// A hidden console running claude, with ACC hooks pointed at the sandbox.
function startSession(sb, goalId) {
  const child = spawn(
    "cmd.exe",
    ["/c", "start", "/min", "claude", "--model", MODEL],
    {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ACC_ROOT: sb.root,
        ACC_POLICY: sb.policyPath,
        ACC_GOAL: goalId || "",
        CLAUDE_CONFIG_DIR: path.join(sb.root, "cfg"),
      },
      cwd: REPO,
    }
  );
  return child;
}

const sleep = (ms) => execFileSync("powershell", ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`]);

// Poll a predicate until true or timeout. Returns true/false; never throws.
function waitFor(label, ms, fn) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (fn()) return true; } catch {}
    sleep(2000);
  }
  console.log(`    timeout waiting for: ${label}`);
  return false;
}

function clearbotLog(sb) {
  try { return fs.readFileSync(path.join(sb.root, "watcher", "clearbot.log"), "utf8"); } catch { return ""; }
}

function goalJson(sb, id) {
  try { return JSON.parse(fs.readFileSync(path.join(sb.root, "runner", "goals", `${id}.json`), "utf8")); } catch { return null; }
}

// Runs one clearbot cycle against the sandbox (instead of a resident watcher,
// so the scenario controls timing and nothing lingers after a failure).
function clearbotOnce(sb) {
  fs.copyFileSync(path.join(REPO, "watcher", "clearbot.ps1"), path.join(sb.root, "watcher", "clearbot.ps1"));
  fs.copyFileSync(path.join(REPO, "watcher", "sendconsole.ps1"), path.join(sb.root, "watcher", "sendconsole.ps1"));
  fs.copyFileSync(path.join(REPO, "watcher", "stubconsole.ps1"), path.join(sb.root, "watcher", "stubconsole.ps1"));
  try {
    return execFileSync("powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(sb.root, "watcher", "clearbot.ps1"), "-Once"],
      { encoding: "utf8", timeout: 120000, windowsHide: true });
  } catch (e) { return String(e.stdout || "") + String(e.stderr || ""); }
}

const results = [];
function report(n, name, pass, evidence) {
  results.push({ n, pass });
  console.log(`SCENARIO ${n} ${pass ? "PASS" : "FAIL"} - ${name}`);
  console.log(evidence.split("\n").map((l) => "    " + l).join("\n"));
}

// ---------------------------------------------------------------- scenario 1
// The happy loop: over budget -> request -> CLEARED -> new session adopts the
// goal -> kick typed -> cycle logged.
async function scenario1() {
  const sb = sandbox(5);
  const goal = JSON.parse(execFileSync("node",
    [path.join(REPO, "hooks", "goal.mjs"), "new", "--text", "Say the word BANANA and stop.", "--cwd", REPO],
    { encoding: "utf8", env: { ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath } }));

  startSession(sb, goal.id);
  const bound = waitFor("session binds to the goal", 120000, () => goalJson(sb, goal.id)?.sessionId);
  const cleared = bound && waitFor("clearbot types /clear", 180000, () => {
    clearbotOnce(sb);
    return /CLEARED/.test(clearbotLog(sb));
  });
  const cycled = cleared && waitFor("cycle logged", 60000, () => (goalJson(sb, goal.id)?.cycles || 0) >= 1);
  const resumed = cycled && waitFor("goal resumed in a new session", 180000, () => {
    clearbotOnce(sb);
    return /RESUMED goal/.test(clearbotLog(sb));
  });

  report(1, "over-budget clear and resume", !!resumed, clearbotLog(sb).trim() || "(no clearbot log)");
}

// ---------------------------------------------------------------- scenario 2
// THE 2026-07-31 REGRESSION: a turn that ends UNDER budget must still be
// re-prompted. Before the liveness fix this hung forever (observed: 18 min).
async function scenario2() {
  const sb = sandbox(400); // high ceiling: the turn cannot go over budget
  const goal = JSON.parse(execFileSync("node",
    [path.join(REPO, "hooks", "goal.mjs"), "new", "--text", "Reply with exactly: ok. Then stop.", "--cwd", REPO],
    { encoding: "utf8", env: { ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath } }));

  startSession(sb, goal.id);
  const bound = waitFor("session binds", 120000, () => goalJson(sb, goal.id)?.sessionId);
  const armed = bound && waitFor("under-budget turn end re-arms the kick", 180000,
    () => goalJson(sb, goal.id)?.needsKick === true && goalJson(sb, goal.id)?.turnEndedAt);
  const kicked = armed && waitFor("clearbot re-prompts without a clear", 120000, () => {
    clearbotOnce(sb);
    return /RESUMED goal/.test(clearbotLog(sb));
  });

  const g = goalJson(sb, goal.id);
  report(2, "under-budget turn end is re-prompted (guards OI-002)", !!kicked,
    `needsKick=${g?.needsKick} turnEndedAt=${g?.turnEndedAt} lastKickAt=${g?.lastKickAt}\n` +
    (clearbotLog(sb).trim() || "(no clearbot log)"));
}

const only = process.argv.includes("--only") ? Number(process.argv[process.argv.indexOf("--only") + 1]) : 0;
const all = { 1: scenario1, 2: scenario2 };
for (const [n, fn] of Object.entries(all)) if (!only || only === Number(n)) await fn();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 2: Run scenario 2 first (it is the regression that matters most)**

Run: `node e2e/loop.e2e.mjs --only 2`
Expected on a correct implementation: `SCENARIO 2 PASS`. If it fails, the evidence block prints `needsKick`, `turnEndedAt` and the clearbot log — debug from that, do not weaken the scenario.

- [ ] **Step 3: Run scenario 1**

Run: `node e2e/loop.e2e.mjs --only 1`
Expected: `SCENARIO 1 PASS`.

Likely friction to solve here (all are harness bugs, not product bugs — fix the harness):
- `cmd /c start claude` may not inherit the env; if the hooks fire against live state instead of the sandbox, launch via a generated `.cmd` that `set`s the four variables then calls `claude`.
- The session may need a first prompt to produce a transcript; use `watcher/sendconsole.ps1 -TargetPid <pid> -Text "hi"` against the spawned console, obtaining the pid from `runner/state/<sid>.window`.

- [ ] **Step 4: Commit**

```bash
git add e2e/loop.e2e.mjs
git commit -m "test: proof-tier E2E - real-claude happy loop and the under-budget stall regression"
```

---

### Task 10: Proof-tier scenarios 3 (escalation) and 4 (/cd)

**Files:**
- Modify: `e2e/loop.e2e.mjs`

**Interfaces:**
- Consumes: the harness helpers from Task 9 (`sandbox`, `startSession`, `waitFor`, `clearbotOnce`, `clearbotLog`, `goalJson`, `report`).
- Produces: scenarios 3 and 4 registered in the `all` map.

- [ ] **Step 1: Add scenario 3 (closes OI-011's owed evidence)**

Insert before the `const only = ...` line in `e2e/loop.e2e.mjs`:

```js
// ---------------------------------------------------------------- scenario 3
// ESCALATION (OI-011): when a Stop hook keeps refusing to let the turn end, the
// typed /clear cannot execute. clearbot must notice the re-written request and
// press Esc to interrupt the turn, then clear. This path has NEVER fired for
// real - this scenario is the evidence OI-011 has been owed since 2026-07-31.
async function scenario3() {
  const sb = sandbox(5);
  // A sandbox-local Stop hook that always blocks - the pathological case.
  const hookFile = path.join(sb.root, "block-stop.mjs");
  fs.writeFileSync(hookFile,
    `process.stdout.write(JSON.stringify({decision:"block",reason:"sandbox: refusing to stop"}));process.exit(0);\n`);
  fs.writeFileSync(path.join(sb.root, "cfg", "settings.json"), JSON.stringify({
    hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: `node ${hookFile.replace(/\\/g, "/")}` }] }] },
  }));

  const goal = JSON.parse(execFileSync("node",
    [path.join(REPO, "hooks", "goal.mjs"), "new", "--text", "Count to five slowly, then stop.", "--cwd", REPO],
    { encoding: "utf8", env: { ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath } }));

  startSession(sb, goal.id);
  const bound = waitFor("session binds", 120000, () => goalJson(sb, goal.id)?.sessionId);
  // Two cycles at least 60s apart: the first types /clear (throttled), the
  // second sees the re-written request and escalates.
  const escalated = bound && waitFor("clearbot escalates with Esc", 300000, () => {
    clearbotOnce(sb);
    return /ESCALATE/.test(clearbotLog(sb));
  });
  const cleared = escalated && waitFor("and the clear lands", 120000, () => {
    clearbotOnce(sb);
    return /CLEARED/.test(clearbotLog(sb));
  });

  report(3, "Esc escalation when the turn refuses to end (OI-011)", !!cleared,
    clearbotLog(sb).trim() || "(no clearbot log)");
}
```

- [ ] **Step 2: Add scenario 4 (diagnoses guards OI-003)**

Insert directly after scenario 3:

```js
// ---------------------------------------------------------------- scenario 4
// /cd RELIABILITY (guards OI-003): on 2026-07-31 clearbot typed /cd twice and
// the session's cwd did not change either time. This scenario is the rig that
// tells us WHY: it asserts the cwd actually moved, and prints what was typed
// when it did not. Acceptance is the observation, not any particular fix.
async function scenario4() {
  const sb = sandbox(400);
  const goal = JSON.parse(execFileSync("node",
    [path.join(REPO, "hooks", "goal.mjs"), "new", "--text", "Reply with exactly: ok.", "--cwd", REPO],
    { encoding: "utf8", env: { ...process.env, ACC_ROOT: sb.root, ACC_POLICY: sb.policyPath } }));

  startSession(sb, goal.id);
  const bound = waitFor("session binds", 120000, () => goalJson(sb, goal.id)?.sessionId);
  const sid = goalJson(sb, goal.id)?.sessionId;
  const win = bound && JSON.parse(fs.readFileSync(path.join(sb.root, "runner", "state", `${sid}.window`), "utf8"));

  // Ask route.mjs for a real, on-table destination and queue the cd by hand,
  // exactly as the UserPromptSubmit hook would.
  const dest = "C:\\code\\guards";
  fs.writeFileSync(path.join(sb.root, "runner", "clear-requests", `${sid}.cd.json`), JSON.stringify({
    kind: "cd", sessionId: sid, consolePid: win.consolePid, path: dest, clear: false, replay: "pwd", queued: false,
  }));

  const typedCd = bound && waitFor("clearbot types /cd", 120000, () => {
    clearbotOnce(sb);
    return /CD .* -> /.test(clearbotLog(sb));
  });
  // The proof the cd TOOK: the session's next route verdict is computed from
  // its cwd, so the .route state file records the new folder.
  const took = typedCd && waitFor("cwd actually changed", 120000, () => {
    const rf = path.join(sb.root, "runner", "state", `${sid}.route`);
    try { return fs.readFileSync(rf, "utf8").includes("guards"); } catch { return false; }
  });

  report(4, "a typed /cd actually changes the session cwd (guards OI-003)", !!took,
    clearbotLog(sb).trim() || "(no clearbot log)");
}
```

Register both in the map — replace the `const all = { 1: scenario1, 2: scenario2 };` line with:

```js
const all = { 1: scenario1, 2: scenario2, 3: scenario3, 4: scenario4 };
```

- [ ] **Step 3: Run scenario 3**

Run: `node e2e/loop.e2e.mjs --only 3`
Expected: `SCENARIO 3 PASS` with `ESCALATE` and `CLEARED` in the evidence. This is the evidence OI-011 has been waiting for — paste the excerpt into the goal log when it passes.

- [ ] **Step 4: Run scenario 4 and act on what it shows**

Run: `node e2e/loop.e2e.mjs --only 4`

- If it PASSES twice consecutively: guards OI-003 was environmental; record that in the ledger with the evidence and move on.
- If it FAILS: the evidence names the failing half (typed vs took). Fix per the spec's diagnose-first rule — most likely a readiness wait before typing `/cd` plus one logged retry — then re-run until it passes **twice consecutively**.

- [ ] **Step 5: Commit**

```bash
git add e2e/loop.e2e.mjs
git commit -m "test: proof-tier scenarios for Esc escalation (OI-011) and /cd reliability (OI-003)"
```

---

### Task 11: Documentation, ledger, and the DONE gate

**Files:**
- Modify: `AGENTS.md` (the "The regression, exactly" block and the "Goals" section)
- Modify: `OPEN-ISSUES.md` (guards)
- Modify: `SLICE-RUNNER.md`

- [ ] **Step 1: Update the regression block in AGENTS.md**

Replace the fenced command block under `## The regression, exactly` with:

```
node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs hooks/clearbot.test.mjs
    -> fast tier, hermetic; run from C:\code\guards. Never `node --test hooks/`
       (the runner grades the directory as one bogus failing test).
node e2e/loop.e2e.mjs [--only N]
    -> PROOF TIER: spawns a REAL claude and spends tokens. Scenarios:
       1 happy loop, 2 under-budget re-prompt, 3 Esc escalation, 4 /cd.
powershell -File C:/code/guards/guards-gui.ps1 -SmokeTest
powershell -File C:/code/guards/watcher/screenshot-gui.ps1 [-Advanced]
```

- [ ] **Step 2: Document liveness and the watchdog in the Goals section**

Append to the `## Goals` section of `AGENTS.md`:

```markdown
Two things keep the loop from stalling. **Liveness:** a goal session that ends
its turn UNDER the ceiling gets no clear, so the Stop hook re-arms the kick
instead (`goal.mjs recordTurnEnd`), and `pendingKicks` decides when it is safe
to fire — after `goals.kickSettleSeconds` (90), and not within
`goals.humanHoldMinutes` (10) of a prompt Kyle typed, so it stays quiet during
a conversation and self-heals when he leaves. Before this, an under-budget turn
end ended the loop (observed twice on 2026-07-31, once for 18 minutes).
**Supervision:** clearbot writes `watcher/clearbot.heartbeat` every cycle; the
statusline shows `bot DEAD` and SessionStart warns when it goes stale, and the
"ACC clearbot watchdog" Scheduled Task restarts it at logon and every 2 minutes.
```

- [ ] **Step 3: Flip the ledger entries**

In `C:\code\guards\OPEN-ISSUES.md`, delete the resolved entries and add one line each under `## Resolved`, naming what landed and the evidence:
- OI-001 (stop-clearbot self-match) — fixed in Task 3.
- OI-002 (under-budget stall) — fixed in Tasks 1–2, proven by E2E scenario 2.
- OI-004 (request binding) — fixed in Task 6, proven by the fast-tier refusal cases.
- OI-003 (/cd) — only if scenario 4 passes twice; otherwise annotate with the new evidence and leave open.

In `C:\code\OPEN-ISSUES.md`, resolve OI-011 with the scenario-3 excerpt.

- [ ] **Step 4: Run both tiers as the final gate**

```bash
node --test hooks/budget.test.mjs hooks/goal.test.mjs hooks/usage.test.mjs hooks/route.test.mjs hooks/statusline.test.mjs hooks/clearbot.test.mjs
node e2e/loop.e2e.mjs
```
Expected: fast tier all pass; proof tier scenarios 1–3 PASS (4 too, unless it was left open in Step 3).

**This is the ACC goal's DONE gate.** Only when it is green may the goal be closed:
```bash
node C:/code/guards/hooks/goal.mjs done g-20260731-134525-09wb
```

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md OPEN-ISSUES.md SLICE-RUNNER.md ../OPEN-ISSUES.md
git commit -m "docs: liveness, watchdog and the two test tiers; ledger flips for the autonomy work"
```

---

## Self-review notes

**Spec coverage:** §1 Liveness → Tasks 1–2. §2 Supervision → Tasks 3 (probe), 4 (heartbeat), 5 (visibility), 8 (watchdog). §3 Typing hardening → Task 6. §4 /cd → Task 10 scenario 4. §5 Tests → Task 7 (fast tier) + Tasks 9–10 (proof tier); every row of the spec's mapping table has a test above. §6 Observability → Task 5. DONE gate → Task 11 Step 4.

**Known deviations from the spec, deliberate:** the OI-001 target moved from `start-clearbot.cmd` to `stop-clearbot.cmd` (start was verified already fixed on 2026-07-31); the spec was corrected in place before this plan was written.

**Type consistency:** `recordTurnEnd(id, {human})`, `pendingKicks(now, opts)`, `Test-Binding($req)`, `Get-HardK`, `botDead()`, `startStub()`/`typed(stub)`, and the harness helpers are each defined once and used with the same names and shapes throughout.

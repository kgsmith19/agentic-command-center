# Machine-Wide Claude Launch Cap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a hard, machine-wide cap (default 3) on concurrent `claude.exe` processes regardless of launch path, via a fail-open PATH-shim gate plus a standalone alert-only watcher.

**Architecture:** A new `gate` mode in `hooks/lane.mjs` counts live `claude.exe` processes (matched by absolute exe path, via `Get-CimInstance Win32_Process`) against `policy.json`'s new `lane.total.cap`/`lane.total.exe`, exiting 42 to refuse or falling through silently to allow. `shim/claude.cmd` / `shim/claude` sit ahead of the real `claude.exe` on PATH, call the gate, and only refuse on an explicit exit 42 — any other outcome (crash, missing node) execs the real binary. `watcher/claude-cap-watch.ps1` is a standalone, code-independent, alert-only Scheduled Task that flags breaches and silent fail-opens.

**Tech Stack:** Node.js (`hooks/lane.mjs`, `node --test`), Windows batch + POSIX sh (shim), PowerShell (watcher), `policy.json` config.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-03-claude-launch-cap-design.md` (committed `ca628b5`, approved). Implement exactly what it calls for — no extra scope.
- TDD, RED first: write the failing test, confirm it fails, then implement.
- `hooks/lane.mjs` is a covgate-scoped lib file: changed lines need 100% line/function coverage and >=85% branch coverage (its existing `policy.json` `tests.branchFloorOverrides["hooks/lane.mjs"]` override, per OI-017 — do not lower it further).
- Fast tier: `npm run test:windows`, run from `C:\code\guards`. Coverage gate: `node hooks/covgate.mjs`.
- `.ps1` tests are NOT wired into `package.json` — invoke directly: `powershell -NoProfile -ExecutionPolicy Bypass -File <path>` (matches `gui/ptyhost.test.ps1`'s existing convention, including its `Check($name, $cond)` PASS/FAIL assertion style).
- Never spend real API tokens/run `e2e/loop.e2e.mjs` as part of this plan's own verification — Kyle decides that timing separately, same as OI-025.
- Machine-state changes (user PATH, Scheduled Task registration) are NOT executed directly — they are written as one self-contained, idempotent script into `runbox/` per `AGENTS.md`'s runbox rules, for Kyle to run via `/approve`.
- No secrets involved; nothing here touches the vault.
- Commit after each task (small, working diffs), per repo convention.

---

### Task 1: Pure gate-decision primitives — `isUtilityInvocation`, `countCappedProcesses`

**Files:**
- Modify: `hooks/lane.mjs` (add near the bottom of the breaker section, before the CLI section at line 347)
- Modify: `hooks/lane.mjs:65-68` (imports — add `execFileSync`, used by Task 3, but declare now to avoid a second import-block edit)
- Test: `hooks/lane.test.mjs`

**Interfaces:**
- Produces: `isUtilityInvocation(args: string[]) -> boolean`
- Produces: `countCappedProcesses(exePaths: string[], listProcesses?: () => Array<{ProcessId, ExecutablePath, CreationDate}>) -> Array<{ProcessId, ExecutablePath, CreationDate}>` — `listProcesses` defaults to `queryClaudeProcesses` (Task 3; forward-reference is fine, `countCappedProcesses`'s default param is only evaluated when actually called with no override, which no test in this task does)

- [ ] **Step 1: Write the failing tests**

Add to `hooks/lane.test.mjs` (anywhere after the existing imports/setup, e.g. right after the `runCli` tests block ending at line 602):

```javascript
test("isUtilityInvocation recognizes known utility tokens, nothing else", () => {
  assert.equal(isUtilityInvocation(["--version"]), true);
  assert.equal(isUtilityInvocation(["--help"]), true);
  assert.equal(isUtilityInvocation(["doctor"]), true);
  assert.equal(isUtilityInvocation(["update"]), true);
  assert.equal(isUtilityInvocation(["install"]), true);
  assert.equal(isUtilityInvocation(["mcp"]), true);
  assert.equal(isUtilityInvocation(["config"]), true);
  assert.equal(isUtilityInvocation(["-p", "hello"]), false);
  assert.equal(isUtilityInvocation([]), false);
  assert.equal(isUtilityInvocation(undefined), false);
});

test("countCappedProcesses matches by exact exe path, case-insensitively, ignoring unmatched paths", () => {
  const procs = [
    { ProcessId: 1, ExecutablePath: "C:\\real\\claude.exe", CreationDate: "t1" },
    { ProcessId: 2, ExecutablePath: "C:\\REAL\\CLAUDE.EXE", CreationDate: "t2" },
    { ProcessId: 3, ExecutablePath: "C:\\Program Files\\WindowsApps\\Claude_1\\app\\claude.exe", CreationDate: "t3" },
    { ProcessId: 4, ExecutablePath: null, CreationDate: "t4" },
  ];
  const matched = countCappedProcesses(["C:\\real\\claude.exe"], () => procs);
  assert.deepEqual(matched.map((p) => p.ProcessId), [1, 2]);
});

test("countCappedProcesses returns empty when the lister returns nothing", () => {
  assert.deepEqual(countCappedProcesses(["C:\\real\\claude.exe"], () => []), []);
});
```

Add `isUtilityInvocation, countCappedProcesses` to the destructured import block at line ~35 (`const { acquireSlot, ... } = await import("./lane.mjs");`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test hooks/lane.test.mjs`
Expected: FAIL — `isUtilityInvocation is not defined` / `countCappedProcesses is not defined`.

- [ ] **Step 3: Implement**

In `hooks/lane.mjs:65-68`, change:

```javascript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
```

to:

```javascript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
```

Insert before the `// ------------------------------------------------------------------- CLI` comment at line 347:

```javascript
// ------------------------------------------------------------- launch cap
// Machine-wide ceiling on concurrent claude.exe, independent of the lane
// slots above (those are cooperative; this is enforced at every claude
// resolution via the shim — see shim/claude.cmd). Policy: policy.json
// lane.total.{cap, exe}. No cap/exe configured = fail open (gate() below).
const UTILITY_ARGS = new Set(["--version", "-v", "--help", "-h", "doctor", "update", "install", "mcp", "config"]);

// Subcommands/flags that never start a session — these bypass the cap
// entirely, uncounted, so `claude --version` never queues behind a busy
// machine.
export function isUtilityInvocation(args) {
  const first = args && args[0];
  return first != null && UTILITY_ARGS.has(String(first));
}

// Matched by absolute exe PATH, never by image name — claude.exe is also the
// name of the (separate, unrelated) desktop app's bundled binary at a
// different path, which must never count against this cap.
export function countCappedProcesses(exePaths, listProcesses = queryClaudeProcesses) {
  const procs = listProcesses() || [];
  const wanted = new Set((exePaths || []).map((p) => String(p).toLowerCase()));
  return procs.filter((p) => p && p.ExecutablePath && wanted.has(String(p.ExecutablePath).toLowerCase()));
}
```

(`queryClaudeProcesses` is added in Task 3 — this file will not fully run standalone until then; that's fine, Task 1's own tests always pass an explicit `listProcesses` override.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test hooks/lane.test.mjs`
Expected: the 3 new tests PASS. (Pre-existing tests may fail to *import* until Task 3 adds `queryClaudeProcesses` — if so, temporarily stub `function queryClaudeProcesses() { return []; }` above the new block, and delete the stub in Task 3 Step 3.)

- [ ] **Step 5: Commit**

```bash
git add hooks/lane.mjs hooks/lane.test.mjs
git commit -m "feat(guards): add isUtilityInvocation/countCappedProcesses gate primitives"
```

---

### Task 2: `gate()` — the decision function

**Files:**
- Modify: `hooks/lane.mjs` (immediately after `countCappedProcesses`)
- Test: `hooks/lane.test.mjs`

**Interfaces:**
- Consumes: `laneConfig()` (existing, `hooks/lane.mjs:100`), `laneStatusAll()` (existing, `hooks/lane.mjs:172`), `isUtilityInvocation`, `countCappedProcesses` (Task 1)
- Produces: `gate(args: string[], opts?: {listProcesses?: () => Array}) -> {ok: true, reason?: string, count?: number, cap?: number} | {ok: false, count: number, cap: number, holders: Array<{pid, startedAt, label}>}`

- [ ] **Step 1: Write the failing tests**

Add to `hooks/lane.test.mjs`:

```javascript
test("gate: no lane.total configured at all -> ok true (fail open)", () => {
  setPolicy({});
  assert.deepEqual(gate(["-p", "hi"]), { ok: true, reason: "no-cap-configured" });
});

test("gate: cap configured but no exe list -> ok true (fail open)", () => {
  setPolicy({ total: { cap: 3 } });
  assert.deepEqual(gate(["-p", "hi"]), { ok: true, reason: "no-exe-configured" });
});

test("gate: utility invocation bypasses cap entirely, never calls the lister", () => {
  setPolicy({ total: { cap: 0, exe: ["C:\\real\\claude.exe"] } });
  let called = false;
  const out = gate(["--version"], { listProcesses: () => { called = true; return []; } });
  assert.deepEqual(out, { ok: true, reason: "utility" });
  assert.equal(called, false);
});

test("gate: under cap -> ok true with count", () => {
  setPolicy({ total: { cap: 3, exe: ["C:\\real\\claude.exe"] } });
  const procs = [{ ProcessId: 1, ExecutablePath: "C:\\real\\claude.exe" }];
  assert.deepEqual(gate(["-p", "hi"], { listProcesses: () => procs }), { ok: true, count: 1, cap: 3 });
});

test("gate: at cap -> ok false with holder pid/startedAt, no lane label when unheld", () => {
  setPolicy({ total: { cap: 1, exe: ["C:\\real\\claude.exe"] } });
  const procs = [{ ProcessId: 999999, ExecutablePath: "C:\\real\\claude.exe", CreationDate: "2026-08-03T00:00:00Z" }];
  const out = gate(["-p", "hi"], { listProcesses: () => procs });
  assert.equal(out.ok, false);
  assert.equal(out.count, 1);
  assert.equal(out.cap, 1);
  assert.deepEqual(out.holders, [{ pid: 999999, startedAt: "2026-08-03T00:00:00Z", label: null }]);
});

test("gate: over cap enriches a holder with its lane label when the pid holds a real slot", async () => {
  setPolicy({ total: { cap: 1, exe: ["C:\\real\\claude.exe"] } });
  const held = await acquireSlot("labeled-holder", { category: "interactive" });
  try {
    const procs = [{ ProcessId: process.pid, ExecutablePath: "C:\\real\\claude.exe", CreationDate: "now" }];
    const out = gate(["-p", "hi"], { listProcesses: () => procs });
    assert.equal(out.ok, false);
    assert.equal(out.holders[0].label, "labeled-holder");
  } finally {
    held.release();
  }
});

test("gate: lister throwing -> ok true (fail open), reason count-failed", () => {
  setPolicy({ total: { cap: 1, exe: ["C:\\real\\claude.exe"] } });
  const out = gate(["-p", "hi"], { listProcesses: () => { throw new Error("CIM unavailable"); } });
  assert.equal(out.ok, true);
  assert.equal(out.reason, "count-failed");
  assert.match(out.error, /CIM unavailable/);
});
```

Add `gate` to the destructured import block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test hooks/lane.test.mjs`
Expected: FAIL — `gate is not defined`.

- [ ] **Step 3: Implement**

Insert immediately after `countCappedProcesses`'s closing brace:

```javascript
function laneLabelForPid(pid) {
  const all = laneStatusAll();
  for (const list of [all.automation, all.interactive]) {
    const hit = list.find((s) => Number(s.pid) === Number(pid));
    if (hit) return hit.label || null;
  }
  return null;
}

// The gate: ok:true means "let it through" (default — every unconfigured or
// erroring path fails open, on purpose). ok:false means "refuse" and is the
// ONLY outcome the shim (shim/claude.cmd) maps to exit 42.
export function gate(args, opts = {}) {
  if (isUtilityInvocation(args)) return { ok: true, reason: "utility" };
  const cfg = laneConfig();
  const total = (cfg.total && typeof cfg.total === "object") ? cfg.total : {};
  const cap = Number(total.cap);
  if (!Number.isFinite(cap)) return { ok: true, reason: "no-cap-configured" };
  const exePaths = Array.isArray(total.exe) ? total.exe : [];
  if (!exePaths.length) return { ok: true, reason: "no-exe-configured" };
  let matched;
  try {
    matched = countCappedProcesses(exePaths, opts.listProcesses);
  } catch (e) {
    return { ok: true, reason: "count-failed", error: String((e && e.message) || e) };
  }
  if (matched.length < cap) return { ok: true, count: matched.length, cap };
  return {
    ok: false,
    count: matched.length,
    cap,
    holders: matched.map((p) => ({ pid: p.ProcessId, startedAt: p.CreationDate || null, label: laneLabelForPid(p.ProcessId) })),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test hooks/lane.test.mjs`
Expected: all new tests PASS; full suite still green.

- [ ] **Step 5: Commit**

```bash
git add hooks/lane.mjs hooks/lane.test.mjs
git commit -m "feat(guards): add lane.mjs gate() cap decision"
```

---

### Task 3: Real process listing + CLI wiring (exit 42 contract)

**Files:**
- Modify: `hooks/lane.mjs` (replace the Task 1 stub with the real `queryClaudeProcesses`; modify the `isMain` footer at lines 419-426)
- Test: `hooks/lane.test.mjs`

**Interfaces:**
- Produces: `queryClaudeProcesses() -> Array<{ProcessId, ExecutablePath, CreationDate}>` (real `Get-CimInstance` call)
- Produces (CLI contract, consumed by `shim/claude.cmd`/`shim/claude` in Task 5): `node hooks/lane.mjs gate [-- ] <claude-args...>` exits 0 and prints nothing on allow; exits 42 and prints one line to stderr (`lane: claude launch cap reached (N/cap) — held by ...`) on refuse.

- [ ] **Step 1: Write the failing tests**

Add to `hooks/lane.test.mjs`:

```javascript
test("queryClaudeProcesses runs a real CIM query and returns an array", { skip: process.platform !== "win32" }, () => {
  const out = queryClaudeProcesses();
  assert.ok(Array.isArray(out));
});

test("CLI: node hooks/lane.mjs gate --version bypasses the cap and exits 0 silently", () => {
  const out = execFileSync(process.execPath, [path.join(HERE_DIR, "lane.mjs"), "gate", "--version"], {
    env: { ...process.env, ACC_LANE_DIR: process.env.ACC_LANE_DIR, ACC_POLICY: process.env.ACC_POLICY },
    encoding: "utf8",
  });
  assert.equal(out, "");
});

test("CLI: node hooks/lane.mjs gate with cap:0 refuses for real and exits 42 with a stderr holder line", { skip: process.platform !== "win32" }, () => {
  setPolicy({ total: { cap: 0, exe: ["C:\\definitely-not-a-real-path\\claude.exe"] } });
  assert.throws(
    () => execFileSync(process.execPath, [path.join(HERE_DIR, "lane.mjs"), "gate", "--", "-p", "hi"], {
      env: { ...process.env, ACC_LANE_DIR: process.env.ACC_LANE_DIR, ACC_POLICY: process.env.ACC_POLICY },
      encoding: "utf8",
    }),
    (err) => {
      assert.equal(err.status, 42);
      assert.match(err.stderr, /lane: claude launch cap reached \(0\/0\)/);
      return true;
    },
  );
});
```

Add `queryClaudeProcesses` to the destructured import block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test hooks/lane.test.mjs`
Expected: FAIL — the CLI tests currently exit 0 with a JSON status line printed (old `runCli`/`unknown command` path), not the new gate contract; `queryClaudeProcesses` test fails as `not defined` (or passes trivially against the Task-1 stub, then fails once the stub is removed in Step 3 — either way it does not yet exercise a real CIM call).

- [ ] **Step 3: Implement**

Delete the temporary `function queryClaudeProcesses() { return []; }` stub from Task 1 (if you added it) and replace with the real implementation, placed directly above `countCappedProcesses` (which now resolves its default parameter for real):

```javascript
// One real Win32_Process query, filtered by NAME only (path-filtering happens
// in countCappedProcesses) — Name alone would also match the unrelated
// desktop app's claude.exe, which is exactly why the caller must filter by
// ExecutablePath afterward.
export function queryClaudeProcesses() {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
    "Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress -Depth 3";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const trimmed = out.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}
```

In `hooks/lane.mjs`, replace the `isMain` footer (lines 419-426):

```javascript
const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const out = runCli(process.argv.slice(2));
  console.log(JSON.stringify(out));
  if (out && out.ok === false) process.exitCode = 1;
}
```

with:

```javascript
const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  if (cmd === "gate") {
    // Deliberately NOT routed through runCli's JSON-on-stdout convention:
    // shim/claude.cmd only cares about the exit code, and a JSON line on
    // every single successful `claude` launch would be noise in Kyle's
    // terminal. Silent on allow; one human-readable line on stderr to
    // refuse.
    const gateArgs = rest[0] === "--" ? rest.slice(1) : rest;
    const out = gate(gateArgs);
    if (out && out.ok === false) {
      const holders = (out.holders || [])
        .map((h) => `pid ${h.pid}${h.label ? ` [${h.label}]` : ""}${h.startedAt ? ` (started ${h.startedAt})` : ""}`)
        .join(", ");
      console.error(`lane: claude launch cap reached (${out.count}/${out.cap}) — held by ${holders || "unknown"}`);
      process.exitCode = 42;
    }
  } else {
    const out = runCli(argv);
    console.log(JSON.stringify(out));
    if (out && out.ok === false) process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test hooks/lane.test.mjs`
Expected: all PASS, including the two Windows-only tests (this repo's test machine is Windows). Full existing suite still green (the `status` CLI subprocess test at the old line 595 is unaffected — `cmd !== "gate"` for it).

- [ ] **Step 5: Commit**

```bash
git add hooks/lane.mjs hooks/lane.test.mjs
git commit -m "feat(guards): real CIM process listing + gate CLI contract (exit 42)"
```

---

### Task 4: `policy.json` — `lane.total` dial

**Files:**
- Modify: `policy.json:99-117` (the `lane` block)

**Interfaces:**
- Produces the config shape `gate()` (Task 2) and `watcher/claude-cap-watch.ps1` (Task 6) both read: `policy.json.lane.total = { cap: number, exe: string[] }`.

- [ ] **Step 1: (no separate failing test — this is data, not logic; Task 2/3's tests already prove `gate()` handles any shape of `lane.total` correctly via fixtures)**

- [ ] **Step 2: Edit `policy.json`**

Insert a `"total"` key as a sibling of `"interactive"` inside the existing `"lane"` object (`policy.json:99-117`), directly after `"interactive"`'s closing brace on line 115 and before the `"_note"` on line 116:

```json
    "lane":  {
                 "slots":  1,
                 "minGapMs":  3000,
                 "retries":  2,
                 "backoffBaseMs":  2000,
                 "overloadBaseMs":  4000,
                 "backoffCapMs":  30000,
                 "breakerThreshold":  3,
                 "breakerWindowMs":  300000,
                 "breakerCooldownMs":  120000,
                 "breakerBlocking":  true,
                 "interactive":  {
                                     "slots":  1,
                                     "minGapMs":  0,
                                     "breakerBlocking":  false,
                                     "_note":  "..."
                                 },
                 "total":  {
                               "cap":  3,
                               "exe":  ["C:\\Users\\kyleg\\.local\\bin\\claude.exe"],
                               "_note":  "Machine-wide ceiling on concurrent claude.exe, enforced by shim/claude.cmd + shim/claude via `node hooks/lane.mjs gate` (see hooks/lane.mjs's launch-cap section). Independent of slots/interactive above, which are cooperative lane pools; this is a hard ceiling checked at every PATH resolution of `claude`, regardless of launch path. cap:0 is a supported deliberate lockdown (refuses every session launch). exe lists the absolute path(s) that count toward the cap, matched exactly (case-insensitive) -- the Claude desktop app's bundled claude.exe at a different path is never counted. Design: docs/superpowers/specs/2026-08-03-claude-launch-cap-design.md."
                           },
                 "_note":  "hooks/lane.mjs - machine-wide launch lane for real-claude spawns. Added 2026-08-01, hardened 2026-08-01 after Kyle hit an API error INSIDE an interactive session even after the first fix: the first pass only ever wrapped AUTOMATED headless launches (runner.mjs, e2e proof tier); guards-gui.ps1's Go button and Terminal tab spawned claude with zero coordination, so an interactive launch could still stack concurrently with automation or another manual terminal. slots=1 means one automated session at a time across ALL loops; minGapMs paces starts; retries are TRANSPORT-ONLY (econnreset/429/5xx/overloaded) with FULL-JITTER backoff - logic failures never retry, and 529/overloaded gets overloadBaseMs (a model-layer overload, not this account's rate limit) instead of backoffBaseMs. breakerThreshold failures within breakerWindowMs trips a breakerCooldownMs hold on new AUTOMATED launches (interactive only warns - see lane.interactive above). `lane.interactive` is a second, fully isolated slot pool for GUI/Terminal launches; `lane.total` (added 2026-08-03) is the machine-wide hard cap that catches launches neither of the above ever sees, e.g. Kyle's own manual terminals outside the GUI - see lane.total._note. State: os.tmpdir()/acc-lane, never ACC_ROOT."
             },
```

(The existing `interactive._note` text is unchanged — only its closing brace's trailing context shifts to make room for the new sibling key. The final `_note` for the whole `lane` block is amended to mention `lane.total` instead of claiming manual terminals are unlaned by design — that sentence is now false.)

- [ ] **Step 3: Verify it parses and shapes correctly**

Run: `node -e "const p = require('fs').readFileSync('policy.json','utf8'); const j = JSON.parse(p.replace(/^\uFEFF/, '')); console.log(JSON.stringify(j.lane.total))"`
Expected: `{"cap":3,"exe":["C:\\Users\\kyleg\\.local\\bin\\claude.exe"]}` (plus `_note`, harmless — `gate()` only reads `.cap`/`.exe`).

Run: `npm run test:windows`
Expected: full suite still PASS (no test reads the real `policy.json` — all use `ACC_POLICY` fixture overrides — this step is a regression guard only).

- [ ] **Step 4: Commit**

```bash
git add policy.json
git commit -m "feat(guards): configure lane.total launch cap (default 3)"
```

---

### Task 5: The shim (`shim/claude.cmd`, `shim/claude`)

**Files:**
- Create: `shim/claude.cmd`
- Create: `shim/claude`
- Test: `shim/claude.test.ps1`

**Interfaces:**
- Consumes: the Task 3 CLI contract (`node hooks/lane.mjs gate -- <args>`, exit 42 = refuse).
- Consumes (env override, test-only; production uses the baked-in default): `ACC_REAL_CLAUDE_EXE` — if set, used instead of the baked-in real exe path. Lets tests substitute a harmless stand-in instead of the real `claude.exe`.
- Produces: nothing further downstream consumes these directly; Task 7's runbox script puts `shim/`'s directory on PATH ahead of the real install.

- [ ] **Step 1: Write `shim/claude.test.ps1` (RED first — it will fail because the two shim files don't exist yet)**

```powershell
# shim/claude.test.ps1 - control-flow test for the claude launch-cap shim.
# Uses a harmless stand-in exe (never the real claude.exe, never spends
# tokens) via ACC_REAL_CLAUDE_EXE, and forces allow/refuse deterministically
# via lane.total.cap rather than depending on the machine's real process
# count. Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File shim/claude.test.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here
$sandbox = Join-Path $env:TEMP ("shim-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox | Out-Null

$standIn = Join-Path $sandbox 'stand-in-claude.cmd'
Set-Content -Path $standIn -Value "@echo off`r`necho STAND-IN-RAN`r`nexit /b 7"

$policyPath = Join-Path $sandbox 'policy.json'
$laneDir = Join-Path $sandbox 'lane'

function Set-Cap([int]$cap) {
    $policy = @{ lane = @{ total = @{ cap = $cap; exe = @('C:\definitely-not-a-real-path\claude.exe') } } }
    ($policy | ConvertTo-Json -Depth 5) | Set-Content -Path $policyPath
}

$env:ACC_POLICY = $policyPath
$env:ACC_LANE_DIR = $laneDir
$env:ACC_REAL_CLAUDE_EXE = $standIn

$fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:fail = 1 } }

Set-Cap 3
$allowOut = & (Join-Path $repoRoot 'shim\claude.cmd') --version 2>$null
Check 'allow: exit code passes through from the stand-in (7)' ($LASTEXITCODE -eq 7)
Check 'allow: the stand-in actually ran' ($allowOut -match 'STAND-IN-RAN')

Set-Cap 0
$refuseErr = & (Join-Path $repoRoot 'shim\claude.cmd') -p hi 2>&1
Check 'refuse: shim exits 42' ($LASTEXITCODE -eq 42)
Check 'refuse: the stand-in never ran' (-not ($refuseErr -match 'STAND-IN-RAN'))

Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
exit $fail
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File shim/claude.test.ps1`
Expected: FAIL (`shim\claude.cmd` does not exist — PowerShell reports the call operator target not found).

- [ ] **Step 3: Create `shim/claude.cmd`**

```bat
@echo off
setlocal
node "%~dp0..\hooks\lane.mjs" gate -- %*
if %ERRORLEVEL% EQU 42 exit /b 42
set "ACC_REAL_CLAUDE=%ACC_REAL_CLAUDE_EXE%"
if "%ACC_REAL_CLAUDE%"=="" set "ACC_REAL_CLAUDE=C:\Users\kyleg\.local\bin\claude.exe"
"%ACC_REAL_CLAUDE%" %*
exit /b %ERRORLEVEL%
```

- [ ] **Step 4: Create `shim/claude` (POSIX, for Git Bash)**

```sh
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
node "$DIR/../hooks/lane.mjs" gate -- "$@"
CODE=$?
if [ "$CODE" -eq 42 ]; then
  exit 42
fi
REAL="${ACC_REAL_CLAUDE_EXE:-C:/Users/kyleg/.local/bin/claude.exe}"
exec "$REAL" "$@"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File shim/claude.test.ps1`
Expected: all 4 `Check` lines PASS, exit code 0.

- [ ] **Step 6: Cross-check test — shim and policy.json must never silently drift**

Add to `hooks/lane.test.mjs` (this test reads the REAL repo files, not fixtures — deliberately, since its entire job is catching drift between two files that duplicate one literal path):

```javascript
test("shim/claude.cmd's baked-in real exe path matches policy.json's lane.total.exe[0]", () => {
  const policy = JSON.parse(fs.readFileSync(path.join(HERE_DIR, "..", "policy.json"), "utf8").replace(/^\uFEFF/, ""));
  const configuredExe = policy.lane.total.exe[0];
  const shimCmd = fs.readFileSync(path.join(HERE_DIR, "..", "shim", "claude.cmd"), "utf8");
  assert.ok(shimCmd.includes(configuredExe), `shim/claude.cmd must contain the exact path ${configuredExe}`);
});
```

Run: `node --test hooks/lane.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add shim/claude.cmd shim/claude shim/claude.test.ps1 hooks/lane.test.mjs
git commit -m "feat(guards): fail-open claude launch-cap shim (cmd + posix)"
```

---

### Task 6: The watcher (`watcher/claude-cap-watch.ps1`)

**Files:**
- Create: `watcher/claude-cap-watch.ps1`
- Test: `watcher/claude-cap-watch.test.ps1`

**Interfaces:**
- Consumes: `policy.json`'s `lane.total.{cap,exe}` (real file at runtime; `Get-CapDecision` itself takes plain parameters, no file I/O, for testability), live `Get-CimInstance Win32_Process`, `shim/claude.cmd`'s existence, the user `Path` env var.
- Produces: `Get-CapDecision` (pure function, dot-sourceable) for the test; a breach/clear log at `watcher/claude-cap-watch.log`; a debounce state file `watcher/claude-cap-watch.state.json`. Never kills a process.

- [ ] **Step 1: Write `watcher/claude-cap-watch.test.ps1` (RED first)**

```powershell
# watcher/claude-cap-watch.test.ps1 - unit tests for Get-CapDecision (pure;
# no CIM call, no file I/O, no scheduled task). Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File watcher/claude-cap-watch.test.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-cap-watch.ps1')

$fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:fail = 1 } }

$one = @([pscustomobject]@{ ExecutablePath = 'C:\real\claude.exe' })
$four = @(1..4 | ForEach-Object { [pscustomobject]@{ ExecutablePath = 'C:\real\claude.exe' } })

$d1 = Get-CapDecision -Cap 3 -ExePaths @('C:\real\claude.exe') -Processes $one -ShimOnPath $true -ShimFileExists $true -RealExeExists $true
Check 'under cap, healthy shim -> no alert' (-not $d1.Alert -and -not $d1.Breach -and -not $d1.FailOpen)

$d2 = Get-CapDecision -Cap 3 -ExePaths @('C:\real\claude.exe') -Processes $four -ShimOnPath $true -ShimFileExists $true -RealExeExists $true
Check 'over cap -> breach alert' ($d2.Breach -and $d2.Alert -and $d2.Count -eq 4)

$d3 = Get-CapDecision -Cap 3 -ExePaths @('C:\real\claude.exe') -Processes $one -ShimOnPath $false -ShimFileExists $true -RealExeExists $true
Check 'shim missing from PATH -> fail-open alert, not a breach' ($d3.FailOpen -and $d3.Alert -and -not $d3.Breach)

$d4 = Get-CapDecision -Cap 3 -ExePaths @('C:\real\claude.exe') -Processes $one -ShimOnPath $true -ShimFileExists $false -RealExeExists $true
Check 'shim file missing -> fail-open alert' ($d4.FailOpen -and $d4.Alert)

$d5 = Get-CapDecision -Cap 3 -ExePaths @('C:\real\claude.exe') -Processes $one -ShimOnPath $true -ShimFileExists $true -RealExeExists $false
Check 'real exe missing on disk -> fail-open alert' ($d5.FailOpen -and $d5.Alert)

$d6 = Get-CapDecision -Cap 3 -ExePaths @('C:\other\claude.exe') -Processes $four -ShimOnPath $true -ShimFileExists $true -RealExeExists $true
Check 'processes at an unconfigured path are never counted' (-not $d6.Breach -and $d6.Count -eq 0)

$d7 = Get-CapDecision -Cap 0 -ExePaths @('C:\real\claude.exe') -Processes @() -ShimOnPath $true -ShimFileExists $true -RealExeExists $true
Check 'cap:0 lockdown breaches even at zero live processes' ($d7.Breach -and $d7.Alert)

exit $fail
```

- [ ] **Step 2: Run to verify it fails**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File watcher/claude-cap-watch.test.ps1`
Expected: FAIL (`watcher\claude-cap-watch.ps1` does not exist).

- [ ] **Step 3: Create `watcher/claude-cap-watch.ps1`**

```powershell
# watcher/claude-cap-watch.ps1 - one-shot claude launch-cap health check.
# Alert-only: NEVER kills a process. Invoked repeatedly by a Scheduled Task
# (60s repetition, registered by runbox/install-claude-cap-gate.ps1) rather
# than looping itself - Task Scheduler already owns repetition, so this
# script does exactly one check and exits. Standalone by design: imports no
# repo code, so a bug in hooks/lane.mjs or the shim cannot also break the
# thing meant to detect that bug. Design:
# docs/superpowers/specs/2026-08-03-claude-launch-cap-design.md
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here

# Pure decision logic - no file/process I/O, fully unit-testable by dot-
# sourcing this script (see claude-cap-watch.test.ps1).
function Get-CapDecision {
    param(
        [int]$Cap,
        [string[]]$ExePaths,
        [array]$Processes,
        [bool]$ShimOnPath,
        [bool]$ShimFileExists,
        [bool]$RealExeExists
    )
    $wanted = @($ExePaths | ForEach-Object { $_.ToLowerInvariant() })
    $matched = @($Processes | Where-Object { $_.ExecutablePath -and ($wanted -contains $_.ExecutablePath.ToLowerInvariant()) })
    $breach = $matched.Count -gt $Cap
    $failOpen = (-not $ShimOnPath) -or (-not $ShimFileExists) -or (-not $RealExeExists)
    [pscustomobject]@{
        Count    = $matched.Count
        Cap      = $Cap
        Breach   = $breach
        FailOpen = $failOpen
        Alert    = ($breach -or $failOpen)
    }
}

# Dot-sourced (by the test) -> stop here, functions only, no real run.
if ($MyInvocation.InvocationName -eq '.') { return }

$policyPath = if ($env:ACC_POLICY) { $env:ACC_POLICY } else { Join-Path $repoRoot 'policy.json' }
$stateFile = Join-Path $here 'claude-cap-watch.state.json'
$logFile = Join-Path $here 'claude-cap-watch.log'

$policy = Get-Content $policyPath -Raw | ConvertFrom-Json
$cap = $policy.lane.total.cap
$exePaths = @($policy.lane.total.exe)

$shimDir = Join-Path $repoRoot 'shim'
$shimOnPath = @(($env:Path -split ';') | Where-Object { $_ -eq $shimDir }).Count -gt 0
$shimFileExists = Test-Path (Join-Path $shimDir 'claude.cmd')
$realExeExists = ($exePaths.Count -gt 0) -and (Test-Path $exePaths[0])

$procs = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Select-Object ProcessId, ExecutablePath, CreationDate

$decision = Get-CapDecision -Cap $cap -ExePaths $exePaths -Processes $procs `
    -ShimOnPath $shimOnPath -ShimFileExists $shimFileExists -RealExeExists $realExeExists

$prevAlert = $false
if (Test-Path $stateFile) {
    try { $prevAlert = [bool](Get-Content $stateFile -Raw | ConvertFrom-Json).Alert } catch { $prevAlert = $false }
}

if ($decision.Alert -and -not $prevAlert) {
    $msg = if ($decision.Breach) {
        "claude launch cap BREACH: $($decision.Count)/$($decision.Cap) claude.exe running"
    } else {
        "claude launch cap gate is silently fail-open (shim missing from PATH or misconfigured)"
    }
    Add-Content -Path $logFile -Value "$(Get-Date -Format o) ALERT $msg"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $ni = New-Object System.Windows.Forms.NotifyIcon
        $ni.Icon = [System.Drawing.SystemIcons]::Warning
        $ni.Visible = $true
        $ni.ShowBalloonTip(10000, 'ACC claude launch cap', $msg, [System.Windows.Forms.ToolTipIcon]::Warning)
        Start-Sleep -Milliseconds 500
        $ni.Dispose()
    } catch {
        # Best-effort only - a headless/no-session context (or missing
        # WinForms) must never make this script fail; the log line above is
        # the durable record either way.
    }
} elseif (-not $decision.Alert -and $prevAlert) {
    Add-Content -Path $logFile -Value "$(Get-Date -Format o) CLEARED"
}

$decision | ConvertTo-Json | Set-Content -Path $stateFile
```

- [ ] **Step 4: Run to verify it passes**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File watcher/claude-cap-watch.test.ps1`
Expected: all 7 `Check` lines PASS, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add watcher/claude-cap-watch.ps1 watcher/claude-cap-watch.test.ps1
git commit -m "feat(guards): standalone alert-only claude cap watcher"
```

---

### Task 7: Runbox install script (PATH + Scheduled Task — machine state, not executed directly)

**Files:**
- Create: `runbox/install-claude-cap-gate.ps1`

**Interfaces:**
- Consumes: `shim/` directory (Task 5), `watcher/claude-cap-watch.ps1` (Task 6) — both must already be committed.
- Produces: nothing importable — this is a one-shot operational script for Kyle to run via `/approve`, per `AGENTS.md`'s runbox rules (PATH and Scheduled Task changes are machine state outside the repo; not something to execute directly per `C:\Users\kyleg\.claude\CLAUDE.md`).

- [ ] **Step 1: Create the script**

```powershell
# Installs the machine-wide claude launch-cap gate: prepends C:\code\guards\shim
# to the user PATH (ahead of the current claude.exe location, so claude.cmd
# there is what "claude" resolves to from any new terminal) and registers a
# 60s-repeating logon Scheduled Task running watcher\claude-cap-watch.ps1
# (alert-only, never kills a process). Idempotent - safe to re-run.
# Design: docs\superpowers\specs\2026-08-03-claude-launch-cap-design.md
$ErrorActionPreference = 'Stop'
$repoRoot = 'C:\code\guards'
$shimDir = Join-Path $repoRoot 'shim'

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($userPath -split ';' | Where-Object { $_ -ne '' })
if ($parts -notcontains $shimDir) {
    $newPath = ($shimDir + ';' + $userPath).TrimEnd(';')
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "Prepended $shimDir to the user PATH."
} else {
    Write-Host "$shimDir is already on the user PATH."
}

$taskName = 'ACC-ClaudeCapWatch'
$scriptPath = Join-Path $repoRoot 'watcher\claude-cap-watch.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Seconds 60) -RepetitionDuration ([TimeSpan]::MaxValue)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigger, $logonTrigger) -Settings $settings -Force | Out-Null
Write-Host "Registered scheduled task '$taskName' (60s repetition, starts now and at every logon)."

Write-Host ""
Write-Host "Install complete. Open a NEW terminal window for the PATH change to take effect -- existing open terminals keep their old PATH until restarted."
```

- [ ] **Step 2: Sanity-check the script (no execution — read-through, per runbox convention: this script is reviewed via its preview, not unit-tested)**

Confirm: idempotent PATH check (`-notcontains`), `-Force` on `Register-ScheduledTask` (safe re-register), no secrets, leading comment matches the required preview format (`AGENTS.md:60`).

- [ ] **Step 3: Commit**

```bash
git add runbox/install-claude-cap-gate.ps1
git commit -m "chore(guards): runbox script to install the claude cap gate (PATH + scheduled task)"
```

- [ ] **Step 4: Tell Kyle**

After this commit, tell Kyle: "`runbox/install-claude-cap-gate.ps1` is ready — run `/approve` to prepend the shim to your PATH and register the watcher's scheduled task. Until you do, the shim and watcher exist in the repo but are not yet live on the machine."

---

### Task 8: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Fast tier**

Run: `npm run test:windows`
Expected: all tests PASS, including every new test from Tasks 1-3.

- [ ] **Step 2: Coverage gate**

Run: `node hooks/covgate.mjs`
Expected: PASS — `hooks/lane.mjs`'s changed lines at 100% line/function coverage, >=85% branch coverage (its existing OI-017 override).

- [ ] **Step 3: PowerShell tests**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File shim/claude.test.ps1`
Run: `powershell -NoProfile -ExecutionPolicy Bypass -File watcher/claude-cap-watch.test.ps1`
Expected: both PASS (exit 0).

- [ ] **Step 4: Cheap real-machine sanity check (no token spend)**

Run: `node hooks/lane.mjs gate --version` (from `C:\code\guards`)
Expected: prints nothing, exits 0 (utility bypass — this alone doesn't touch the real cap logic).

Run: `node hooks/lane.mjs gate -- -p hi` twice in a row with a temporary `ACC_POLICY` pointed at a scratch file setting `lane.total.cap: 0` and `lane.total.exe` set to the real resolved path (`C:\Users\kyleg\.local\bin\claude.exe`) — confirms the gate refuses (exit 42) against the REAL live process count on this machine, not just fixtures. This does not spend any tokens (no claude process is ever launched — the whole point is that it refuses before exec).

- [ ] **Step 5: Confirm non-goals held**

`git diff --stat` since this plan's first commit should show zero changes to `e2e/loop.e2e.mjs`, `runner/runner.mjs`, `kernel/adapters/claude-code.mjs`, and `guards-gui.ps1` — per the spec, these inherit cap enforcement for free via PATH resolution once Task 7's runbox script is run; no code change was needed in any of them.

- [ ] **Step 6: Note the deferred real proof run**

Do not run `e2e/loop.e2e.mjs` (real tokens) as part of this plan. If Kyle wants live confirmation that the original incident (4/5 scenario failures under concurrent load) is actually resolved, that is his call on timing, same as OI-025 — mention it, don't run it unprompted.

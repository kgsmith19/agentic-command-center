# Sub-project J — Service Decomposition and Naming Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split one 5,100-line repo into six independently testable repos and rename the concepts that mislead, without the running system ever being broken for more than one commit.

**Architecture:** The migration's real risk is not moving files — it is the ~15 absolute paths *outside* every repo that point into it, which no repo's test suite can see. So the order is: **remove the class of problem first, move files second.** Tasks 1–4 make every self-reference resolve from `import.meta.url` and make every Claude Code integration point installer-written. Only then do files move. After that, a repo move is recoverable by one command per repo instead of an audit.

**Tech Stack:** Node 20+ ESM, `node:test`, `git subtree split` for history-preserving extraction, `gh` CLI for repo creation, PowerShell 5.1 for the watcher.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-acc-decomposition-design.md` (15 ACs). Absorbs sub-project C / `OI-026`.
- Standard: `docs/superpowers/specs/2026-08-04-acc-standards-design.md`.
- Worktree: `git worktree add -b acc/j-decomposition ../acc-j-decomposition main` — created **after wave 1 merges**, so it includes B2b. J runs alone: it moves every file, so nothing else may run beside it.
- **Prerequisite: B2b must be merged first.** J renames the file B2b edits.
- Six repos, exact names: `agent-repo-gates`, `agent-guardrails`, `claude-session-telemetry`, `agentic-command-center`, `agentic-command-center-ui`, `claude-launch-cap`. All under `kgsmith19/`.
- Renames, exact: `goal` → `standing order` (module `standing.mjs`, ids `so-`, injection `[ACC STANDING so-…]`, store `runner/standing/`, policy `standing.*`); `clearbot` → `autopilot`; `guards` (concept) → `guardrails`; `kernel/` → `core/`; folder `C:\code\guards` → `C:\code\agentic-command-center`. `runbox` is **not** renamed.
- After **every** task, the system must still work end to end. Task 12's smoke check is run after each of Tasks 5–11, not only at the end.
- `~/.claude/settings.json` is `config.protected`. Every edit to it goes through the runbox lane per `AGENTS.md` — never a direct write, even by the installer during development. The installer writes to a fixture until Task 4 proves it, then is invoked via the runbox.
- Coverage floor per repo: 100/100/90.

## File Structure

| Path | Becomes |
|---|---|
| `hooks/covgate.mjs`, `testplan.mjs`, `pre-push`, `tools/inventory.mjs` | `agent-repo-gates` |
| `kernel/guard.mjs`, `guardhook.mjs`, `hooks/guard.mjs`, `hooks/engine.mjs`, `vault.json` | `agent-guardrails` |
| `hooks/budget.mjs`, `usage.mjs`, `statusline.mjs`, `cmdline.mjs`, `prompts.mjs`, `route.mjs` | `claude-session-telemetry` |
| `hooks/goal.mjs`→`core/standing.mjs`, `hooks/lane.mjs`, `runner/`, `watcher/clearbot.ps1`→`autopilot.ps1`, rest of `kernel/`→`core/` | `agentic-command-center` |
| `gui/server.mjs`, `term.html`, `kernel.html`, `PtyHost.cs`, `guards-gui.ps1` | `agentic-command-center-ui` |
| `watcher/claude-cap-watch.ps1`, `install-cap-watch-task.ps1` | `claude-launch-cap` |

---

### Task 1: The path resolver — no module knows where it lives

**Files:**
- Create: `core/paths.mjs`
- Create: `core/paths.test.mjs`

**Interfaces:**
- Produces: `repoRoot() -> string` (absolute, forward slashes), derived from
  `import.meta.url` by walking up to the nearest directory containing
  `package.json`. `resolve(...segments) -> string` joins from that root.
- Every module that currently hardcodes `C:/code/guards/...` uses these.

- [ ] **Step 1: Write the failing test**

```javascript
// node --test core/paths.test.mjs   (run from the repo root)
//
// The point of this module: a repo that does not know its own absolute path
// cannot be broken by moving it. Tested by running it from a COPY at a
// different path and asserting it reports the copy, not the original.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const m = await import("./paths.mjs");

test("repoRoot is the directory containing package.json", () => {
  assert.ok(fs.existsSync(path.join(m.repoRoot(), "package.json")));
});

test("repoRoot uses forward slashes so string comparison is stable on Windows", () => {
  assert.doesNotMatch(m.repoRoot(), /\\/);
});

test("a copy of the repo at another path reports THAT path", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acc-paths-"));
  fs.mkdirSync(path.join(tmp, "core"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), "{}");
  fs.copyFileSync(path.join(m.repoRoot(), "core/paths.mjs"), path.join(tmp, "core/paths.mjs"));
  const copy = await import(`file://${path.join(tmp, "core/paths.mjs").replace(/\\/g, "/")}`);
  assert.equal(copy.repoRoot(), tmp.replace(/\\/g, "/"));
  assert.notEqual(copy.repoRoot(), m.repoRoot());
  fs.rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test core/paths.test.mjs`
Expected: FAIL — `Cannot find module './paths.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// core/paths.mjs — where am I?
//
// Every absolute path in this codebase used to be written down. That made a
// folder rename a 15-site audit across files no test suite can see. A module
// that derives its own root cannot be broken by moving it, so the whole class
// of breakage disappears instead of being managed.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fwd = (p) => p.replace(/\\/g, "/");

let cached = null;

export function repoRoot() {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("no package.json above core/paths.mjs");
    dir = up;
  }
  return (cached = fwd(dir));
}

export function resolve(...segments) {
  return fwd(join(repoRoot(), ...segments));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test core/paths.test.mjs`
Expected: PASS, 3/3

- [ ] **Step 5: Commit**

```bash
git add core/paths.mjs core/paths.test.mjs
git commit -m "feat(paths): derive the repo root instead of hardcoding it (AC-J1)"
```

---

### Task 2: The grep gate that keeps hardcoded paths out

**Files:**
- Create: `tools/pathgate.mjs`
- Create: `tools/pathgate.test.mjs`
- Modify: `package.json` (add `"gates": "node tools/pathgate.mjs"`)

**Interfaces:**
- Produces: `findHardcoded(files, readFile) -> Finding[]`, `Finding = { file, line, text }`.
- Flags any source file containing an absolute path to a repo root
  (`C:/code/guards`, `C:\code\guards`, `C:/code/agentic-command-center`, …).
- Allowlist: `docs/**`, `OPEN-ISSUES.md`, and any line ending `// pathgate-ok`
  with a reason after it.

- [ ] **Step 1: Write the failing test**

```javascript
test("a hardcoded repo path in source is a finding", () => {
  const f = m.findHardcoded(["a.mjs"], () => 'const p = "C:/code/guards/policy.json";\n');
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 1);
});

test("backslash form is caught too", () => {
  const f = m.findHardcoded(["a.mjs"], () => 'const p = "C:\\\\code\\\\guards\\\\policy.json";\n');
  assert.equal(f.length, 1);
});

test("the post-rename path is caught as well - the gate must not expire", () => {
  const f = m.findHardcoded(["a.mjs"], () => 'const p = "C:/code/agentic-command-center/x";\n');
  assert.equal(f.length, 1);
});

test("an explicitly justified line is allowed", () => {
  const f = m.findHardcoded(["a.mjs"],
    () => 'const p = "C:/code/guards"; // pathgate-ok: fixture asserting the old path\n');
  assert.deepEqual(f, []);
});

test("a bare pathgate-ok with no reason is still a finding", () => {
  const f = m.findHardcoded(["a.mjs"], () => 'const p = "C:/code/guards"; // pathgate-ok\n');
  assert.equal(f.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/pathgate.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```javascript
// tools/pathgate.mjs — no source file may name a repo root absolutely.
const ROOTS = /C:[\\/]{1,2}code[\\/]{1,2}(guards|agentic-command-center|agent-guardrails|claude-session-telemetry|agentic-command-center-ui|claude-launch-cap|agent-repo-gates)/i;
const OK = /\/\/\s*pathgate-ok:\s*\S+/;

export function findHardcoded(files, readFile) {
  const out = [];
  for (const file of files) {
    readFile(file).split(/\r?\n/).forEach((text, i) => {
      if (ROOTS.test(text) && !OK.test(text)) out.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return out;
}
```

Plus a CLI entry that walks the tree excluding `node_modules`, `docs/`, `.git/`, `runbox/`, `runner/`, and `OPEN-ISSUES.md`, prints findings and exits 1 when any exist.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/pathgate.test.mjs`
Expected: PASS, 5/5

- [ ] **Step 5: Run the gate against the real tree and record the baseline**

Run: `node tools/pathgate.mjs`
Expected: exit 1 with findings — this is the RED for Task 3. **Save the full output into the Task 3 commit body.**

- [ ] **Step 6: Commit**

```bash
git add tools/pathgate.mjs tools/pathgate.test.mjs package.json
git commit -m "feat(gates): fail on any hardcoded repo root in source (AC-J1)"
```

---

### Task 3: De-hardcode every source path

**Files:**
- Modify: every file listed by Task 2 Step 5. Known at time of writing:
  `hooks/budget.mjs` (message strings), `hooks/usage.mjs`, `config.json`,
  `hooks/dialcheck.test.mjs` (fixtures), and ~20 `*.test.mjs` sandbox assertions.

**Interfaces:**
- Consumes: `resolve()` from Task 1.
- Produces: `assertNotLiveRoot(dir)` in `tools/testkit.mjs` — the one shared
  sandbox assertion replacing ~20 copies (AC-J13).

- [ ] **Step 1: Write the failing test for the shared helper**

```javascript
test("assertNotLiveRoot throws when handed a live repo root", () => {
  assert.throws(() => k.assertNotLiveRoot(m.repoRoot()), /refusing to use the live repo/);
});

test("assertNotLiveRoot throws for a path INSIDE the live root, not just equal to it", () => {
  assert.throws(() => k.assertNotLiveRoot(m.resolve("runner/standing")), /refusing/);
});

test("assertNotLiveRoot allows a temp dir", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kit-"));
  assert.doesNotThrow(() => k.assertNotLiveRoot(t));
  fs.rmSync(t, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tools/testkit.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the helper**

```javascript
// tools/testkit.mjs — one place to be right about "never touch live state".
// This assertion used to be copy-pasted into ~20 suites; a missed copy silently
// disarms a safety check, which is the worst kind of test bug.
import { repoRoot } from "../core/paths.mjs";

export function assertNotLiveRoot(dir) {
  const d = String(dir).replace(/\\/g, "/").replace(/\/+$/, "");
  const live = repoRoot();
  if (d === live || d.startsWith(live + "/")) {
    throw new Error(`refusing to use the live repo as a sandbox: ${d}`);
  }
  return d;
}
```

- [ ] **Step 4: Replace every hardcoded site**

Work the Task 2 Step 5 list top to bottom. Three patterns:

1. **Message strings** (`hooks/budget.mjs`, `hooks/usage.mjs`) — build the path at call time:
   ```javascript
   `Run \`node ${resolve("core/standing.mjs")} done ${goal.id}\``
   ```
2. **Sandbox assertions** in tests — replace the inline check with `assertNotLiveRoot(BASE)`.
3. **`config.json`** — leave absolute (it is configuration, not source) but add it to `install-hooks`'s rewrite set in Task 4.

- [ ] **Step 5: Run the gate and the full suite**

```bash
node tools/pathgate.mjs        # expect exit 0
npm run test:windows
npm run covgate
```
Expected: gate clean, suite green.

- [ ] **Step 6: Commit**

```bash
git add -u && git add tools/testkit.mjs tools/testkit.test.mjs
git commit -m "refactor: resolve every repo path at runtime, one shared sandbox assertion (AC-J1, AC-J13, AC-J15)"
```

---

### Task 4: `install-hooks` — nobody writes a hook path by hand again

**Files:**
- Create: `tools/install-hooks.mjs`
- Create: `tools/install-hooks.test.mjs`
- Modify: `package.json` (`"install-hooks": "node tools/install-hooks.mjs"`)

**Interfaces:**
- Produces: `upsert(settings, registrations) -> settings` — pure. `registrations`
  is `[{ event, matcher, command }]`. Idempotent, and it **only** touches entries
  whose command resolves inside this repo's root; every other repo's entries pass
  through untouched.
- This is the highest-ROI task in J: it converts a one-time migration hazard into
  a repeatable command, and it is what makes the *next* move cheap.

- [ ] **Step 1: Write the failing test**

```javascript
const OTHER = {
  hooks: {
    PreToolUse: [{ hooks: [{ type: "command", command: 'node "C:/code/agent-guardrails/hook.mjs"' }] }],
    SessionStart: [{ hooks: [{ type: "command", command: 'node "C:/other/thing.mjs"' }] }],
  },
};

test("upsert adds this repo's registrations", () => {
  const out = m.upsert({ hooks: {} }, [
    { event: "PreToolUse", matcher: "*", command: 'node "C:/repo/hooks/guard.mjs"' },
  ]);
  assert.equal(out.hooks.PreToolUse[0].hooks[0].command, 'node "C:/repo/hooks/guard.mjs"');
});

test("upsert is idempotent - twice equals once", () => {
  const regs = [{ event: "PreToolUse", matcher: "*", command: 'node "C:/repo/hooks/guard.mjs"' }];
  const once = m.upsert({ hooks: {} }, regs);
  const twice = m.upsert(structuredClone(once), regs);
  assert.deepEqual(twice, once);
});

test("upsert never removes or duplicates another repo's registrations", () => {
  const out = m.upsert(structuredClone(OTHER), [
    { event: "PreToolUse", matcher: "*", command: 'node "C:/repo/hooks/guard.mjs"' },
  ]);
  const cmds = out.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.includes('node "C:/code/agent-guardrails/hook.mjs"'), "other repo survived");
  assert.equal(out.hooks.SessionStart[0].hooks[0].command, 'node "C:/other/thing.mjs"');
  assert.equal(cmds.filter((c) => c.includes("C:/repo")).length, 1, "no duplicate");
});

test("after a simulated move, upsert points the old registration at the new path", () => {
  const before = m.upsert({ hooks: {} }, [
    { event: "PreToolUse", matcher: "*", command: 'node "C:/old/hooks/guard.mjs"' },
  ]);
  const after = m.upsert(before, [
    { event: "PreToolUse", matcher: "*", command: 'node "C:/new/hooks/guard.mjs"' },
  ], { ownedRoots: ["C:/old", "C:/new"] });
  const cmds = after.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(cmds, ['node "C:/new/hooks/guard.mjs"']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tools/install-hooks.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

`upsert` groups by `event`, drops any existing entry whose command names a root in `ownedRoots` (defaulting to `[repoRoot()]`), then appends this repo's registrations. Everything else is copied through untouched.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tools/install-hooks.test.mjs`
Expected: PASS, 4/4

- [ ] **Step 5: Prove it on a fixture before it ever sees the real file**

```bash
cp ~/.claude/settings.json /tmp/settings-fixture.json
node tools/install-hooks.mjs --settings /tmp/settings-fixture.json
node tools/install-hooks.mjs --settings /tmp/settings-fixture.json   # twice
node -e "const a=require('/tmp/settings-fixture.json');console.log(JSON.stringify(a.hooks,null,1))"
```
Expected: all 8 current registrations present exactly once, pointing at resolved paths. **Do not run this against `~/.claude/settings.json` directly** — it is `config.protected`; the real run goes through the runbox in Task 9.

- [ ] **Step 6: Commit**

```bash
git add tools/install-hooks.mjs tools/install-hooks.test.mjs package.json
git commit -m "feat(install): installer-written hook registrations, idempotent and repo-scoped (AC-J2, AC-J3, AC-J4)"
```

---

### Task 5: Rename `goal` → standing order, with an idempotent store migration

**Files:**
- Rename: `hooks/goal.mjs` → `core/standing.mjs`, `hooks/goal.test.mjs` → `core/standing.test.mjs`
- Create: `core/migrate-standing.mjs`, `core/migrate-standing.test.mjs`
- Modify: `policy.json`, `watcher/clearbot.ps1`, `hooks/budget.mjs`, `hooks/statusline.mjs`, `guards-gui.ps1`, `AGENTS.md`, `~/.claude/skills/goal-kgs/` → `standing-kgs/`

**Interfaces:**
- Produces: `migrate({ from, to }) -> { moved: string[], skipped: string[] }`.
  Moves `runner/goals/{active,done}/*.json` to `runner/standing/…`, rewrites
  `id` prefix `g-` → `so-`, and **moves rather than copies** — two stores would
  let the loop read the stale one.
- Idempotent: a second run finds nothing to move and reports `moved: []`.

- [ ] **Step 1: Write the failing test**

```javascript
test("migrate moves a legacy goal into the standing store with a new id prefix", () => {
  fs.mkdirSync(path.join(BASE, "goals/active"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "goals/active/g-20260804-1-abcd.json"),
    JSON.stringify({ id: "g-20260804-1-abcd", text: "keep tests green", status: "active" }));

  const r = m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") });

  assert.deepEqual(r.moved, ["g-20260804-1-abcd"]);
  const moved = JSON.parse(fs.readFileSync(path.join(BASE, "standing/active/so-20260804-1-abcd.json"), "utf8"));
  assert.equal(moved.id, "so-20260804-1-abcd");
  assert.equal(moved.text, "keep tests green");
  assert.equal(fs.existsSync(path.join(BASE, "goals/active/g-20260804-1-abcd.json")), false,
    "legacy file must be MOVED, not copied - two stores means the loop can read the stale one");
});

test("migrate is idempotent", () => {
  fs.mkdirSync(path.join(BASE, "goals/active"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "goals/active/g-1-a.json"), JSON.stringify({ id: "g-1-a" }));
  m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") });
  assert.deepEqual(m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") }).moved, []);
});

test("migrate preserves consoleStartedAt from B2b", () => {
  fs.mkdirSync(path.join(BASE, "goals/active"), { recursive: true });
  fs.writeFileSync(path.join(BASE, "goals/active/g-1-a.json"),
    JSON.stringify({ id: "g-1-a", consolePid: 42, consoleStartedAt: "2026-08-04T10:00:00.000Z" }));
  m.migrate({ from: path.join(BASE, "goals"), to: path.join(BASE, "standing") });
  const j = JSON.parse(fs.readFileSync(path.join(BASE, "standing/active/so-1-a.json"), "utf8"));
  assert.equal(j.consoleStartedAt, "2026-08-04T10:00:00.000Z");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test core/migrate-standing.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the migration, then rename**

Write `migrate`, then `git mv` the modules and mechanically rename inside them:
`goal`→`standing`, `Goal`→`Standing`, `goals.`→`standing.` in `policy.json`,
`[ACC GOAL g-`→`[ACC STANDING so-`, `g-`→`so-` in id generation.

- [ ] **Step 4: Accept the legacy injection for one release**

```javascript
test("a legacy [ACC GOAL g-...] injection is still understood, and warns", () => {
  const r = m.parseInjection("[ACC GOAL g-20260804-1-abcd] keep tests green");
  assert.equal(r.id, "so-20260804-1-abcd");
  assert.match(r.deprecation, /\[ACC GOAL\] is deprecated/);
});
```

- [ ] **Step 5: Run everything, then migrate the real store**

```bash
npm run test:windows && npm run covgate
node core/standing.mjs list            # before
node core/migrate-standing.mjs          # real store
node core/standing.mjs list            # after - so- ids, same content
```
Paste both `list` outputs into the commit body.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: goal becomes standing order, with an idempotent store migration (OI-026, AC-J5, AC-J6, AC-J7)"
```

---

### Task 6: Rename `clearbot` → autopilot and `kernel/` → `core/`

**Files:**
- Rename: `watcher/clearbot.ps1` → `watcher/autopilot.ps1`, `start-clearbot.cmd` → `start-autopilot.cmd`, `stop-clearbot.cmd` → `stop-autopilot.cmd`, `hooks/clearbot.test.mjs` → `hooks/autopilot.test.mjs`, `kernel/*` → `core/*`
- Modify: every referencing file, plus `package.json` test globs

**Interfaces:**
- Produces: `tools/namegate.mjs` — fails on the retired words in the renamed
  sense, with an allowlist for genuine other uses (e.g. "the goal of this
  function", OS kernel references in comments).

- [ ] **Step 1: Write the failing gate test**

```javascript
test("the retired names are gone from source", () => {
  const f = m.findRetired(["a.mjs"], () => 'import x from "./clearbot.ps1";\n');
  assert.equal(f.length, 1);
});

test("a genuine English use of the word is allowed", () => {
  assert.deepEqual(m.findRetired(["a.mjs"], () => '// the goal of this function is to parse\n'), []);
});

test("the OS sense of kernel in a comment is allowed", () => {
  assert.deepEqual(m.findRetired(["a.mjs"], () => '// the Windows kernel schedules this\n'), []);
});
```

The distinguishing rule: flag identifier and path uses (`goal.mjs`, `goals/`, `goalId`, `clearbot`, `kernel/`), not prose. Match on `\bgoal(Id|s)?\b` adjacent to `.mjs`/`/`/`_`, plus bare `clearbot` anywhere.

- [ ] **Step 2: Run to verify it fails**, then implement, then:

- [ ] **Step 3: Do the rename**

```bash
git mv watcher/clearbot.ps1 watcher/autopilot.ps1
git mv watcher/start-clearbot.cmd watcher/start-autopilot.cmd
git mv watcher/stop-clearbot.cmd watcher/stop-autopilot.cmd
git mv kernel core
```
Then fix every reference, including `package.json`'s two long test globs and the `clearbot.heartbeat` / `clearbot.stop` / `clearbot.log` filenames.

- [ ] **Step 4: Verify**

```bash
node tools/namegate.mjs        # expect exit 0
npm run test:windows && npm run covgate
node tools/pathgate.mjs
```

- [ ] **Step 5: Smoke the real loop**

```bash
watcher/start-autopilot.cmd
sleep 10 && tail -20 watcher/autopilot.log
watcher/stop-autopilot.cmd
```
Expected: the loop starts, logs a cycle, stops. Paste into the commit body.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: clearbot becomes autopilot, kernel becomes core (AC-J8)"
```

---

### Task 7: `agent-repo-gates` — extract the first repo

**Files:**
- Create: new repo `kgsmith19/agent-repo-gates`
- Move: `hooks/covgate.mjs`, `hooks/testplan.mjs`, `hooks/pre-push`, `tools/inventory.mjs`, `tools/pathgate.mjs`, `tools/namegate.mjs`, `tools/testkit.mjs` (+ their tests)

**Interfaces:**
- Produces: an npm package consumed as a git dependency:
  `"agent-repo-gates": "github:kgsmith19/agent-repo-gates#main"`.
- Exposes: `npx repo-gates` running the full section-3 gate set.

Extracted first because nothing depends on it yet — the safest possible first move, and it proves the extraction procedure before it is used on load-bearing code.

- [ ] **Step 1: Split with history preserved**

```bash
git subtree split --prefix=tools -b split/repo-gates
mkdir ../agent-repo-gates && cd ../agent-repo-gates && git init
git pull ../agentic-command-center split/repo-gates
```

- [ ] **Step 2: Verify history survived**

```bash
git log --oneline | tail -5
git log --all --oneline | grep -c .
```
Expected: pre-split commits present. This is AC-J12; if history is gone, stop and redo the split rather than proceeding.

- [ ] **Step 3: Add the standard's section-5 artifacts**

`AGENTS.md` (with the boundary statement: *repo-gates answers "does this repo meet the standard?"*), `README.md`, `OPEN-ISSUES.md` from the template, `package.json`, `.github/workflows/ci.yml`, `hooks/pre-push` at mode 100755 with LF endings.

- [ ] **Step 4: Create the GitHub repo and push**

```bash
gh repo create kgsmith19/agent-repo-gates --private --source=. --push
gh repo view kgsmith19/agent-repo-gates --json name,defaultBranchRef
```
Expected: repo exists, default branch pushed. This is AC-J11 — a repo that exists only locally does not satisfy J.

- [ ] **Step 5: Consume it from the origin repo and delete the originals**

```bash
cd ../agentic-command-center
npm install github:kgsmith19/agent-repo-gates#main
git rm -r tools/pathgate.mjs tools/namegate.mjs tools/testkit.mjs tools/inventory.mjs hooks/covgate.mjs hooks/testplan.mjs
```
Update every import. Run the full gate set.

- [ ] **Step 6: Smoke check (run after every extraction, Tasks 7–11)**

```bash
npm run test:windows && npx repo-gates
node core/standing.mjs list
watcher/start-autopilot.cmd && sleep 10 && tail -5 watcher/autopilot.log && watcher/stop-autopilot.cmd
```

- [ ] **Step 7: Commit both repos**

---

### Task 8: `claude-launch-cap` — extract the standalone one

Same procedure as Task 7. `watcher/claude-cap-watch.ps1`, `install-cap-watch-task.ps1`, `flash-probe.ps1` and their tests. Zero inbound dependencies, so it is the second-safest move.

- [ ] **Step 1–4:** split, verify history, add section-5 artifacts, `gh repo create`, push.
- [ ] **Step 5: Re-register the scheduled task at its new path**

The `ACC-ClaudeCapWatch` task points at the old location. Write a runbox script (it needs elevation) that re-registers with the S4U principal B1 established, then:
```bash
node hooks/engine.mjs list
```
and ask Kyle to `/approve-kgs`.

- [ ] **Step 6: Prove it still fires with no window**

```bash
powershell -File flash-probe.test.ps1     # ~200s, AC-2 from sub-project B
Get-ScheduledTaskInfo ACC-ClaudeCapWatch
```
Expected: no new visible window across ≥3 firings; `LastRunTime` advancing.

- [ ] **Step 7:** smoke check, commit both repos.

**AGENTS.md boundary statement:** *launch-cap answers "are there too many claudes?" Nothing else.* It stays dependency-free by design.

---

### Task 9: `agent-guardrails` — extract, then re-point settings.json

**Files:**
- Move: `core/guard.mjs`, `core/guardhook.mjs`, `hooks/guard.mjs`, `hooks/engine.mjs`, `vault.json`, `runbox/` convention docs

This is the first extraction that moves a registered hook, so it is the first to exercise `install-hooks` against the real `settings.json`.

- [ ] **Step 1–4:** split, verify history, section-5 artifacts, `gh repo create`, push.
- [ ] **Step 5: Re-point the registrations through the runbox lane**

`~/.claude/settings.json` is `config.protected` — the guard will refuse a direct edit, correctly. Write the installer invocation as a runbox script:

```javascript
// guards: re-point PreToolUse at agent-guardrails' new location after the J
// extraction. Undo: re-run the previous repo's install-hooks.
// Touches: C:/Users/kyleg/.claude/settings.json
```
Then `node hooks/engine.mjs list` and ask Kyle to `/approve-kgs`.

- [ ] **Step 6: Prove the guard still guards**

```bash
node -e "/* attempt a write to a denyRoots path through the hook */"
```
Expected: denied, with the resolved target shown. A guard that stopped guarding during its own extraction is the worst possible outcome, so this is observed, not assumed.

- [ ] **Step 7:** smoke check, commit.

**Boundary statement:** *guardrails answers one question — may this action happen? It never performs the action and never knows why it was requested.*

---

### Task 10: `claude-session-telemetry` — extract the largest cluster

**Files:**
- Move: `hooks/budget.mjs` (791), `usage.mjs` (571), `statusline.mjs`, `cmdline.mjs`, `prompts.mjs`, `route.mjs` + tests

- [ ] **Step 1–4:** split, verify history, section-5 artifacts, `gh repo create`, push.
- [ ] **Step 5:** re-point its six registrations via the runbox lane, same as Task 9.
- [ ] **Step 6: Prove the statusline and budget bands still work**

Open a real session; observe the statusline rendering and a budget band changing as context grows. Screenshot or paste the statusline output.

- [ ] **Step 7:** smoke check, commit.

**Boundary statement:** *telemetry answers "what is this session's state?" It reads and reports; it never decides and never writes to another repo's store.*

**Note:** `route.mjs` moves here but stays unregistered — `OI-033` is F's to resolve, and re-enabling it during a migration would confound two changes.

---

### Task 11: `agentic-command-center-ui` — extract the UI

**Files:**
- Move: `gui/server.mjs`, `term.html`, `kernel.html`, `PtyHost.cs`, `vendor/`, `guards-gui.ps1`, `gui/e2e/`

- [ ] **Step 1–4:** split, verify history, section-5 artifacts, `gh repo create`, push.
- [ ] **Step 5: Wire it to command-center over HTTP**

This is the one place a network boundary is created, because a process boundary already existed. The UI calls command-center's local endpoint; command-center gains no knowledge of the UI.

- [ ] **Step 6: Prove the GUI still launches and the pty still binds**

```bash
powershell -File guards-gui.ps1 -SmokeTest
```
Expected: the `SMOKE OK` line with every count non-zero.

- [ ] **Step 7:** smoke check, commit. D and E build in this repo from here.

**Boundary statement:** *ui answers "what does Kyle see, and what did he click?" It holds no decision logic; every button calls command-center.*

---

### Task 12: Rename the folder, re-run every installer

**Files:**
- Move: `C:\code\guards` → `C:\code\agentic-command-center`
- Modify: `~/.claude/CLAUDE.md`, `C:/code/ROUTING.md`, `C:/code/CLAUDE.md`, `~/.claude/skills/approve-kgs/SKILL.md`, `config.json`

Left until last deliberately: by now every source self-reference resolves at runtime and every integration point is installer-written, so this is a directory move plus one command per repo — not an audit.

- [ ] **Step 1: Write the rollback down first**

In the commit body, before doing it: *rollback is `mv C:/code/agentic-command-center C:/code/guards` followed by `npm run install-hooks` in each of the six repos.*

- [ ] **Step 2: Move it**

```bash
cd C:/code && mv guards agentic-command-center
```

- [ ] **Step 3: Re-run every installer through the runbox lane**

One runbox script invoking all six `install-hooks`, then `/approve-kgs`.

- [ ] **Step 4: Fix the five documents that name the path in prose**

`~/.claude/CLAUDE.md` (engine.mjs, AGENTS.md, runbox), `C:/code/ROUTING.md` (route.mjs), `C:/code/CLAUDE.md`, `approve-kgs/SKILL.md`, `config.json`. The first and fourth are outside every repo; `~/.claude/CLAUDE.md` is protected, so it goes through the runbox too.

- [ ] **Step 5: The full proof (AC-J14)**

```bash
npm run test:windows && npx repo-gates && node tools/pathgate.mjs
node core/standing.mjs create "prove the migration" && node core/standing.mjs list
watcher/start-autopilot.cmd && sleep 30 && tail -20 watcher/autopilot.log
# in a real session: confirm the standing order is injected and kicked
node -e "/* attempt a denied write */"   # guard still denies
watcher/stop-autopilot.cmd
```
Expected: a real session binds a standing order, autopilot kicks it, and the guard denies a protected write. **This is the criterion that proves the system still works rather than still builds.** Paste the whole transcript into the commit body.

- [ ] **Step 6: Commit and merge**

```bash
git add -A && git commit -m "refactor: rename the folder to match the repo, re-point every consumer (AC-J14)"
git checkout main && git merge --no-ff acc/j-decomposition -m "merge: sub-project J, six repos and the naming migration"
```

- [ ] **Step 7: Close `OI-026` and `OI-022`, update the master plan**

---

## Self-Review

**Spec coverage:** AC-J1→T1+T2+T3, AC-J2/J3/J4→T4, AC-J5/J6/J7→T5, AC-J8→T6, AC-J9/J10→T7–T11 (section-5 artifacts per repo), AC-J11→T7–T11 Step 4, AC-J12→T7–T11 Step 2, AC-J13→T3, AC-J14→T7–T12 Step 6/5, AC-J15→T3. All fifteen covered.

**Placeholder scan:** Two code steps are described rather than shown — Task 4 Step 3 (`upsert`'s grouping logic) and Task 2 Step 3's CLI walker. Both have complete tests defining exact behaviour, which is the contract; writing the body from a red test is the job. Task 12's `node -e "/* attempt a denied write */"` is a genuine gap: fill it with the exact denied-path command from `core/guard.test.mjs`'s existing traversal case when executing.

**Type consistency:** `repoRoot()`/`resolve()` from Task 1 used unchanged throughout. `Finding = { file, line, text }` shared by `pathgate` and `namegate`. `registrations = [{ event, matcher, command }]` identical in Task 4's tests and Tasks 9–12's usage. `migrate({from,to}) -> {moved,skipped}` fixed in Task 5.

**Ordering risk, stated:** Tasks 7–11 each re-point live hook registrations. If any extraction leaves the machine unable to start a session, the recovery is `npm run install-hooks` in the last-known-good repo — which is exactly what Task 4 exists to guarantee, and why it lands before any file moves.

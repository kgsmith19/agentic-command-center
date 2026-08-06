# ACC Open-Issues Closure Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close OI-023 (DEP0190 spawn), OI-024 (guardhook autonomy ceilings), OI-022 (web decision), OI-020 (Playwright e2e foundation) and OI-025 (deferred proof run), then push the branch and end on green CI.

**Architecture:** One shared quoting module makes the DEP0190 combination unrepresentable at all three claude spawn sites; the guardhook adopts the supervisor's own `effectiveCeilings`; a loopback-only Node server + plain HTML page replatform the kernel-settings tab (web-incremental decision of record), tested by Playwright in a new ubuntu CI job. Spec: `docs/superpowers/specs/2026-08-03-acc-oi-closure-design.md` — read it first.

**Tech Stack:** Node >= 22 (`node:test`, zero runtime deps), PowerShell 5.1 WinForms + WebView2, `@playwright/test` (the ONE new devDependency, chromium only).

**Checkbox-state notice (added 2026-08-06, Phase 8 of `docs/2026-08-03-full-remediation-prompt.md`):** every checkbox below is unchecked, but substantial-to-complete matching work already exists in the repo for most tasks in this plan (confirmed by cross-referencing `OPEN-ISSUES.md` and `git log`) — this plan predates the convention of checking boxes off as work lands, and was never gone back through to update them. Do not read an unchecked box here as "not done." `OPEN-ISSUES.md` and the current code are the source of truth for what actually shipped; this file records the ORIGINAL task breakdown, not live status.

## Global Constraints

- Run everything from `C:\code\guards`. Never `node --test hooks/` (directory form grades as one bogus failing test).
- Fast tier locally: `npm run test:windows`. Targeted: `node --test <file...>`. Coverage: `npm run covgate` — floors on CHANGED lib files: lines 100 / functions 100 / branches 90.
- Tests are written RED FIRST. Record the red: paste one line of the failing output into that task's commit body as `RED: <line>`. A test born green proves nothing.
- Never run a hook or test against live state. Suites sandbox via `ACC_ROOT` / `ACC_POLICY` / `ACC_LANE_DIR` / `ACC_RUNNER_ROOT`; follow each test file's existing pattern.
- Every real claude spawn goes through the launch lane. The two proof suites already do this internally — just run them as written, one at a time.
- Run `/security-review` before the commits flagged below (they touch input handling), and address findings before committing.
- Zero runtime dependencies stays true. Only `@playwright/test` enters `devDependencies`.
- PowerShell edits: 5.1 syntax (no `&&`, no ternary). Match surrounding style. Line numbers cited below are as of commit `3ecf386` — re-anchor with the quoted context if drifted.
- Kernel proof runs and Playwright spend real resources; do not loop them on failure — investigate instead.

---

### Task 1: `hooks/cmdline.mjs` — quoting helper + spawn spec

**Files:**
- Create: `hooks/cmdline.mjs`
- Test: `hooks/cmdline.test.mjs`
- Modify: `package.json:9-10` (add the test to both lists), `.github/workflows/ci.yml:78` (add to `ACC_COVGATE_TESTS`), `AGENTS.md:118` (add to the fast-tier file list)

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `class CmdQuoteError extends Error`; `cmdQuote(arg) -> string` (throws `CmdQuoteError`); `spawnSpec(bin, args = [], platform = process.platform) -> {file, args, shell:false}` on POSIX, `{file, shell:true}` (NO `args` key) on win32. Tasks 2-3 consume `spawnSpec`.

- [ ] **Step 1: Write the failing test** — create `hooks/cmdline.test.mjs`:

```js
// node --test hooks/cmdline.test.mjs  (run from C:\code\guards)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cmdQuote, spawnSpec, CmdQuoteError } from "./cmdline.mjs";

test("bare-safe args pass through untouched", () => {
  for (const a of ["-p", "--output-format", "stream-json", "C:\\tmp\\s.json", "a/b.mjs", "Read.Bash", "key=value", "@scope", "trailing\\"]) {
    assert.equal(cmdQuote(a), a);
  }
});

test("anything else is CRT-quoted; embedded quotes and backslash runs survive", () => {
  assert.equal(cmdQuote("two words"), '"two words"');
  assert.equal(cmdQuote(""), '""');
  assert.equal(cmdQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(cmdQuote("a b\\"), '"a b\\\\"');
  assert.equal(cmdQuote('back\\\\"slash'), '"back\\\\\\\\\\"slash"');
});

test("cmd metacharacters always end up inside quotes, never bare", () => {
  for (const a of ["a&b", "a|b", "a>b", "a<b", "a^b", "(a)", "a!b", "a;b", "a,b", "a b&c"]) {
    const q = cmdQuote(a);
    assert.ok(q.startsWith('"') && q.endsWith('"'), `${a} must be quoted, got ${q}`);
  }
});

test("what cannot be made safe throws, never mangles (fail closed)", () => {
  for (const a of ["line\nbreak", "cr\rhere", "%PATH%", "50%", "nul\0char"]) {
    assert.throws(() => cmdQuote(a), CmdQuoteError, a);
  }
});

test("spawnSpec invariant: shell:true never carries an args array (DEP0190 unrepresentable)", () => {
  const win = spawnSpec("claude", ["-p", "two words"], "win32");
  assert.equal(win.shell, true);
  assert.ok(!("args" in win), "shell spec must not carry args");
  assert.equal(win.file, 'claude -p "two words"');
  const posix = spawnSpec("claude", ["-p", "two words"], "linux");
  assert.deepEqual(posix, { file: "claude", args: ["-p", "two words"], shell: false });
});

test("real spawn round-trip: hostile argv arrives byte-identical on THIS platform", () => {
  const hostile = ["two words", 'say "hi"', "a&b|c>d<e", "(paren)!bang", "comma,semi;colon", "a b\\", ""];
  const probe = "console.log(JSON.stringify(process.argv.slice(1)))";
  const sp = spawnSpec(process.execPath, ["-e", probe, ...hostile]);
  const r = sp.args
    ? spawnSync(sp.file, sp.args, { encoding: "utf8" })
    : spawnSync(sp.file, { shell: true, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout);
  assert.deepEqual(seen.slice(-hostile.length), hostile);
});
```

- [ ] **Step 2: Run it, verify it fails** — `node --test hooks/cmdline.test.mjs` → Expected: FAIL, cannot find module `./cmdline.mjs`. Keep one line for the commit body.
- [ ] **Step 3: Implement** — create `hooks/cmdline.mjs`:

```js
// hooks/cmdline.mjs — the one boundary between "we hold argv" and "a child
// process runs". Closes DEP0190 (shell:true + args array is concatenated,
// not escaped) at every real-claude spawn site: kernel adapter identity()/
// startTask() and runner/runClaudeOnce. POSIX needs no shell at all, so the
// injection class is deleted there, not escaped. Windows must keep a shell
// for the `claude.cmd` shim (Node refuses shell-less .cmd since
// CVE-2024-27980), so args become ONE string, quoted here, tested hard.
export class CmdQuoteError extends Error {}

// Chars cmd.exe passes through bare AND the MS C runtime parses as one arg.
// Everything else is CRT-quoted; quoting also neutralizes cmd metacharacters
// (& | < > ^ ( ) ! ; ,) because cmd treats quoted spans literally with
// delayed expansion off — node spawns `cmd.exe /d /s /c`, so it is off.
const BARE = /^[A-Za-z0-9._:\\/+=@-]+$/;

export function cmdQuote(arg) {
  const s = String(arg);
  if (/[\r\n\0]/.test(s)) throw new CmdQuoteError(`control character in spawn arg: ${JSON.stringify(s)}`);
  // % expands even inside quotes and cannot be caret-escaped on a /c command
  // line. Kernel-generated args never contain it; refusing beats mangling.
  if (s.includes("%")) throw new CmdQuoteError(`"%" cannot be escaped on a cmd.exe command line: ${JSON.stringify(s)}`);
  if (s !== "" && BARE.test(s)) return s;
  let out = '"';
  let bs = 0;
  for (const ch of s) {
    if (ch === "\\") { bs++; continue; }
    if (ch === '"') { out += "\\".repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
    out += "\\".repeat(bs) + ch;
    bs = 0;
  }
  return out + "\\".repeat(bs * 2) + '"';
}

// What to hand child_process. Invariant (unit-locked): shell:true => no args
// key, so the DEP0190 combination is unrepresentable at the call sites.
export function spawnSpec(bin, args = [], platform = process.platform) {
  if (platform !== "win32") return { file: String(bin), args: args.map(String), shell: false };
  return { file: [bin, ...args].map(cmdQuote).join(" "), shell: true };
}
```

- [ ] **Step 4: Run to green** — `node --test hooks/cmdline.test.mjs` → all pass.
- [ ] **Step 5: Wire the lists** — `package.json`: add `hooks/cmdline.test.mjs` after `hooks/prompts.test.mjs` in BOTH `test` and `test:windows`; `ci.yml` line 78: add `hooks/cmdline.test.mjs` to `ACC_COVGATE_TESTS`; `AGENTS.md` line 118 block: add it to the fast-tier list.
- [ ] **Step 6: Gates** — `npm run test:windows` green, then `npm run covgate` green (cmdline.mjs is a changed lib file; floors apply).
- [ ] **Step 7: `/security-review`** on the working diff; address findings.
- [ ] **Step 8: Commit** — `git add -A` then commit:
`feat(hooks): cmdline.mjs — fail-closed cmd quoting and DEP0190-free spawn specs` (body includes the `RED:` line).

---

### Task 2: adapter call sites — identity, startTask, raw buildArgs

**Files:**
- Modify: `kernel/adapters/claude-code.mjs:19-24` (identity), `:36-44` (buildArgs), `:62-64` (startTask spawn)
- Test: `kernel/adapters/claude-code.test.mjs:11-49` (update), plus one new capture test

**Interfaces:**
- Consumes: `spawnSpec` from `hooks/cmdline.mjs` (adapter already imports from `hooks/` — see `:14`).
- Produces: `buildArgs` now returns the settings path RAW (no embedded quotes). Nothing else changes shape.

- [ ] **Step 1: Turn the tests red** — in `claude-code.test.mjs`:
  - In the `buildArgs` test (line ~34), change the expectation `'"C:/tmp/s.json"'` → `"C:/tmp/s.json"` (raw, no quotes).
  - Update the identity test to the new call shape and add a startTask capture test:

```js
import { spawnSpec } from "../../hooks/cmdline.mjs";

test("identity probes via spawnSpec — no args array ever rides shell:true", () => {
  const calls = [];
  const exec = (...c) => { calls.push(c); return "2.1.220 (Claude Code)\n"; };
  assert.deepEqual(A.identity({ exec }), { name: "claude-code", version: "2.1.220" });
  const sp = spawnSpec("claude", ["--version"]);
  assert.equal(calls[0][0], sp.file);
  if (sp.args) {
    assert.deepEqual(calls[0][1], sp.args);
    assert.equal(calls[0][2].shell, false);
  } else {
    assert.equal(calls[0][1].shell, true);
  }
});

test("startTask spawns exactly what spawnSpec builds for this platform", async () => {
  const seen = [];
  const child = fakeChild();
  const handle = await A.startTask({
    runId: "r-spec", prompt: "p", settingsPath: "C:/tmp dir/s.json",
    sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"],
    cwd: BASE, spawnFn: (...a) => { seen.push(a); return child; },
  });
  const sp = spawnSpec("claude", A.buildArgs({ settingsPath: "C:/tmp dir/s.json", sessionId: "11111111-2222-3333-4444-555555555555", tools: ["Read"] }));
  assert.equal(seen[0][0], sp.file);
  const opts = sp.args ? seen[0][2] : seen[0][1];
  if (sp.args) assert.deepEqual(seen[0][1], sp.args);
  assert.equal(opts.shell, sp.shell);
  child.emit("close", 0);
  await handle.done;
});
```

  (`"C:/tmp dir/s.json"` has a space on purpose — on Windows the spec test proves it arrives quoted; delete the old identity test it replaces.)
- [ ] **Step 2: Verify red** — `node --test kernel/adapters/claude-code.test.mjs` → FAIL (old quoting / old call shape). Keep a `RED:` line.
- [ ] **Step 3: Implement** — in `claude-code.mjs`:
  - Add `import { spawnSpec } from "../../hooks/cmdline.mjs";`
  - Replace the comment at `:19-20` with: `// Spawn shapes come from hooks/cmdline.mjs: POSIX = argv + no shell; Windows = one pre-quoted string + shell (the .cmd shim needs it). See OI-023.`
  - `identity()`: build `const sp = spawnSpec("claude", ["--version"]);` and call
    `sp.args ? exec(sp.file, sp.args, { encoding: "utf8", timeout: 15000, windowsHide: true, shell: sp.shell }) : exec(sp.file, { encoding: "utf8", timeout: 15000, windowsHide: true, shell: sp.shell })`.
  - `buildArgs()`: `"--settings", `\`"${settingsPath}"\`` → `"--settings", settingsPath` (raw). Update the function's comment: quoting is the spawn boundary's job now.
  - `startTask()`: `const sp = spawnSpec("claude", buildArgs({ settingsPath, sessionId, tools, resume }));` then
    `const opts = { cwd, shell: sp.shell, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: { ...as today } };`
    `child = sp.args ? spawnFn(sp.file, sp.args, opts) : spawnFn(sp.file, opts);`
- [ ] **Step 4: Green** — `node --test kernel/adapters/claude-code.test.mjs` then `npm run test:windows`, `npm run covgate`.
- [ ] **Step 5: `/security-review`**, then commit: `fix(kernel): adapter spawns via spawnSpec — no shell on POSIX, quoted string on Windows (OI-023)`.

---

### Task 3: runner call site + the DEP0190 regression lock

**Files:**
- Modify: `runner/runner.mjs:100-123` (runClaudeOnce spawn)
- Test: `runner/runner.test.mjs` (one new test in the fake-claude integration group, after line ~358)

**Interfaces:**
- Consumes: `spawnSpec` from `hooks/cmdline.mjs` (runner already imports from `hooks/` — see `:12`).
- Produces: nothing new; behavior identical, warning gone.

- [ ] **Step 1: Write the failing test** — in `runner.test.mjs`, integration group (fake `claude` is already on PATH — POSIX shebang stub at `:341-349`, `claude.cmd` at `:350`):

```js
test("integration: the spawn path is DEP0190-clean (--throw-deprecation stays exit 0)", async () => {
  const dir = fakeClaudeDir("dep0190");
  process.env.FAKE_CLAUDE_MODE = "ok";
  const j = job({ bootstrap: "dep check" });
  const driver = `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(HERE, "runner.mjs")).href)});
    const j = ${JSON.stringify(j)};
    const r = await m.runClaudeOnce(j);
    process.exit(r.code === 0 ? 0 : 1);
  `;
  const r = spawnSync(process.execPath, ["--throw-deprecation", "--input-type=module", "-e", driver], {
    encoding: "utf8", env: { ...process.env },
  });
  assert.ok(!/DEP0190/.test(r.stderr), `spawn still triggers DEP0190:\n${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
});
```

  Use the file's existing `job(...)` helper, `HERE`, and imports (`pathToFileURL` from `node:url`, `spawnSync` — add imports if the file lacks them). The driver inherits `ACC_RUNNER_ROOT`/`FAKE_CLAUDE_*`/PATH from the suite's env.
- [ ] **Step 2: Verify red** — `node --test runner/runner.test.mjs` → the new test FAILS with DEP0190 in stderr (thrown as an error under `--throw-deprecation`). Keep a `RED:` line.
- [ ] **Step 3: Implement** — in `runner.mjs`, add `import { spawnSpec } from "../hooks/cmdline.mjs";` to the top imports, then replace the spawn in `runClaudeOnce` (`:106`):

```js
    const sp = spawnSpec("claude", args);
    const opts = {
      cwd: job.workdir, shell: sp.shell, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", // see killTree
      env: { ...process.env, ACC_PTY: "", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", CLAUDE_CODE_RUNNER: "1", NODE_V8_COVERAGE: undefined },
    };
    const child = sp.args ? spawn(sp.file, sp.args, opts) : spawn(sp.file, opts);
```

  Keep the existing env/timeout comments (`:109-122`) with the block. Update the comment at `:96-99`: bootstrap still goes over stdin by doctrine; argv is now quoted/shell-free per platform via `hooks/cmdline.mjs`.
- [ ] **Step 4: Green** — `node --test runner/runner.test.mjs` (all 40), `npm run test:windows`, `npm run covgate`.
- [ ] **Step 5: `/security-review`**, then commit: `fix(runner): runClaudeOnce spawns via spawnSpec; --throw-deprecation regression lock (OI-023)`.

---

### Task 4: guardhook enforces autonomy-tightened ceilings

**Files:**
- Modify: `kernel/autonomy.mjs` (add `readAutonomyStrict`), `kernel/guardhook.mjs:84-99`, `kernel/README.md` (honest-ceilings wording), traceability AC-B1/AC-B2 language (grep `AC-B1` under `docs/` and `kernel/`)
- Test: `kernel/autonomy.test.mjs` (3 cases), `kernel/guardhook.test.mjs` (4 cases)

**Interfaces:**
- Consumes: `effectiveCeilings(contract, policy, state)` (exists, `autonomy.mjs:33`), `autonomyFile()` from `ledger.mjs`.
- Produces: `readAutonomyStrict() -> state` (ENOENT → fresh `{factor:1,...}`; other read/parse errors THROW). Ledger decision records gain `ceiling` (number) and `autonomyFactor` (number) fields.

- [ ] **Step 1: Failing tests, autonomy side** — in `kernel/autonomy.test.mjs`, following the file's existing sandbox pattern (`ACC_ROOT`/`ACC_POLICY`):

```js
test("readAutonomyStrict: missing file is fresh, corrupt file THROWS (never fails open)", () => {
  fs.rmSync(autonomyFile(), { force: true });
  assert.equal(readAutonomyStrict().factor, 1);
  fs.mkdirSync(path.dirname(autonomyFile()), { recursive: true });
  fs.writeFileSync(autonomyFile(), "{ not json");
  assert.throws(() => readAutonomyStrict());
  fs.writeFileSync(autonomyFile(), JSON.stringify({ factor: 0.5, runsLeft: 3 }));
  assert.equal(readAutonomyStrict().factor, 0.5);
});
```

- [ ] **Step 2: Failing tests, guardhook side** — in `kernel/guardhook.test.mjs` (idiom: `stage()` + `fire()`; `L.autonomyFile()` lives under the sandboxed `ACC_ROOT`). First hoist two imports to the top of the file, next to the existing `S`/`L` ones:

```js
const AU = await import("./autonomy.mjs");
const P = await import("./policy.mjs");
```

  then add:

```js
test("a tightened autonomy factor shrinks the per-fire ceiling to EXACTLY effectiveCeilings' number (OI-024)", () => {
  stage();
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), JSON.stringify({ factor: 0.5 }));
  const shrunk = AU.effectiveCeilings(contract, P.loadKernelPolicy(), { factor: 0.5 }).toolCalls; // 3 * 0.5 -> 2
  const read = () => fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  for (let i = 0; i < shrunk; i++) assert.equal(read().code, 0, `fire ${i + 1} of ${shrunk} must still be allowed`);
  const over = read();
  assert.equal(over.code, 2, "the fire after the shrunk ceiling must be denied");
  const rows = fs.readFileSync(L.decisionsFile(RUN), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).ceiling, shrunk, "the decision record must carry the effective ceiling");
  assert.equal(rows.at(-1).autonomyFactor, 0.5, "…and the factor that produced it");
});

test("absent autonomy state means base ceiling, corrupt autonomy state fails closed", () => {
  stage(); // no autonomy file
  const read = () => fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  for (let i = 0; i < 3; i++) assert.equal(read().code, 0); // contract.budget.toolCalls = 3
  assert.equal(read().code, 2);
  stage();
  fs.mkdirSync(path.dirname(L.autonomyFile()), { recursive: true });
  fs.writeFileSync(L.autonomyFile(), "{ not json");
  const r = read();
  assert.equal(r.code, 2);
  assert.match(r.err, /autonomy/i);
});

test("a contract yielding no finite toolCalls ceiling denies instead of comparing against NaN", () => {
  process.env.ACC_ROOT = ROOT; process.env.ACC_POLICY = POLICY;
  fs.rmSync(ROOT, { recursive: true, force: true });
  S.writeRunFiles({ ...contract, budget: { ...contract.budget, toolCalls: "many" } }, { runId: RUN, guardhookPath: HOOK });
  const r = fire({ tool_name: "Read", tool_input: { file_path: path.join(BASE, "work", "a.txt") } });
  assert.equal(r.code, 2);
  assert.match(r.err, /finite/i);
});
```

  Note: `await import` is only legal at module top level — hoist `AU`/`P` imports to sit beside the file's existing `S`/`L` imports. If the existing over-ceiling denial message doesn't match, read the deny text in `kernel/guard.mjs` and keep assertions on exit codes + ledger fields (already the strongest claims).
- [ ] **Step 3: Verify red** — `node --test kernel/autonomy.test.mjs kernel/guardhook.test.mjs` → new cases FAIL (no `readAutonomyStrict`; ceiling not shrunk; NaN compares allow). Keep a `RED:` line.
- [ ] **Step 4: Implement** — `autonomy.mjs`, after `readAutonomy`:

```js
// Strict read for ENFORCEMENT points (guardhook). ENOENT = fresh state (the
// first-run case). Anything else THROWS: an enforcement point that treats a
// corrupt state file as "no tightening" fails open, and readAutonomy's
// lenient fallback is exactly that. Reporting paths keep readAutonomy.
export function readAutonomyStrict() {
  let raw;
  try {
    raw = fs.readFileSync(autonomyFile(), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { ...FRESH, log: [] };
    throw e;
  }
  return { ...FRESH, ...JSON.parse(raw) };
}
```

  `guardhook.mjs`: import `{ effectiveCeilings, readAutonomyStrict }` from `./autonomy.mjs`; replace lines 84-86 with:

```js
let autonomy;
try {
  autonomy = readAutonomyStrict();
} catch (e) {
  deny(`cannot read autonomy state (${e.message}) — failing closed`, pin.runId, {
    tool: payload?.tool_name ?? null, allow: false, rule: "config", reason: "unreadable autonomy state", target: null,
  });
}
// The SAME function the supervisor uses (run.mjs) — the two enforcement
// points cannot drift, and tightening applies on the very next fire (OI-024).
const ceiling = effectiveCeilings(contract, policy, autonomy).toolCalls;
if (!Number.isFinite(ceiling)) {
  deny(`no finite toolCalls ceiling from contract/policy (got ${ceiling}) — failing closed`, pin.runId, {
    tool: payload?.tool_name ?? null, allow: false, rule: "config", reason: "non-finite toolCalls ceiling", target: null,
  });
}
```

  and extend the record write at `:99` to
  `appendDecision(pin.runId, { tool: d.tool, allow: d.allow, rule: d.rule, reason: d.reason, target: d.target, ceiling, autonomyFactor: autonomy.factor ?? 1 });`
  (Behavior note, deliberate: a non-numeric `contract.budget.toolCalls` used to fall back to the policy default via `Number.isFinite`; it now DENIES. Fail-closed doctrine — the new test locks it.)
- [ ] **Step 5: Docs truth-up** — grep `AC-B1\|AC-B2\|60s\|tick` in `kernel/README.md` and `docs/` traceability material; rewrite any sentence claiming toolCalls tightening waits for the supervisor tick (it no longer does; wall-clock/stall still do).
- [ ] **Step 6: Green + gates** — targeted suites, then `npm run test:windows`, `npm run covgate`.
- [ ] **Step 7: `/security-review`**, then commit: `fix(kernel): guardhook enforces autonomy-tightened toolCalls ceiling per fire (OI-024)`.

---

### Task 5: kernel proof run (covers Tasks 1-4 live)

- [ ] **Step 1:** `node kernel/kernel.e2e.mjs` — real tokens, lane-serialized, run it once, deliberately.
- [ ] **Step 2:** Expected: both scenarios PASS as the suite defines them, AND the captured output contains **no `DEP0190`** anywhere (that warning in this exact suite's stderr is what opened OI-023). If DEP0190 appears or a scenario fails: stop, fix, re-run once. Save the tail of the output for the Task 12 ledger commit.

---

### Task 6: `saveKernelPolicy` — the policy write API

**Files:**
- Modify: `kernel/policy.mjs` (append two exports)
- Test: `kernel/policy.test.mjs`

**Interfaces:**
- Consumes: `policyPath()`, `loadKernelPolicy()` (same file).
- Produces: `validateKernelBlock(block)` (throws `Error` with `kernel policy: <field> ...`), `saveKernelPolicy(block) -> loadKernelPolicy()` result. Task 7's server consumes both. Block shape (exactly what the GUI edits): `{ harness, budget: { wallClockMin, toolCalls, tokens }, hardCaps: { wallClockMin }, autonomy: { window, rejectRate, factor, runs }, checkpointMin, alwaysAllowTools: [], extraDenyWriteRoots: [] }`.

- [ ] **Step 1: Failing tests** — in `kernel/policy.test.mjs` (existing `ACC_POLICY` sandbox idiom; build a valid block by editing a copy of `loadKernelPolicy()`):

```js
const goodBlock = () => {
  const k = loadKernelPolicy();
  return {
    harness: "claude-code",
    budget: { wallClockMin: k.budget.wallClockMin, toolCalls: 150, tokens: k.budget.tokens },
    hardCaps: { wallClockMin: k.hardCaps.wallClockMin },
    autonomy: { ...k.autonomy },
    checkpointMin: k.checkpointMin,
    alwaysAllowTools: ["TodoWrite"],
    extraDenyWriteRoots: [],
  };
};

test("saveKernelPolicy round-trips through the file and preserves everything it does not own", () => {
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({
    context: { softK: 400 },
    kernel: { ...goodBlock(), _note: "keep me" },
  }, null, 2));
  const saved = saveKernelPolicy({ ...goodBlock(), budget: { ...goodBlock().budget, toolCalls: 99 } });
  assert.equal(saved.budget.toolCalls, 99);
  const onDisk = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  assert.equal(onDisk.kernel.budget.toolCalls, 99);
  assert.equal(onDisk.kernel._note, "keep me", "unknown kernel keys survive");
  assert.equal(onDisk.context.softK, 400, "other policy blocks survive");
});

test("an invalid block is rejected atom-for-atom: throws, file byte-identical", () => {
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ kernel: goodBlock() }, null, 2));
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  for (const evil of [
    { ...goodBlock(), harness: "" },
    { ...goodBlock(), budget: { ...goodBlock().budget, toolCalls: 0 } },
    { ...goodBlock(), budget: { ...goodBlock().budget, tokens: 1.5 } },
    { ...goodBlock(), autonomy: { ...goodBlock().autonomy, rejectRate: 5 } },
    { ...goodBlock(), autonomy: { ...goodBlock().autonomy, factor: 0 } },
    { ...goodBlock(), checkpointMin: -1 },
    { ...goodBlock(), alwaysAllowTools: ["", "x"] },
    { ...goodBlock(), alwaysAllowTools: "TodoWrite" },
  ]) {
    assert.throws(() => saveKernelPolicy(evil), /kernel policy:/);
    assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before, "rejected save must not touch the file");
  }
});

test("saveKernelPolicy with no policy file fails closed instead of inventing one", () => {
  fs.rmSync(process.env.ACC_POLICY, { force: true });
  assert.throws(() => saveKernelPolicy(goodBlock()), /cannot edit/);
});
```

- [ ] **Step 2: Verify red**, keep a `RED:` line.
- [ ] **Step 3: Implement** — append to `kernel/policy.mjs`:

```js
// The GUI's write path (gui/server.mjs). Validation and the atomic write live
// HERE, with the other policy IO — the server carries no business logic.
function req(cond, msg) { if (!cond) throw new Error(`kernel policy: ${msg}`); }
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const strList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim());

export function validateKernelBlock(k) {
  req(k && typeof k === "object", "block must be an object");
  req(typeof k.harness === "string" && k.harness.trim(), "harness must be a non-empty string");
  req(isNum(k.budget?.wallClockMin) && k.budget.wallClockMin > 0, "budget.wallClockMin must be > 0");
  req(Number.isInteger(k.budget?.toolCalls) && k.budget.toolCalls >= 1, "budget.toolCalls must be an integer >= 1");
  req(Number.isInteger(k.budget?.tokens) && k.budget.tokens >= 1, "budget.tokens must be an integer >= 1");
  req(isNum(k.hardCaps?.wallClockMin) && k.hardCaps.wallClockMin > 0, "hardCaps.wallClockMin must be > 0");
  req(isNum(k.checkpointMin) && k.checkpointMin > 0, "checkpointMin must be > 0");
  req(Number.isInteger(k.autonomy?.window) && k.autonomy.window >= 1, "autonomy.window must be an integer >= 1");
  req(isNum(k.autonomy?.rejectRate) && k.autonomy.rejectRate > 0 && k.autonomy.rejectRate <= 1, "autonomy.rejectRate must be in (0, 1]");
  req(isNum(k.autonomy?.factor) && k.autonomy.factor > 0 && k.autonomy.factor <= 1, "autonomy.factor must be in (0, 1]");
  req(Number.isInteger(k.autonomy?.runs) && k.autonomy.runs >= 1, "autonomy.runs must be an integer >= 1");
  req(strList(k.alwaysAllowTools), "alwaysAllowTools must be a list of non-empty strings");
  req(strList(k.extraDenyWriteRoots), "extraDenyWriteRoots must be a list of non-empty strings");
}

export function saveKernelPolicy(block) {
  validateKernelBlock(block);
  const file = policyPath();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`kernel policy: cannot edit ${file} (${e.message})`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const pol = JSON.parse(text);
  pol.kernel = {
    ...(pol.kernel || {}), // _note and any future keys survive
    harness: block.harness.trim(),
    budget: { wallClockMin: block.budget.wallClockMin, toolCalls: block.budget.toolCalls, tokens: block.budget.tokens },
    hardCaps: { ...((pol.kernel || {}).hardCaps || {}), wallClockMin: block.hardCaps.wallClockMin },
    autonomy: { window: block.autonomy.window, rejectRate: block.autonomy.rejectRate, factor: block.autonomy.factor, runs: block.autonomy.runs },
    checkpointMin: block.checkpointMin,
    alwaysAllowTools: block.alwaysAllowTools.map((s) => s.trim()),
    extraDenyWriteRoots: block.extraDenyWriteRoots.map((s) => s.trim()),
  };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(pol, null, 2));
  fs.renameSync(tmp, file); // atomic on the same volume; no torn policy.json
  return loadKernelPolicy();
}
```

- [ ] **Step 4: Green + gates** — `node --test kernel/policy.test.mjs`, `npm run test:windows`, `npm run covgate`.
- [ ] **Step 5: Commit** — `feat(kernel): saveKernelPolicy — validated atomic writes for the kernel policy block`.

---

### Task 7: `gui/server.mjs` + covgate extension to `gui/`

**Files:**
- Create: `gui/server.mjs`
- Test: `gui/server.test.mjs`
- Modify: `hooks/covgate.mjs:69` (lib regex) and its test-discovery dirs (~`:137`), `hooks/covgate.test.mjs` (one case), `package.json` (both test lists), `ci.yml:78` (covgate list), `AGENTS.md:118`

**Interfaces:**
- Consumes: `loadKernelPolicy`, `saveKernelPolicy` from `kernel/policy.mjs`.
- Produces: `handler(req, res)`, `startServer({ port }) -> Promise<{ server, port }>`; CLI `node gui/server.mjs [--port N]` printing `LISTENING <port>`. Routes: `GET /` and `/kernel.html` (static), `GET|POST /api/kernel-policy`. Tasks 8-9 consume the CLI + routes.

- [ ] **Step 1: Failing tests** — create `gui/server.test.mjs`:

```js
// node --test gui/server.test.mjs  (run from C:\code\guards)
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-gui-srv-"));
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_ROOT = path.join(BASE, "root");
const KERNEL = {
  harness: "claude-code",
  budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 },
  hardCaps: { wallClockMin: 240 },
  autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 },
  checkpointMin: 20, alwaysAllowTools: ["TodoWrite"], extraDenyWriteRoots: [],
};
const resetPolicy = () => fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ kernel: { ...KERNEL, _note: "fixture" } }, null, 2));

const { startServer } = await import("./server.mjs");
let srv, base;
before(async () => { const s = await startServer({ port: 0 }); srv = s.server; base = `http://127.0.0.1:${s.port}`; });
beforeEach(resetPolicy);
after(() => { srv.close(); fs.rmSync(BASE, { recursive: true, force: true }); });

const good = () => ({ ...KERNEL, budget: { ...KERNEL.budget, toolCalls: 150 } });
const post = (body, headers = {}) => fetch(`${base}/api/kernel-policy`, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", "X-ACC": "1", ...headers },
});

test("GET / serves the kernel page", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /id="toolCalls"/);
});

test("GET /api/kernel-policy returns the live block", async () => {
  const r = await fetch(`${base}/api/kernel-policy`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).kernel.budget.toolCalls, 200);
});

test("a valid POST lands on disk and preserves _note", async () => {
  const r = await post(good());
  assert.equal(r.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  assert.equal(onDisk.kernel.budget.toolCalls, 150);
  assert.equal(onDisk.kernel._note, "fixture");
});

test("CSRF is closed by construction: no X-ACC header, foreign Origin, foreign Host all 403 and never write", async () => {
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  assert.equal((await post(good(), { "X-ACC": "" })).status, 403);
  assert.equal((await post(good(), { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(good(), { host: "evil.example" })).status, 403);
  assert.equal((await fetch(`${base}/api/kernel-policy`, { headers: { host: "evil.example" } })).status, 403);
  assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before);
});

test("no CORS grant ever leaves this server", async () => {
  const r = await fetch(`${base}/api/kernel-policy`, { headers: { origin: "http://127.0.0.1" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("invalid input: bad JSON 400, invalid block 400 with the validator's message, file untouched", async () => {
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  const raw = await fetch(`${base}/api/kernel-policy`, { method: "POST", body: "{ nope", headers: { "X-ACC": "1" } });
  assert.equal(raw.status, 400);
  const bad = await post({ ...good(), checkpointMin: -1 });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /checkpointMin/);
  assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before);
});

test("unknown routes 404", async () => {
  assert.equal((await fetch(`${base}/api/other`)).status, 404);
  assert.equal((await fetch(`${base}/../policy.json`)).status, 404);
});

test("CLI: prints LISTENING <port> and serves on it", async () => {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url)); // add fileURLToPath to the node:url import
  const child = spawn(process.execPath, [serverPath, "--port", "0"], {
    env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  const line = await new Promise((res) => child.stdout.once("data", (d) => res(String(d))));
  const m = line.match(/^LISTENING (\d+)/);
  assert.ok(m, `expected LISTENING banner, got: ${line}`);
  const r = await fetch(`http://127.0.0.1:${m[1]}/api/kernel-policy`);
  assert.equal(r.status, 200);
  child.kill();
});
```

  (If the URL-to-path dance in the CLI test is awkward, use `fileURLToPath(new URL("./server.mjs", import.meta.url))` — cleaner, do that.)
- [ ] **Step 2: Verify red**, keep a `RED:` line.
- [ ] **Step 3: Implement** — create `gui/server.mjs`:

```js
#!/usr/bin/env node
// gui/server.mjs — rails of the web GUI (spec 2026-08-03-acc-oi-closure-design
// §5-§6): the kernel-settings tab is the first migrated tab; later tabs mount
// alongside. Loopback-only, ZERO business logic — reads and writes go through
// kernel/policy.mjs, the same single owner the WinForms tab used.
//
// Ethos answer (OI-022's recorded tension): binds 127.0.0.1 only. A same-user
// local process could already edit policy.json directly, so no new privilege
// exists here. The genuinely new risk is web-borne CSRF against a localhost
// mutator; it is closed by construction — mutating routes demand the custom
// X-ACC header (unsettable cross-origin without a CORS grant this server
// never issues), Origin/Host must be local, and no CORS header ever leaves.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKernelPolicy, saveKernelPolicy } from "../kernel/policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Exact-match route map — request input never touches a filesystem path, so
// there is no traversal surface to defend.
const PAGES = { "/": "kernel.html", "/kernel.html": "kernel.html" };
const BODY_CAP = 64 * 1024;

const localHost = (h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(h || ""));
const localOrigin = (o) => o === undefined || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(o));

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

export function handler(req, res) {
  if (!localHost(req.headers.host)) return send(res, 403, { error: "non-local Host" });
  if (!localOrigin(req.headers.origin)) return send(res, 403, { error: "non-local Origin" });
  const route = req.url.split("?")[0];
  if (req.method === "GET" && PAGES[route]) {
    return send(res, 200, fs.readFileSync(path.join(HERE, PAGES[route])), "text/html; charset=utf-8");
  }
  if (route === "/api/kernel-policy") {
    if (req.method === "GET") {
      try { return send(res, 200, { kernel: loadKernelPolicy() }); }
      catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (req.method === "POST") {
      if (req.headers["x-acc"] !== "1") return send(res, 403, { error: "missing X-ACC header" });
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > BODY_CAP) req.destroy(); // over-cap is dropped, never parsed
      });
      req.on("end", () => {
        let block;
        try { block = JSON.parse(body); }
        catch { return send(res, 400, { error: "body is not JSON" }); }
        try { return send(res, 200, { ok: true, kernel: saveKernelPolicy(block) }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      });
      return;
    }
  }
  send(res, 404, { error: "not found" });
}

export function startServer({ port = 0 } = {}) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const i = process.argv.indexOf("--port");
  const { port } = await startServer({ port: i === -1 ? 0 : Number(process.argv[i + 1]) });
  console.log(`LISTENING ${port}`); // consumers (guards-gui.ps1, Playwright) parse this line
}
```

  Also create **`gui/kernel.html` in this same step** — the server and its page ship together, and the `GET /` test above asserts against the page's `id="toolCalls"`. The full file content is given at the end of Task 8 (kept there so the Playwright selectors and the page sit side by side); copy it verbatim. Task 8 then only adds Playwright on top.
- [ ] **Step 4: covgate extension** — in `hooks/covgate.mjs:69` change the lib filter regex `^(hooks|runner|kernel)\/` → `^(hooks|runner|kernel|gui)\/` (keep the rest identical), and where test discovery lists directories (~`:137`, the `readdirSync` loop that scans for `*.test.mjs`), add `"gui"` to the scanned dirs. Add one `hooks/covgate.test.mjs` case following its fixture idiom: a changed `gui/x.mjs` with an uncovered line FAILS the gate (proving gui/ is now inside the fence). RED first: the case fails before the regex change.
- [ ] **Step 5: Wire the lists** — `package.json` both test lists + `ci.yml` `ACC_COVGATE_TESTS` + `AGENTS.md:118`: add `gui/server.test.mjs`.
- [ ] **Step 6: Green + gates** — `node --test gui/server.test.mjs hooks/covgate.test.mjs`, `npm run test:windows`, `npm run covgate` (server.mjs is now a gated lib file — floors apply to it).
- [ ] **Step 7: `/security-review`** (this is the network-facing commit — review Host/Origin/X-ACC logic, the exact-match route map, the body cap), then commit: `feat(gui): loopback kernel-settings server + page — first web-migrated tab (OI-022)`.

---

### Task 8: Playwright e2e for the kernel page

**Files:**
- Create: `playwright.config.mjs`, `gui/e2e/kernel-settings.spec.mjs`, `.gitignore` entries
- Modify: `package.json` (devDependency + `e2e:gui` script), commit `package-lock.json`

**Interfaces:**
- Consumes: `node gui/server.mjs --port 43117` + the page ids (`#harness #wallClockMin #toolCalls #tokens #hardCapWallClockMin #checkpointMin #window #rejectRate #factor #runs #alwaysAllowTools #extraDenyWriteRoots #save #status`).
- Produces: `npm run e2e:gui` — the command Task 10's CI job runs.

- [ ] **Step 1: Install** — `npm install --save-dev @playwright/test` then `npx playwright install chromium`. Create/append `.gitignore`:

```
node_modules/
test-results/
playwright-report/
```

- [ ] **Step 2: Config** — create `playwright.config.mjs`:

```js
import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One sandbox dir per run; the spec file reads the same env var to reset the
// fixture between tests. The server re-reads policy.json on every request
// (kernel/policy.mjs never caches), so no restarts are needed.
const dir = process.env.ACC_GUI_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "acc-gui-e2e-"));
process.env.ACC_GUI_E2E_DIR = dir;

export default defineConfig({
  testDir: "gui/e2e",
  use: { baseURL: "http://127.0.0.1:43117" },
  webServer: {
    command: "node gui/server.mjs --port 43117",
    url: "http://127.0.0.1:43117/api/kernel-policy",
    reuseExistingServer: false,
    env: { ACC_POLICY: path.join(dir, "policy.json"), ACC_ROOT: dir },
  },
});
```

- [ ] **Step 3: Failing spec** — create `gui/e2e/kernel-settings.spec.mjs`:

```js
// npm run e2e:gui  (run from C:\code\guards). Sandbox only — never live state.
// Satisfies OI-020's done-when: visible field state + a live-edit-applies-
// without-restart flow, in CI (see .github/workflows/ci.yml gui-e2e).
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const policyFile = path.join(process.env.ACC_GUI_E2E_DIR, "policy.json");
const KERNEL = {
  harness: "claude-code",
  budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 },
  hardCaps: { wallClockMin: 240 },
  autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 },
  checkpointMin: 20, alwaysAllowTools: ["TodoWrite"], extraDenyWriteRoots: [],
};
const onDisk = () => JSON.parse(fs.readFileSync(policyFile, "utf8"));

test.beforeEach(() => {
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  fs.writeFileSync(policyFile, JSON.stringify({ kernel: { ...KERNEL, _note: "e2e fixture" } }, null, 2));
});

test("renders the real on-disk field state", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#harness")).toHaveValue("claude-code");
  await expect(page.locator("#toolCalls")).toHaveValue("200");
  await expect(page.locator("#rejectRate")).toHaveValue("0.3");
  await expect(page.locator("#alwaysAllowTools")).toHaveValue("TodoWrite");
});

test("live edit applies without restart: save lands on disk, reload shows it", async ({ page }) => {
  await page.goto("/");
  await page.locator("#toolCalls").fill("150");
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("Saved");
  expect(onDisk().kernel.budget.toolCalls).toBe(150);
  expect(onDisk().kernel._note).toBe("e2e fixture");
  await page.reload();
  await expect(page.locator("#toolCalls")).toHaveValue("150");
});

test("invalid input is rejected visibly and the file stays untouched", async ({ page }) => {
  const before = fs.readFileSync(policyFile, "utf8");
  await page.goto("/");
  await page.locator("#rejectRate").fill("5");
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("Not saved");
  expect(fs.readFileSync(policyFile, "utf8")).toBe(before);
});

test("CSRF guard: a request without the custom header (or with a foreign Origin) is 403 and writes nothing", async ({ request }) => {
  const before = fs.readFileSync(policyFile, "utf8");
  const bare = await request.post("/api/kernel-policy", { data: { ...KERNEL } });
  expect(bare.status()).toBe(403);
  const foreign = await request.post("/api/kernel-policy", {
    data: { ...KERNEL }, headers: { "X-ACC": "1", origin: "https://evil.example" },
  });
  expect(foreign.status()).toBe(403);
  expect(fs.readFileSync(policyFile, "utf8")).toBe(before);
});
```

  Add to `package.json` scripts: `"e2e:gui": "playwright test"`.
- [ ] **Step 4: Red then green** — before the page exists the suite fails; with Task 7's `kernel.html` in place run `npm run e2e:gui` → 4/4 green. (If Task 7 shipped the page already, prove red differently: `git stash push gui/kernel.html` → run → FAIL → `git stash pop` → PASS. Record the `RED:` line either way.)
- [ ] **Step 5: Gates** — `npm run test:windows` still green (Playwright adds no fast-tier files), `npm run covgate`.
- [ ] **Step 6: Commit** (include `package-lock.json`): `test(gui): Playwright e2e for the kernel settings page (OI-020)`.

**`gui/kernel.html`** (created in Task 7 Step 3 alongside the server — full content):

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Kernel settings</title>
<style>
  body { font: 14px 'Segoe UI', sans-serif; margin: 16px; max-width: 720px; }
  fieldset { margin: 0 0 14px; border: 1px solid #ccc; }
  label { display: inline-block; margin: 4px 14px 4px 0; }
  input { width: 90px; }
  #harness { width: 140px; }
  #alwaysAllowTools, #extraDenyWriteRoots { width: 420px; }
  #status { margin-left: 12px; }
  .ok { color: #1a7a1a; }
  .err { color: #b22222; }
</style>
</head>
<body>
<h3>Kernel — ceilings and dials</h3>
<p>Edits apply to the very next tool call of a running kernel task — no restart.</p>
<fieldset><legend>Harness, per-run budget, and hard caps</legend>
  <label>Harness <input id="harness"></label>
  <label>Checkpoint interval (min) <input id="checkpointMin"></label><br>
  <label>Wall-clock (min) <input id="wallClockMin"></label>
  <label>Tool calls <input id="toolCalls"></label>
  <label>Tokens <input id="tokens"></label><br>
  <label>Hard cap on wall-clock (min) <input id="hardCapWallClockMin"></label>
</fieldset>
<fieldset><legend>Autonomy — automatic tightening after a run of failures</legend>
  <label>Window <input id="window"></label>
  <label>Reject rate <input id="rejectRate"></label>
  <label>Factor <input id="factor"></label>
  <label>Runs <input id="runs"></label>
</fieldset>
<fieldset><legend>Always-allowed tools and extra protected write roots (comma separated)</legend>
  <label>Always-allowed <input id="alwaysAllowTools"></label><br>
  <label>Extra write roots <input id="extraDenyWriteRoots"></label>
</fieldset>
<button id="save">Save kernel settings</button><span id="status"></span>
<script>
const $ = (id) => document.getElementById(id);
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
async function load() {
  const k = (await (await fetch("/api/kernel-policy")).json()).kernel;
  $("harness").value = k.harness ?? "";
  $("wallClockMin").value = k.budget.wallClockMin;
  $("toolCalls").value = k.budget.toolCalls;
  $("tokens").value = k.budget.tokens;
  $("hardCapWallClockMin").value = k.hardCaps.wallClockMin;
  $("checkpointMin").value = k.checkpointMin;
  $("window").value = k.autonomy.window;
  $("rejectRate").value = k.autonomy.rejectRate;
  $("factor").value = k.autonomy.factor;
  $("runs").value = k.autonomy.runs;
  $("alwaysAllowTools").value = k.alwaysAllowTools.join(", ");
  $("extraDenyWriteRoots").value = k.extraDenyWriteRoots.join(", ");
}
$("save").onclick = async () => {
  const st = $("status");
  const block = {
    harness: $("harness").value,
    budget: { wallClockMin: Number($("wallClockMin").value), toolCalls: Number($("toolCalls").value), tokens: Number($("tokens").value) },
    hardCaps: { wallClockMin: Number($("hardCapWallClockMin").value) },
    autonomy: { window: Number($("window").value), rejectRate: Number($("rejectRate").value), factor: Number($("factor").value), runs: Number($("runs").value) },
    checkpointMin: Number($("checkpointMin").value),
    alwaysAllowTools: list($("alwaysAllowTools").value),
    extraDenyWriteRoots: list($("extraDenyWriteRoots").value),
  };
  try {
    const r = await fetch("/api/kernel-policy", {
      method: "POST",
      headers: { "content-type": "application/json", "X-ACC": "1" },
      body: JSON.stringify(block),
    });
    const j = await r.json();
    if (!r.ok) { st.textContent = "Not saved: " + j.error; st.className = "err"; return; }
    st.textContent = "Saved. Next tool call in a running kernel task sees this - no restart.";
    st.className = "ok";
    await load();
  } catch (e) {
    st.textContent = "Not saved: " + e;
    st.className = "err";
  }
};
load().catch((e) => { $("status").textContent = "cannot read policy: " + e; $("status").className = "err"; });
</script>
</body>
</html>
```

---

### Task 9: WinForms kernel tab hosts the web page

**Files:**
- Modify: `guards-gui.ps1` — `:417-485` (tab body), `:791` (select handler), `:962-1011` (delete Refresh-Kernel + save click), `:1636` (delete `Refresh-Kernel` call), plus the form-close handler (grep `Add_FormClosed` / `FormClosing`).

**Interfaces:**
- Consumes: `node gui/server.mjs --port 0` printing `LISTENING <port>`; WebView2 idiom as at `:1360-1401`; `$script:TermOk` (dll load, `:8-23`); `$Root` (`:25`).
- Produces: nothing downstream; the WinForms field controls and their logic are DELETED (one implementation — the web page).

- [ ] **Step 1: Replace the tab body** — delete lines 423-485 (all `$lblK*/$txtK*/$grpK*/$btnKSave` control definitions, keeping the `$tabK = New-Tab 'Kernel'` line) and replace with:

```powershell
# The kernel settings UI is a WEB page now (gui/kernel.html served by
# gui/server.mjs on 127.0.0.1) — the first tab migrated per spec
# docs/superpowers/specs/2026-08-03-acc-oi-closure-design.md §5-§6. This tab
# only HOSTS it (WebView2 when the runtime exists; a browser button always).
# The same page and API are what Playwright drives in CI (gui/e2e/).
$pnlKTop = Add-Ctl $tabK (New-Object System.Windows.Forms.Panel) 0 0 10 10
$pnlKTop.Dock = 'Top'; $pnlKTop.Height = 36
$btnKOpen = New-Object System.Windows.Forms.Button
$btnKOpen.Text = 'Open in browser'; $btnKOpen.SetBounds(15, 5, 140, 26)
$lblKStatus = New-Object System.Windows.Forms.Label
$lblKStatus.SetBounds(170, 10, 480, 20)
$pnlKTop.Controls.Add($btnKOpen); $pnlKTop.Controls.Add($lblKStatus)

$script:kernelSrv = $null
$script:kernelUrl = $null
function Ensure-KernelServer {
    if ($script:kernelSrv -and -not $script:kernelSrv.HasExited) { return $true }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'node'
        $psi.Arguments = '"' + (Join-Path $Root 'gui\server.mjs') + '" --port 0'
        $psi.WorkingDirectory = $Root
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.CreateNoWindow = $true
        $script:kernelSrv = [System.Diagnostics.Process]::Start($psi)
        $line = $script:kernelSrv.StandardOutput.ReadLine()
        if ($line -notmatch '^LISTENING (\d+)$') { throw "unexpected server banner: $line" }
        $script:kernelUrl = "http://127.0.0.1:$($Matches[1])/kernel.html"
        $lblKStatus.Text = ''
        return $true
    } catch {
        $script:kernelUrl = $null
        $lblKStatus.Text = "kernel settings server failed to start: $($_.Exception.Message)"
        $lblKStatus.ForeColor = [System.Drawing.Color]::Firebrick
        return $false
    }
}
$btnKOpen.Add_Click({ if (Ensure-KernelServer) { Start-Process $script:kernelUrl } })

$script:kwvInit = $false
function Ensure-KernelWeb {
    if (-not (Ensure-KernelServer)) { return }
    if (-not $script:TermOk) { $lblKStatus.Text = 'WebView2 runtime missing - use the browser button.'; return }
    if ($script:kwvInit) { return }
    $script:kwvInit = $true
    $script:kwv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
    $script:kwv.Dock = [System.Windows.Forms.DockStyle]::Fill
    $tabK.Controls.Add($script:kwv)
    $script:kwv.BringToFront()
    $script:kwv.add_CoreWebView2InitializationCompleted({
        if ($script:kwv.CoreWebView2) { $script:kwv.CoreWebView2.Navigate($script:kernelUrl) }
    })
    # Same no-threadpool init dance as the Terminal tab (guards-gui.ps1:1382).
    $script:kwvEnvTask = $null
    $script:kwvTimer = New-Object System.Windows.Forms.Timer
    $script:kwvTimer.Interval = 100
    $script:kwvTimer.Add_Tick({
        if ($script:kwvEnvTask -and $script:kwvEnvTask.IsCompleted) {
            $script:kwvTimer.Stop()
            if (-not $script:kwvEnvTask.IsFaulted) {
                [void]$script:kwv.EnsureCoreWebView2Async($script:kwvEnvTask.Result)
            } else {
                $lblKStatus.Text = 'WebView2 init failed - use the browser button.'
            }
        }
    })
    $udf = Join-Path $env:LOCALAPPDATA 'acc-webview2'
    $script:kwvEnvTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, $udf, $null)
    $script:kwvTimer.Start()
}
```

  If `Add-Ctl` sets absolute bounds incompatible with `Dock`, create the Panel plainly (`New-Object` + `$tabK.Controls.Add`) — match how `:1357` builds the deck.
- [ ] **Step 2: Rewire** — `:791` becomes `if ($tabControl.SelectedTab -eq $tabK) { Ensure-KernelWeb }`. Delete the whole `Refresh-Kernel` function and `$btnKSave.Add_Click` block (`:962-1011`) and the `Refresh-Kernel` bootstrap call (`:1636`). In the existing form-close handler (grep `Add_FormClosed`; add one if absent) append:

```powershell
if ($script:kernelSrv -and -not $script:kernelSrv.HasExited) { try { $script:kernelSrv.Kill() } catch {} }
```

- [ ] **Step 3: Verify** — `powershell -File guards-gui.ps1 -SmokeTest` → passes (the form builds; nothing is spawned because no tab gets selected). `powershell -File watcher/screenshot-gui.ps1` → screenshot taken (AGENTS.md rule for any GUI change); eyeball it.
- [ ] **Step 4: Manual spot-check (Kyle's machine only, optional in a headless run):** launch `Guards Control.cmd`, open the Kernel tab, confirm the page renders and a save round-trips into `policy.json` (revert the value after).
- [ ] **Step 5: Commit** — `refactor(gui): kernel tab hosts the web settings page; WinForms field editor retired (OI-022)`.

---

### Task 10: CI job + doc truth-ups

**Files:**
- Modify: `.github/workflows/ci.yml` (append job), `package.json:4` (description), `AGENTS.md` (regression block: add the `npm run e2e:gui` line)

- [ ] **Step 1: Append to `ci.yml`:**

```yaml
  gui-e2e:
    name: GUI e2e (Playwright, kernel settings)
    runs-on: ubuntu-latest
    # No `needs` — parallel with the other jobs, same doctrine as
    # windows-integration. Fully sandboxed: playwright.config.mjs points
    # ACC_POLICY/ACC_ROOT at a mkdtemp dir, never live state.
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run e2e:gui
```

- [ ] **Step 2:** `package.json` description: change `No dependencies — pure node:test, plain PowerShell/C#.` → `No runtime dependencies — pure node:test, plain PowerShell/C#; @playwright/test is the one devDependency (GUI e2e).` `AGENTS.md` regression block: add a line `npm run e2e:gui  -> GUI e2e. Playwright drives gui/kernel.html against gui/server.mjs in a sandbox; runs headless in CI (gui-e2e job).`
- [ ] **Step 3:** Local re-verification: `npm run e2e:gui` green, `npm run test:windows` green. (The YAML itself is proven by Task 13's push.)
- [ ] **Step 4: Commit** — `ci(gui): Playwright e2e job on the Linux lane; dependency truth-up`.

---

### Task 11: loop proof run (closes OI-025)

- [ ] **Step 1:** `node e2e/loop.e2e.mjs` — full 5 scenarios, real tokens, 15-20+ min, lane-serialized; run once, deliberately, with no other automated launches active.
- [ ] **Step 2:** Expected: scenarios 1-5 all PASS. Save the summary tail for Task 12's ledger commit. A failure here is NEW information (nothing in this batch touches goal-loop files) — stop and investigate before proceeding; do not loop the suite.

---

### Task 12: ledger resolutions

**Files:**
- Modify: `OPEN-ISSUES.md` (delete five sections; five `## Resolved` one-liners)

- [ ] **Step 1:** Per the file's convention (see the OI-001 resolved entry at the bottom): delete the full sections for OI-020, OI-022, OI-023, OI-024, OI-025 and add, under `## Resolved` (fill real hashes from `git log`):

```markdown
## OI-020 [RESOLVED 2026-08-03] Playwright e2e verifies the kernel GUI in CI
- opened: 2026-08-03, resolved: <task-8/10 hashes> — gui/e2e/kernel-settings.spec.mjs
  asserts visible field state + a live-edit-applies-without-restart flow against
  the real page in the gui-e2e CI job (spec 2026-08-03-acc-oi-closure-design §6).

## OI-022 [RESOLVED 2026-08-03] GUI platform decided: web, migrated incrementally
- opened: 2026-08-03, resolved: <task-7/9 hashes> — decision of record in
  docs/superpowers/specs/2026-08-03-acc-oi-closure-design.md §5: local web
  frontend, tab-by-tab migration starting with the kernel settings tab;
  WinForms shell retires when its last tab moves. OI-009/OI-010 remain open.

## OI-023 [RESOLVED 2026-08-03] DEP0190 spawn pattern closed at all three sites
- opened: 2026-08-03, resolved: <task-1/2/3 hashes> — hooks/cmdline.mjs
  spawnSpec: POSIX spawns shell-free with argv; Windows spawns ONE
  fail-closed-quoted string; kernel.e2e stderr verified DEP0190-free.

## OI-024 [RESOLVED 2026-08-03] Guardhook enforces autonomy-tightened ceilings per fire
- opened: 2026-08-03, resolved: <task-4 hash> — guardhook computes
  effectiveCeilings(contract, policy, readAutonomyStrict()) on every fire;
  denial records carry ceiling + autonomyFactor; corrupt state fails closed.

## OI-025 [RESOLVED 2026-08-03] loop.e2e.mjs re-run: scenarios 1-5 PASS
- opened: 2026-08-03, resolved: <task-12 hash> — full proof run on <date/time>,
  5/5 PASS (Task 11 of plan 2026-08-03-acc-oi-closure-plan.md).
```

- [ ] **Step 2: Commit** — `docs: resolve OI-020/022/023/024/025 (closure batch; spec 2026-08-03)`.

---

### Task 13: publish

- [ ] **Step 1:** Final local sweep: `npm run test:windows` && `npm run covgate` && `npm run e2e:gui` — all green.
- [ ] **Step 2:** `git push origin main` (the pre-batch commits — the 8 kernel-plan ones plus the spec and plan doc commits — ride along with this batch's).
- [ ] **Step 3:** `gh run watch` (or `gh run list --limit 1` then `gh run view <id>`) until ALL FOUR jobs are green: fast-tier-linux, coverage-gate, windows-integration, gui-e2e. Windows-integration and gui-e2e run on shared GH runners for the first time with these changes — a failure there is information, not noise: investigate, fix forward, push again. The batch ends ONLY on green.

## Plan self-review (done at write time)

Spec coverage: §3→Tasks 1-3+5, §4→Task 4+5, §5→Tasks 7/9 + ledger, §6→Tasks 6-10, §7→Tasks 5/11/12/13, §8 order preserved (1,2,3,4 → 5 proof → 6-10 GUI → 11 proof → 12 ledger → 13 push), §9 ACs each land in a named test/step. Known judgment call: kernel.html ships in Task 7 (with its server + fast-tier assertion) and Task 8 adds Playwright on top — the Task 8 red-run instruction covers both orders.

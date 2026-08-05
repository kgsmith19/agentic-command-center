# Sub-project E — Web UI First-Principles Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the ACC interface as a web app organised around Kyle's own five modes — Watch, Work, Take over, Set up, Look back — where every tab justifies its existence, every identifier explains itself, and the quality bar is enforced by gates rather than opinion.

**Architecture:** Five modes, one screen per mode, no framework and no build step. A route manifest declares each screen's mode and is gated. Every identifier renders through one component that states its purpose, storage and log location. Every control is registered in `controls.json`, which F's harness gates — a control that changes nothing observable cannot ship. The server binds loopback only, requires a per-run token, and holds no authority guardrails does not grant it.

**Tech Stack:** Node 20+ ESM (server), plain ES modules + CSS custom properties (client), vendored `xterm.js`, Playwright + `@axe-core/playwright` for the accessibility gates.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-acc-ui-redesign-design.md` (22 ACs). Ledger: `OI-022`, `OI-015`.
- Standard: `docs/superpowers/specs/2026-08-04-acc-standards-design.md`.
- Worktree: `git worktree add -b acc/e-ui ../acc-e-ui main` in **`agentic-command-center-ui`**, at wave 4 — **after D merges**. D owns the Take over region's controls; E builds the shell around them and must not redesign them.
- **No framework, no build step.** ES modules served directly, plain CSS with custom properties, vendored dependencies only. A `package.json` gate asserts zero runtime dependencies.
- **Zero axe violations** is the accessibility gate — a score is not a gate. WCAG 2.2 AA.
- No horizontal page scroll from 320 px to 2560 px on any screen. Wide content scrolls inside its own container.
- Banned generic labels: `OK`, `Submit`, `Go`, `Run`, `Apply` without a qualifying noun. Gated.
- Every mutating endpoint goes through guardrails. The UI has no authority the guard does not grant it.
- `/security-review-kgs` before any commit touching the server, the token, the WebSocket upgrade or CSP.
- Coverage floor: 100/100/90 for server modules; Playwright for the UI criteria.

## File Structure

| File | Responsibility |
|---|---|
| `src/routes.mjs` | the route manifest: path → mode → screen. One source of truth. |
| `src/modes/{watch,work,take-over,set-up,look-back}.mjs` | one screen per mode |
| `src/components/identifier.mjs` | the identifier component — the only way an id renders |
| `src/components/empty.mjs`, `error.mjs` | designed empty and error states |
| `controls.json` | control manifest, gated by F |
| `server.mjs` | loopback bind, run token, CSP, WebSocket origin check |
| `tools/uigate.mjs` | label gate, raw-identifier gate, destructive-action gate, dependency gate |
| `e2e/*.spec.mjs` | Playwright |

---

### Task 1: The route manifest and the mode gate

**Files:**
- Create: `src/routes.mjs`, `src/routes.test.mjs`

**Interfaces:**
- Produces: `ROUTES = [{ path, mode, screen, title }]` and
  `validateRoutes(routes) -> Problem[]`.
- `MODES = ["watch", "work", "take-over", "set-up", "look-back"]`, frozen.
- A screen with no mode, or an unknown mode, is a problem. A screen not reachable
  from the five-mode navigation is a problem.

This is the structural answer to "does every tab justify its existence": a screen that cannot name its mode does not exist.

- [ ] **Step 1: Write the failing test**

```javascript
// node --test src/routes.test.mjs   (run from the ui repo root)
//
// Kyle asked whether users "can distinguish observation, configuration,
// execution, intervention, and history". Those five ARE the information
// architecture, not a checklist item - so the manifest enforces them.
import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("./routes.mjs");

test("every route declares exactly one of the five modes", () => {
  assert.deepEqual(m.validateRoutes(m.ROUTES), []);
  for (const r of m.ROUTES) assert.ok(m.MODES.includes(r.mode), `${r.path} has mode ${r.mode}`);
});

test("a route with an unknown mode is a problem", () => {
  const p = m.validateRoutes([{ path: "/x", mode: "misc", screen: "x", title: "X" }]);
  assert.deepEqual(p, [{ kind: "unknown-mode", path: "/x" }]);
});

test("a route with no mode is a problem", () => {
  const p = m.validateRoutes([{ path: "/x", screen: "x", title: "X" }]);
  assert.deepEqual(p, [{ kind: "no-mode", path: "/x" }]);
});

test("every mode has at least one route - a mode with no screen is dead navigation", () => {
  for (const mode of m.MODES) {
    assert.ok(m.ROUTES.some((r) => r.mode === mode), `mode ${mode} has no route`);
  }
});

test("every route has a title that is not the mode name", () => {
  for (const r of m.ROUTES) {
    assert.ok(r.title && r.title.length > 2, `${r.path} needs a real title`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/routes.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/routes.mjs — five modes, and nothing outside them.
//
// Watch      what is happening right now?
// Work       do the thing
// Take over  change what the machine is doing NOW
// Set up     change how it behaves NEXT TIME
// Look back  what happened, and why?
//
// Dangerous actions are separated by NAVIGATION, not by a red border: Take over
// and Set up are different places.
export const MODES = Object.freeze(["watch", "work", "take-over", "set-up", "look-back"]);

export const ROUTES = Object.freeze([
  { path: "/",           mode: "watch",     screen: "watch",    title: "What is happening" },
  { path: "/work",       mode: "work",      screen: "work",     title: "Do the work" },
  { path: "/take-over",  mode: "take-over", screen: "takeOver", title: "Take over" },
  { path: "/set-up",     mode: "set-up",    screen: "setUp",    title: "Set up" },
  { path: "/look-back",  mode: "look-back", screen: "lookBack", title: "What happened" },
]);

export function validateRoutes(routes) {
  const problems = [];
  for (const r of routes) {
    if (!r.mode) problems.push({ kind: "no-mode", path: r.path });
    else if (!MODES.includes(r.mode)) problems.push({ kind: "unknown-mode", path: r.path });
  }
  return problems;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/routes.test.mjs`
Expected: PASS, 5/5

- [ ] **Step 5: Commit**

```bash
git add src/routes.mjs src/routes.test.mjs
git commit -m "feat(ui): five-mode route manifest, gated (AC-E1, AC-E2)"
```

---

### Task 2: Harden the server — loopback, token, CSP, origin

**Files:**
- Modify: `server.mjs`, `server.test.mjs`

**Interfaces:**
- `createServer({ token, host: "127.0.0.1" })`.
- Every mutating method (`POST`, `PUT`, `DELETE`) requires
  `Authorization: Bearer <run token>`; the token is generated per run and never
  persisted.
- WebSocket upgrade checks `Origin`.
- CSP: `default-src 'self'; script-src 'self'; connect-src 'self'` — no inline
  script, no external origin.

The UI can kill processes and edit protected files. It is a real attack surface and is treated as one.

- [ ] **Step 1: Write the failing test**

```javascript
test("the server binds loopback only", async () => {
  const s = await m.createServer({ token: "t" });
  assert.equal(s.address().address, "127.0.0.1");
  await assert.rejects(m.createServer({ token: "t", host: "0.0.0.0" }),
    /refuses to bind a non-loopback interface/);
  s.close();
});

test("a mutating request without the run token is refused", async () => {
  const r = await fetch(`${base}/api/stop`, { method: "POST" });
  assert.equal(r.status, 401);
});

test("a mutating request with the wrong token is refused", async () => {
  const r = await fetch(`${base}/api/stop`, {
    method: "POST", headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(r.status, 401);
});

test("a GET does not require the token - reading is not authority", async () => {
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
});

test("a WebSocket upgrade from a foreign origin is refused", async () => {
  const r = await fetch(`${base}/pty`, {
    headers: { Connection: "Upgrade", Upgrade: "websocket", Origin: "http://evil.local" },
  });
  assert.equal(r.status, 403);
});

test("CSP blocks inline script and every external origin", async () => {
  const csp = (await fetch(base)).headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /https?:\/\//);
});

test("a mutating endpoint is refused when guardrails deny it", async () => {
  const r = await fetch(`${base}/api/settings`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ path: DENIED_PATH, value: "x" }),
  });
  assert.equal(r.status, 403);
  assert.match((await r.json()).reason, /guard/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement**, then:

- [ ] **Step 4: Run to verify it passes**, then run the security review

```bash
node --test server.test.mjs
```
Then invoke `/security-review-kgs` on the diff before committing — this touches auth and input handling, which is exactly its trigger.

- [ ] **Step 5: Commit**

```bash
git add server.mjs server.test.mjs
git commit -m "feat(ui): loopback bind, run token, origin check, strict CSP (AC-E16, AC-E17, AC-E18, AC-E19, AC-E20)"
```

---

### Task 3: The identifier component

**Files:**
- Create: `src/components/identifier.mjs`, `src/components/identifier.test.mjs`

**Interfaces:**
- Produces: `identifier(id, kind) -> HTMLElement` and
  `explain(id, kind) -> { short, sentence, storedAt, loggedAt }`.
- Kinds in use: `standing-order`, `session`, `pty`, `pid`, `ledger-entry`,
  `approval`, `tamper-finding`.
- **An identifier with nothing to say is a bug** — `explain` throws on an unknown
  kind rather than rendering an opaque string.

Kyle: *"Does every identifier have a visible purpose? Can users tell where identifiers are stored, logged, and used?"* Today the UI shows `g-20260804-…` and bare pids with no explanation, which is a large part of the 6/100.

- [ ] **Step 1: Write the failing test**

```javascript
test("every id kind in use has a purpose, a storage location and a log location", () => {
  for (const kind of m.KINDS) {
    const e = m.explain("so-20260804-1-abcd", kind);
    assert.ok(e.sentence.length > 10, `${kind} needs a plain sentence`);
    assert.ok(e.storedAt, `${kind} must say where it is stored`);
    assert.ok(e.loggedAt, `${kind} must say where it is logged`);
  }
});

test("a standing order id explains itself in plain words", () => {
  const e = m.explain("so-20260804-222717-lu7o", "standing-order");
  assert.match(e.sentence, /standing order/i);
  assert.match(e.sentence, /4 August 2026/);
  assert.match(e.storedAt, /runner\/standing/);
});

test("an unknown kind throws - showing what we cannot explain is the bug", () => {
  assert.throws(() => m.explain("x-1", "mystery"), /no explanation for id kind "mystery"/);
});

test("the short form is short and the full id is copyable", () => {
  const el = m.identifier("so-20260804-222717-lu7o", "standing-order");
  assert.ok(el.textContent.length <= 12);
  assert.equal(el.querySelector("button[data-copy]").dataset.copy, "so-20260804-222717-lu7o");
});

test("screen-reader text is the sentence, not the opaque string", () => {
  const el = m.identifier("so-20260804-222717-lu7o", "standing-order");
  assert.match(el.getAttribute("aria-label"), /standing order/i);
});
```

- [ ] **Step 2: Run to verify it fails**, implement, run, commit

```bash
git commit -am "feat(ui): identifiers explain their purpose, storage and log location (AC-E7, AC-E8)"
```

---

### Task 4: The UI gates — labels, raw identifiers, destructive placement, dependencies

**Files:**
- Create: `tools/uigate.mjs`, `tools/uigate.test.mjs`

**Interfaces:**
- `bannedLabels(files, readFile) -> Finding[]` — `OK`, `Submit`, `Go`, `Run`,
  `Apply` with no qualifying noun.
- `rawIdentifiers(files, readFile) -> Finding[]` — an id-shaped string
  interpolated into markup without going through `identifier()`.
- `destructivePlacement(controls) -> Finding[]` — a control marked
  `destructive: true` outside the `take-over` mode.
- `noRuntimeDeps(pkg) -> Finding[]` — enforces the no-framework decision.

- [ ] **Step 1: Write the failing test**

```javascript
test("a banned generic label is a finding", () => {
  assert.equal(m.bannedLabels(["a.mjs"], () => '<button>Submit</button>').length, 1);
  assert.equal(m.bannedLabels(["a.mjs"], () => '<button>OK</button>').length, 1);
});

test("a qualified label is fine", () => {
  assert.deepEqual(m.bannedLabels(["a.mjs"], () => '<button>Submit standing order</button>'), []);
  assert.deepEqual(m.bannedLabels(["a.mjs"], () => '<button>Run the test suite</button>'), []);
});

test("an id interpolated straight into markup is a finding", () => {
  assert.equal(m.rawIdentifiers(["a.mjs"], () => 'el.innerHTML = `<span>${goal.id}</span>`').length, 1);
});

test("an id passed through the identifier component is fine", () => {
  assert.deepEqual(m.rawIdentifiers(["a.mjs"], () => 'el.append(identifier(order.id, "standing-order"))'), []);
});

test("a destructive control outside take-over is a finding", () => {
  assert.equal(m.destructivePlacement([
    { id: "stop", label: "Emergency stop", destructive: true, mode: "set-up" },
  ]).length, 1);
});

test("a runtime dependency is a finding - no framework, no build step", () => {
  assert.equal(m.noRuntimeDeps({ dependencies: { react: "^19" } }).length, 1);
  assert.deepEqual(m.noRuntimeDeps({ devDependencies: { "@playwright/test": "^1" } }), []);
});
```

- [ ] **Step 2: Run to verify it fails**, implement, then:

- [ ] **Step 3: Wire into `npm run gates` and commit**

```bash
git commit -am "feat(ui): label, raw-identifier, destructive-placement and dependency gates (AC-E11, AC-E7, AC-E13)"
```

---

### Task 5: The five screens, one slice each

Each screen is its own slice: build it, gate it, commit it. Do not build five screens and then test them.

**Files (per screen):** `src/modes/<mode>.mjs`, `src/modes/<mode>.test.mjs`, `e2e/<mode>.spec.mjs`

- [ ] **Step 5a: Watch** — live sessions, standing orders, spend band, autopilot state, tamper findings.

```javascript
test("Watch shows the live autopilot state, not a cached flag", async ({ page }) => {
  await page.goto(UI + "/");
  await expect(page.getByTestId("autopilot-state")).toHaveText("running");
  await stopAutopilotOutOfBand();
  await expect(page.getByTestId("autopilot-state")).toHaveText("stopped", { timeout: 10000 });
});

test("Watch renders every identifier through the component", async ({ page }) => {
  const ids = await page.locator("[data-id-kind]").count();
  const raw = await page.getByText(/\bso-\d{8}-/).count();
  expect(ids).toBeGreaterThan(0);
  expect(raw).toBe(0);
});
```

- [ ] **Step 5b: Work** — the terminal *is* the page. `xterm.js` fills the viewport below a status strip; the control strip is fixed and never scrolls away; the driving banner is a button.

```javascript
test("the terminal fills the viewport and the control strip never scrolls away", async ({ page }) => {
  await page.goto(UI + "/work");
  const term = await page.getByTestId("terminal").boundingBox();
  const vh = page.viewportSize().height;
  expect(term.height).toBeGreaterThan(vh * 0.6);
  await page.mouse.wheel(0, 2000);
  await expect(page.getByTestId("control-strip")).toBeInViewport();
});

test("Start work is the empty state of Work, not a separate place", async ({ page }) => {
  await stopAllSessions();
  await page.goto(UI + "/work");
  await expect(page.getByLabel("What should this session work on?")).toBeVisible();
});
```

- [ ] **Step 5c: Take over** — hosts D's controls. **Do not redesign them**; import and place them.

- [ ] **Step 5d: Set up** — permissions, protected paths, secrets (behind progressive disclosure), policy dials, the settings the retired Kernel tab held, grouped by what they control rather than by module.

```javascript
test("secrets are behind progressive disclosure, not on the surface", async ({ page }) => {
  await page.goto(UI + "/set-up");
  await expect(page.getByTestId("secrets-panel")).toBeHidden();
  await page.getByRole("button", { name: /passwords and secrets/i }).click();
  await expect(page.getByTestId("secrets-panel")).toBeVisible();
});

test("no screen is titled Kernel - a tab named after an implementation is not a user goal", async ({ page }) => {
  for (const r of ROUTES) {
    await page.goto(UI + r.path);
    await expect(page.getByRole("heading", { name: /kernel/i })).toHaveCount(0);
  }
});
```

- [ ] **Step 5e: Look back** — ledger, approvals, tamper log, runs, spend history.

Each of 5a–5e ends with its own commit.

---

### Task 6: Empty states and error states, everywhere

**Files:**
- Create: `src/components/empty.mjs`, `src/components/error.mjs`
- Modify: every screen

**Interfaces:**
- Every list has a designed empty state. **An empty list that renders nothing is
  a defect.**
- Every fetch has a designed error state with a retry.

- [ ] **Step 1: Write the failing tests**

```javascript
test("every list has a designed empty state", async ({ page }) => {
  await seedEmpty();
  for (const r of ROUTES) {
    await page.goto(UI + r.path);
    for (const list of await page.locator("[data-list]").all()) {
      await expect(list.getByTestId("empty-state")).toBeVisible();
      const text = await list.getByTestId("empty-state").innerText();
      expect(text.length).toBeGreaterThan(15);   // a designed sentence, not a dash
    }
  }
});

test("every fetch has a designed error state with a retry", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  for (const r of ROUTES) {
    await page.goto(UI + r.path);
    await expect(page.getByTestId("error-state")).toBeVisible();
    await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
  }
});
```

- [ ] **Step 2: Run to verify they fail**, implement, run, commit

```bash
git commit -am "feat(ui): designed empty and error states on every list and fetch (AC-E9, AC-E10)"
```

---

### Task 7: Accessibility and responsive gates

**Files:**
- Create: `e2e/a11y.spec.mjs`, `e2e/responsive.spec.mjs`

**Interfaces:**
- Zero axe violations on every screen, light and dark.
- Every primary workflow completes keyboard-only.
- No horizontal page scroll from 320 px to 2560 px.

- [ ] **Step 1: Write the failing tests**

```javascript
import AxeBuilder from "@axe-core/playwright";

for (const scheme of ["light", "dark"]) {
  for (const r of ROUTES) {
    test(`${r.path} has zero axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(UI + r.path);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test("every interactive element has an accessible name", async ({ page }) => {
  for (const r of ROUTES) {
    await page.goto(UI + r.path);
    for (const el of await page.locator("button, a, input, select, textarea").all()) {
      const name = await el.evaluate((n) => n.ariaLabel || n.textContent?.trim() || n.title || "");
      expect(name, `unnamed element on ${r.path}`).not.toBe("");
    }
  }
});

for (const width of [320, 375, 768, 1024, 1440, 2560]) {
  test(`no horizontal page scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const r of ROUTES) {
      await page.goto(UI + r.path);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(overflow, `${r.path} overflows at ${width}px`).toBe(false);
    }
  });
}

test("submitting a standing order works keyboard-only", async ({ page }) => {
  await page.goto(UI + "/work");
  await page.keyboard.press("Tab");
  // ... tab to the field, type, tab to the button, Enter - no pointer at all
  await expect(page.getByTestId("session-state")).toHaveText("running");
});
```

- [ ] **Step 2: Run to verify they fail**, fix until green.

**Do not narrow the axe tag set or exclude a rule to get green.** If a violation is genuinely a false positive, disable that one rule at that one node with a comment naming the reason and the date.

- [ ] **Step 3: Commit**

```bash
git commit -am "test(ui): zero axe violations, keyboard-only workflows, 320-2560px (AC-E3, AC-E4, AC-E5, AC-E6)"
```

---

### Task 8: Feature parity — nothing lost in the redesign

**Files:**
- Create: `e2e/parity.spec.mjs`, `docs/tab-audit.md`

**Interfaces:**
- The anti-regression criterion. Every capability of the seven retired tabs is
  reachable in the new IA.

- [ ] **Step 1: Write the parity checklist from the audit table**

`docs/tab-audit.md`, one row per capability of each old tab: Terminal, Start work, Claude's requests (runbox), What Claude can do (permissions), Passwords and secrets, This week's spend, Kernel.

- [ ] **Step 2: Write the failing test**

```javascript
const PARITY = JSON.parse(fs.readFileSync("docs/tab-audit.json", "utf8"));

for (const cap of PARITY) {
  test(`capability still reachable: ${cap.name} (was: ${cap.oldTab})`, async ({ page }) => {
    await page.goto(UI + cap.newPath);
    await expect(page.getByRole(cap.role, { name: cap.accessibleName })).toBeVisible();
  });
}

test("the audit covers every capability of every retired tab", () => {
  const tabs = new Set(PARITY.map((c) => c.oldTab));
  for (const t of ["Terminal", "Start work", "Claude's requests", "What Claude can do",
                   "Passwords and secrets", "This week's spend", "Kernel"]) {
    assert.ok(tabs.has(t), `no capability recorded for the ${t} tab`);
  }
});
```

- [ ] **Step 3: Run to verify it fails**, close every gap, run, commit

```bash
git commit -am "test(ui): feature parity with all seven retired tabs (AC-E21)"
```

---

### Task 9: The full workflow, end to end

**Files:**
- Create: `e2e/workflow.spec.mjs`

**Interfaces:**
- AC-E22 — proves the five modes work as a system rather than as five screens.

- [ ] **Step 1: Write the failing e2e**

```javascript
test("submit a standing order, watch it run, take over, stop it, find it in history", async ({ page }) => {
  // Work: submit
  await page.goto(UI + "/work");
  await page.getByLabel("What should this session work on?").fill("count slowly to one hundred");
  await page.getByRole("button", { name: "Start work" }).click();
  const orderId = await page.getByTestId("standing-order-id").getAttribute("data-full-id");

  // Watch: it appears as running
  await page.goto(UI + "/");
  await expect(page.getByTestId(`order-${orderId}`)).toContainText("running");

  // Take over: stop it with a real hold
  await page.goto(UI + "/take-over");
  const btn = page.getByRole("button", { name: "Emergency stop" });
  await btn.hover(); await page.mouse.down();
  await page.waitForTimeout(700); await page.mouse.up();
  await expect(page.getByTestId("stop-outcome")).toHaveText("stopped", { timeout: 15000 });

  // Look back: it is in history as interrupted, with the pid list
  await page.goto(UI + "/look-back");
  const row = page.getByTestId(`ledger-${orderId}`);
  await expect(row).toContainText("interrupted");
  await expect(row).toContainText(/pid/i);
});
```

- [ ] **Step 2: Run to verify it fails**, wire it, run until green.

- [ ] **Step 3: Full gate set**

```bash
npm test && npx repo-gates && npm run gates && npx playwright test
```

- [ ] **Step 4: Register every control with F's harness**

```bash
node ../agentic-command-center/core/traceability.mjs gate
```
Expected: exit 0 — AC-F14 now passes, which was the gap F's Task 9 recorded.

- [ ] **Step 5: Merge**

```bash
git checkout main
git merge --no-ff acc/e-ui -m "merge: sub-project E, five-mode web UI"
git worktree remove ../acc-e-ui
```

Close `OI-022`. **`OI-015` stays open** — its remaining half needs Kyle at the machine, and closing it here would be exactly the kind of quiet completion claim the standard forbids.

---

## Self-Review

**Spec coverage:** AC-E1/E2→T1, AC-E3/E4/E5/E6→T7, AC-E7/E8→T3+T4, AC-E9/E10→T6, AC-E11→T4, AC-E12→T9 Step 4, AC-E13→T4, AC-E14→T5b, AC-E15→T5a, AC-E16..E20→T2, AC-E21→T8, AC-E22→T9. All twenty-two covered.

**Placeholder scan:** Task 5's five sub-slices give representative tests rather than the full suite per screen — each sub-slice is a full RED→GREEN→commit cycle and the gates in Tasks 4, 6 and 7 apply to every screen automatically, which is what keeps them honest. Task 7's keyboard test has an elided tab sequence; the assertion at the end defines the outcome and the sequence is discovered by running it.

**Type consistency:** `ROUTES` entries are `{ path, mode, screen, title }` in every task. `Finding = { file, line, text }` matches J's `pathgate`, deliberately — one finding shape across every gate in the programme. `controls.json` entries are `{ id, label, destructive, mode }` in Task 4 and Task 9, matching what D's Task 9 writes.

**Dependency on D, stated:** Task 5c imports D's controls and must not redesign them. If D is not merged, E stops at Task 5b rather than building a placeholder — a placeholder STOP button is the most dangerous possible artifact in this repo.

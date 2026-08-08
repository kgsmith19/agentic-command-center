// npm run e2e:gui  (run from C:\code\guards). Start-work tab (SPEC-0005).
// Sandbox only — the directive store lives under ACC_GUI_E2E_DIR (the server
// inherits ACC_ROOT there), the routing table is the config's fixture, and
// the runner is gui/e2e/fake-runner.e2e.mjs, which records argv and spawns
// nothing. No test here can ever start a real claude or touch live state.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const dir = process.env.ACC_GUI_E2E_DIR;
const routeDir = path.join(dir, "code", "guards-target"); // the config fixture's one route
const dirsDir = path.join(dir, "runner", "directives");
const callsFile = path.join(dir, "runner-calls.jsonl");
const runnerCalls = () => {
  try { return fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const liveIds = () => {
  try { return fs.readdirSync(dirsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")); }
  catch { return []; }
};

test.beforeEach(() => {
  fs.rmSync(dirsDir, { recursive: true, force: true });
  fs.rmSync(callsFile, { force: true });
  // Dials + profiles the page renders; kernel block keeps the other tab's
  // fixture shape intact.
  fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({
    context: { softK: 400, hardK: 600 }, week: { amberTokens: 1e9, redTokens: 2e9 },
    review: { maxFinders: 3 }, subagents: { allow: [] },
    profiles: { _note: "e2e fixture", Normal: { label: "std" }, Heavy: { label: "big" } },
    lane: { slots: 1, minGapMs: 0 },
    kernel: { harness: "claude-code", budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 } },
  }, null, 2));
  // Engine state so the page's guards sections render (same seed as guards.spec).
  fs.writeFileSync(path.join(dir, "guards-state.json"), JSON.stringify({
    enabled: true, secrets: [], protected: [], projects: [], vaultKeys: [], pending: [], trashed: [],
  }));
});

async function go(page, text) {
  await page.goto("/guards");
  await page.locator("#dirText").fill(text);
  await page.locator("#dirText").blur(); // fires the folder suggestion
  await expect(page.locator("#dirCwd")).toHaveValue(routeDir);
  await page.locator("#dirGo").click();
  await expect(page.locator("#dirMsg")).toContainText("launched d-");
}

test("typing a task suggests the routed folder; no match says so", async ({ page }) => {
  await page.goto("/guards");
  await page.locator("#dirText").fill("tighten the guards hook checks");
  await page.locator("#dirText").blur();
  await expect(page.locator("#dirCwd")).toHaveValue(routeDir);
  await expect(page.locator("#dirSuggest")).toContainText("Folder set to guards");
  await page.locator("#dirText").fill("zebra stampede");
  await page.locator("#dirCwd").clear();
  await page.locator("#dirText").blur();
  await expect(page.locator("#dirSuggest")).toContainText("No clear match");
});

test("GO creates a real directive and hands exactly directive:<id> to the runner", async ({ page }) => {
  await go(page, "tighten the guards hook checks");
  const ids = liveIds();
  expect(ids).toHaveLength(1);
  const stored = JSON.parse(fs.readFileSync(path.join(dirsDir, ids[0] + ".json"), "utf8"));
  expect(stored.text).toBe("tighten the guards hook checks");
  expect(stored.cwd).toBe(routeDir);
  expect(stored.profile).toBe("Normal"); // first radio is preselected
  await expect.poll(() => runnerCalls().length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(runnerCalls().at(-1)).toEqual([`directive:${ids[0]}`]);
  await expect(page.locator("#dirList")).toContainText(ids[0]);
  await expect(page.locator("#dirList")).toContainText("tighten the guards hook");
  await expect(page.locator("#laneLine")).toContainText("Launch lane:");
});

test("the profile radios come from policy.json (private keys filtered) and the choice lands on the directive", async ({ page }) => {
  await page.goto("/guards");
  await expect(page.locator("#profiles input[name=profile]")).toHaveCount(2);
  await page.locator("#dirText").fill("tighten the guards hook checks");
  await page.locator("#dirText").blur();
  await expect(page.locator("#dirCwd")).toHaveValue(routeDir);
  await page.locator("#profiles input[value=Heavy]").check();
  await page.locator("#dirGo").click();
  await expect(page.locator("#dirMsg")).toContainText("launched d-");
  const stored = JSON.parse(fs.readFileSync(path.join(dirsDir, liveIds()[0] + ".json"), "utf8"));
  expect(stored.profile).toBe("Heavy");
});

test("Mark finished archives the directive out of the live list, for real", async ({ page }) => {
  await go(page, "a guards hook task to finish");
  await page.getByRole("button", { name: "Mark finished" }).click();
  await expect(page.locator("#dirList")).toContainText("(nothing in flight)");
  expect(liveIds()).toHaveLength(0);
  const archived = fs.readdirSync(path.join(dirsDir, "done")).filter((f) => f.endsWith(".json"));
  expect(archived).toHaveLength(1);
});

test("View log shows the live tail, including lines appended after opening", async ({ page }) => {
  await go(page, "a guards hook task with a log");
  const id = liveIds()[0];
  await page.getByRole("button", { name: "View log" }).click();
  await expect(page.locator("#dirList pre")).toBeVisible();
  await expect(page.locator("#dirList pre")).toContainText("a guards hook task with a log");
  fs.appendFileSync(path.join(dirsDir, `${id}.log.md`), "\nFRESH-TAIL-LINE\n");
  // the open tail polls every 5s
  await expect(page.locator("#dirList pre")).toContainText("FRESH-TAIL-LINE", { timeout: 10000 });
});

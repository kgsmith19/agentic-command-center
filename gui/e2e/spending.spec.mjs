// npm run e2e:gui  (run from C:\code\guards). Sandbox only — never live state.
// Same proof shape as engine.spec.mjs: rendered state matches a fixture, a
// live edit round-trips to the real file and survives reload, invalid input
// is refused visibly with the file untouched. See docs/superpowers/specs/
// 2026-08-06-acc-gui-remaining-tabs-design.md §5.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const root = () => process.env.ACC_GUI_E2E_DIR;
const policyFile = () => path.join(root(), "policy.json");

// week thresholds at 0 short-circuit spendingSummary to green with NO real
// transcript scan (usage.mjs's own documented behavior) -- this is what
// keeps the spec hermetic: the e2e server process has no CLAUDE_CONFIG_DIR
// override, so without this short-circuit it would scan whatever real
// ~/.claude directory exists on the machine running the test.
test.beforeEach(() => {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(policyFile(), JSON.stringify({
    context: { softK: 400, hardK: 600 },
    week: { amberTokens: 0, redTokens: 0 },
    subagents: { mode: "allowlist", allow: ["Explore"], maxPerSession: 6, exploreMaxReportLines: 80 },
    review: { maxFinders: 3 },
  }, null, 2));
});

test("renders the green tier and the current dials from a fresh fixture", async ({ page }) => {
  await page.goto("/spending.html");
  await expect(page.locator("#tierBadge")).toHaveText("green");
  await expect(page.locator("#softK")).toHaveValue("400");
  await expect(page.locator("#hardK")).toHaveValue("600");
});

test("saving a dial lands on disk and survives reload", async ({ page }) => {
  await page.goto("/spending.html");
  await page.locator("#softK").fill("300");
  await page.locator("#policySave").click();
  await expect(page.locator("#policyStatus")).toContainText("Saved");
  expect(JSON.parse(fs.readFileSync(policyFile(), "utf8")).context.softK).toBe(300);
  await page.reload();
  await expect(page.locator("#softK")).toHaveValue("300");
});

test("a hardK not greater than softK is refused visibly, file untouched", async ({ page }) => {
  const before = fs.readFileSync(policyFile(), "utf8");
  await page.goto("/spending.html");
  await page.locator("#hardK").fill("100"); // less than the fixture's softK (400)
  await page.locator("#policySave").click();
  await expect(page.locator("#policyStatus")).toContainText("Not saved");
  expect(fs.readFileSync(policyFile(), "utf8")).toBe(before);
});

test("the kill switch requires a second click to arm, and writes the real stop-file once confirmed", async ({ page }) => {
  await page.goto("/spending.html");
  const stopFile = path.join(root(), "runner", "stop", "slice-runner.stop");
  await page.locator("#btnKill").click();
  await expect(page.locator("#btnKill")).toHaveText(/confirm/i);
  expect(fs.existsSync(stopFile)).toBe(false);
  await page.locator("#btnKill").click();
  await expect(page.locator("#actionStatus")).toContainText("Stopped");
  expect(fs.existsSync(stopFile)).toBe(true);
});

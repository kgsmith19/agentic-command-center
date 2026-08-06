// npm run e2e:gui  (run from C:\code\guards). Sandbox only — never live state.
// Same proof shape as spending.spec.mjs/engine.spec.mjs: rendered state
// matches a real mission record, a live action (done/stop) round-trips to
// the real mission.mjs store and survives reload. See docs/superpowers/
// specs/2026-08-06-acc-gui-remaining-tabs-design.md §7 -- this page is only
// the non-launch slice of Start work (the "what's running now" panel);
// there is no launch/Terminal test here because there is no launch/Terminal
// code, on purpose.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const root = () => process.env.ACC_GUI_E2E_DIR;
const missionsDir = () => path.join(root(), "runner", "missions");

test.beforeEach(() => {
  fs.mkdirSync(root(), { recursive: true });
  fs.rmSync(missionsDir(), { recursive: true, force: true });
});

async function createMission(text, cwd) {
  process.env.ACC_ROOT = root();
  const m = await import(`../../hooks/mission.mjs?t=${Date.now()}-${Math.random()}`);
  return m.createMission({ text, cwd: cwd || root(), profile: "" });
}

test("nothing running shows the empty state, action buttons disabled", async ({ page }) => {
  await page.goto("/startwork.html");
  await expect(page.locator("#missionText")).toHaveText("Nothing running.");
  await expect(page.locator("#missionDone")).toBeDisabled();
  await expect(page.locator("#missionStop")).toBeDisabled();
});

test("a real mission renders its text and cycle count", async ({ page }) => {
  await createMission("ship the terminal migration", "/tmp/some-project");
  await page.goto("/startwork.html");
  await expect(page.locator("#missionText")).toHaveText("ship the terminal migration");
  await expect(page.locator("#missionMeta")).toContainText("no restarts yet");
  await expect(page.locator("#missionDone")).toBeEnabled();
});

test("marking it finished round-trips to the real store and survives reload", async ({ page }) => {
  await createMission("finish me", root());
  await page.goto("/startwork.html");
  await expect(page.locator("#missionDone")).toBeEnabled();
  await page.locator("#missionDone").click();
  await expect(page.locator("#missionStatus")).toContainText("Marked finished");
  await expect(page.locator("#missionText")).toHaveText("Nothing running.");
  await page.reload();
  await expect(page.locator("#missionText")).toHaveText("Nothing running.");
});

test("viewing the progress log shows the real log tail", async ({ page }) => {
  const g = await createMission("log check", root());
  process.env.ACC_ROOT = root();
  const m = await import(`../../hooks/mission.mjs?t=${Date.now()}-${Math.random()}`);
  m.appendCycle(g.id, { text: "made real progress here" });

  await page.goto("/startwork.html");
  await expect(page.locator("#missionViewLog")).toBeEnabled();
  await page.locator("#missionViewLog").click();
  await expect(page.locator("#missionLog")).toContainText("made real progress here");
});

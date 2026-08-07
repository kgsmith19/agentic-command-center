// npm run e2e:gui  (run from C:\code\guards). Sandbox only — the server is
// pointed at gui/e2e/fake-engine.e2e.mjs via ACC_ENGINE (playwright.config.mjs),
// so no test can ever touch the real config.json, vault, or runbox.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const dir = process.env.ACC_GUI_E2E_DIR;
const stateFile = path.join(dir, "guards-state.json");
const onDisk = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));

test.beforeEach(() => {
  const rb = path.join(dir, "rb");
  fs.mkdirSync(rb, { recursive: true });
  fs.writeFileSync(path.join(rb, "fix.ps1"), "# does a thing\necho hi\n");
  fs.writeFileSync(stateFile, JSON.stringify({
    enabled: true,
    secrets: [".env", "*.pem"], protected: ["C:/x"], projects: [], vaultKeys: ["EXISTING_KEY"],
    pending: [{ label: "central", name: "fix.ps1", dir: rb, runboxDir: rb, cwd: rb, keep: false, summary: "does a thing" }],
    trashed: [],
  }));
});

test("renders live engine state: status, protections, pending script", async ({ page }) => {
  await page.goto("/guards");
  await expect(page.locator("#status")).toHaveText("ENABLED");
  await expect(page.locator("#secrets option")).toHaveCount(2);
  await expect(page.locator("#pending option")).toHaveText(["central:fix.ps1  — does a thing"]);
});

test("toggle round-trips through the engine and re-renders", async ({ page }) => {
  await page.goto("/guards");
  await page.locator("#toggle").click();
  await expect(page.locator("#status")).toHaveText("DISABLED");
  expect(onDisk().enabled).toBe(false);
});

test("selecting a pending script previews its exact content; Run executes and moves it to trash", async ({ page }) => {
  await page.goto("/guards");
  await page.locator("#pending").selectOption("central:fix.ps1");
  await expect(page.locator("#preview")).toContainText("does a thing");
  await page.locator("#run").click();
  await expect(page.locator("#result")).toContainText("done");
  await expect(page.locator("#pending option")).toHaveCount(0);
  await expect(page.locator("#trashed option")).toHaveCount(1);
  expect(onDisk().trashed[0].name).toBe("fix.ps1");
});

test("vault: saving a secret sends only NAME=value over stdin, clears the input, and lists the name", async ({ page }) => {
  await page.goto("/guards");
  await expect(page.locator("#vaultKeys option")).toHaveText(["EXISTING_KEY"]);
  await page.locator("#vaultInput").fill("NEW_TOKEN=sup3r-secret");
  await page.locator("#vaultSave").click();
  await expect(page.locator("#vaultMsg")).toContainText("stored: NEW_TOKEN");
  // The secret must not linger in the DOM after a save.
  await expect(page.locator("#vaultInput")).toHaveValue("");
  await expect(page.locator("#vaultKeys option")).toHaveText(["EXISTING_KEY", "NEW_TOKEN"]);
  // The value's only sink was stdin — never rendered, and the state file the
  // fake writes stores names only.
  const stdin = fs.readFileSync(path.join(dir, "vault-stdin.txt"), "utf8");
  expect(stdin).toBe("NEW_TOKEN=sup3r-secret\n");
  expect(JSON.stringify(onDisk())).not.toContain("sup3r-secret");
});

test("vault: deleting a key removes it via vault-rm", async ({ page }) => {
  await page.goto("/guards");
  await page.locator("#vaultKeys").selectOption("EXISTING_KEY");
  await page.locator("#vaultRm").click();
  await expect(page.locator("#vaultKeys option")).toHaveCount(0);
  expect(onDisk().vaultKeys).not.toContain("EXISTING_KEY");
});

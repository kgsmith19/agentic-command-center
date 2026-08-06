// npm run e2e:gui  (run from C:\code\guards). Sandbox only — never live state.
// Same proof shape as kernel-settings.spec.mjs: rendered state matches a
// fixture, a live edit round-trips to the real file and survives reload,
// invalid input is refused visibly with the file untouched, and the CSRF
// guard blocks a request missing X-ACC. See docs/superpowers/specs/
// 2026-08-06-acc-gui-remaining-tabs-design.md §4e.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const root = () => process.env.ACC_GUI_E2E_DIR;
const configFile = () => path.join(root(), "config.json");
const runboxDir = () => path.join(root(), "runbox");

test.beforeEach(() => {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ enabled: true, secrets: [], protected: [], projects: [] }));
  fs.rmSync(path.join(root(), "vault.json"), { force: true });
  fs.rmSync(runboxDir(), { recursive: true, force: true });
});

test("renders empty lists against a fresh fixture", async ({ page }) => {
  await page.goto("/engine.html");
  await expect(page.locator("#secretList li")).toHaveCount(0);
  await expect(page.locator("#protList li")).toHaveCount(0);
  await expect(page.locator("#vaultList li")).toHaveCount(0);
});

test("adding a secret pattern lands on disk and survives reload", async ({ page }) => {
  await page.goto("/engine.html");
  await page.locator("#secretInput").fill("*.pfx");
  await page.locator("#secretAdd").click();
  await expect(page.locator("#secretList li")).toHaveCount(1);
  expect(JSON.parse(fs.readFileSync(configFile(), "utf8")).secrets).toEqual(["*.pfx"]);
  await page.reload();
  await expect(page.locator("#secretList li")).toContainText("*.pfx");
});

test("watching a folder that does not exist is refused visibly, config file untouched", async ({ page }) => {
  const before = fs.readFileSync(configFile(), "utf8");
  await page.goto("/engine.html");
  await page.locator("#projInput").fill(path.join(root(), "does-not-exist"));
  await page.locator("#projAdd").click();
  await expect(page.locator("#status")).toContainText("Not saved");
  await expect(page.locator("#projList li")).toHaveCount(0);
  expect(fs.readFileSync(configFile(), "utf8")).toBe(before);
});

test("vault import with nothing usable on stdin is refused visibly, vault file untouched", async ({ page }) => {
  await page.goto("/engine.html");
  await page.locator("#vaultIn").fill("# only a comment, nothing to store\n");
  await page.locator("#vaultImport").click();
  await expect(page.locator("#vaultStatus")).toContainText("Not saved");
  await expect(page.locator("#vaultList li")).toHaveCount(0);
  expect(fs.existsSync(path.join(root(), "vault.json"))).toBe(false);
});

test("vault import stores a key (value never rendered) and it can be removed", async ({ page }) => {
  await page.goto("/engine.html");
  await page.locator("#vaultIn").fill("MY_KEY=super-secret-value\n");
  await page.locator("#vaultImport").click();
  await expect(page.locator("#vaultStatus")).toContainText("Saved: MY_KEY");
  await expect(page.locator("#vaultList li")).toContainText("MY_KEY");
  const pageContent = await page.content();
  expect(pageContent.includes("super-secret-value")).toBe(false);

  await page.locator("#vaultList li button").click();
  await expect(page.locator("#vaultList li")).toHaveCount(0);
});

test("runbox: run a script, see it archived, then find it in the trash view", async ({ page }) => {
  fs.mkdirSync(runboxDir(), { recursive: true });
  fs.writeFileSync(path.join(runboxDir(), "task.mjs"), "// a fixture script\nprocess.exit(0);\n");
  await page.goto("/engine.html");
  await page.locator("#runboxList li").click();
  await expect(page.locator("#preview")).toContainText("a fixture script");
  await page.locator("#runboxRun").click();
  await expect(page.locator("#runboxStatus")).toContainText("done");
  await expect(page.locator("#runboxList li")).toHaveCount(0);

  await page.locator("#showTrash").check();
  await expect(page.locator("#runboxList li")).toHaveCount(1);
});

test("CSRF guard: a mutation without X-ACC (or with a foreign Origin) is 403 and writes nothing", async ({ request }) => {
  const before = fs.readFileSync(configFile(), "utf8");
  const bare = await request.post("/api/engine/secret", { data: { op: "add", pattern: "*.pfx" } });
  expect(bare.status()).toBe(403);
  const foreign = await request.post("/api/engine/secret", {
    data: { op: "add", pattern: "*.pfx" }, headers: { "X-ACC": "1", origin: "https://evil.example" },
  });
  expect(foreign.status()).toBe(403);
  expect(fs.readFileSync(configFile(), "utf8")).toBe(before);
});

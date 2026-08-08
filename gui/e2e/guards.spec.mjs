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

// --- spending tab (SPEC-0004) ---
const policyFile = path.join(dir, "policy.json");
const budgetCallsFile = path.join(dir, "budget-calls.jsonl");
function seedPolicy() {
  fs.writeFileSync(policyFile, JSON.stringify({
    _comment: "e2e", context: { softK: 400, hardK: 600 }, week: { amberTokens: 1e9, redTokens: 2e9 },
    review: { maxFinders: 3 }, subagents: { allow: ["Explore"] },
    kernel: { harness: "claude-code", budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 }, hardCaps: { wallClockMin: 240 }, autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 }, checkpointMin: 20, alwaysAllowTools: ["TodoWrite"], extraDenyWriteRoots: [] },
  }, null, 2));
  try { fs.rmSync(budgetCallsFile); } catch {}
}

test("spending: tier and dials render from the backend", async ({ page }) => {
  seedPolicy();
  await page.goto("/guards");
  await expect(page.locator("#tier")).toContainText("Getting expensive"); // amber
  await expect(page.locator("#softK")).toHaveValue("400");
  await expect(page.locator("#allow")).toHaveValue("Explore");
});

test("spending: saving dials writes policy.json and preserves the kernel block", async ({ page }) => {
  seedPolicy();
  const before = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  await page.goto("/guards");
  // Wait for the async load populate to finish before editing — otherwise the
  // in-flight refreshProcess() overwrites the field after fill() and the save
  // reads the stale value.
  await expect(page.locator("#softK")).toHaveValue("400");
  await page.locator("#softK").fill("350");
  await page.locator("#allow").fill("Explore, Plan");
  await page.locator("#dialsSave").click();
  await expect(page.locator("#dialsMsg")).toContainText("Saved");
  const after = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  expect(after.context.softK).toBe(350);
  expect(after.subagents.allow).toEqual(["Explore", "Plan"]);
  expect(after.kernel).toEqual(before.kernel);
});

test("spending: STOP writes the runner stop-file; Resume calls budget unstop", async ({ page }) => {
  seedPolicy();
  await page.goto("/guards");
  await expect(page.locator("#stopState")).toContainText("Running normally"); // initial load settled
  await page.locator("#ctlStop").click();
  await expect(page.locator("#stopState")).toContainText("STOPPED");
  expect(fs.existsSync(path.join(dir, "runner", "stop", "slice-runner.stop"))).toBe(true);
  await page.locator("#ctlResume").click();
  // Resume runs `budget unstop`, which clears the stop-file; wait for the UI
  // to reflect that before reading the recorded calls — the click's POST +
  // fake-budget append are async, so reading the file immediately races them.
  await expect(page.locator("#stopState")).toContainText("Running normally");
  const calls = fs.readFileSync(budgetCallsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(calls).toContainEqual(["unstop"]);
});

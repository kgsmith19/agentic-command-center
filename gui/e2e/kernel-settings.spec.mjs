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

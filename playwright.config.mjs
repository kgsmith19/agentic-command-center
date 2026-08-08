import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = process.env.ACC_GUI_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "acc-gui-e2e-"));
process.env.ACC_GUI_E2E_DIR = dir;

const routeDir = path.join(dir, "code", "guards-target");
fs.mkdirSync(routeDir, { recursive: true });
fs.writeFileSync(path.join(dir, "ROUTING.md"), "# routes\n```json\n" + JSON.stringify({
  routes: [{ label: "guards", path: routeDir, signals: ["guards", "hook"] }],
}) + "\n```\n");

export default defineConfig({
  testDir: "gui/e2e",
  workers: 1,
  reporter: [["line"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:43117",
    screenshot: process.env.E2E_PROOF ? "on" : "only-on-failure",
    trace: "retain-on-failure",
    ...(process.env.ACC_PW_CHROMIUM ? { launchOptions: { executablePath: process.env.ACC_PW_CHROMIUM } } : {}),
  },
  webServer: {
    command: "node gui/server.mjs --port 43117",
    url: "http://127.0.0.1:43117/api/kernel-policy",
    reuseExistingServer: false,
    env: {
      ACC_POLICY: path.join(dir, "policy.json"), ACC_ROOT: dir,
      ACC_ENGINE: path.resolve("gui/e2e/fake-engine.e2e.mjs"), ACC_GUI_E2E_DIR: dir,
      ACC_USAGE: path.resolve("gui/e2e/fake-usage.e2e.mjs"),
      ACC_BUDGET: path.resolve("gui/e2e/fake-budget.e2e.mjs"),
      ACC_RUNNER: path.resolve("gui/e2e/fake-runner.e2e.mjs"),
      ACC_ROUTING_MD: path.join(dir, "ROUTING.md"),
      ACC_LANE_DIR: path.join(dir, "lane"),
    },
  },
});

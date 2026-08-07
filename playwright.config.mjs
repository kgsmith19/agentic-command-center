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
  use: {
    baseURL: "http://127.0.0.1:43117",
    // ACC_PW_CHROMIUM: absolute path to a system Chromium, for environments
    // whose preinstalled browser revision differs from this package's pin
    // (e.g. cloud sandboxes with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1). Unset
    // — the normal case on Kyle's machine — Playwright uses its own browser.
    ...(process.env.ACC_PW_CHROMIUM ? { launchOptions: { executablePath: process.env.ACC_PW_CHROMIUM } } : {}),
  },
  webServer: {
    command: "node gui/server.mjs --port 43117",
    url: "http://127.0.0.1:43117/api/kernel-policy",
    reuseExistingServer: false,
    env: {
      ACC_POLICY: path.join(dir, "policy.json"), ACC_ROOT: dir,
      // guards.spec.mjs: the server shells this fake instead of the real
      // engine, so e2e can never mutate the live config/runbox (SPEC-0002).
      ACC_ENGINE: path.resolve("gui/e2e/fake-engine.e2e.mjs"), ACC_GUI_E2E_DIR: dir,
    },
  },
});

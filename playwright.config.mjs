import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One sandbox dir per run; the spec file reads the same env var to reset the
// fixture between tests. The server re-reads policy.json on every request
// (core/policy.mjs never caches), so no restarts are needed.
const dir = process.env.ACC_GUI_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "acc-gui-e2e-"));
process.env.ACC_GUI_E2E_DIR = dir;

export default defineConfig({
  testDir: "gui/e2e",
  use: { baseURL: "http://127.0.0.1:43117" },
  webServer: {
    command: "node gui/server.mjs --port 43117",
    url: "http://127.0.0.1:43117/api/kernel-policy",
    reuseExistingServer: false,
    env: { ACC_POLICY: path.join(dir, "policy.json"), ACC_ROOT: dir },
  },
});

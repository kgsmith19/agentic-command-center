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
  // Serial, not the default CPU-based parallelism: every spec file shares
  // ONE server process and ONE policy.json/config.json under `dir` above,
  // and each file's own beforeEach does a blind fixture reset (kernel-
  // settings.spec.mjs overwrites the whole file with just its "kernel" key;
  // spending.spec.mjs overwrites it with context/week/subagents/review).
  // Under >1 worker those resets can interleave across DIFFERENT spec
  // files hitting the SAME file concurrently -- caught for real (2026-08-06,
  // adding gui/e2e/spending.spec.mjs): a parallel run corrupted
  // kernel-settings.spec.mjs's own toolCalls field via exactly this race.
  // The whole suite is ~15 fast HTTP/DOM specs (a few seconds total), so
  // trading parallel speed for correctness here costs nothing real.
  workers: 1,
  use: { baseURL: "http://127.0.0.1:43117" },
  webServer: {
    command: "node gui/server.mjs --port 43117",
    url: "http://127.0.0.1:43117/api/kernel-policy",
    reuseExistingServer: false,
    env: { ACC_POLICY: path.join(dir, "policy.json"), ACC_ROOT: dir },
  },
});

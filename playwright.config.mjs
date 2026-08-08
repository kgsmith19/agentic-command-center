import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One sandbox dir per run; the spec file reads the same env var to reset the
// fixture between tests. The server re-reads policy.json on every request
// (kernel/policy.mjs never caches), so no restarts are needed.
const dir = process.env.ACC_GUI_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "acc-gui-e2e-"));
process.env.ACC_GUI_E2E_DIR = dir;

// start-work.spec.mjs (SPEC-0005): a routing table whose signals are known to
// the spec, anchored in the sandbox so the real C:\code\ROUTING.md is never
// read. The route target must EXIST (the create route stats cwd), so it lives
// in the sandbox too.
const routeDir = path.join(dir, "code", "guards-target");
fs.mkdirSync(routeDir, { recursive: true });
fs.writeFileSync(path.join(dir, "ROUTING.md"), "# routes\n```json\n" + JSON.stringify({
  routes: [{ label: "guards", path: routeDir, signals: ["guards", "hook"] }],
}) + "\n```\n");

export default defineConfig({
  testDir: "gui/e2e",
  // One worker: every spec file shares the single ACC_GUI_E2E_DIR sandbox
  // (policy.json, guards-state.json, directive store), so parallel workers
  // would clobber each other's beforeEach seeds mid-test.
  workers: 1,
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
      // guards.spec.mjs spending tab (SPEC-0004): fake usage/budget so the
      // process controls never read real spend or type into a console.
      ACC_USAGE: path.resolve("gui/e2e/fake-usage.e2e.mjs"),
      ACC_BUDGET: path.resolve("gui/e2e/fake-budget.e2e.mjs"),
      // start-work.spec.mjs (SPEC-0005): fake runner (records argv, spawns
      // nothing), sandboxed routing table and launch lane. The directive
      // store needs no fake — hooks/directive.mjs already honours ACC_ROOT.
      ACC_RUNNER: path.resolve("gui/e2e/fake-runner.e2e.mjs"),
      ACC_ROUTING_MD: path.join(dir, "ROUTING.md"),
      ACC_LANE_DIR: path.join(dir, "lane"),
    },
  },
});

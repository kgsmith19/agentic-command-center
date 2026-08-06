// node --test gui/guards-gui.test.mjs  (run from the repo root)
//
// OI-015: guards-gui.ps1's interactive-lane wiring (Enter-InteractiveLane /
// Complete-InteractiveLaneHandoff / Exit-InteractiveLane) had zero coverage
// because the environment it was written in had no powershell binary at all.
// `-TestInteractiveLane` (guards-gui.ps1) drives the exact reserve -> reown ->
// release handshake a real Go-button launch uses, against the real
// hooks/lane.mjs (already proven 44/44 in hooks/lane.test.mjs), and exits
// with one line of JSON - no WinForms window is ever built.
//
// What this does NOT prove: the busy-refusal MessageBox actually appearing,
// or the slot directory disappearing within a few seconds of a real Kyle
// double-press on the real Go button. That half needs Kyle physically
// watching the GUI (OPEN-ISSUES.md OI-015 stays open for exactly that).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const GUI = path.join(REPO, "guards-gui.ps1");

function runInteractiveLaneTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acc-gui-lane-"));
  const env = {
    ...process.env,
    ACC_LANE_DIR: path.join(root, "lane"),
    ACC_POLICY: path.join(root, "does-not-exist-policy.json"), // falls back to lane.mjs's own DEFAULTS (slots:1)
  };
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", GUI, "-TestInteractiveLane"],
    { encoding: "utf8", timeout: 30000, windowsHide: true, env }
  );
  return JSON.parse(out.trim());
}

test("OI-015: reserve -> reown -> release matches a real Go-button launch's handshake", () => {
  const r = runInteractiveLaneTest();
  assert.equal(typeof r.slot1, "number", "first reserve succeeds while the lane is free");
  assert.equal(r.busy1, null, "no busy message on a successful reserve");

  assert.equal(r.slot2, null, "a second reserve while the first is still held must be refused");
  assert.match(r.busy2, /already using the lane/i, "the busy message names the reason, for the MessageBox text");

  assert.equal(typeof r.slot3, "number", "after release, a fresh reserve succeeds again");
});

// Kernel dials. Single source: policy.json "kernel". Every getter re-reads the
// file, because the GUI settings tab edits it live and a guardhook fire must
// see the edit on the very next tool call (AC-G9/AC-U2) — never cache.
//
// Unreadable-but-present policy THROWS rather than falling back to defaults:
// the kernel's whole job is enforcing limits, and silently enforcing guessed
// ones is worse than refusing to run. Absent file = defaults, which is the
// first-run case.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

export const policyPath = () => process.env.ACC_POLICY || path.join(REPO, "policy.json");
export const kernelRoot = () => path.resolve(process.env.ACC_ROOT || REPO);
export const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();

export const KERNEL_DEFAULTS = Object.freeze({
  harness: "claude-code",
  budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 },
  hardCaps: { wallClockMin: 240 },
  autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 },
  checkpointMin: 20,
  alwaysAllowTools: ["TodoWrite"],
  extraDenyWriteRoots: [],
});

export function loadKernelPolicy() {
  let raw = {};
  if (fs.existsSync(policyPath())) {
    let parsed;
    try {
      let text = fs.readFileSync(policyPath(), "utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip a UTF-8 BOM
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`kernel policy unreadable: ${policyPath()} (${e.message})`);
    }
    raw = parsed.kernel || {};
  }
  return {
    ...KERNEL_DEFAULTS,
    ...raw,
    budget: { ...KERNEL_DEFAULTS.budget, ...(raw.budget || {}) },
    hardCaps: { ...KERNEL_DEFAULTS.hardCaps, ...(raw.hardCaps || {}) },
    autonomy: { ...KERNEL_DEFAULTS.autonomy, ...(raw.autonomy || {}) },
  };
}

// Written to regardless of contract: the guards repo (kernel code, ledger,
// policy, vault) and the user's whole .claude tree (settings + hook scripts).
// Derived, not literal, so a checkout at another path is still protected.
export function alwaysDenyWriteRoots() {
  return [REPO, path.join(os.homedir(), ".claude"), ...loadKernelPolicy().extraDenyWriteRoots].map(norm);
}

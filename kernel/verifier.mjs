// The kernel's own answer to "did this actually work". It runs in the kernel
// process AFTER the harness has exited, and it reads the filesystem and git
// directly. It is never handed the harness's output, so there is no path by
// which a model's summary of its own work can become a pass (AC-V5).
//
// Any fail or unknown makes the whole run not accepted. No partial credit:
// that is what forces a contract to state criteria that can actually be
// checked.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const run = (execFn, cmd, args, cwd) =>
  (execFn || ((c, a, o) => spawnSync(c, a, o)))(cmd, args, { cwd, encoding: "utf8", shell: true, timeout: 10 * 60 * 1000 });

const result = (criterion, status, detail) => ({
  id: criterion.id, method: criterion.verify?.method ?? null, status, detail,
});

// guards#OI-040: a criterion that throws while being verified (e.g. an
// invalid `pattern` regex) must fail the criterion, not escape verifyAll and
// crash the caller. kernel/run.mjs never gets to finalize() a run whose
// verification step threw uncaught — no run_finalized ledger line, no
// cleanupRun, no autonomy update — so this is a fail-CLOSED boundary, matching
// every other criterion outcome here.
export async function verifyCriterion(criterion, { cwd, execFn } = {}) {
  const v = criterion.verify || {};
  try {
    switch (v.method) {
      case "command": {
        const r = run(execFn, v.command, [], v.cwd || cwd);
        return result(criterion, r.status === 0 ? "pass" : "fail", `exit ${r.status}${r.stderr ? `: ${String(r.stderr).trim().slice(-200)}` : ""}`);
      }
      case "file_exists":
        return result(criterion, fs.existsSync(v.path) ? "pass" : "fail", v.path);
      case "file_contains": {
        let text;
        try { text = fs.readFileSync(v.path, "utf8"); } catch (e) { return result(criterion, "fail", `unreadable: ${e.message}`); }
        return result(criterion, new RegExp(v.pattern).test(text) ? "pass" : "fail", `${v.path} =~ /${v.pattern}/`);
      }
      case "git_clean": {
        const r = run(execFn, "git", ["status", "--porcelain"], v.cwd || cwd);
        if (r.status !== 0) return result(criterion, "unknown", `git status failed: ${String(r.stderr || "").trim().slice(-200)}`);
        const dirty = String(r.stdout || "").trim();
        return result(criterion, dirty ? "fail" : "pass", dirty ? `working tree dirty:\n${dirty.slice(0, 400)}` : "clean");
      }
      default:
        return result(criterion, "unknown", `no verification method for "${v.method}"`);
    }
  } catch (e) {
    return result(criterion, "fail", `verification threw: ${e.message}`);
  }
}

export async function verifyAll(contract, opts = {}) {
  const criteria = [];
  for (const c of contract.acceptanceCriteria || []) {
    criteria.push(await verifyCriterion(c, opts));
  }
  return { criteria, accepted: criteria.length > 0 && criteria.every((c) => c.status === "pass") };
}

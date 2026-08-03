#!/usr/bin/env node
// The orchestrator: one task contract in, one ledger record out.
//
//   node kernel/run.mjs <contract.json>
//
// Two distinct failure shapes, deliberately not conflated:
//   refused        — the contract is incomplete or unsafe. No runId, no ledger
//                    entry, nothing spawned. It never became a run.
//   failed-to-start — the contract was fine but the harness would not start.
//                    That IS a run and it gets the full started/finalized pair.
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadContract, validateContract } from "./contract.mjs";
import { resolveAdapter } from "./adapter.mjs";
import { appendStarted, appendFinalized } from "./ledger.mjs";

export function newRunId() {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "T");
  return `r-${t}-${randomBytes(3).toString("hex")}`;
}

export async function runTask(contractPath, { adapter } = {}) {
  const contract = loadContract(contractPath);
  const { ok, errors } = validateContract(contract);
  if (!ok) {
    for (const e of errors) console.error(`kernel: ${e}`);
    return { runId: null, outcome: "refused", errors };
  }

  const harnessAdapter = adapter || (await resolveAdapter());
  const runId = newRunId();
  const startedAt = new Date();
  appendStarted({ runId, startedAt: startedAt.toISOString(), contract, settingsSha256: null });

  const finalize = (extra) => {
    appendFinalized({
      runId, finishedAt: new Date().toISOString(),
      wallClockMs: Date.now() - startedAt.getTime(), ...extra,
    });
    return { runId, errors: [], ...extra };
  };

  let harness;
  try {
    harness = harnessAdapter.identity();
  } catch (e) {
    console.error(`kernel: ${e.message}`);
    return finalize({ outcome: "failed-to-start", harness: null, error: e.message, criteria: [], decisions: {}, tokens: 0 });
  }

  // Stage 1 stops here: launching, guarding, verifying and budgeting are
  // wired into this same function in later tasks.
  return finalize({ outcome: "rejected", harness, criteria: [], decisions: {}, tokens: 0 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node kernel/run.mjs <contract.json>");
    process.exit(2);
  }
  const result = await runTask(file);
  console.log(JSON.stringify(result));
  process.exit(result.outcome === "accepted" ? 0 : 2);
}

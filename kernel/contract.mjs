// The task contract: the only thing that grants a run any authority at all.
// An incomplete contract is refused before a harness process exists, because
// a run whose success cannot be checked is not a run worth starting.
import fs from "node:fs";
import { loadKernelPolicy, alwaysDenyWriteRoots, norm } from "./policy.mjs";

export const REQUIRED_FIELDS = Object.freeze([
  "goal", "constraints", "allowedActions", "budget", "acceptanceCriteria", "rollbackPlan",
]);
export const VERIFY_METHODS = Object.freeze(["command", "file_exists", "file_contains", "git_clean"]);

const ACTION_KEYS = Object.freeze(["readRoots", "writeRoots", "bashPatterns", "networkHosts", "vaultKeys", "subagents"]);

export function loadContract(file) {
  try {
    let text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip a UTF-8 BOM
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`kernel: contract unreadable: ${file} (${e.message})`);
  }
}

export function validateContract(contract) {
  const errors = [];
  const c = contract || {};
  for (const field of REQUIRED_FIELDS) {
    if (c[field] === undefined || c[field] === null) errors.push(`contract is missing required field "${field}"`);
  }

  const actions = c.allowedActions;
  if (actions && typeof actions === "object") {
    for (const key of ACTION_KEYS) {
      if (actions[key] !== undefined && !Array.isArray(actions[key])) {
        errors.push(`allowedActions.${key} must be an array`);
      }
    }
    const denied = alwaysDenyWriteRoots();
    for (const root of actions.writeRoots || []) {
      const target = norm(root);
      if (denied.some((d) => target === d || target.startsWith(d + "/") || d.startsWith(target + "/"))) {
        errors.push(`allowedActions.writeRoots entry "${root}" overlaps a protected path — refused before launch`);
      }
    }
  }

  const criteria = c.acceptanceCriteria;
  if (Array.isArray(criteria)) {
    if (criteria.length === 0) errors.push("acceptanceCriteria is empty — a run whose outcome cannot be checked is refused");
    const seen = new Set();
    for (const [i, crit] of criteria.entries()) {
      const label = crit?.id || `#${i}`;
      if (!crit?.id) errors.push(`acceptance criterion ${label} has no id`);
      else if (seen.has(crit.id)) errors.push(`duplicate acceptance criterion id "${crit.id}"`);
      else seen.add(crit.id);
      if (!crit?.verify?.method) errors.push(`acceptance criterion ${label} has no verify method`);
      else if (!VERIFY_METHODS.includes(crit.verify.method)) {
        errors.push(`acceptance criterion ${label} uses unknown verify method "${crit.verify.method}"`);
      }
    }
  } else if (criteria !== undefined) {
    errors.push("acceptanceCriteria must be an array");
  }

  // OI-019 scenario-enumeration pass: a malformed budget field (wrong type,
  // negative, zero) used to pass validation silently and then defeat the
  // ceiling it names downstream instead of being refused here. A string
  // wallClockMin, for one concrete example: `Number.isFinite(wall) &&
  // wall > caps.wallClockMin` below was false either way (isFinite("x") is
  // false), so no error was ever raised, and effectiveCeilings' `b.wallClockMin
  // ?? policy.budget.wallClockMin` picked the string anyway (?? only falls
  // back on null/undefined, not on wrong type) -- Math.min/Math.round then
  // silently produced NaN, and checkpointVerdict's `elapsedMs >
  // ceilings.wallClockMs` is false against NaN no matter how long the run
  // runs, so the wall-clock ceiling — one of the kernel's core safety
  // limits — was silently unenforced for the whole run, not merely
  // unvalidated. Each of these three budget fields is optional (falls back
  // to the policy default when absent, per effectiveCeilings), so only
  // validate the ones actually present, but validate them for real.
  if (c.budget && typeof c.budget === "object") {
    if (c.budget.wallClockMin !== undefined && !(Number.isFinite(c.budget.wallClockMin) && c.budget.wallClockMin > 0)) {
      errors.push(`budget.wallClockMin ${JSON.stringify(c.budget.wallClockMin)} must be a positive number`);
    }
    if (c.budget.toolCalls !== undefined && !(Number.isInteger(c.budget.toolCalls) && c.budget.toolCalls >= 1)) {
      errors.push(`budget.toolCalls ${JSON.stringify(c.budget.toolCalls)} must be an integer >= 1`);
    }
    if (c.budget.tokens !== undefined && !(Number.isInteger(c.budget.tokens) && c.budget.tokens >= 1)) {
      errors.push(`budget.tokens ${JSON.stringify(c.budget.tokens)} must be an integer >= 1`);
    }
  }

  const caps = loadKernelPolicy().hardCaps;
  const wall = c.budget?.wallClockMin;
  if (Number.isFinite(wall) && wall > caps.wallClockMin) {
    errors.push(`budget.wallClockMin ${wall} exceeds the policy hard cap of ${caps.wallClockMin}`);
  }

  return { ok: errors.length === 0, errors };
}

// The --tools allowlist: a tool the contract grants no authority to does not
// exist for the run at all. This is the structural half of deny-by-default;
// the guardhook enforces the arguments of the tools that remain.
export function toolsFor(contract) {
  const a = contract.allowedActions || {};
  const tools = new Set(loadKernelPolicy().alwaysAllowTools);
  if ((a.readRoots || []).length) ["Read", "Glob", "Grep"].forEach((t) => tools.add(t));
  if ((a.writeRoots || []).length) ["Edit", "Write"].forEach((t) => tools.add(t));
  if ((a.bashPatterns || []).length) tools.add("Bash");
  if ((a.networkHosts || []).length) ["WebFetch", "WebSearch"].forEach((t) => tools.add(t));
  if ((a.subagents || []).length) tools.add("Task");
  return [...tools];
}

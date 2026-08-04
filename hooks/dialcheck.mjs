// hooks/dialcheck.mjs - does a policy dial actually control anything?
//
// guards OI-033. A runbox script auto-ran at 18:42 on 2026-08-04 and removed
// hooks/route.mjs from ~/.claude/settings.json, while policy.json went on
// reading `autoCd.enabled: true` for hours afterwards. Nothing noticed, because
// nothing checks that a dial's stated consumer exists. That is the smallest
// possible instance of the rule this file exists to enforce: proving a control
// changed a stored value proves nothing about whether anything reads it.
//
// Deliberately its own file rather than a branch inside route.mjs: config/
// consumer coherence is a separate concern from routing, and it is the seed of
// the wider setting-traceability work (see the master plan). Pure decision
// logic + a thin CLI, so the rules are testable against fixtures instead of
// against whatever this machine happens to look like today.
//
//   node hooks/dialcheck.mjs      -> exit 0 clean, exit 1 with the divergence
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Each entry: a dial, and the hook file that dial claims to control. Kept as
// data so adding a dial is a one-line change and never a new code path.
export const DIALS = [
  {
    dial: "autoCd.enabled",
    read: (policy) => !!policy?.autoCd?.enabled,
    event: "UserPromptSubmit",
    hook: "route.mjs",
  },
];

// Pure. Returns [] when every dial agrees with settings.json, else one message
// per divergence. Both directions are reported: a hook running while its dial
// says off is just as much a lie as a dial pointing at nothing.
export function divergences(policy, settings, dials = DIALS) {
  const out = [];
  for (const d of dials) {
    const enabled = d.read(policy);
    const registered = JSON.stringify(settings?.hooks?.[d.event] ?? []).includes(d.hook);
    if (enabled && !registered)
      out.push(`${d.dial} is TRUE but ${d.hook} is not registered in settings.json ${d.event} - the dial controls nothing`);
    else if (!enabled && registered)
      out.push(`${d.hook} IS registered in settings.json ${d.event} but ${d.dial} is FALSE - the hook runs while the dial says it should not`);
  }
  return out;
}

// Unreadable/missing config reads as "disabled", never as enabled: a check that
// fails closed on its own inability to read would cry wolf on every fresh
// machine, and a check nobody trusts is a check nobody runs.
export function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function policyPath() {
  return process.env.ACC_POLICY || path.resolve(HERE, "..", "policy.json");
}

export function settingsPath() {
  if (process.env.ACC_SETTINGS) return process.env.ACC_SETTINGS;
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
}

export function main() {
  const found = divergences(readJson(policyPath()), readJson(settingsPath()));
  if (found.length) {
    console.log("DIAL/HOOK DIVERGENCE:");
    for (const f of found) console.log("  " + f);
    return 1;
  }
  console.log(`dials clean: ${DIALS.length} dial(s) agree with settings.json`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))
  process.exit(main());

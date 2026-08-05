// tools/install-hooks.mjs — nobody writes a hook path into settings.json by
// hand again. `upsert` is pure and repo-scoped: it only ever touches entries
// whose command already names one of `ownedRoots` (default: this repo's own
// entries being re-added, matched by exact command equality) - every other
// repo's registrations pass through untouched. This is what turns a repo
// move from a manual settings.json edit into `node tools/install-hooks.mjs`.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolve, repoRoot } from "../core/paths.mjs";

// Every past canonical absolute root this exact repo has ever lived at.
// Every sub-project develops in its own differently-named worktree
// (acc-j-decomposition, acc-a-inventory, ...), so THIS run's repoRoot()
// alone can never recognize a registration written by a checkout at one of
// these other names as belonging to the same repo - it would duplicate
// instead of re-point. Append the new canonical root here when Task 12
// actually renames the folder.
const KNOWN_ROOTS = ["C:/code/guards"];

export function ownedRoots() {
  return [...KNOWN_ROOTS, repoRoot()];
}

export function upsert(settings, registrations, opts = {}) {
  const out = structuredClone(settings);
  out.hooks = out.hooks || {};

  const byEvent = new Map();
  for (const r of registrations) {
    if (!byEvent.has(r.event)) byEvent.set(r.event, []);
    byEvent.get(r.event).push(r);
  }

  for (const [event, regs] of byEvent) {
    const existing = out.hooks[event] || [];
    const newCommands = new Set(regs.map((r) => r.command));
    const isStale = (command) =>
      opts.ownedRoots
        ? opts.ownedRoots.some((root) => command.includes(root))
        : newCommands.has(command);
    const kept = existing.filter((group) => !(group.hooks || []).some((h) => isStale(h.command)));
    const added = regs.map((r) => ({
      matcher: r.matcher,
      hooks: [{ type: "command", command: r.command }],
    }));
    out.hooks[event] = [...kept, ...added];
  }

  return out;
}

// This repo's own declared hook manifest - the source of truth `upsert`
// reconciles into settings.json. Matches what is live today (checked
// 2026-08-05): guard.mjs on the tool-call boundary, budget.mjs on every
// turn-lifecycle event, testplan.mjs injecting the testing contract.
// route.mjs and dialcheck.mjs are deliberately absent (OI-033: route.mjs is
// disabled pending a decision; dialcheck.mjs is gate-only, never registered).
export function registrations() {
  const guard = `node "${resolve("hooks/guard.mjs")}"`;
  const budget = `node "${resolve("hooks/budget.mjs")}"`;
  const testplan = `node "${resolve("hooks/testplan.mjs")}"`;
  return [
    { event: "PreToolUse", matcher: "Edit|Write|NotebookEdit|Read", command: guard },
    { event: "PreToolUse", matcher: "Agent", command: budget },
    { event: "UserPromptSubmit", matcher: null, command: budget },
    { event: "UserPromptSubmit", matcher: null, command: testplan },
    { event: "PostToolUse", matcher: null, command: budget },
    { event: "SessionStart", matcher: null, command: budget },
    { event: "Stop", matcher: null, command: budget },
  ];
}

export function main(argv = process.argv.slice(2)) {
  const flagIndex = argv.indexOf("--settings");
  if (flagIndex === -1 || !argv[flagIndex + 1]) {
    process.stderr.write("install-hooks: --settings <path> is required (never defaults to the live settings.json)\n");
    return 1;
  }
  const settingsPath = argv[flagIndex + 1];
  const before = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  const after = upsert(before, registrations(), { ownedRoots: ownedRoots() });
  writeFileSync(settingsPath, JSON.stringify(after, null, 2) + "\n");
  process.stdout.write(`install-hooks: wrote ${registrations().length} registration(s) to ${settingsPath}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exit(main());

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "../core/paths.mjs";
import * as m from "./install-hooks.mjs";

const OTHER = {
  hooks: {
    PreToolUse: [{ hooks: [{ type: "command", command: 'node "C:/code/agent-guardrails/hook.mjs"' }] }], // pathgate-ok: fixture for a DIFFERENT repo's registration, which must survive untouched
    SessionStart: [{ hooks: [{ type: "command", command: 'node "C:/other/thing.mjs"' }] }],
  },
};

test("upsert adds this repo's registrations", () => {
  const out = m.upsert({ hooks: {} }, [
    { event: "PreToolUse", matcher: "*", command: 'node "C:/repo/hooks/guard.mjs"' },
  ]);
  assert.equal(out.hooks.PreToolUse[0].hooks[0].command, 'node "C:/repo/hooks/guard.mjs"');
});

test("upsert is idempotent - twice equals once", () => {
  const regs = [{ event: "PreToolUse", matcher: "*", command: 'node "C:/repo/hooks/guard.mjs"' }];
  const once = m.upsert({ hooks: {} }, regs);
  const twice = m.upsert(structuredClone(once), regs);
  assert.deepEqual(twice, once);
});

test("upsert never removes or duplicates another repo's registrations", () => {
  const out = m.upsert(structuredClone(OTHER), [
    { event: "PreToolUse", matcher: "*", command: 'node "C:/repo/hooks/guard.mjs"' },
  ]);
  const cmds = out.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.includes('node "C:/code/agent-guardrails/hook.mjs"'), "other repo survived"); // pathgate-ok: asserts the other repo's literal registration is preserved
  assert.equal(out.hooks.SessionStart[0].hooks[0].command, 'node "C:/other/thing.mjs"');
  assert.equal(cmds.filter((c) => c.includes("C:/repo")).length, 1, "no duplicate");
});

test("after a simulated move, upsert points the old registration at the new path", () => {
  const before = m.upsert({ hooks: {} }, [
    { event: "PreToolUse", matcher: "*", command: 'node "C:/old/hooks/guard.mjs"' },
  ]);
  const after = m.upsert(before, [
    { event: "PreToolUse", matcher: "*", command: 'node "C:/new/hooks/guard.mjs"' },
  ], { ownedRoots: ["C:/old", "C:/new"] });
  const cmds = after.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(cmds, ['node "C:/new/hooks/guard.mjs"']);
});

// Every sub-project develops in its own differently-named worktree
// (acc-j-decomposition, acc-a-inventory, ...), so this file's own resolve()
// NEVER equals the live registrations' real root - a default that only
// recognizes THIS worktree's own path as "owned" cannot clean up a stale
// registration and silently duplicates it instead (found running Task 4's
// own fixture proof from this worktree, 2026-08-05).
test("ownedRoots() includes both the current resolved root and every known legacy root for this repo", () => {
  const roots = m.ownedRoots();
  assert.ok(roots.includes("C:/code/guards"), "the pre-Task-12 canonical root must be recognized as stale"); // pathgate-ok: the literal legacy root is what this test exists to pin
  assert.ok(roots.includes(repoRoot()), "the current worktree's own root must also be recognized");
});

test("main() re-points a legacy registration instead of duplicating it, from any worktree", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acc-install-hooks-"));
  const settingsPath = path.join(tmp, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Edit|Write|NotebookEdit|Read", hooks: [{ type: "command", command: 'node "C:/code/guards/hooks/guard.mjs"' }] }] }, // pathgate-ok: fixture of the legacy-root registration this test re-points
  }));
  m.main(["--settings", settingsPath]);
  m.main(["--settings", settingsPath]); // twice: still idempotent
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const cmds = after.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(cmds.filter((c) => c.includes("hooks/guard.mjs")).length, 1, "the legacy entry must be replaced, not duplicated");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --settings is the only thing standing between this installer and Kyle's
// real ~/.claude/settings.json — the file guard.mjs refuses to let an agent
// edit. It had no test, so nothing proved the refusal actually happens or
// that it happens BEFORE anything is written.
function mainWithStderr(argv) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk) => { captured += chunk; return true; };
  try {
    return { code: m.main(argv), stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

test("main() refuses and writes nothing when --settings is absent", () => {
  const cwdBefore = fs.readdirSync(".").length;
  const r = mainWithStderr([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--settings <path> is required/);
  assert.match(r.stderr, /never defaults to the live settings\.json/);
  assert.equal(fs.readdirSync(".").length, cwdBefore, "a refused run must not create files");
});

test("main() refuses when --settings is given with no path after it", () => {
  const r = mainWithStderr(["--settings"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--settings <path> is required/);
});

test("main() with no argv at all refuses, so the bare CLI can never touch live settings", () => {
  const r = mainWithStderr(undefined);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--settings <path> is required/);
});

test("main() installs into a settings.json that does not exist yet", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acc-install-hooks-"));
  const settingsPath = path.join(tmp, "settings.json");
  assert.equal(m.main(["--settings", settingsPath]), 0);
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(
    Object.values(after.hooks).flat().length,
    m.registrations().length,
    "a first-time install writes every declared registration",
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Settings.json is shared with every other tool the user installs, so a group
// that carries no `hooks` array at all is a shape this must tolerate rather
// than throw on — it belongs to somebody else and must survive untouched.
test("upsert tolerates a foreign group with no hooks array", () => {
  const out = m.upsert({ hooks: { PreToolUse: [{ matcher: "*" }] } }, [
    { event: "PreToolUse", matcher: "*", command: 'node "C:/repo/hooks/guard.mjs"' },
  ]);
  assert.deepEqual(out.hooks.PreToolUse[0], { matcher: "*" }, "the foreign group is preserved verbatim");
  assert.equal(out.hooks.PreToolUse.length, 2, "and ours is appended, not substituted");
});

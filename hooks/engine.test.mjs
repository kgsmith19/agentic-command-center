// Minimal, focused coverage for the Phase 4 D2 fix (full-remediation-
// prompt.md): a corrupt vault.json used to hard-crash EVERY engine.mjs
// command, and writes were not atomic. This is NOT the comprehensive
// engine.mjs suite Phase 7 calls for ("Test engine.mjs -- zero coverage
// today... vault read/write round-trip, corrupt-vault handling, runbox
// run/trash/restore") -- that's a separate, larger pass, deliberately not
// done here. engine.mjs's ROOT (and therefore VAULT/CONFIG) is NOT
// env-overridable the way goal.mjs/budget.mjs/usage.mjs's ACC_ROOT is, so
// this file has to operate against the real repo-relative vault.json path
// (gitignored, never committed) rather than a throwaway sandbox -- another
// gap Phase 7's broader pass should close.
//
// Run: node --test hooks/engine.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, "engine.mjs");
const REPO_ROOT = path.join(HERE, "..");
const VAULT = path.join(REPO_ROOT, "vault.json");

// Only ever touch vault.json if it did not already exist -- never clobber a
// real one a developer might have locally.
const preexisting = fs.existsSync(VAULT);
const savedContent = preexisting ? fs.readFileSync(VAULT, "utf8") : null;

after(() => {
  if (preexisting) fs.writeFileSync(VAULT, savedContent);
  else { try { fs.unlinkSync(VAULT); } catch {} }
});

test("Phase 4 D2: a corrupt vault.json does not crash 'vault-keys' -- reads as empty instead", () => {
  fs.writeFileSync(VAULT, "{ not valid json at all");
  const out = execFileSync("node", [ENGINE, "vault-keys"], { encoding: "utf8" });
  assert.equal(out.trim(), "", "a corrupt vault reads as empty, not a crash");
});

test("Phase 4 D2: a missing vault.json also reads as empty, not a crash (pre-existing behavior, still correct)", () => {
  try { fs.unlinkSync(VAULT); } catch {}
  const out = execFileSync("node", [ENGINE, "vault-keys"], { encoding: "utf8" });
  assert.equal(out.trim(), "", "a missing vault reads as empty");
});

test("Phase 4 D2: vault-import writes atomically -- no leftover .tmp- file after a successful write, and the content round-trips", () => {
  try { fs.unlinkSync(VAULT); } catch {}
  execFileSync("node", [ENGINE, "vault-import"], { input: "MY_KEY=my-value\n", encoding: "utf8" });
  const keys = execFileSync("node", [ENGINE, "vault-keys"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(keys, ["MY_KEY"], "the imported key round-trips through the atomic write");
  const leftovers = fs.readdirSync(REPO_ROOT).filter((f) => f.startsWith("vault.json.tmp-"));
  assert.deepEqual(leftovers, [], "no temp file left behind after a successful atomic write");
});

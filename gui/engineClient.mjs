// gui/engineClient.mjs — business logic for the Protected paths / Vault /
// Runbox web page (gui/engine.html), per docs/superpowers/specs/
// 2026-08-06-acc-gui-remaining-tabs-design.md §4. Thin execFileSync wrapper
// around hooks/engine.mjs's existing, tested CLI (decision (a) in that
// spec): engine.mjs's fail()/process.exit() pattern makes it unsafe to
// import in-process into a long-running server, and every command here is
// cheap (file I/O only, no network), so the subprocess boundary costs
// nothing worth avoiding it for.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, "..", "hooks", "engine.mjs");

function run(args, { input } = {}) {
  try {
    const out = execFileSync(process.execPath, [ENGINE, ...args], {
      encoding: "utf8",
      input: input !== undefined ? input : undefined,
    });
    return { ok: true, out };
  } catch (e) {
    // engine.mjs's fail() writes its message to stderr and exits non-zero;
    // execFileSync surfaces that as e.stderr on the thrown error. e.message
    // is the fallback for a spawn-level failure (e.g. node itself couldn't
    // launch), which has no stderr at all to read.
    const err = new Error(String(e.stderr || e.message).trim());
    err.stdout = String(e.stdout || "");
    throw err;
  }
}

export function status() {
  return JSON.parse(run(["status"]).out);
}

export function secretOp(op, pattern) {
  if (op !== "add" && op !== "rm") throw new Error(`unknown op "${op}"`);
  run([`secret-${op}`, pattern]);
}

export function protectedOp(op, targetPath) {
  if (op !== "add" && op !== "rm") throw new Error(`unknown op "${op}"`);
  run([`protected-${op}`, targetPath]);
}

export function projectOp(op, targetPath) {
  if (op !== "add" && op !== "rm") throw new Error(`unknown op "${op}"`);
  run([`projects-${op}`, targetPath]);
}

// Values travel over stdin, never argv — same discipline engine.mjs's own
// CLI already keeps (never in a process listing, never logged). The
// response carries key NAMES only; a value must never round-trip back to
// the browser (see the design spec §4b).
export function vaultImport(text) {
  // A successful (non-throwing) vault-import unconditionally prints
  // "stored: <names>" -- the only other outcome is the throw above, so
  // there is no real "ran fine but the output doesn't match" case to
  // guard against here.
  const out = run(["vault-import"], { input: text }).out;
  const [, names] = out.match(/^stored: (.+)$/m);
  return { imported: names.split(",").map((s) => s.trim()) };
}

export function vaultRm(key) {
  run(["vault-rm", key]);
}

export function runboxList(trash) {
  return JSON.parse(run([trash ? "trash-list" : "list", "--json"]).out);
}

// run/trash/restore/flush report success/failure as data, not a throw for
// the "script itself failed" case — that's a normal, expected outcome the
// page shows in its result panel, not an engine.mjs-level error. A THROWN
// error here means engine.mjs itself refused to even attempt it (unknown
// ref, bad extension), which the route layer treats as a real 400.
export function runboxRun(ref) {
  try {
    return { ok: true, out: run(["run", ref]).out };
  } catch (e) {
    // A failed script (real work attempted, non-zero exit) vs. engine.mjs
    // refusing outright (no such script) both throw from run() above --
    // distinguish by engine.mjs's own message shape: "FAILED" only comes
    // from a script that actually ran.
    // e.stdout is always a string here (never undefined) -- run()'s own
    // catch above guarantees it via String(e.stdout || "").
    if (/FAILED/.test(e.message) || /FAILED/.test(e.stdout)) {
      return { ok: false, out: `${e.stdout}${e.message}`.trim() };
    }
    throw e;
  }
}

export function runboxTrash(ref) {
  run(["trash", ref]);
}

export function runboxRestore(ref) {
  run(["restore", ref]);
}

export function runboxFlush() {
  run(["flush", "--really"]);
}

// No engine.mjs command exists for "show me the contents" (design spec
// §4c) -- reads the file directly, but ONLY a ref engine.mjs's own
// pending/trash listing already named this request, so a ref that isn't
// in either listing is refused before any filesystem read happens at all.
// This is the one place this module adds logic beyond "shell out and
// parse," so it gets the same scenario-enumeration attention as the
// kernel/ pass earlier tonight: no path traversal, no reading outside
// what the listing itself already proved is a real runbox script.
export function runboxPreview(ref) {
  const pending = runboxList(false);
  const trashed = runboxList(true);
  const match = (items) => items.find((i) => i.name === ref || `${i.label}:${i.name}` === ref);
  const item = match(pending) || match(trashed);
  if (!item) throw new Error(`not found in the runbox or trash: ${ref}`);
  return fs.readFileSync(path.join(item.dir, item.name), "utf8");
}

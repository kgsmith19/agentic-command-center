// core/paths.mjs — where am I?
//
// Every absolute path in this codebase used to be written down. That made a
// folder rename a 15-site audit across files no test suite can see. A module
// that derives its own root cannot be broken by moving it, so the whole class
// of breakage disappears instead of being managed.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fwd = (p) => p.replace(/\\/g, "/");

let cached = null;

export function repoRoot() {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("no package.json above core/paths.mjs");
    dir = up;
  }
  return (cached = fwd(dir));
}

export function resolve(...segments) {
  return fwd(join(repoRoot(), ...segments));
}

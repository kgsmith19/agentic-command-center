// core/migrate-standing.mjs — one-time, idempotent move of the legacy `goal`
// store into the renamed `standing order` store. Moves rather than copies:
// leaving both around would let the loop keep reading the stale one.
//
// Directory shape matches core/standing.mjs's real contract (there is no
// "active" subfolder - active records live directly in the base dir, done
// records live under done/): legacy active files sit directly in `from`,
// legacy done files sit in `from/done`. The new store mirrors that exactly
// under `to`.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

function migrateFlat(fromDir, toDir) {
  const moved = [];
  const skipped = [];
  if (!existsSync(fromDir)) return { moved, skipped };
  mkdirSync(toDir, { recursive: true });
  for (const file of readdirSync(fromDir)) {
    if (file === "done") continue; // handled separately by the caller
    if (!file.endsWith(".json")) { skipped.push(file); continue; }
    const record = JSON.parse(readFileSync(join(fromDir, file), "utf8"));
    if (typeof record.id !== "string" || !record.id.startsWith("g-")) {
      skipped.push(file);
      continue;
    }
    const newId = "so-" + record.id.slice("g-".length);
    writeFileSync(join(toDir, `${newId}.json`), JSON.stringify({ ...record, id: newId }, null, 2));
    rmSync(join(fromDir, file));
    moved.push(record.id);
  }
  return { moved, skipped };
}

export function migrate({ from, to }) {
  if (!existsSync(from)) return { moved: [], skipped: [] };
  const active = migrateFlat(from, to);
  const done = migrateFlat(join(from, "done"), join(to, "done"));
  return {
    moved: [...active.moved, ...done.moved],
    skipped: [...active.skipped, ...done.skipped],
  };
}

export function main(argv = process.argv.slice(2)) {
  const fromIndex = argv.indexOf("--from");
  const toIndex = argv.indexOf("--to");
  const from = fromIndex !== -1 ? argv[fromIndex + 1] : "runner/goals";
  const to = toIndex !== -1 ? argv[toIndex + 1] : "runner/standing";
  const r = migrate({ from, to });
  process.stdout.write(`migrate-standing: moved ${r.moved.length}, skipped ${r.skipped.length}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exit(main());

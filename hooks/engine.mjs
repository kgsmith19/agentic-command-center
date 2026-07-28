// CLI engine for guards. The GUI (guards-gui.ps1) shells to this for every
// mutation; agents use `vault-keys` and `apply` to consume user-uploaded
// secrets without the values ever entering a conversation, and `list` /
// `run` / `trash` to work the runbox (see AGENTS.md). Values travel
// stdin -> vault.json -> target file, never argv and never stdout.
//
// Runbox lifecycle: scripts live in a runbox (central runbox/ here, or
// <project>/.guards/runbox for each folder in config "projects"). A script
// that runs successfully is auto-archived into that runbox's .trash unless
// its first lines contain "guards: keep". Trash is undo-able (restore);
// only `flush --really` (the GUI's confirmed Empty-trash button) or a manual
// file delete removes anything for good. Runboxes are never tracked in git.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "config.json");
const VAULT = path.join(ROOT, "vault.json");

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, j) => writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
const vault = () => readJson(VAULT, {});
const fail = (m) => { console.error(m); process.exit(1); };
const config = () => readJson(CONFIG, null) ?? fail(`no config.json at ${CONFIG}`);
const norm = (p) => path.resolve(p).replaceAll("\\", "/");

async function stdinText() {
  let b = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) b += c;
  return b;
}

// ---------- runbox helpers ----------
const RUNNABLE = /\.(ps1|cmd|bat|mjs|js)$/i;
const STAMP_RE = /^\d{8}-\d{6}_/;

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Every place scripts can live: the central runbox plus one .guards/runbox
// per configured project folder. label is what users type (`run label:name`).
function runboxes(c) {
  const boxes = [{
    label: "central",
    dir: norm(c.runboxDir ?? path.join(ROOT, "runbox")),
    cwd: ROOT,
  }];
  for (const p of c.projects ?? []) {
    boxes.push({ label: path.basename(norm(p)), dir: norm(path.join(p, ".guards", "runbox")), cwd: norm(p) });
  }
  return boxes;
}

function filesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => {
    try { return statSync(path.join(dir, f)).isFile(); } catch { return false; }
  });
}

function firstComment(file) {
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/).slice(0, 10)) {
      const t = line.trim();
      if (/^(#|\/\/)/.test(t)) {
        const text = t.replace(/^(#|\/\/)\s*/, "");
        if (/^guards:\s*keep/i.test(text)) continue; // marker line, not a description
        if (text) return text.slice(0, 160);
      } else if (t) break; // first real code line: no leading comment
    }
  } catch { /* unreadable: no summary */ }
  return "";
}

function hasKeepMarker(file) {
  try {
    return /guards:\s*keep/i.test(readFileSync(file, "utf8").split(/\r?\n/).slice(0, 10).join("\n"));
  } catch { return false; }
}

function pendingScripts(c) {
  const out = [];
  for (const box of runboxes(c)) {
    for (const name of filesIn(box.dir)) {
      if (!RUNNABLE.test(name)) continue;
      const full = path.join(box.dir, name);
      out.push({
        label: box.label, name, dir: box.dir, cwd: box.cwd,
        keep: hasKeepMarker(full),
        summary: firstComment(full),
        mtime: statSync(full).mtime.toISOString(),
      });
    }
  }
  return out;
}

function trashedScripts(c) {
  const out = [];
  for (const box of runboxes(c)) {
    const trash = path.join(box.dir, ".trash");
    for (const name of filesIn(trash)) {
      out.push({
        label: box.label, name, dir: trash, runboxDir: box.dir,
        summary: firstComment(path.join(trash, name)),
        mtime: statSync(path.join(trash, name)).mtime.toISOString(),
      });
    }
  }
  return out;
}

// Hidden attribute keeps trash invisible in Explorer; the GUI's "Show deleted"
// toggle is how it becomes visible again. Best-effort — dot-folder either way.
function ensureTrash(runboxDir) {
  const trash = path.join(runboxDir, ".trash");
  if (!existsSync(trash)) {
    mkdirSync(trash, { recursive: true });
    spawnSync("attrib", ["+h", trash], { shell: false });
  }
  return trash;
}

function moveToTrash(item) {
  const trash = ensureTrash(item.dir);
  const dest = path.join(trash, `${stamp()}_${item.name}`);
  renameSync(path.join(item.dir, item.name), dest);
  return dest;
}

// ref forms: "name", "label:name", or an absolute path inside a runbox.
function resolveRef(items, ref, what) {
  let matches;
  if (path.isAbsolute(ref)) {
    matches = items.filter((i) => norm(path.join(i.dir, i.name)) === norm(ref));
  } else if (ref.includes(":")) {
    const [label, name] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
    matches = items.filter((i) => i.label === label && i.name === name);
  } else {
    matches = items.filter((i) => i.name === ref);
  }
  if (matches.length === 0) {
    fail(`no ${what} named "${ref}". Available:\n${items.map((i) => `  ${i.label}:${i.name}`).join("\n") || "  (none)"}`);
  }
  if (matches.length > 1) {
    fail(`"${ref}" is ambiguous — say which one:\n${matches.map((i) => `  ${i.label}:${i.name}`).join("\n")}`);
  }
  return matches[0];
}

const RUNNERS = {
  ".ps1": (f) => ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f]],
  ".cmd": (f) => ["cmd", ["/c", f]],
  ".bat": (f) => ["cmd", ["/c", f]],
  ".mjs": (f) => ["node", [f]],
  ".js": (f) => ["node", [f]],
};

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "status": {
    const c = config();
    console.log(JSON.stringify({
      enabled: c.enabled,
      secrets: c.secrets ?? [],
      protected: c.protected ?? [],
      projects: c.projects ?? [],
      vaultKeys: Object.keys(vault()),
      pending: pendingScripts(c).length,
      trashed: trashedScripts(c).length,
    }));
    break;
  }
  case "toggle": {
    if (!["on", "off"].includes(args[0])) fail("usage: toggle on|off");
    const c = config();
    c.enabled = args[0] === "on";
    writeJson(CONFIG, c);
    console.log(`guards ${c.enabled ? "ENABLED" : "DISABLED"}`);
    break;
  }
  case "secret-add":
  case "secret-rm":
  case "protected-add":
  case "protected-rm": {
    const key = cmd.startsWith("secret") ? "secrets" : "protected";
    const val = args[0] ?? fail("value required");
    const c = config();
    const list = c[key] ?? [];
    c[key] = cmd.endsWith("add") ? [...new Set([...list, val])] : list.filter((x) => x !== val);
    writeJson(CONFIG, c);
    console.log(`${key}: ${c[key].join(", ") || "(empty)"}`);
    break;
  }
  case "projects-add": {
    const p = args[0] ? norm(args[0]) : fail("usage: projects-add <folder>");
    if (!existsSync(p) || !statSync(p).isDirectory()) fail(`not a folder: ${p}`);
    const c = config();
    const list = c.projects ?? [];
    if (!list.some((x) => norm(x).toLowerCase() === p.toLowerCase())) list.push(p);
    c.projects = list;
    const runbox = path.join(p, ".guards", "runbox");
    mkdirSync(runbox, { recursive: true });
    ensureTrash(runbox);
    // Self-ignoring: .guards never shows up in the project's git, no matter
    // what the project's own .gitignore says.
    writeFileSync(path.join(p, ".guards", ".gitignore"), "*\n");
    writeJson(CONFIG, c);
    console.log(`watching: ${c.projects.join(", ")}`);
    break;
  }
  case "projects-rm": {
    const p = args[0] ? norm(args[0]) : fail("usage: projects-rm <folder>");
    const c = config();
    c.projects = (c.projects ?? []).filter((x) => norm(x).toLowerCase() !== p.toLowerCase());
    writeJson(CONFIG, c);
    console.log(`watching: ${c.projects.join(", ") || "(only the central runbox)"}`);
    console.log(`note: ${p}\\.guards was left on disk — delete it by hand if you want it gone`);
    break;
  }
  case "list": {
    const items = pendingScripts(config());
    if (args[0] === "--json") { console.log(JSON.stringify(items)); break; }
    if (!items.length) { console.log("runbox is empty — no pending scripts."); break; }
    for (const i of items) {
      console.log(`${i.label}:${i.name}${i.keep ? "  [keep]" : ""}\n    ${i.summary || "(no description)"}`);
    }
    break;
  }
  case "trash-list": {
    const items = trashedScripts(config());
    if (args[0] === "--json") { console.log(JSON.stringify(items)); break; }
    if (!items.length) { console.log("trash is empty."); break; }
    for (const i of items) console.log(`${i.label}:${i.name}`);
    break;
  }
  case "run": {
    const ref = args[0] ?? fail("usage: run <name | label:name | full path>");
    const item = resolveRef(pendingScripts(config()), ref, "pending script");
    const full = path.join(item.dir, item.name);
    const runner = RUNNERS[path.extname(item.name).toLowerCase()];
    if (!runner) fail(`cannot run ${item.name} — supported: .ps1 .cmd .bat .mjs .js`);
    const [exe, exeArgs] = runner(full);
    console.log(`[guards] running ${item.label}:${item.name} ...`);
    const r = spawnSync(exe, exeArgs, { stdio: "inherit", cwd: item.cwd });
    const code = r.status ?? 1;
    if (code === 0 && !item.keep) {
      if (existsSync(full)) {
        moveToTrash(item);
        console.log(`\n[guards] done — archived to the runbox trash (undo: restore ${item.name})`);
      } else {
        console.log(`\n[guards] done — script cleaned itself up`); // e.g. an installer that self-archives
      }
    } else if (code === 0) {
      console.log(`\n[guards] done — kept in the runbox (standing script)`);
    } else {
      console.error(`\n[guards] FAILED (exit ${code}) — script left in the runbox`);
    }
    process.exit(code);
  }
  case "trash": {
    const ref = args[0] ?? fail("usage: trash <name | label:name>");
    const item = resolveRef(pendingScripts(config()), ref, "pending script");
    moveToTrash(item);
    console.log(`trashed ${item.label}:${item.name} — undo with: restore ${item.name}`);
    break;
  }
  case "restore": {
    const ref = args[0] ?? fail("usage: restore <name | label:name>  (name as shown in trash-list, stamp optional)");
    const items = trashedScripts(config());
    // Accept both the stamped trash name and the original name.
    const bare = (n) => n.replace(STAMP_RE, "");
    let matches = items.filter((i) => i.name === ref || `${i.label}:${i.name}` === ref);
    if (!matches.length) {
      matches = items.filter((i) => bare(i.name) === ref || `${i.label}:${bare(i.name)}` === ref);
    }
    if (!matches.length) fail(`nothing in trash matches "${ref}". trash-list shows what's there.`);
    // Same script trashed repeatedly: restore the newest copy.
    matches.sort((a, b) => b.name.localeCompare(a.name));
    const item = matches[0];
    const dest = path.join(item.runboxDir, bare(item.name));
    if (existsSync(dest)) fail(`cannot restore: ${dest} already exists in the runbox`);
    renameSync(path.join(item.dir, item.name), dest);
    console.log(`restored ${item.label}:${bare(item.name)}`);
    break;
  }
  case "flush": {
    // Permanent. Only the GUI's confirmed button (or a human typing --really)
    // reaches this; agents must never call it.
    if (args[0] !== "--really") fail("flush is permanent — this is the GUI's Empty-trash button. CLI: flush --really");
    const items = trashedScripts(config());
    for (const i of items) rmSync(path.join(i.dir, i.name));
    console.log(`flushed ${items.length} archived script(s) for good.`);
    break;
  }
  case "vault-import": { // KEY=VALUE lines on stdin; blank lines and # comments skipped
    const v = vault();
    const names = [];
    for (const line of (await stdinText()).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      v[k] = t.slice(i + 1).trim();
      names.push(k);
    }
    if (!names.length) fail("no KEY=VALUE lines found on stdin");
    writeJson(VAULT, v);
    console.log(`stored: ${names.join(", ")}`);
    break;
  }
  case "vault-rm": {
    const v = vault();
    if (!(args[0] in v)) fail(`not in vault: ${args[0]}`);
    delete v[args[0]];
    writeJson(VAULT, v);
    console.log(`removed: ${args[0]}`);
    break;
  }
  case "vault-keys":
    console.log(Object.keys(vault()).join("\n"));
    break;
  case "apply": { // apply <targetFile> <KEY...>: upsert KEY=value lines into an env-format file
    const [target, ...keys] = args;
    if (!target || !keys.length) fail("usage: apply <targetFile> <KEY...>");
    const v = vault();
    const missing = keys.filter((k) => !(k in v));
    if (missing.length) fail(`not in vault: ${missing.join(", ")} — the user must add these via the Guards GUI first`);
    // Strip a UTF-8 BOM: with one, the first line never matches KEY= and a
    // stale duplicate line wins on read.
    const lines = existsSync(target)
      ? readFileSync(target, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
      : [];
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    for (const k of keys) {
      const idx = lines.findIndex((l) => l.startsWith(k + "="));
      if (idx >= 0) lines[idx] = `${k}=${v[k]}`;
      else lines.push(`${k}=${v[k]}`);
    }
    writeFileSync(target, lines.join("\n") + "\n");
    console.log(`applied to ${target}: ${keys.join(", ")}`);
    break;
  }
  default:
    fail([
      "usage: engine.mjs <command>",
      "  status | toggle on|off",
      "  secret-add/rm <glob> | protected-add/rm <path> | projects-add/rm <folder>",
      "  list [--json] | run <ref> | trash <ref> | trash-list [--json] | restore <ref> | flush --really",
      "  vault-import | vault-rm <KEY> | vault-keys | apply <file> <KEY...>",
    ].join("\n"));
}

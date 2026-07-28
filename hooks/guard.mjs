// Claude Code PreToolUse guard, registered in ~/.claude/settings.json for
// Edit|Write|NotebookEdit|Read across all projects. Three checks, in order:
//   1. secrets  — basename globs; reads AND writes blocked so keys never enter
//                 the conversation.
//   2. protected — guard machinery + its registration; writes blocked so an
//                  agent cannot edit the rules that constrain it.
//   3. cells    — per-repo path ownership (see config.json "repos"), matched
//                 by the TARGET file's path — not the session folder — so a
//                 session launched from a parent folder is guarded the same
//                 as one launched inside the repo. Writes to a cell-owned
//                 path are blocked unless .agents/task.json in that repo
//                 declares the owning cell.
// Scope: only tools named in the hook matcher. Writes via Bash (redirects,
// sed -i, tee) are NOT intercepted — convention enforcer, not a security boundary.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config.json");

function deny(msg) {
  console.error(msg);
  process.exit(2);
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  deny(`guard: cannot read ${CONFIG_PATH} (${e.message}) — failing closed. Fix or delete the hook registration in ~/.claude/settings.json.`);
}
if (!config.enabled) process.exit(0);

// Read the hook payload asynchronously. readFileSync(0) returns empty on
// Windows pipes — that is how the original lifeos path-guard crashed on every
// invocation. The 4s cap keeps a never-closing pipe from holding the tool call
// until the hook timeout; whatever arrived by then is used.
const raw = await new Promise((resolve) => {
  let buf = "";
  const timer = setTimeout(() => resolve(buf), 4000);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => { clearTimeout(timer); resolve(buf); });
  process.stdin.on("error", () => { clearTimeout(timer); resolve(buf); });
});

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  deny(`guard: no hook payload on stdin (got ${raw.length} bytes) — failing closed rather than silently allowing. Run guards/disable-guards.cmd if this repeats.`);
}

const filePath = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
if (!filePath) process.exit(0);

const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
const target = norm(filePath);
const base = path.basename(target);
const globRe = (g) =>
  new RegExp(`^${g.toLowerCase().split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

if ((config.secrets ?? []).some((g) => globRe(g).test(base))) {
  deny(`guard: "${base}" matches a secret pattern — reads and writes are blocked so keys never enter the conversation. Ask the user for the specific value you need, or use the guards vault (engine.mjs vault-keys / apply).`);
}

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
if (!WRITE_TOOLS.has(payload.tool_name)) process.exit(0);

// Runboxes are the sanctioned drop-zones: agents may write scripts there for
// the user to review and run (/approve or the Guards GUI), so they are exempt
// from every write rule below. Covers the central runbox and each
// <project>/.guards folder.
const runboxDirs = [
  ...(config.runboxDir ? [config.runboxDir] : []),
  ...(config.projects ?? []).map((p) => path.join(p, ".guards")),
].map(norm);
if (runboxDirs.some((d) => target === d || target.startsWith(d + "/"))) process.exit(0);

for (const p of config.protected ?? []) {
  const pref = norm(p);
  if (target === pref || target.startsWith(pref + "/")) {
    deny(`guard: "${filePath}" is guard machinery — agents may not edit the rules that constrain them. To hand this change to the user, write a script into ${config.runboxDir ?? "the runbox"} instead and ask them to run it (/approve or the Guards GUI).`);
  }
}

// Cell ownership: which configured repo contains the TARGET file?
const repoKey = Object.keys(config.repos ?? {}).find((k) => {
  const pref = norm(k);
  return target === pref || target.startsWith(pref + "/");
});
if (!repoKey) process.exit(0);
const repo = config.repos[repoKey];

const rel = target.slice(norm(repoKey).length + 1); // normalized + lowercase
if ((repo.alwaysAllowed ?? []).includes(rel)) process.exit(0);

const cells = repo.cells ?? {};
const owner = Object.keys(cells).find((c) => cells[c].some((p) => rel.startsWith(p)));
if (!owner) process.exit(0); // unowned path (README, config, etc.)

let declared = null;
try {
  declared = JSON.parse(readFileSync(path.join(repoKey, ".agents/task.json"), "utf8")).cell;
} catch {} // no declaration file: declared stays null and owned paths are blocked below

if (declared === owner) process.exit(0);
deny(
  `guard: "${rel}" is owned by the "${owner}" cell but this task declares ` +
    `${declared ? `"${declared}"` : "no cell"}. Either declare {"cell": "${owner}"} in ` +
    `${repoKey}/.agents/task.json (rules/ADR edits require an explicitly-declared "rules" task), ` +
    `or write the need into cross-domain-change-request.md instead of editing across the boundary.`
);

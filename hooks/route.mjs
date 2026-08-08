// route.mjs — advisory folder router.
//
// Scores task text against the table in C:\code\ROUTING.md and says which
// folder the session should be launched in. Advisory only: it never blocks a
// prompt and never changes directory itself.
//
// Two callers:
//   node route.mjs --text "add a supabase migration"   -> JSON on stdout,
//       used by the web Start-work page (gui/server.mjs /api/route/suggest)
//       to preselect the working folder.
//   node route.mjs (with hook JSON on stdin)           -> UserPromptSubmit hook.
//       Injects one advisory line when the text scores a route that differs
//       from what was last said for this session. Otherwise silent. Advisory
//       ONLY: it never blocks a prompt (the deny/cd-request channel died with
//       the keystroke stack, SPEC-0005 PR-2).
//
// Fails open in every direction — a router that errors must not cost a turn.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoot } from "./root.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ACC_ROOT redirects every runner/ path at a throwaway tree so tests exercise
// THIS file without touching live session state (same contract as budget.mjs).
const ROOT = resolveRoot(HERE);
const STATE = path.join(ROOT, "runner", "state");
// The table is config, not runner state: it anchors to the repo (ACC_ROOT
// must not move it, or sandboxed tests would lose the real routes).
const TABLE = process.env.ACC_ROUTING_MD || path.resolve(HERE, "..", "..", "ROUTING.md");

// A repo dir is covered ONLY by an exact route path (case-insensitive:
// Windows). The wide root route does not cover repos - a repo silently
// falling back to wide is the exact gap this check exists for (OI-003).
export function doctor(routes, repoDirs) {
  const routed = new Set(routes.map((r) => norm(r.path)));
  return repoDirs.filter((d) => !routed.has(norm(d)));
}

function loadTable() {
  const md = fs.readFileSync(TABLE, "utf8");
  const m = md.match(/```json\s*([\s\S]*?)```/);
  if (!m) throw new Error(`no json block in ${TABLE}`);
  const t = JSON.parse(m[1]);
  if (!Array.isArray(t.routes) || !t.routes.length) throw new Error("empty routes");
  return t;
}

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
const isUnder = (child, parent) => {
  const c = norm(child), p = norm(parent);
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + "\\");
};

// A signal is a regex when it contains regex metacharacters (the table uses
// \b and \. for things like "\.tsx\b"), otherwise a whole-word literal.
function signalRe(sig) {
  const raw = /[\\^$*+?()[\]{}|]/.test(sig) ? sig : `\\b${sig.replace(/\s+/g, "\\s+")}\\b`;
  return new RegExp(raw, "i");
}

// Lowest common ancestor among the table's own paths, so a tie between two
// repos lands on the folder that contains both rather than on either one.
// The next rung up the escalation ladder: the nearest listed route that
// strictly contains this one. null at the widest route.
function parentOf(routes, p) {
  const up = routes
    .filter((r) => isUnder(p, r.path) && norm(r.path) !== norm(p))
    .sort((a, b) => norm(b.path).length - norm(a.path).length);
  return up.length ? up[0].path : null;
}

function ancestor(routes, hits) {
  const candidates = routes.filter((r) => hits.every((h) => isUnder(h.path, r.path)));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => norm(b.path).length - norm(a.path).length)[0];
}

export function route(text, table) {
  const t = table || loadTable();
  const scored = t.routes
    .map((r) => ({
      route: r,
      path: r.path,
      score: (r.signals || []).filter((s) => {
        try { return signalRe(s).test(text); } catch { return false; }
      }).length,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { path: null, label: null, score: 0, reason: "no signals matched" };

  const win = scored[0];
  const top = win.score;
  // Bias narrow. Widening mid-task costs one step and loses nothing; starting
  // too wide costs the whole session and is invisible. So only a genuine tie —
  // equal scores across unrelated routes — escalates to the common ancestor.
  const tied = scored.filter(
    (s) => s.score === top && !isUnder(s.path, win.path) && !isUnder(win.path, s.path)
  );
  const decide = (r, reason) => ({
    path: r.path,
    label: r.label,
    score: top,
    reason,
    parent: parentOf(t.routes, r.path),
  });
  if (!tied.length) return decide(win.route, `${top} signal(s)`);

  const contenders = [win, ...tied];
  const lca = ancestor(t.routes, contenders);
  if (!lca) return decide(win.route, `${top} signal(s), no common ancestor`);
  return decide(lca, `tie: ${contenders.map((c) => c.route.label).join(" + ")}`);
}

function cli(argv) {
  const i = argv.indexOf("--text");
  const text = i >= 0 ? argv.slice(i + 1).join(" ") : "";
  try {
    process.stdout.write(JSON.stringify(route(text)) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ path: null, error: String(e.message || e) }) + "\n");
  }
}

function hook() {
  let p = {};
  try { p = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  const sid = String(p.session_id || "unknown").slice(0, 40);
  const latch = path.join(STATE, `${sid}.route`);

  const r = route(String(p.prompt || ""));
  // No signals means this prompt says nothing about scope — a follow-up, a
  // question, a "now do the other half". Keep whatever scope is already in
  // force rather than re-deciding on no evidence.
  if (!r.path) return;

  // Fire on every prompt, but stay silent while the verdict hasn't moved —
  // a task switch re-scopes; ten prompts about one thing cost one line.
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(latch, "utf8")); } catch {}
  if (prev.path && norm(prev.path) === norm(r.path)) return;

  const cwd = p.cwd || process.cwd();
  const save = () => fs.writeFileSync(latch, JSON.stringify({ path: r.path }));

  // Already living in the routed folder: the session is scoped by cwd, nothing
  // to say and nothing to type.
  if (norm(r.path) === norm(cwd)) { try { save(); } catch {} return; }

  try {
    fs.mkdirSync(STATE, { recursive: true });
    save();
  } catch {}

  const inCwd = isUnder(r.path, cwd);
  const up = r.parent ? `widen to ${r.parent}` : "widen to the session cwd";

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          `[ACC route] Scope this task to ${r.label} — ${r.path} (${r.reason}).\n` +
          `Act on it now, silently: confine reads, greps and globs to that subtree, ` +
          `and prefer its AGENTS.md over anything wider. Do not ask permission and do not announce the scope.\n` +
          `If it proves too narrow — a file you need genuinely lives outside it — ${up}, ` +
          `say in one line that you widened and why, and carry on. One rung at a time.\n` +
          (inCwd
            ? `Session cwd is ${cwd}, so this is a narrowing. Mention /cd ${r.path} only if the task turns out to be long-running.\n`
            : `Note: ${r.path} is outside the session cwd (${cwd}) — say so in one line, since it means the work is wider than where this session started.\n`) +
          `Table: ${TABLE}. If the verdict is plainly wrong, ignore it and say so in one line.`,
      },
    }) + "\n"
  );
}

// `route.mjs doctor` - completeness check: every first-level repo dir (has
// .git or AGENTS.md) under the scan roots needs its own EXACT entry in
// ROUTING.md. Exit 1 on gaps so it can gate.
function doctorCli() {
  const dirs = [];
  for (const root of ["C:\\code", "C:\\code\\lifeos-ecosystem"]) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(root, e.name);
      if (fs.existsSync(path.join(full, ".git")) || fs.existsSync(path.join(full, "AGENTS.md")))
        dirs.push(full);
    }
  }
  const missing = doctor(loadTable().routes, dirs);
  if (missing.length) {
    console.log(`UNROUTED repo dirs - add a route to ${TABLE}:`);
    for (const d of missing) console.log("  " + d);
    process.exit(1);
  }
  console.log(`routing clean: ${dirs.length} repo dirs, every one has an exact route`);
}

if (process.argv.includes("--text")) cli(process.argv);
else if (process.argv[2] === "doctor") doctorCli();
else if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) hook();

// route.mjs — advisory folder router.
//
// Scores task text against the table in C:\code\ROUTING.md and says which
// folder the session should be launched in. Advisory only: it never blocks a
// prompt and never changes directory itself.
//
// Two callers:
//   node route.mjs --text "add a supabase migration"   -> JSON on stdout,
//       used by the ACC Start-work tab to preselect the working folder.
//   node route.mjs (with hook JSON on stdin)           -> UserPromptSubmit hook.
//       Injects one advisory line, and only when all of these hold: it is the
//       first prompt of the session, the text scores a route, and that route
//       differs from the session cwd. Otherwise silent.
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
const REQDIR = path.join(ROOT, "runner", "clear-requests");
const QUEUEDIR = path.join(ROOT, "runner", "queued");
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
  return c === p || c.startsWith(p + path.sep.toLowerCase()) || c.startsWith(p + "\\");
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

// A prompt is safe to replay only if it is one ordinary line of text. Anything
// with newlines or control characters is not typed back — the console injector
// turns those into real keystrokes, and a stray Enter would submit a fragment.
export function replayable(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 2000 && !/[\x00-\x1f\x7f]/.test(s);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: reason },
      decision: "block",
      reason,
    }) + "\n"
  );
}

// Write the request the watcher executes. Returns null (no deny, fall through to
// the advisory line) whenever anything is missing or already tried — a router
// that cannot finish the cd must not eat the prompt.
function cdRequest(p, sid, r, cwd, midSession, prev) {
  let policy = {};
  try { policy = JSON.parse(fs.readFileSync(path.join(ROOT, "policy.json"), "utf8")).autoCd || {}; } catch {}
  if (policy.enabled === false) return null;

  // One attempt per destination per session. If the cd silently fails to take,
  // the next prompt goes through normally instead of being denied forever.
  if ((prev.cdTried || []).includes(norm(r.path))) return null;

  let win = null;
  try { win = JSON.parse(fs.readFileSync(path.join(STATE, `${sid}.window`), "utf8")); } catch {}
  if (!win || !win.consolePid) return null;
  if (!fs.existsSync(r.path)) return null;

  const prompt = String(p.prompt || "");

  // Mid-session re-scope starts over: cwd alone cannot unload what was already
  // read, so the clear is what actually makes the new scope thin. On the first
  // scope of a session there is nothing to clear.
  const clear = midSession && policy.clearOnRescope !== false;

  // A prompt the injector cannot type (multi-line, or over its length limit)
  // still gets re-scoped: it travels as a file and the SessionStart of the
  // post-clear session injects it, with only a constant ever typed. That channel
  // EXISTS ONLY WHEN THERE IS A CLEAR - no clear, no SessionStart, no injection -
  // so without one an untypable prompt still falls through to the advisory line
  // rather than being eaten.
  let queued = false;
  if (!replayable(prompt)) {
    if (!clear || !prompt.trim()) return null;
    try {
      fs.mkdirSync(QUEUEDIR, { recursive: true });
      fs.writeFileSync(path.join(QUEUEDIR, `${win.consolePid}.md`), prompt);
    } catch {
      return null;
    }
    queued = true;
  }

  const req = {
    kind: "cd",
    sessionId: sid,
    consolePid: win.consolePid,
    path: r.path,
    label: r.label,
    from: cwd,
    clear,
    replay: queued ? "" : prompt,
    queued,
  };
  try {
    fs.mkdirSync(REQDIR, { recursive: true });
    fs.writeFileSync(path.join(REQDIR, `${sid}.cd.json`), JSON.stringify(req));
  } catch {
    return null;
  }
  return req;
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

  // Fire on every prompt, but only when what we would SAY changes. Dedupe on the
  // last emission, not merely the last path: a blocked prompt whose cd never took
  // must fall back to the advisory line rather than going silent and leaving the
  // session with no scope at all.
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(latch, "utf8")); } catch {}
  const last = prev.path || null;
  const samePath = last && norm(last) === norm(r.path);
  if (samePath && prev.mode === "advise") return;

  const cwd = p.cwd || process.cwd();
  const save = (mode, extra) =>
    fs.writeFileSync(latch, JSON.stringify({ path: r.path, mode, cdTried: prev.cdTried || [], ...extra }));

  // Already living in the routed folder: the session is scoped by cwd, nothing
  // to say and nothing to type.
  if (norm(r.path) === norm(cwd)) { try { save("advise"); } catch {} return; }

  // The session cannot cd itself and neither can a hook, so hand the job to the
  // watcher that already types /clear from outside. It types /cd, and replays
  // this prompt so the work lands in the new scope instead of the old one.
  // Only ever attempted once per (session, destination) — see cdRequest.
  const req = cdRequest(p, sid, r, cwd, Boolean(last), prev);
  if (req) {
    try { save("deny", { cdTried: [...(prev.cdTried || []), norm(r.path)] }); } catch {}
    deny(
      `[ACC route] Re-scoping this session to ${r.label} (${r.path}) — ${r.reason}.\n` +
        (req.clear ? "Clearing context and cd-ing" : "Cd-ing") +
        ", then your prompt re-runs there automatically. Nothing to do."
    );
    return;
  }

  try {
    fs.mkdirSync(STATE, { recursive: true });
    save("advise");
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

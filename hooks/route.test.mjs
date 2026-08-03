// node --test hooks/route.test.mjs  (run from C:\code\guards)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

// Sandbox BEFORE route.mjs initialises: it resolves its runner/ tree from
// ACC_ROOT at import time, and fire()'s child processes inherit the env, so
// every write lands in a throwaway tree. Live runner/state must never see
// test files (OI-009: ~60 strays were mixed in with real session state).
process.env.ACC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "acc-route-test-"));
// See budget.test.mjs's matching comment: fire()'s child processes below
// inherit process.env, which would otherwise carry a live NODE_V8_COVERAGE
// straight through, and route.mjs is not itself gated this session — that
// incidental volume measurably degrades an unrelated gated file's merged
// branch coverage when many such spawns share one coverage run (found
// 2026-08-02).
delete process.env.NODE_V8_COVERAGE;
const { route, replayable, doctor } = await import("./route.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ACC_ROOT;
const STATE = path.join(ROOT, "runner", "state");
const REQ = path.join(ROOT, "runner", "clear-requests");
const QUEUED = path.join(ROOT, "runner", "queued");

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// A session the cd path will accept: it needs a recorded console pid.
function withConsole(sid, consolePid = process.pid) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, `${sid}.window`), JSON.stringify({ consolePid, ok: true }));
  return sid;
}
function cdReq(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(REQ, `${sid}.cd.json`), "utf8")); } catch { return null; }
}
function queuedFor(consolePid) {
  try { return fs.readFileSync(path.join(QUEUED, `${consolePid}.md`), "utf8"); } catch { return null; }
}
function cleanup(sid) {
  for (const f of [
    path.join(STATE, `${sid}.window`),
    path.join(STATE, `${sid}.route`),
    path.join(REQ, `${sid}.cd.json`),
    path.join(QUEUED, `${process.pid}.md`),
  ]) { try { fs.unlinkSync(f); } catch {} }
}

test("backend task routes to lifeos", () => {
  const r = route("add a supabase migration and a pytest for the new endpoint");
  assert.equal(r.label, "lifeos");
});

test("frontend task routes to lifeos-ui", () => {
  const r = route("the react component layout is broken, fix the tailwind styling");
  assert.equal(r.label, "lifeos-ui");
});

test("harness task routes to guards", () => {
  const r = route("the context budget hook is firing twice in the command center");
  assert.equal(r.label, "guards");
});

test("cross-repo task routes to the ecosystem, not either repo", () => {
  const r = route("change the api contract and regenerate types.gen.ts");
  assert.equal(r.label, "lifeos-ecosystem");
});

test("an exact tie across two repos escalates to their common ancestor", () => {
  const r = route("add a fastapi pydantic supabase change plus the react tailwind component");
  assert.equal(r.path, "C:\\code\\lifeos-ecosystem");
});

test("a one-signal lead still keeps the narrow folder — widening is the cheap fix", () => {
  const r = route("supabase migration and pytest, then touch one react component");
  assert.equal(r.label, "lifeos");
});

test("every verdict carries the next rung up the ladder", () => {
  assert.equal(route("supabase migration").parent, "C:\\code\\lifeos-ecosystem");
  assert.equal(route("fix the tailwind component").parent, "C:\\code\\lifeos-ecosystem");
  assert.equal(route("the guards hook misfires").parent, "C:\\code");
  assert.equal(route("across all repos").parent, null);
});

test("unmatched text yields no verdict rather than a guess", () => {
  const r = route("what did we decide about that thing yesterday");
  assert.equal(r.path, null);
});

test("--text CLI prints parseable JSON", () => {
  const out = execFileSync(
    process.execPath,
    [path.join(HERE, "route.mjs"), "--text", "fix the playwright e2e run"],
    { encoding: "utf8" }
  );
  assert.equal(JSON.parse(out).label, "lifeos-ui");
});

const fire = (sid, prompt, cwd = "C:\\code") =>
  execFileSync(process.execPath, [path.join(HERE, "route.mjs")], {
    input: JSON.stringify({ session_id: sid, prompt, cwd }),
    encoding: "utf8",
  }).trim();

test("hook scopes without asking, and names the rung above", () => {
  const ctx = JSON.parse(fire(`t${process.pid}a`, "add a supabase migration"))
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, /Scope this task to lifeos/);
  assert.match(ctx, /Do not ask permission/);
  assert.match(ctx, /widen to C:\\code\\lifeos-ecosystem/);
  assert.match(ctx, /this is a narrowing/);
  assert.doesNotMatch(ctx, /outside the session cwd/);
});

test("repeat prompts on the same scope stay silent", () => {
  const sid = `t${process.pid}b`;
  assert.notEqual(fire(sid, "fix the react component"), "");
  assert.equal(fire(sid, "now fix the other react component"), "");
});

test("switching tasks mid-session re-scopes", () => {
  const sid = `t${process.pid}c`;
  assert.match(fire(sid, "fix the react component"), /lifeos-ui/);
  const ctx = JSON.parse(fire(sid, "now add a supabase migration and pytest"))
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, /Scope this task to lifeos —/);
});

test("a prompt with no scope signal leaves the current scope alone", () => {
  const sid = `t${process.pid}d`;
  assert.notEqual(fire(sid, "fix the react component"), "");
  assert.equal(fire(sid, "ok now explain what you just did"), "");
});

test("hook flags a route that sits outside the session cwd", () => {
  const ctx = JSON.parse(
    fire(`t${process.pid}e`, "the guards budget hook misfires", "C:\\code\\lifeos-ecosystem\\lifeos")
  ).hookSpecificOutput.additionalContext;
  assert.match(ctx, /outside the session cwd/);
});

// cdRequest requires the route's real directory to exist on disk
// (hooks/route.mjs's fs.existsSync(r.path) gate) — meaningful only where the
// fixture's routes point at real checked-out repos, i.e. Windows. Same
// platform-skip pattern already used by hooks/budget.test.mjs and
// hooks/testplan.test.mjs for their own OS-specific cases.
test("scope change blocks the prompt and queues a cd for the watcher", { skip: process.platform !== "win32" }, () => {
  const sid = withConsole(`t${process.pid}f`);
  try {
    const out = JSON.parse(fire(sid, "add a supabase migration"));
    assert.equal(out.decision, "block");
    assert.match(out.reason, /Re-scoping this session to lifeos/);
    const req = cdReq(sid);
    assert.equal(req.kind, "cd");
    assert.equal(req.path, String.raw`C:\code\lifeos-ecosystem\lifeos`);
    assert.equal(req.replay, "add a supabase migration");
    assert.equal(req.clear, false); // first scope of the session: nothing to clear
  } finally { cleanup(sid); }
});

test("a mid-session re-scope also asks for a clear", { skip: process.platform !== "win32" }, () => {
  const sid = withConsole(`t${process.pid}g`);
  try {
    fire(sid, "fix the react component");            // first scope, cd queued
    fs.unlinkSync(path.join(REQ, `${sid}.cd.json`)); // pretend the watcher ran it
    fire(sid, "now add a supabase migration", String.raw`C:\code\lifeos-ecosystem\lifeos-ui`);
    assert.equal(cdReq(sid).clear, true);
  } finally { cleanup(sid); }
});

test("the same destination is never attempted twice — no deny loop", { skip: process.platform !== "win32" }, () => {
  const sid = withConsole(`t${process.pid}h`);
  try {
    assert.equal(JSON.parse(fire(sid, "add a supabase migration")).decision, "block");
    fs.unlinkSync(path.join(REQ, `${sid}.cd.json`));
    // cd silently failed to take: cwd is still C:\code. Second time it must fall
    // through to the advisory line rather than eating the prompt again.
    const out = JSON.parse(fire(sid, "another supabase migration and pytest run"));
    assert.notEqual(out.decision, "block");
    assert.match(out.hookSpecificOutput.additionalContext, /Scope this task to lifeos/);
  } finally { cleanup(sid); }
});

test("no recorded console means advise, never block", () => {
  const sid = `t${process.pid}i`; // deliberately no .window file
  try {
    const out = JSON.parse(fire(sid, "add a supabase migration"));
    assert.notEqual(out.decision, "block");
    assert.equal(cdReq(sid), null);
  } finally { cleanup(sid); }
});

test("an untypable prompt with no clear to ride on is never blocked", () => {
  // First scope of a session: no clear, so no SessionStart fires and there is
  // nothing to inject a queued prompt into. Advise instead of eating it.
  const sid = withConsole(`t${process.pid}j`);
  try {
    const out = JSON.parse(fire(sid, "add a supabase migration\nand a second line"));
    assert.notEqual(out.decision, "block");
    assert.equal(cdReq(sid), null);
    assert.equal(queuedFor(process.pid), null);
  } finally { cleanup(sid); }
});

test("a multi-line mid-session re-scope queues the prompt instead of typing it", { skip: process.platform !== "win32" }, () => {
  const sid = withConsole(`t${process.pid}k`);
  const multi = "now add a supabase migration\nand a pytest for it";
  try {
    fire(sid, "fix the react component");            // first scope, cd queued
    fs.unlinkSync(path.join(REQ, `${sid}.cd.json`)); // pretend the watcher ran it
    const out = JSON.parse(fire(sid, multi, String.raw`C:\code\lifeos-ecosystem\lifeos-ui`));
    assert.equal(out.decision, "block");
    const req = cdReq(sid);
    assert.equal(req.clear, true);
    assert.equal(req.queued, true);
    assert.equal(req.replay, "");        // nothing derived from the prompt is typed
    assert.equal(queuedFor(process.pid), multi);  // it travels as a file, intact
  } finally { cleanup(sid); }
});

// doctor: a repo dir is covered ONLY by an exact route path. The wide root
// route does not cover repos — silent fallback to wide is the OI-003 gap.
test("doctor flags a repo dir no route covers", () => {
  const routes = [{ path: "C:\\code\\guards" }, { path: "C:\\code" }];
  const dirs = ["C:\\code\\guards", "C:\\code\\newrepo"];
  assert.deepEqual(doctor(routes, dirs), ["C:\\code\\newrepo"]);
});

test("doctor accepts a repo covered by an exact route", () => {
  assert.deepEqual(doctor([{ path: "C:\\code\\guards" }], ["C:\\code\\guards"]), []);
});

test("doctor compares paths case-insensitively (Windows)", () => {
  assert.deepEqual(doctor([{ path: "C:\\code\\Guards" }], ["c:\\CODE\\guards"]), []);
});

test("replayable rejects exactly what the injector cannot be trusted with", () => {
  assert.ok(replayable("fix the login page"));
  assert.ok(!replayable("two\nlines"));
  assert.ok(!replayable("tab\there"));
  assert.ok(!replayable(""));
  assert.ok(!replayable("x".repeat(2001)));
});

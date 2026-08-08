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
const { route, doctor } = await import("./route.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ACC_ROOT;
const STATE = path.join(ROOT, "runner", "state");

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

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

// The deny/cd-request/queued-prompt channel died with the keystroke stack
// (SPEC-0005 PR-2). The router is purely advisory now — this pins that no
// prompt shape, scope change, or re-scope can ever block a prompt again.
test("the hook NEVER blocks: scope changes and multi-line prompts advise only", () => {
  const sid = `t${process.pid}f`;
  const out = JSON.parse(fire(sid, "add a supabase migration"));
  assert.notEqual(out.decision, "block");
  assert.match(out.hookSpecificOutput.additionalContext, /Scope this task to lifeos/);
  const multi = JSON.parse(fire(`t${process.pid}g`, "add a supabase migration\nand a second line"));
  assert.notEqual(multi.decision, "block");
});

// node --test kernel/policy.test.mjs  (run from C:\code\guards)
// Hermetic: ACC_POLICY/ACC_ROOT point at throwaway paths BEFORE the import.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-policy-"));
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_ROOT = path.join(BASE, "root");

const { loadKernelPolicy, KERNEL_DEFAULTS, kernelRoot, alwaysDenyWriteRoots } =
  await import("./policy.mjs");

const writePolicy = (kernel) =>
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify(kernel ? { kernel } : {}));

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("absent policy file yields the defaults", () => {
  fs.rmSync(process.env.ACC_POLICY, { force: true });
  assert.equal(loadKernelPolicy().budget.wallClockMin, KERNEL_DEFAULTS.budget.wallClockMin);
});

test("a policy edit applies to the NEXT call with no restart (AC-G9, AC-U2)", () => {
  writePolicy({ budget: { toolCalls: 7 } });
  assert.equal(loadKernelPolicy().budget.toolCalls, 7);
  writePolicy({ budget: { toolCalls: 9 } });
  assert.equal(loadKernelPolicy().budget.toolCalls, 9, "must re-read, never cache");
});

test("a partial block keeps the other defaults", () => {
  writePolicy({ budget: { toolCalls: 5 } });
  const p = loadKernelPolicy();
  assert.equal(p.budget.toolCalls, 5);
  assert.equal(p.budget.wallClockMin, KERNEL_DEFAULTS.budget.wallClockMin);
  assert.equal(p.autonomy.window, KERNEL_DEFAULTS.autonomy.window);
});

test("a corrupt policy file THROWS so callers fail closed, never guesses dials", () => {
  fs.writeFileSync(process.env.ACC_POLICY, "{ not json");
  assert.throws(() => loadKernelPolicy(), /kernel policy unreadable/);
});

test("always-deny write roots cover the guards repo and the user .claude dir (AC-G7)", () => {
  writePolicy({});
  const roots = alwaysDenyWriteRoots();
  const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
  assert.ok(roots.includes(norm(path.join(os.homedir(), ".claude"))));
  assert.ok(roots.every((r) => r === r.toLowerCase() && !r.includes("\\")), "roots must be normalized");
});

test("kernelRoot honors ACC_ROOT so tests never touch live state", () => {
  assert.equal(kernelRoot(), path.resolve(process.env.ACC_ROOT));
});

test("kernelRoot falls back to the repo root when ACC_ROOT is unset", () => {
  const saved = process.env.ACC_ROOT;
  delete process.env.ACC_ROOT;
  try {
    assert.ok(path.isAbsolute(kernelRoot()));
  } finally {
    process.env.ACC_ROOT = saved;
  }
});

test("loadKernelPolicy falls back to the repo policy.json when ACC_POLICY is unset (read-only)", () => {
  const saved = process.env.ACC_POLICY;
  delete process.env.ACC_POLICY;
  try {
    assert.doesNotThrow(() => loadKernelPolicy());
  } finally {
    process.env.ACC_POLICY = saved;
  }
});

test("a policy file with a leading UTF-8 BOM still parses", () => {
  fs.writeFileSync(process.env.ACC_POLICY, "﻿" + JSON.stringify({ kernel: { budget: { toolCalls: 3 } } }));
  assert.equal(loadKernelPolicy().budget.toolCalls, 3);
});

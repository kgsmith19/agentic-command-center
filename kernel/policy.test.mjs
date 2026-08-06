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

const { loadKernelPolicy, KERNEL_DEFAULTS, kernelRoot, alwaysDenyWriteRoots, saveKernelPolicy } =
  await import("./policy.mjs");

const writePolicy = (kernel) =>
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify(kernel ? { kernel } : {}));

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("absent policy file yields the defaults", () => {
  fs.rmSync(process.env.ACC_POLICY, { force: true });
  assert.equal(loadKernelPolicy().budget.wallClockMin, KERNEL_DEFAULTS.budget.wallClockMin);
});

// OI-019 scenario-enumeration pass: a policy.json that EXISTS and parses
// fine, but simply has no "kernel" key at all -- the real first-time-setup
// case (a policy.json that predates the kernel feature, or one only ever
// used for the non-kernel hooks), distinct from the missing-file case
// above. Not a bug (verified correct beforehand), but was untested.
test("a present policy file with no 'kernel' key at all also yields the defaults", () => {
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ context: { softK: 100 } }));
  assert.equal(loadKernelPolicy().budget.wallClockMin, KERNEL_DEFAULTS.budget.wallClockMin);
  assert.equal(loadKernelPolicy().autonomy.window, KERNEL_DEFAULTS.autonomy.window);
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

const goodBlock = () => {
  const k = loadKernelPolicy();
  return {
    harness: "claude-code",
    budget: { wallClockMin: k.budget.wallClockMin, toolCalls: 150, tokens: k.budget.tokens },
    hardCaps: { wallClockMin: k.hardCaps.wallClockMin },
    autonomy: { ...k.autonomy },
    checkpointMin: k.checkpointMin,
    alwaysAllowTools: ["TodoWrite"],
    extraDenyWriteRoots: [],
  };
};

test("saveKernelPolicy round-trips through the file and preserves everything it does not own", () => {
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({
    context: { softK: 400 },
    kernel: { ...goodBlock(), _note: "keep me" },
  }, null, 2));
  const saved = saveKernelPolicy({
    ...goodBlock(), budget: { ...goodBlock().budget, toolCalls: 99 },
    extraDenyWriteRoots: ["  C:/some/root  "],
  });
  assert.equal(saved.budget.toolCalls, 99);
  assert.deepEqual(saved.extraDenyWriteRoots, ["C:/some/root"], "list entries are trimmed");
  const onDisk = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  assert.equal(onDisk.kernel.budget.toolCalls, 99);
  assert.equal(onDisk.kernel._note, "keep me", "unknown kernel keys survive");
  assert.equal(onDisk.context.softK, 400, "other policy blocks survive");
});

test("an invalid block is rejected atom-for-atom: throws, file byte-identical", () => {
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ kernel: goodBlock() }, null, 2));
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  for (const evil of [
    { ...goodBlock(), harness: "" },
    { ...goodBlock(), budget: { ...goodBlock().budget, toolCalls: 0 } },
    { ...goodBlock(), budget: { ...goodBlock().budget, tokens: 1.5 } },
    { ...goodBlock(), autonomy: { ...goodBlock().autonomy, rejectRate: 5 } },
    { ...goodBlock(), autonomy: { ...goodBlock().autonomy, factor: 0 } },
    { ...goodBlock(), checkpointMin: -1 },
    { ...goodBlock(), alwaysAllowTools: ["", "x"] },
    { ...goodBlock(), alwaysAllowTools: "TodoWrite" },
  ]) {
    assert.throws(() => saveKernelPolicy(evil), /kernel policy:/);
    assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before, "rejected save must not touch the file");
  }
});

test("saveKernelPolicy with no policy file fails closed instead of inventing one", () => {
  fs.rmSync(process.env.ACC_POLICY, { force: true });
  assert.throws(() => saveKernelPolicy(goodBlock()), /cannot edit/);
});

// OI-019 scenario-enumeration pass: the file EXISTS (so saveKernelPolicy
// doesn't fail closed above) but has no "kernel" key yet -- first-time
// kernel setup through the GUI settings tab (OI-022), distinct from the
// no-file case. Not a bug (verified correct beforehand), but was untested.
test("saveKernelPolicy creates the kernel block fresh when the file exists but has no kernel key yet", () => {
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ context: { softK: 100 } }));
  const saved = saveKernelPolicy(goodBlock());
  assert.equal(saved.harness, "claude-code");
  const onDisk = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  assert.equal(onDisk.kernel.harness, "claude-code");
  assert.equal(onDisk.context.softK, 100, "the pre-existing non-kernel block survives");
});

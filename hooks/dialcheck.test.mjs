// node --test hooks/dialcheck.test.mjs   (run from the repo root)
//
// Hermetic: every rule is checked against inline fixtures, and the two path
// helpers + main() are driven through env vars pointing at a throwaway tree.
// Nothing reads this machine's real settings.json.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-dialcheck-"));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const m = await import("./dialcheck.mjs");

// The live divergence this file was written for: disable-route-hook.mjs auto-ran
// at 18:42 on 2026-08-04 and stripped hooks/route.mjs out of settings.json,
// while policy.json advertised autoCd.enabled:true for hours afterwards.
const withHook = {
  hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "C:/code/example-project/hooks/route.mjs"' }] }] },
};
const withoutHook = {
  hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "C:/code/example-project/hooks/testplan.mjs"' }] }] },
};

test("the real 2026-08-04 divergence: dial says enabled, hook is not registered", () => {
  const d = m.divergences({ autoCd: { enabled: true } }, withoutHook);
  assert.equal(d.length, 1);
  assert.match(d[0], /autoCd\.enabled is TRUE .* controls nothing/);
});

test("the other direction is also a lie: hook registered while the dial says disabled", () => {
  const d = m.divergences({ autoCd: { enabled: false } }, withHook);
  assert.equal(d.length, 1);
  assert.match(d[0], /route\.mjs IS registered .* is FALSE/);
});

test("no complaint when dial and hook agree, in both directions", () => {
  assert.deepEqual(m.divergences({ autoCd: { enabled: true } }, withHook), []);
  assert.deepEqual(m.divergences({ autoCd: { enabled: false } }, withoutHook), []);
});

// A check that fails closed on its own inability to read config would cry wolf
// on every fresh machine, and a check nobody trusts is a check nobody runs.
test("missing or unreadable config reads as disabled, not as enabled", () => {
  assert.deepEqual(m.divergences(null, null), []);
  assert.deepEqual(m.divergences({}, {}), []);
  assert.deepEqual(m.divergences({ autoCd: {} }, { hooks: {} }), []);
});

test("a hook registered under a DIFFERENT event does not count as registered", () => {
  const elsewhere = { hooks: { Stop: [{ hooks: [{ command: 'node "hooks/route.mjs"' }] }] } };
  assert.match(m.divergences({ autoCd: { enabled: true } }, elsewhere)[0], /controls nothing/);
});

test("multiple dials each report independently", () => {
  const dials = [
    { dial: "a.enabled", read: (p) => !!p?.a?.enabled, event: "UserPromptSubmit", hook: "aaa.mjs" },
    { dial: "b.enabled", read: (p) => !!p?.b?.enabled, event: "UserPromptSubmit", hook: "bbb.mjs" },
  ];
  const settings = { hooks: { UserPromptSubmit: [{ hooks: [{ command: "node bbb.mjs" }] }] } };
  const d = m.divergences({ a: { enabled: true }, b: { enabled: false } }, settings, dials);
  assert.equal(d.length, 2, "one message per diverging dial");
  assert.match(d[0], /a\.enabled is TRUE/);
  assert.match(d[1], /bbb\.mjs IS registered/);
});

test("readJson returns null instead of throwing on a missing or malformed file", () => {
  assert.equal(m.readJson(path.join(BASE, "absent.json")), null);
  const bad = path.join(BASE, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.equal(m.readJson(bad), null);
  const good = path.join(BASE, "good.json");
  fs.writeFileSync(good, '{"ok":1}');
  assert.deepEqual(m.readJson(good), { ok: 1 });
});

test("policyPath and settingsPath honour their env overrides, and fall back predictably", () => {
  const savedPolicy = process.env.ACC_POLICY;
  const savedSettings = process.env.ACC_SETTINGS;
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.ACC_POLICY = path.join(BASE, "p.json");
    assert.equal(m.policyPath(), path.join(BASE, "p.json"));
    delete process.env.ACC_POLICY;
    assert.equal(path.basename(m.policyPath()), "policy.json", "falls back to the repo's own policy.json");

    process.env.ACC_SETTINGS = path.join(BASE, "s.json");
    assert.equal(m.settingsPath(), path.join(BASE, "s.json"));
    delete process.env.ACC_SETTINGS;
    process.env.CLAUDE_CONFIG_DIR = path.join(BASE, "cfg");
    assert.equal(m.settingsPath(), path.join(BASE, "cfg", "settings.json"));
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(m.settingsPath(), path.join(os.homedir(), ".claude", "settings.json"));
  } finally {
    if (savedPolicy === undefined) delete process.env.ACC_POLICY; else process.env.ACC_POLICY = savedPolicy;
    if (savedSettings === undefined) delete process.env.ACC_SETTINGS; else process.env.ACC_SETTINGS = savedSettings;
    if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
  }
});

// main() is exercised in-process, not as a subprocess: a spawned process is
// invisible to this file's own coverage instrumentation (the lesson OI-006 paid
// for on standing.mjs, and the reason budget.mjs still measures 0%).
test("main() returns 1 and names the divergence, 0 when clean", () => {
  const savedPolicy = process.env.ACC_POLICY;
  const savedSettings = process.env.ACC_SETTINGS;
  const logged = [];
  const realLog = console.log;
  console.log = (...a) => logged.push(a.join(" "));
  try {
    const pol = path.join(BASE, "policy.json");
    const set = path.join(BASE, "settings.json");
    process.env.ACC_POLICY = pol;
    process.env.ACC_SETTINGS = set;

    fs.writeFileSync(pol, JSON.stringify({ autoCd: { enabled: true } }));
    fs.writeFileSync(set, JSON.stringify(withoutHook));
    assert.equal(m.main(), 1, "diverging exits non-zero so it can gate");
    assert.match(logged.join("\n"), /DIAL\/HOOK DIVERGENCE/);

    logged.length = 0;
    fs.writeFileSync(set, JSON.stringify(withHook));
    assert.equal(m.main(), 0, "agreeing exits zero");
    assert.match(logged.join("\n"), /dials clean/);
  } finally {
    console.log = realLog;
    if (savedPolicy === undefined) delete process.env.ACC_POLICY; else process.env.ACC_POLICY = savedPolicy;
    if (savedSettings === undefined) delete process.env.ACC_SETTINGS; else process.env.ACC_SETTINGS = savedSettings;
  }
});

// The dial this repo actually ships, checked against the repo's own policy.json
// and the DIALS table, so a typo in either is caught by the suite rather than by
// a confusing clean run on a machine where the hook is legitimately absent.
test("the shipped DIALS table names autoCd and route.mjs on UserPromptSubmit", () => {
  assert.equal(m.DIALS.length, 1);
  assert.equal(m.DIALS[0].dial, "autoCd.enabled");
  assert.equal(m.DIALS[0].hook, "route.mjs");
  assert.equal(m.DIALS[0].event, "UserPromptSubmit");
  assert.equal(m.DIALS[0].read({ autoCd: { enabled: true } }), true);
  assert.equal(m.DIALS[0].read({}), false);
});

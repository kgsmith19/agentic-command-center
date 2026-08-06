// node --test hooks/consoletable.test.mjs  (run from the repo root)
//
// buildConsoleTable takes its OS-shelling dependency (execFileSync) and its
// active-standing source as injected params specifically so this can be
// exercised in-process without real PowerShell or a real standing store - see the
// module's own header for why SessionStart needs this at all (OI-034).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConsoleTable } from "./consoletable.mjs";

test("no consolePid and no active standing -> undefined, never shells out", () => {
  let called = false;
  const result = buildConsoleTable(null, {
    activeStanding: () => [],
    execFileSync: () => { called = true; return "{}"; },
    here: "C:/code/example-project/hooks",
  });
  assert.equal(result, undefined);
  assert.equal(called, false, "an empty pid set must never spawn powershell");
});

test("gathers the window's own pid plus every active standing order's consolePid, deduped", () => {
  let argsSeen = null;
  const result = buildConsoleTable(
    { consolePid: 111 },
    {
      activeStanding: () => [{ consolePid: 222 }, { consolePid: 111 }, { consolePid: 0 }, {}],
      execFileSync: (cmd, args) => {
        argsSeen = args;
        return JSON.stringify({ 111: "2026-08-01T00:00:00.000Z", 222: "2026-08-01T00:00:00.000Z" });
      },
      here: "C:/code/example-project/hooks",
    }
  );
  const pidsArgIndex = argsSeen.indexOf("-Pids") + 1;
  const pids = argsSeen[pidsArgIndex].split(",").map(Number).sort((a, b) => a - b);
  assert.deepEqual(pids, [111, 222], "the 0/undefined consolePid entries must be dropped, and 111 deduped");
  assert.deepEqual(result, { 111: "2026-08-01T00:00:00.000Z", 222: "2026-08-01T00:00:00.000Z" });
});

test("invokes consoletable.ps1 from the given directory, via powershell", () => {
  let cmdSeen = null;
  let argsSeen = null;
  buildConsoleTable({ consolePid: 5 }, {
    activeStanding: () => [],
    execFileSync: (cmd, args) => {
      cmdSeen = cmd;
      argsSeen = args;
      return "{}";
    },
    here: "C:/code/example-project/hooks",
  });
  assert.equal(cmdSeen, "powershell");
  assert.ok(argsSeen.some((a) => String(a).endsWith("consoletable.ps1")));
  assert.ok(argsSeen.includes("-File"));
  assert.ok(argsSeen.includes("-Pids"));
});

test("a throwing execFileSync (powershell missing, timeout, bad JSON) fails open to undefined", () => {
  const threw = buildConsoleTable({ consolePid: 5 }, {
    activeStanding: () => [],
    execFileSync: () => { throw new Error("boom"); },
    here: "C:/code/example-project/hooks",
  });
  assert.equal(threw, undefined);

  const badJson = buildConsoleTable({ consolePid: 5 }, {
    activeStanding: () => [],
    execFileSync: () => "not json",
    here: "C:/code/example-project/hooks",
  });
  assert.equal(badJson, undefined);
});

test("a standing order with no consolePid at all contributes nothing to the pid set", () => {
  let called = false;
  const result = buildConsoleTable(null, {
    activeStanding: () => [{ text: "no console yet" }],
    execFileSync: () => { called = true; return "{}"; },
    here: "C:/code/example-project/hooks",
  });
  assert.equal(result, undefined);
  assert.equal(called, false);
});

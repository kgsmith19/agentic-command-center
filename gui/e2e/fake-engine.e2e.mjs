// Stateful fake hooks/engine.mjs for the guards-page e2e (SPEC-0002 AC-010).
// Sandbox only — state lives in ACC_GUI_E2E_DIR/guards-state.json, written by
// guards.spec.mjs's beforeEach. Mirrors exactly the verbs/outputs the server
// consumes; nothing here ever touches the real config.json or runbox.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.ACC_GUI_E2E_DIR;
const S = path.join(dir, "guards-state.json");
const s = JSON.parse(fs.readFileSync(S, "utf8"));
const save = () => fs.writeFileSync(S, JSON.stringify(s));
const [cmd, arg] = process.argv.slice(2);

if (cmd === "status") {
  console.log(JSON.stringify({
    enabled: s.enabled, secrets: s.secrets, protected: s.protected, projects: s.projects,
    vaultKeys: [], pending: s.pending.length, trashed: s.trashed.length,
  }));
} else if (cmd === "list") {
  console.log(JSON.stringify(s.pending));
} else if (cmd === "trash-list") {
  console.log(JSON.stringify(s.trashed));
} else if (cmd === "toggle") {
  s.enabled = arg === "on"; save();
  console.log(`guards ${s.enabled ? "ENABLED" : "DISABLED"}`);
} else if (cmd === "run") {
  const item = s.pending.shift(); s.trashed.push(item); save();
  console.log(`[guards] running ${arg} ...\n[guards] done`);
} else {
  console.log(`did ${cmd} ${arg ?? ""}`);
}

// tools/testkit.mjs — one place to be right about "never touch live state".
// This assertion used to be copy-pasted into ~20 suites; a missed copy silently
// disarms a safety check, which is the worst kind of test bug.
import { repoRoot } from "../core/paths.mjs";

export function assertNotLiveRoot(dir) {
  const d = String(dir).replace(/\\/g, "/").replace(/\/+$/, "");
  const live = repoRoot();
  if (d === live || d.startsWith(live + "/")) {
    throw new Error(`refusing to use the live repo as a sandbox: ${d}`);
  }
  return d;
}

// Shared repo-root fallback, used at module-load time by hooks whose root is
// safe to resolve once (budget.mjs, route.mjs, statusline.mjs, testplan.mjs
// all did this identically before this file existed). Hooks that must
// re-resolve PER CALL for sandboxed-test isolation stay separate on purpose
// — see hooks/directive.mjs's own comment on why a cached const there would
// leak one test's ACC_ROOT into every later one, hooks/lane.mjs's on why it
// deliberately does NOT key off ACC_ROOT at all, and runner/runner.mjs's on
// why it anchors at runner/ under its own ACC_RUNNER_ROOT instead.
import path from "node:path";

export function resolveRoot(here) {
  return process.env.ACC_ROOT ? path.resolve(process.env.ACC_ROOT) : path.resolve(here, "..");
}

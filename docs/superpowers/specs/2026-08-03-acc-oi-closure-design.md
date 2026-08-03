# ACC Open-Issues Closure Batch — Design

- date: 2026-08-03
- status: approved (brainstorming session, Kyle 2026-08-03)
- scope: OI-023, OI-024, OI-022, OI-020, OI-025, plus publishing the branch
  (push to origin/main and CI green)
- execution: a separate Sonnet session runs the companion plan
  (`docs/superpowers/plans/2026-08-03-acc-oi-closure-plan.md`); this spec is
  the decision record that OI-022's ledger resolution cites
- ledger anchors: OPEN-ISSUES.md OI-020:286, OI-022:339, OI-023:378,
  OI-024:411, OI-025:445 (line numbers as of 46a6550)

## 1. Context

Five items were left open by the ACC kernel plan's Task 22 end-of-work review.
Two are small kernel code decisions (OI-023 spawn hygiene, OI-024 ceiling
freshness), one is a deferred token-spending verification run (OI-025), and two
form one architecture decision (OI-022 WinForms-vs-web, which gates OI-020
Playwright e2e). Kyle chose: decide the platform now, plan the full e2e path
behind it, and run both proof-tier suites as plan steps.

## 2. Goals and non-goals

Goals, in execution order:

1. Adopt a spawn path that does not trigger DEP0190 in all three call sites
   (adapter `identity()`, adapter `startTask()`, `runner/runner.mjs`), with the
   injection class closed by construction, not by convention.
2. Make the guardhook's per-fire toolCalls ceiling reflect autonomy tightening
   immediately, sharing the supervisor's own `effectiveCeilings`.
3. Record the platform decision — web, migrated incrementally — and build its
   rails: `gui/server.mjs`, the kernel-settings page, the WebView2 swap, and a
   Playwright e2e running in CI (satisfies OI-020's done-when as written).
4. Run `kernel/kernel.e2e.mjs` (after 1+2) and `e2e/loop.e2e.mjs` (all 5
   scenarios, closes OI-025) through the launch lane.
5. Resolve the five ledger entries per convention and push to origin/main,
   ending only on green CI.

Non-goals (explicitly out of scope):

- Migrating the remaining tabs (Start Work, Process, Keys, Terminal) — that is
  the GUI overhaul's work, now pointed at these rails.
- Moving ConPTY/PtyHost ownership out of the GUI process. OI-009 (GUI is a
  SPOF for hosted sessions) stays open; the web decision makes its structural
  fix *possible* later, and nothing more is claimed here.
- OI-010 (multi-line pipe payloads) and OI-021 (API-overload meta-errors) —
  untouched.
- The prompt-storage / cmd-passthrough feature set — separate future
  brainstorm.

## 3. OI-023 — spawn hardening

New shared module `hooks/cmdline.mjs` (hooks/ is the existing shared-utility
area; `runner.mjs` already imports `hooks/lane.mjs`, and this module is pure
functions, so the kernel importing it breaks no isolation):

- `cmdQuote(arg)` — Windows quoting: MS C-runtime argv rules (backslash
  doubling before quotes, wrap when the arg contains space/tab/quote or is
  empty) followed by cmd.exe metacharacter caret-escaping. **Fail-closed**: an
  arg it cannot render safely (embedded newline/CR, `%NAME%` expansion pairs)
  throws `CmdQuoteError` instead of mangling. Call sites do not catch — a
  throw there is a real bug surfacing, per the repo's closed failure doctrine.
- `spawnSpec(bin, args)` — returns what to hand `child_process`:
  - POSIX: `{file: bin, args, shell: false}` — the shell is removed entirely
    (claude is a real executable there); the injection class is deleted, not
    escaped.
  - Windows: `{file: "<bin> <cmdQuote(each arg)>", shell: true}` — the shell
    must stay for the `.cmd` shim (Node refuses shell-less `.cmd` spawn since
    CVE-2024-27980), so the command becomes **one pre-quoted string** — Node's
    own documented DEP0190 remedy. The spec object carries no `args` key.
- Invariant, unit-tested: `shell:true` implies no args array. When a spec has
  `shell:true`, callers pass no args argument at all (this holds for `spawn`
  and `execFileSync` alike). The DEP0190 combination becomes unrepresentable.

Call-site changes:

- `kernel/adapters/claude-code.mjs` `identity()` (~:24, `execFileSync`) and
  `startTask()` (~:62, `spawnFn`) both consume `spawnSpec`.
- `runner/runner.mjs` (~:106) consumes `spawnSpec`.
- `buildArgs()` returns **raw** values; the manual quote-wrapping of
  `settingsPath` (~:39) is deleted. Quoting now happens only at the spawn
  boundary.
- `killTree` unchanged on Windows (the shell wrapper still exists; `taskkill
  /t` already walks the PID tree). On POSIX the child now *is* claude; the
  existing detached process-group kill covers it directly.

OI-023's done-when offers two arms; this design takes the first (a
non-DEP0190 spawn path adopted for both files) and rejects
suppress-and-document.

Tests (red first):

- `cmdQuote` hostile matrix: spaces, embedded quotes, backslash runs before
  quotes, carets, `&|<>()`, `%VAR%` (throw), newlines (throw), empty string.
- `spawnSpec` shape invariant per platform.
- Argv fidelity through the existing spawn seam + fake-claude-on-PATH pattern
  (`runner/runner.test.mjs` idiom): the fake binary echoes its argv; asserted
  byte-identical to intent on both platforms.
- Existing adapter tests updated for raw `buildArgs`; all 39 runner tests stay
  green.
- Live proof: the slice-3 `kernel.e2e.mjs` run's stderr contains **no
  DEP0190 warning** (the OI was originally spotted in that very output).

## 4. OI-024 — guardhook live ceilings

`kernel/guardhook.mjs` (~:84-86) stops computing its own raw ceiling and calls
the supervisor's `effectiveCeilings(contract, policy, readAutonomy())`,
imported from sibling `kernel/autonomy.mjs`. One extra small JSON read in a
fresh-per-fire process that already reads contract/policy/pin — sub-millisecond
against its ~50ms spawn. One shared function at both enforcement points means
they cannot drift. Only the toolCalls dimension changes behavior; wall-clock
and stall enforcement stay the supervisor's.

Failure semantics (closed doctrine, matching unreadable-policy behavior
today): absent autonomy file → defaults, no tightening (first-run semantics);
unreadable/corrupt autonomy file → exit 2, block with a message. The ledger
decision record gains `effectiveCeiling` and `autonomyFactor` fields so the
audit trail shows why a fire was denied. `kernel/README.md`'s honest-ceilings
text gets a sentence updated; if the traceability table's AC-B1/AC-B2 language
still describes the tick-latency gap, correct it — the gap no longer exists.

Tests (red first, `kernel/guardhook.test.mjs`): tightened autonomy file →
denial at exactly the shrunk count, not the raw one (the ledger's own required
case); absent file → base ceiling; corrupt file → fail closed; drift-lock
(hook and supervisor compute identical ceilings from identical inputs); ledger
record carries the new fields.

## 5. OI-022 — decision record: web, migrated incrementally

**Decision: the GUI's future is a local web frontend. Migration is
tab-by-tab; the WinForms shell retires when its last tab moves. This batch
builds the rails and migrates one tab (kernel settings, T21's).**

Grounds (from the ledger's own 2026-08-03 inspection): `gui/PtyHost.cs`
already serves a UI-independent named-pipe protocol; `gui/term.html` is
already web technology talking structured JSON; `guards-gui.ps1` is ~80%
backend glue with no WinForms dependency and only ~15-20% Forms construction.
The upsides recorded there — decoupling session hosting from the viewer
(OI-009's structural fix), remote/multi-device views, cheap live push — all
require web; dev time was recorded as not a factor. The one recorded tension
— adding a network-facing surface to a deny-by-default project — is answered
by the security model in §6: loopback-only, no new privilege, CSRF closed by
construction.

Consequences: remaining tabs keep `-SmokeTest` + screenshot proof until the
GUI overhaul migrates them along these rails, gaining Playwright coverage as
they land. T21's tab, already built in WinForms, replatforms first precisely
because it is the newest, smallest, and a pure policy.json round-trip with no
ConPTY involvement. OI-022's done-when ("Kyle decides, and the decision is
reflected before execution") is satisfied by this spec plus the companion
plan.

## 6. OI-020 — server, page, WebView2 swap, Playwright, CI

`gui/server.mjs` — dependency-free Node HTTP server:

- Binds **127.0.0.1 only**. Port: `--port N`, default ephemeral (`0`); prints
  one line `LISTENING <port>` to stdout that consumers parse
  (`guards-gui.ps1`, the Playwright setup, a human opening a browser).
- **No business logic.** Handlers read/validate/write through
  `kernel/settings.mjs` — exactly one module for this tab; future tabs bring
  their own module calls — preserving the invariant that the engine layer
  owns every state change.
- Security model, answering OI-022's recorded tension: a same-user local
  attacker is out of scope — they can already edit `policy.json` directly, so
  the server creates no new privilege. The genuinely new risk is web-borne
  CSRF against a localhost mutator, closed by construction: every mutating
  route requires the custom header `X-ACC: 1` (unsettable cross-origin
  without a CORS grant we never issue), `Origin`/`Host` must be localhost or
  absent, and the server emits no CORS headers, ever. GET responses carry no
  secrets (the policy kernel block only). `/security-review` gates this
  commit.

`gui/kernel.html` — plain HTML/JS in the `term.html` idiom, field-for-field
port of the WinForms kernel-settings tab. `GET /api/kernel-policy` returns the
current kernel block; `POST /api/kernel-policy` validates via
`kernel/settings.mjs` and writes atomically (reuse its mechanism; if it lacks
write-temp-rename, add it there — the canonical spot — not in the server).
Invalid input → 4xx, file untouched, visible error in the page.

`guards-gui.ps1` — the kernel tab's WinForms body is **replaced** by a
WebView2 view of the local URL (no parallel implementations). The GUI spawns
and owns the server child (start on first tab show, dispose on close). If the
WebView2 runtime is missing, the tab shows the URL and an "open in browser"
button — a fallback that is free with a web page.

Playwright — `@playwright/test` devDependency (chromium only), root
`playwright.config.mjs`, tests in `gui/e2e/kernel-settings.spec.mjs`, npm
script `e2e:gui`. Runs fully sandboxed (`ACC_ROOT`/`ACC_POLICY` + a fixture
policy.json); never against live state. Assertions, matching OI-020's
done-when verbatim:

1. Rendered field state matches the fixture (visible-state assertion).
2. Live-edit flow: change a field → save → the sandbox `policy.json` **on
   disk** changes → reload renders the new value. The file is what every hook
   re-reads per fire, so this is the "applies without restart" contract.
3. Invalid input → 4xx, file byte-identical, error visible.
4. CSRF guard: mutating request without `X-ACC` / with a foreign Origin →
   403, file untouched.

Fast tier: `gui/server.mjs` also gets hermetic unit/integration tests
(in-process server + plain `fetch`) — covgate's 100/100/90 floors apply to it,
`hooks/cmdline.mjs`, and `kernel/guardhook.mjs` as changed lib files.

CI: new ubuntu job `gui-e2e` (`npx playwright install --with-deps chromium`,
browser cache, `npm run e2e:gui`) — server and engine are portable Node, so
GUI e2e lands on the cheap Linux lane, satisfying OI-020's "remote/CI
environment". The windows-integration job keeps `-SmokeTest` and uploads a
fresh screenshot, since the WinForms window changed (AGENTS.md rule).

## 7. OI-025 and publishing

- `node kernel/kernel.e2e.mjs` runs once after slices 1-2, covering both
  kernel changes live; its stderr must be DEP0190-free (§3).
- `node e2e/loop.e2e.mjs` runs in full (5 scenarios) as the final
  verification step — Kyle chose the run over the diff-only argument. Both
  proof runs go through the launch lane and their results are recorded in the
  slice log.
- Ledger closure per repo convention (delete the OI section, add a one-liner
  under `## Resolved` with the resolving commit hash). OI-022's line cites
  this spec's path. OI-020 resolves against its done-when; OI-015 and OI-009
  are *not* claimed.
- `git push origin main`, then watch CI (all four jobs) to green. The batch
  ends only on green CI.

## 8. Sequencing

| Slice | Work | Gate before moving on |
|---|---|---|
| 1 | OI-023 spawn hardening | fast tier + covgate green; `/security-review`; commit |
| 2 | OI-024 guardhook ceilings | fast tier + covgate green; commit |
| 3 | `kernel/kernel.e2e.mjs` proof run | PASS, stderr DEP0190-free |
| 4 | GUI rails: server + page + WebView2 swap + Playwright + CI job | fast tier + covgate + `e2e:gui` green; screenshot; `/security-review`; commit |
| 5 | `e2e/loop.e2e.mjs` full run | scenarios 1-5 PASS |
| 6 | Ledger resolutions | commit |
| 7 | Push + CI | all jobs green |

Standing rules for the executing session: tests are written red-first and the
red run is recorded in the slice log; never run a hook by hand against live
state (sandbox via `ACC_ROOT`/`ACC_POLICY`/`ACC_LANE_DIR`); every real claude
spawn goes through the lane; commits follow the repo's conventional style.

## 9. Acceptance criteria → proof map

| AC | Proof |
|---|---|
| AC-1 No DEP0190-triggering call remains; injection closed by construction | `spawnSpec` invariant + hostile-matrix units; argv-fidelity integration; kernel.e2e stderr clean |
| AC-2 Hostile args are quoted or refused, never mangled | `cmdQuote` unit matrix incl. throw cases |
| AC-3 Tightened runs are denied at the shrunk toolCalls count on the very next fire | guardhook.test shrunk-count case + drift-lock |
| AC-4 Corrupt autonomy state fails closed | guardhook.test corrupt case |
| AC-5 Kernel settings tab verified by Playwright in CI: visible field state + live-edit-applies | `gui/e2e/kernel-settings.spec.mjs` in `gui-e2e` job |
| AC-6 Localhost mutator is CSRF-proof | server unit tests + Playwright 403 case |
| AC-7 Goal loop undisturbed | loop.e2e 5/5 PASS |
| AC-8 Coverage floors hold on all changed lib files | covgate green |
| AC-9 Published | origin/main updated, all CI jobs green |

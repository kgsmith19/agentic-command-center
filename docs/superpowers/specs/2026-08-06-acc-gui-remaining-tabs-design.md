# ACC GUI Web Migration — Remaining Six Sections — Design

- date: 2026-08-06
- status: approved (Kyle, tonight's `/goal` session: "I like the idea of
  making this all Web UI facing... I know there is a way to do it just spec
  it out and figure it all out")
- scope: the six WinForms sections OI-022's spec explicitly left as a
  non-goal — Protected paths, Vault, Runbox, Spending, Start Work, Terminal
- execution: this spec plus a companion research pass (full read of
  `guards-gui.ps1`'s six remaining sections, 2026-08-06) is the decision
  record; three of the six ship in code tonight (§8 sequencing), the other
  three are specified but deliberately not executed — the reasons are
  section-specific and stated where each applies, not a blanket punt
- ledger anchor: none yet filed — the remaining-tabs gap was OI-022's own
  non-goal, not an open issue; this spec is new work, not a resolution
- reference implementation: `gui/server.mjs` + `gui/kernel.html` (the
  Kernel tab, migrated per `docs/superpowers/specs/2026-08-03-acc-oi-closure-design.md`
  §5-§6) — every design decision below either follows that pattern exactly
  or states explicitly why it can't

## 1. Context

The Kernel tab proved the pattern: a loopback-only Node HTTP server with
zero business logic, an exact-match route table, plain HTML/JS pages, a
custom header for CSRF defense, and Playwright coverage on Linux CI. Six
WinForms sections remain un-migrated. A full research pass (background
agent, 2026-08-06) read every one of them in `guards-gui.ps1` end to end —
every control, every backing call, every timer, every cross-tab dependency
— so this spec is written against the actual current behavior, not a
guess. The findings split the six sections into three real tiers of
difficulty, not six equal units of work:

- **Tier 1 — mechanical.** Protected paths, Vault, Runbox. All three are
  already a thin GUI shell over one CLI, `hooks/engine.mjs`, which has
  exactly the shape `kernel/policy.mjs` had for the Kernel tab: a `status`
  read and a handful of named mutating verbs. Wrapping it in a
  `server.mjs`-style route table is close to mechanical.
- **Tier 2 — needs a new owner module first.** Spending. Unlike the other
  five, this tab has no single backing module today — it shells directly
  to `hooks/usage.mjs`, `hooks/budget.mjs`, raw `policy.json` file I/O
  (from two independent handlers, a real race), a bare stop-file touch,
  `cmd.exe` shims, and a WMI process-table scan for clearbot's running
  state. The migration work here is mostly consolidating that into one
  aggregator, not writing HTML.
- **Tier 3 — needs a new transport, and needs Windows to verify.** Start
  Work and Terminal. These two are one migration, not two: "Start work"'s
  happy path *is* opening the Terminal tab. Both depend on `PtyHost.cs`, an
  in-process C# class wrapping Windows ConPTY, talking to the page over
  WebView2's native message bridge — a channel that only exists inside a
  WebView2 host, unreachable from a plain browser tab the way every other
  migrated page is. Making these two web-native for real means moving
  ConPTY spawning behind `gui/server.mjs` (a WebSocket endpoint, or
  `server.mjs` owning a PtyHost-equivalent process and reusing the
  already-validated named-pipe protocol clearbot uses). That is a genuine
  architecture change to the one part of ACC most bound to a real Windows
  machine and a real interactive `claude` session for both authoring and
  verification — this sandbox can write the design and the server-side
  code, but "the terminal actually renders keystrokes and resizes
  correctly" is a claim only a human at a real Windows session can make
  true, per this repo's own standing rule (`AGENTS.md`, `docs/2026-08-03-full-remediation-prompt.md`'s
  own honesty section). Designed fully below (§7); not implemented tonight.

## 2. Goals and non-goals

Goals:

1. Design a single, reusable pattern for wrapping an existing CLI module
   (`hooks/engine.mjs`) as a loopback web API, proven by building it for
   real for Protected paths, Vault, and Runbox tonight.
2. Design and build a new small aggregator for the Spending tab that
   removes the two-writer `policy.json` race the research pass found, and
   replaces the WMI/cmd.exe glue with something a Node server can call
   portably.
3. Design, but explicitly do not build, the ConPTY-behind-a-server
   transport Start Work and Terminal need — state the two viable shapes,
   recommend one, and name exactly what a human with a Windows machine
   needs to verify before it can be trusted.
4. Every migrated tab keeps the Kernel tab's proof bar: hermetic fast-tier
   tests (`covgate` 100/100/90 on the new server code), a Playwright e2e
   spec asserting real state-on-disk changes, CSRF/loopback checks, and no
   parallel WinForms implementation once a tab ships (replace, don't
   duplicate — same rule OI-022's spec set).

Non-goals:

- Redesigning the visual language. Every page below is a field-for-field
  port of its WinForms tab (same labels, same button text, same grouping)
  — this is a transport migration, not a UI refresh. Kyle can ask for a
  visual pass separately once the mechanics are proven.
- Solving OI-009 (GUI-process-as-SPOF for hosted sessions) as a side
  effect. §7's transport design makes that structural fix *possible*
  later, same disclaimer OI-022's own spec carried — nothing more is
  claimed here.
- Multi-user or remote (non-loopback) access. Everything below inherits
  the Kernel tab's loopback-only, no-CORS, same-user-already-has-access
  security model unchanged.
- A native folder-picker equivalent. Two sections (Protected paths' watch-
  folder add, Start Work's work-dir browse) use WinForms'
  `FolderBrowserDialog`, which has no exact browser equivalent. §4/§7 name
  the fallback (typed path, validated server-side) rather than pretend a
  web `<input type=file>` solves it — it doesn't, browsers don't expose
  raw filesystem paths from a picker.

## 3. Shared architecture — the pattern every tier-1/2 tab follows

Extends `gui/server.mjs` rather than spawning a server per tab (one process,
one port, one `guards-gui.ps1` child to own and dispose — the Kernel tab
already established this is one server for the whole app, not one per
page):

```
PAGES = {
  "/": "kernel.html",
  "/kernel.html": "kernel.html",
  "/engine.html": "engine.html",      // Protected paths + Vault + Runbox (one page, three panels — see §4)
  "/spending.html": "spending.html",  // §5
}
```

Route shape, identical to `/api/kernel-policy`'s already-proven contract:

- `GET /api/<resource>` — read-only, returns current state as JSON. No
  `X-ACC` header required (matches Kernel's GET, which also skips it —
  reads carry no CSRF risk).
- `POST /api/<resource>` — one mutation. Requires `X-ACC: 1` header (the
  CSRF defense: unsettable cross-origin without a CORS grant this server
  never issues), `Origin`/`Host` loopback-checked same as every route
  today, body capped at 64KB, non-JSON or over-cap body → 400/refused
  before it reaches any business logic.
- Business logic lives in `.mjs` modules the server calls into, never
  inline in `server.mjs` — the same separation `kernel/policy.mjs` already
  demonstrates. For tier 1, that module is `hooks/engine.mjs` itself
  (needs export surface added — see §4). For tier 2, it's a new
  `hooks/status.mjs` (see §5).

Error convention, matching Kernel: a thrown `Error` from the business-logic
call becomes `{error: e.message}` at whatever status the route decides (400
for a validation-shaped rejection, 500 for anything else) — the page
renders `error` text inline, never a browser `alert()`.

## 4. Tier 1 — Protected paths, Vault, Runbox (`gui/engine.html`)

One page, three panels (mirrors the WinForms tab grouping exactly — these
three WERE already effectively one screen's worth of related controls in
`guards-gui.ps1`, sharing one `Refresh-State` call and one `cboFolder`
population). Backing module: `hooks/engine.mjs`.

**The one real code change needed in `hooks/engine.mjs` itself:** today
every command is only reachable via its CLI switch statement (`process.argv`
dispatch, executes at import — already the case for the module, unaffected
by anything from tonight's Phase 7 pass, which only added `ACC_ROOT`
support and tests, not an import-safe entrypoint guard the way `budget.mjs`
needed). The server needs to call these programmatically, not by shelling
out to a subprocess for every request (that would work but is slower and
loses in-process error handling). Two options:

- (a) Keep shelling out (`execFileSync("node", ["hooks/engine.mjs", ...])`
  from the route handler) — zero changes to `engine.mjs`, matches how
  `guards-gui.ps1` already calls it (`Invoke-Engine`), and the subprocess
  boundary is a feature, not a cost, here: `engine.mjs`'s own `fail()`
  calls `process.exit()`, which would kill the whole GUI server if called
  in-process.
- (b) Refactor `engine.mjs` into exported functions the CLI switch also
  calls, like `contract.mjs`/`policy.mjs` already do.

**Decision: (a).** `engine.mjs`'s commands are already a clean, tested CLI
surface (31 tests as of tonight's Phase 7 pass, real subprocess coverage)
and every command that matters here is cheap (file reads/writes, no
network, sub-50ms). Refactoring it to be import-safe is real, separate
work with its own risk (the file's `fail()`/`process.exit()` pattern is
woven through every command) that buys nothing this migration specifically
needs. The server's route handlers become a thin `execFileSync` wrapper,
parsing engine.mjs's existing stdout/stderr/exit-code contract — the exact
same contract `guards-gui.ps1`'s `Invoke-Engine`/`Invoke-EngineRaw` already
parse today, just from Node instead of PowerShell.

### 4a. Protected paths panel

| Route | Verb | engine.mjs command |
|---|---|---|
| `GET /api/engine/status` | — | `status` (also feeds Vault/Runbox panels — one call refreshes all three, matching `Refresh-State`'s existing role) |
| `POST /api/engine/secret` | `{op:"add"\|"rm", pattern}` | `secret-add <pattern>` / `secret-rm <pattern>` |
| `POST /api/engine/protected` | `{op:"add"\|"rm", path}` | `protected-add <path>` / `protected-rm <path>` |
| `POST /api/engine/project` | `{op:"add"\|"rm", path}` | `projects-add <path>` / `projects-rm <path>` |

Fields: secrets list + add-pattern input, protected-paths list +
add-path input, watched-projects list + add-folder input — each list has
its own remove button, matching the WinForms three-list layout exactly.
`btnConfig` ("Advanced: open the settings file" → Notepad) is dropped, not
replicated — a raw-file escape hatch makes less sense on a page that
already shows every field the file has; if Kyle wants raw JSON access
later it's a `GET /api/engine/status` response away in devtools regardless.

**FolderBrowserDialog replacement:** a plain text input for the folder
path (matches the pattern Kernel's own text fields already use for
anything path-shaped) plus server-side validation reusing exactly what
`engine.mjs projects-add` already checks (`existsSync` + `isDirectory`) —
the 400 response IS the validation message, no client-side path-picking
logic to write or trust.

### 4b. Vault panel

| Route | Verb | engine.mjs command |
|---|---|---|
| `GET /api/engine/status` | — | (same call, `vaultKeys` field) |
| `POST /api/engine/vault-import` | raw text body, `KEY=VALUE` lines | `vault-import` (stdin) |
| `POST /api/engine/vault-rm` | `{key}` | `vault-rm <key>` |

The one place this tab must be careful: `vault-import`'s payload is secret
values. `guards-gui.ps1` already keeps them off argv (piped via stdin);
the web route keeps the same discipline — the POST body IS the stdin
payload (piped straight into the `execFileSync` call's `input` option,
never logged, never echoed back in the JSON response — the response is
`{ok:true, imported:["KEY1","KEY2"]}`, names only, exactly like
`vaultKeys` already never carries values). No new risk versus the current
WinForms textbox: both are entered in plaintext in a loopback-only local
UI, and the security model (§3, inherited from Kernel) already treats a
same-user local attacker as out of scope — they could already read
`vault.json` on disk.

### 4c. Runbox panel

| Route | Verb | engine.mjs command |
|---|---|---|
| `GET /api/engine/runbox?trash=0\|1` | — | `list --json` / `trash-list --json` |
| `GET /api/engine/runbox/preview?ref=<label:name>` | — | direct `fs.readFileSync` (matches `guards-gui.ps1`'s own `txtPreview`, which reads the file directly rather than through engine.mjs — no command exists for "show me the contents," and adding one is unnecessary when the route can do the same safe, path-validated read: resolve against the SAME `pendingScripts`/`trashedScripts` listing the `list`/`trash-list` call already returned, refuse anything not in that list) |
| `POST /api/engine/runbox/run` | `{ref}` | `run <ref>` |
| `POST /api/engine/runbox/trash` | `{ref}` | `trash <ref>` |
| `POST /api/engine/runbox/restore` | `{ref}` | `restore <ref>` |
| `POST /api/engine/runbox/flush` | `{confirm:true}` | `flush --really` (the `confirm` field is the web equivalent of the WinForms `MessageBox` — the page's own JS shows an inline confirm state before sending it, same UX, no `window.confirm()`) |

Folder filter (`cboFolder` equivalent) is client-side filtering of the same
`GET .../runbox` response by its `label` field — no new server round-trip
per filter change, matches the WinForms behavior (the combo doesn't
re-fetch, it filters the already-loaded `$script:ReqItems`).

**Named concern the research pass flagged, carried into this spec rather
than silently dropped:** the runbox has no locking between this page and
the chat-driven `/approve` flow — both can `run`/`trash` the same script.
This is pre-existing (true today in the WinForms version too, not
introduced by the migration) and out of scope to fix here; noted so it
isn't mistaken for a new gap this spec should have closed.

`btnRFolder` ("Open folder" → Explorer) is dropped, not replicated — no
web equivalent exists (a browser cannot open a native file-manager
window), and it's a convenience action, not a required one; the preview
panel already shows the file's full content.

### 4d. Fast-tier tests, `gui/engine.test.mjs`

Mirrors `gui/server.test.mjs`'s existing shape (in-process server + `fetch`,
hermetic `ACC_ROOT`/`ACC_POLICY` sandbox — real repo state never touched):
CSRF guard (missing `X-ACC` → 403, state untouched), loopback Host/Origin
checks, each route's happy path against a fixture `config.json`/`vault.json`/
runbox fixture dir, `runbox/preview`'s ref-must-be-in-the-current-listing
check (refuses a path outside the listing, closing the one new surface
this page adds beyond what `engine.mjs`'s CLI already validates).

### 4e. Playwright, `gui/e2e/engine.spec.mjs`

Same four assertions Kernel's spec already proves, ported to this page's
three panels: rendered state matches a fixture, a live edit (add a secret
pattern) round-trips to the real file on disk and re-renders after reload,
invalid input (e.g. `protected-add` on a nonexistent path) shows an inline
error with the file untouched, and the CSRF guard blocks a request missing
`X-ACC`.

## 5. Tier 2 — Spending (`gui/spending.html`)

New module: `hooks/status.mjs` (name chosen to match the "just read the
current state" role, not `hooks/spending.mjs` — this module answers
several tabs' worth of "what's true right now" questions, spending being
the biggest one; keeping the name generic avoids a second rename fight
later if another tab needs read-aggregation).

Consolidates, in one place, everything the research pass found scattered
across `guards-gui.ps1`'s tab-4 handlers:

- `weekTier()`/cost summary — reuses `hooks/usage.mjs`'s existing
  `week`/`check` logic directly (import, not subprocess — `usage.mjs`'s
  functions are already pure/importable, unlike `budget.mjs` before
  tonight's Phase 7 fix).
- Policy dials (soft-K/hard-K/finders/amber/red/allowlist) — read via
  `loadKernelPolicy()`-equivalent for the NON-kernel policy blocks
  (`context`, `review`, `subagents`, `week`) that this tab edits; these
  live in the same `policy.json` but a different top-level key than
  `kernel` — `hooks/status.mjs` gets its own small `loadOpsPolicy()`/
  `saveOpsPolicy()` pair, same atomic tmp+rename `kernel/policy.mjs`
  already uses, replacing the WinForms tab's two independent raw
  read-modify-write handlers (`btnPolSave` and `chkAutoApprove`'s change
  handler) with ONE owner — this is the fix for the two-writer race the
  research pass flagged, not a new problem to solve differently.
- Kill switch: `POST /api/status/stop` writes `runner/stop/slice-runner.stop`
  (same bare touch-file the WinForms button already does — no CLI
  indirection needed, matches `stopRunner()`'s own mechanism in
  `hooks/budget.mjs`). `POST /api/status/unstop` → `budget.mjs unstop`.
  `POST /api/status/fanout` → `budget.mjs fanout <mins>`.
- Clearbot running-state: the WMI `Get-CimInstance Win32_Process` scan is
  Windows-specific by necessity (it's answering "is a specific process
  running," which has no portable Node equivalent without a native
  dependency) — `hooks/status.mjs` exports `clearbotStatus()` that
  shells to the exact same PowerShell one-liner `guards-gui.ps1`'s
  `Refresh-Clearbot` already runs (`Get-CimInstance ... | Where-Object
  ...`), via `execFileSync("powershell", [...])`, matching how
  `hooks/budget.mjs`'s existing `clearbot-status` CLI command already
  does this identical scan (found while reading `budget.mjs` in Phase 7 —
  this is not new surface, `hooks/status.mjs` calls the SAME logic
  `budget.mjs clearbot-status` already has, refactored to be importable
  rather than duplicated a third time). Start/stop clearbot: shells to
  `start-clearbot.cmd`/`stop-clearbot.cmd`, same as today.

| Route | Verb | Backing |
|---|---|---|
| `GET /api/status/spending` | — | week tier + cost summary (`usage.mjs`) |
| `GET /api/status/policy` | — | ops-policy dials (`status.mjs loadOpsPolicy`) |
| `POST /api/status/policy` | full dial block | `saveOpsPolicy` (validated, atomic) |
| `GET /api/status/clearbot` | — | `clearbotStatus()` |
| `POST /api/status/stop` \| `/unstop` \| `/fanout` | `{mins}` for fanout | as above |
| `POST /api/status/clearbot` | `{op:"start"\|"stop"\|"clear-now"}` | shells to the matching `.cmd`/`budget.mjs clear-now` |

**Global-status leakage, named not ignored:** the WinForms tab writes into
the outer window's header chrome (`$lblStatusAct`) when the tier goes
amber/red — a cross-tab side effect. The web equivalent: a tiny persistent
`GET /api/status/summary` (tier + one-line text) that any page's shared
header component polls independently, rather than the Spending page
reaching into another page's DOM (which isn't possible across page loads
the way it was across WinForms panels in one process). One new small piece
of shared markup/JS (a `<div id="global-status">` + a 30s poll, mirrored
on every migrated page including `engine.html`) rather than a special case.

**`btnKill`'s missing confirmation, named not silently fixed:** the
research pass found the WinForms "STOP all automated work" button has NO
confirmation dialog today, unlike delete/flush elsewhere. The web port
adds one (inline confirm, same pattern as Runbox's flush) — this is a
deliberate, small behavior improvement, called out explicitly rather than
slipped in silently, since it changes a real interaction from what
`guards-gui.ps1` does today. Flagging for Kyle rather than assuming: worth
doing, low risk, but a genuine behavior change, not a pure migration.

Fast-tier tests and Playwright spec follow the identical shape as §4d/4e,
scoped to this page's routes.

## 6. Sequencing note between tiers 1 and 2

Tier 1 ships first and stands alone — Protected paths/Vault/Runbox have no
dependency on Spending. Tier 2 depends on nothing from tier 1 either
(different backing modules entirely) but is real new-module work
(`hooks/status.mjs` doesn't exist yet) rather than a wrapper around an
existing CLI, so it costs more and carries more first-time-integration
risk. Building tier 1 first and proving the whole route/test/Playwright
pattern holds end-to-end before touching tier 2's more novel aggregator
work is the lower-risk order.

## 7. Tier 3 — Start Work + Terminal (designed, not built)

These two are one migration. "Start work"'s only real action —
the Go button — launches exactly the same ConPTY session the Terminal tab
displays; every other Start Work control (route suggestion, goal
list/done/stop, profile picker) is already ordinary CLI-backed and would
migrate exactly like tier 1 (`hooks/route.mjs`, `hooks/goal.mjs` are both
already clean, tested CLIs — wrapping their `list`/`new`/`done`/`paused`
verbs is mechanical, same pattern as §4). The hard part, and the reason
this tier is spec-only tonight, is entirely the pty.

### 7a. What's genuinely different here

Every other tab's "migration" is: take an existing CLI or file-read, put
an HTTP route in front of it, put an HTML page on top. The Terminal tab's
current implementation has no CLI or file underneath it to wrap — `Acc.PtyHost`
is a C# object living inside the SAME PROCESS as `guards-gui.ps1`, and it
talks to `gui/term.html` over WebView2's native
`postMessage`/`window.chrome.webview` bridge, a channel that literally does
not exist outside a WebView2 host. A plain Chrome tab pointed at
`term.html` would load the page and vendor JS fine, then hang forever
waiting for a bridge that was never there. This is the one tab where "make
it a web page" requires an actual new process/transport, not a rewrite of
existing glue.

### 7b. Two viable shapes, one recommendation

**Shape A — reuse the named-pipe protocol, keep PtyHost.cs.** `gui/server.mjs`
spawns the SAME `Acc.PtyHost`-hosting mechanism (a small dedicated .NET/PS1
process, or PtyHost.cs invoked headlessly) and opens a WebSocket route
(`ws://127.0.0.1:<port>/pty/<sessionId>`) that proxies frames to/from the
pty over the EXACT `TEXT`/`TEXTB64`/`SUBMIT`/`ESC`/output-line protocol
`ServePipe`/clearbot already use today, already validated (control-char
and 2100-char payload checks, DACL-restricted to the current user SID —
Phase 6 of tonight's remediation work hardened this exact pipe). Upside:
zero new native code, reuses a protocol this repo has already exercised in
production. Downside: still needs a Windows process hosting ConPTY
somewhere — this doesn't remove the Windows dependency, it just moves the
transport from WebView2-bridge to WebSocket.

**Shape B — replace PtyHost.cs with a Node ConPTY package
(`node-pty` or equivalent) as a child of `gui/server.mjs` itself.** Upside:
one language/process model for the whole server, no C#/Add-Type dependency
at all, WebSocket is `node-pty`'s natural output shape. Downside: a real
rewrite of working, hardened code (`PtyHost.cs` just received two Phase-6
fixes tonight: pipe DACL restriction, tree-kill correctness) for a package
this session has no way to vet on Windows, replacing something proven with
something unproven, for a migration that's about TRANSPORT, not about
whether C# or Node hosts the pty.

**Recommendation: Shape A.** Lower risk, reuses hardened code, and the
actual goal (a browser-reachable terminal) is satisfied by the WebSocket
layer regardless of which process holds the pty underneath it. Shape B is
worth reconsidering later specifically if PtyHost.cs's WinForms-specific
pieces (the WebView2 message-bridge callback, the Win32 ancestor-walk
watchdog it shares with the Go-button launch path) turn out to be more
entangled with the rest of `guards-gui.ps1` than a clean extraction allows
— that's a real risk this spec can't fully retire without reading
`PtyHost.cs` change-by-change against that specific question, which is
its own follow-up, not blocking the decision above.

### 7c. What a human on Windows needs to verify before trusting this

Per this repo's own standing rule: a Windows-gated claim is only true once
someone actually runs it, never from a diff review alone. Concretely, once
Shape A is built:

1. A browser tab (not WebView2) opens `http://127.0.0.1:<port>/term.html`,
   connects the WebSocket, and a real `claude` TUI renders — colors,
   spinner, slash-menu — identically to today's WebView2 rendering.
2. Typing, resize (drag the browser window), and the deck buttons (`Esc`,
   `Ctrl+C`, `/clear`, `/compact`) all still work through the new
   WebSocket path exactly as they do through the current in-process
   `WriteText` calls.
3. The existing named-pipe clients (clearbot) still work unmodified
   against whatever process now hosts `ServePipe` — the protocol doesn't
   change, only who's driving it needs re-verifying end to end.
4. Closing the browser tab (vs. closing the WinForms window today) cleanly
   tears down the child process — the current `Dispose()`/`Kill()` lifecycle
   is tied to WinForms' `FormClosed` event, which a browser tab closing
   does not fire; the WebSocket's own `close` event needs to take over that
   responsibility, and only a real close-and-check-the-process-list test
   proves it does.

None of this can be authored-and-trusted from this sandbox — it can be
authored, and was reasoned through above, but not verified, which is the
whole reason this tier stays spec-only tonight rather than shipped
unverified the way `PtyHost.cs`'s earlier Phase-6 fixes were explicitly
flagged as "not verified on Windows" too.

## 8. Sequencing (what ships tonight vs. what doesn't)

1. **Tonight:** §4 (Protected paths, Vault, Runbox) — `gui/engine.html`,
   `gui/server.mjs` route additions, `gui/engineClient.mjs`,
   `gui/engineClient.test.mjs`, `gui/e2e/engine.spec.mjs`. Shipped commit
   3c482cb, red-first throughout, all Playwright specs verified against a
   real Chromium (not just fetch()-level fast-tier tests). **What did NOT
   ship tonight, named rather than silently left**: `guards-gui.ps1` itself
   still shows the old WinForms bodies for these three tabs — the spec's
   own §9 acceptance criterion "no parallel WinForms implementation
   survives a tab's migration" is NOT yet met. Wiring `guards-gui.ps1` to
   host `gui/engine.html` the same way `Ensure-KernelWeb` already hosts
   `kernel.html` (§3's reference pattern) is mechanically straightforward —
   but removing the old WinForms controls safely means also touching every
   other place in this 1600-line file that references them
   (`lstSecrets`/`lstProt`/`lstProj`/`lstRunbox`/`cboFolder`/`txtPreview`
   and friends appear in `Refresh-State`, tab-switch handlers, the
   `-SmokeTest` diagnostic line, and more not yet fully read). This session
   has no PowerShell interpreter at all — not even for a syntax check —
   and a mistake in a file this tightly coupled could break the tool Kyle
   actually uses daily. Same judgment call already made for Phase 0 and
   Phase 5 step 2 tonight: authored and tested everything that's
   verifiable from here (the server, the API, the page, the browser-level
   e2e proof), left the Windows-only wiring step for a session with a real
   PowerShell/WinForms environment to do AND verify in one pass, rather
   than shipping an edit to load-bearing code blind.
2. **Tonight, if context allows after (1):** §5 (Spending) —
   `hooks/status.mjs`, `gui/spending.html`, route additions, tests, spec.
   **Shipped** (separate follow-up session, same night): `hooks/status.mjs`
   (spendingSummary/loadOpsPolicy/saveOpsPolicy/clearbotStatus/stopRunnerNow/
   unstopRunner/fanout/clearbotOp), `gui/spending.html`, `gui/server.mjs`
   route additions (`/api/status/*`), fast-tier tests
   (`hooks/status.test.mjs`, `gui/server.test.mjs` additions), and
   `gui/e2e/spending.spec.mjs` (4 specs, verified against real Chromium).
   The two-writer `policy.json` race this section called out is closed —
   `saveOpsPolicy` is the one owner, same atomic tmp+rename discipline
   `kernel/policy.mjs`'s `saveKernelPolicy` already uses for the sibling
   `kernel` block. `btnKill`'s missing confirmation (named above) is added
   as a real, deliberate behavior change: two clicks required, same inline-
   confirm pattern the Runbox tab's flush button already uses. **What did
   NOT ship, named rather than silently left**: same as §4's own honesty
   note — `guards-gui.ps1` itself still shows the old WinForms Spending tab;
   wiring it to host `gui/spending.html` needs a real PowerShell
   environment, same reasoning as tier 1's own deferred wiring step. Also
   **Shipped** (separate follow-up, same night): the shared
   `<div id="global-status">` header widget — `GET /api/status/summary`
   (`hooks/status.mjs`'s `globalStatusSummary()`, same `weekTier()` math
   `spendingSummary()` already uses), mirrored on all three migrated pages
   (`kernel.html`, `engine.html`, `spending.html`) with a 30s poll, tests
   for green/amber/red text in `hooks/status.test.mjs`, an HTTP contract
   test in `gui/server.test.mjs`, and an e2e proof on `kernel.html`
   specifically (a page with nothing to do with spending, showing the
   widget is genuinely independent) in `gui/e2e/kernel-settings.spec.mjs`.
3. **Not tonight, spec only:** §7 (Start Work's launch action + Terminal).
   Everything in Start Work THAT ISN'T the launch action (route
   suggestion, goal list/done/stop, profile picker) is tier-1-shaped and
   could ship alongside (1)/(2) if time allows — noted here as a possible
   tonight item, separate from the launch/Terminal work which explicitly
   is not.

## 9. Acceptance criteria → proof map

| AC | Proof |
|---|---|
| Every tier-1/2 route requires `X-ACC` on mutation, rejects foreign Origin/Host | `gui/engine.test.mjs`, `gui/spending.test.mjs` — CSRF/loopback tests, same shape as `gui/server.test.mjs`'s existing ones |
| A live edit round-trips to the real file/state and survives reload | Playwright specs, assertion 2 (§4e), same shape as `kernel-settings.spec.mjs` |
| Invalid input refused, state untouched, error visible inline | Playwright specs, assertion 3; fast-tier tests, validation-rejection cases |
| No parallel WinForms implementation survives a tab's migration | `guards-gui.ps1` diff for that tab's PR — replace, not duplicate, matching OI-022's own rule |
| covgate 100/100/90 on every new/changed lib file | `node hooks/covgate.mjs` run as part of each tab's own commit, same as every other change tonight |
| Spending's two-writer `policy.json` race is actually gone | `hooks/status.mjs`'s test: two rapid `saveOpsPolicy` calls never interleave a torn write (same class of test `kernel/policy.mjs`'s save-path already has) |
| Terminal/Start-Work transport (§7) is NOT claimed working | This spec ships with no `gui/term.html` changes, no `PtyHost.cs` changes, no WebSocket route — the absence itself is the proof nothing here was claimed done without verification |

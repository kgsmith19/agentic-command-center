# Machine-Wide Claude Launch Cap — Design

- date: 2026-08-03
- status: approved (brainstorming session, Kyle 2026-08-03)
- scope: enforce a hard, machine-wide ceiling on concurrent `claude.exe`
  processes, regardless of launch path (manual terminal, GUI, runner,
  kernel adapter, e2e harness)
- supersedes: OPEN-ISSUES.md OI-016 (decided 2026-08-02 not to shim `claude`
  on PATH; explicit revisit trigger fired 2026-08-03 — see OI-016's
  superseded entry for the incident)
- new ledger entry opened alongside this design: OI-026 ("goal" terminology
  collides with the popular Claude Code Goal plugin — documented, not
  designed, per Kyle's instruction to dig into the rename later)

## 1. Context

`node e2e/loop.e2e.mjs` (5-scenario real-token proof suite) failed 4/5
scenarios on timeouts waiting for console/transcript/pty events. At the same
moment, `tasklist` showed 9 concurrent `claude.exe` processes on the machine.
`policy.json`'s `lane.slots`/`lane.interactive.slots` only serialize launches
that go through `hooks/lane.mjs` — `runner/runner.mjs` (`withLaunchSlot`),
`kernel/adapters/claude-code.mjs` (`acquireSlot`), `e2e/loop.e2e.mjs`
(`withLaunchSlot`, scenarios already self-serialize one at a time), and
`guards-gui.ps1`'s Go button / Terminal tab (`Enter-InteractiveLane`). Lane
enforcement is 100% cooperative — `lane.mjs` never consults the live process
table (`process.kill(pid, 0)` only checks a specific recorded PID's
liveness). A bare `claude` typed into any terminal acquires no slot at all
and is fully invisible to it. Kyle's requirement (verbatim): "We can't have
it be possible to have 9 concurrent claude.exe at once... it needs to have a
hard limit that is less than half of that. We can't go anywhere near nine."

The e2e suite's own scenarios do not spawn concurrent claude processes
themselves (confirmed serialized in Explore's topology pass); the failure
mode was other unrelated concurrent sessions stealing the single automation
slot's real-world timing budget. Fixing the machine-wide gap is expected to
fix this transitively — no change to `e2e/loop.e2e.mjs` itself is in scope.

## 2. Goals and non-goals

Goals:

1. A real ceiling on total concurrent `claude.exe` processes on the machine,
   enforced independently of how each one is launched — not another
   opt-in slot that only well-behaved code respects.
2. Default cap of 3, configurable via `policy.json` alongside the existing
   `lane.slots`/`lane.interactive.slots` dials, not hardcoded.
3. Fail-open by construction: a bug in the enforcement code must not be able
   to lock Kyle out of his own `claude` usage.
4. Detection of both a live breach (something got past the gate) and a
   silently-dropped gate (shim missing from PATH), independent of the gate
   itself, so a fail-open bug doesn't go unnoticed indefinitely.
5. At-cap manual launches refuse immediately and print who holds the
   machine (PID / age / lane label where known) — no blocking/waiting, no
   surprise later auto-start.

Non-goals:

- No change to `e2e/loop.e2e.mjs` scenario logic (see Context — the gap is
  machine-wide, not in the suite's own serialization).
- No renaming of `hooks/goal.mjs` / the `/goal` skill (OI-026 logs the
  naming collision for a future dedicated pass; not designed here).
- No killing of live processes to enforce the cap. The watcher is
  alert-only; nothing in this design terminates a running `claude.exe`.
- Counting is scoped to the configured executable path(s) only. The
  Claude desktop app's bundled processes
  (`WindowsApps\Claude_...\app\claude.exe`) are a different binary at a
  different path and are not counted or affected.

## 3. Architecture

Two independent layers sharing only `policy.json` as data:

```
manual terminal ─┐                                       ┌──────────────────┐
GUI Go/PTY tab ──┤   PATH resolves "claude"              │  claude.exe pool │
runner/kernel ───┼─► C:\code\guards\shim\claude.cmd ──►  │  (counted by     │
e2e wrapper ─────┘   │ node hooks/lane.mjs gate          │  exe path only)  │
                     │  ├─ headroom → exec real exe ──►  └──────────────────┘
                     │  └─ at cap  → refuse, exit 42              ▲
                                                                  │ CIM poll (60s)
                     watcher/claude-cap-watch.ps1  ───────────────┘
                     (standalone scheduled task: alerts only,
                      also checks whether the shim is still live)
```

**Layer 1 — the gate (preventive).** `C:\code\guards\shim\` is prepended to
the user PATH ahead of `C:\Users\kyleg\.local\bin` (today's `claude`
resolution — confirmed via `where.exe claude`). It holds a generated
`claude.cmd` (cmd/PowerShell resolution) and an extensionless `claude`
POSIX shell script (Git Bash), both with the real exe's absolute path baked
in at install time. Contract: run `node hooks\lane.mjs gate -- %*`; if and
only if its exit code is exactly `42`, exit 42 without launching; on any
other outcome (0, a gate crash, `node` missing entirely) fall through and
exec the real `claude.exe %*`. The gate process exits before the real
`claude` starts — nothing sits between the terminal and `claude.exe` at
runtime, so TUI behavior, signal handling, and exit codes are unaffected by
this design once a session is running.

The `gate` verb is a new CLI verb on the existing `hooks/lane.mjs` (adds to
its current `try-acquire`/`reown`/`release` verbs rather than introducing a
new module). Decision order:

1. Utility invocations (`--version`, `--help`, `doctor`, `update`,
   `install`, `mcp`, and any other non-session subcommand) pass through
   immediately without counting.
2. Read the cap via the existing hot-read `laneConfig()` (already re-reads
   `policy.json` on every call — no caching to invalidate).
3. Count live processes via a PowerShell CIM query (`Get-CimInstance
   Win32_Process`) filtered to the configured executable path(s) —
   matched by path, never by image name, so the desktop app is invisible to
   the count.
4. At or over cap: print the holder list (PID, start time, lane label where
   the PID matches an `acc-lane/owner.json` record) and exit 42. Under cap:
   exit 0.

**Layer 2 — the watcher (detective).** `watcher/claude-cap-watch.ps1`,
registered as a per-user Scheduled Task at logon, polling every 60s.
Standalone by rule — imports no repo code, reads exactly two inputs:
`policy.json` (data) and the live CIM process table. It alerts (Windows
toast + an append-only breach log, debounced to one alert per episode) on:

- **Breach** — path-counted `claude.exe` count exceeds the configured cap
  (something got past the gate: a race, or a bypass).
- **Silent fail-open** — the shim directory is missing from PATH, `claude.cmd`
  is missing from the shim directory, or the configured real-exe path no
  longer exists.

It never kills a process. It has no code-level dependency on `hooks/lane.mjs`
or the shim, so a bug in either layer cannot also break the layer meant to
detect that bug.

**Shared config** (`policy.json`, extends the existing `lane` block, does
not touch `lane.slots`/`lane.interactive.slots`):

```json
"lane": {
  "slots": 1,
  "interactive": { "slots": 1 },
  "total": {
    "cap": 3,
    "exe": ["C:\\Users\\kyleg\\.local\\bin\\claude.exe"]
  }
}
```

`cap: 0` is a deliberate, supported lockdown value (refuses all session
launches). `exe` is an array so a second counted binary is a config change,
not a code change. Both the gate and the watcher read `lane.total` from the
same `policy.json` — a cross-check test (below) asserts they agree on cap
and exe-path semantics so the two layers cannot silently drift apart.

## 4. Data flow

**Manual terminal at cap:** `claude` → PATH → `shim\claude.cmd` → `node
hooks/lane.mjs gate` → CIM count ≥ `lane.total.cap` → holder list printed to
stderr → exit 42 → `.cmd` exits 42, real `claude.exe` never execs.

**Cooperative call sites** (`runner.mjs:107` `spawnSpec("claude", ...)`,
`claude-code.mjs:65` `spawnSpec("claude", ...)`, `e2e/loop.e2e.mjs:115`'s
generated wrapper invoking bare `claude`, and `guards-gui.ps1`'s two spawn
points — the direct `cmd.exe /k claude` `ProcessStartInfo` at ~:1171 and the
`Get-Command claude`-resolved absolute path handed to the ConPTY host at
~:1427, both reached after `Enter-InteractiveLane` acquires its slot):
every one of these resolves `"claude"` via PATH (directly, through
`cmd.exe /c`, or through `Get-Command`), so every one already passes through
the shim like any other launch — no double-counting, since the gate counts
live processes, not lane slots, and a process that never started was never
counted. This depends on the shim directory being ordered ahead of the
existing PATH entry (§7 Rollout) so `Get-Command`/PATH resolution finds
`shim\claude.cmd` first. No code change is required in these call sites for
cap enforcement to apply to them; they inherit it for free via the shim. (If
in practice the refusal UX at these call sites is too abrupt
post-implementation — e.g. a runner job hard-failing instead of retrying —
that is a follow-up tuning issue, not part of this design's done-when.)

**Race window (accepted risk):** the gate is check-then-launch, not
check-and-reserve — two near-simultaneous manual invocations could both
observe under-cap and both launch, momentarily exceeding the cap by a small
margin before the next poll. No cross-process lock is added for this,
deliberately: human-typed launches are not high-frequency enough to make
this likely, the automation/interactive paths that *do* launch
programmatically already serialize through `lane.mjs`'s existing lock-based
slots before ever reaching the shim, and the watcher's breach alert (§3
Layer 2) catches the momentary overshoot if it happens. Adding locking here
would be complexity the actual risk doesn't justify.

## 5. Error handling

- Gate crash, timeout, or `node` missing (`ENOENT`/9009) → shim falls
  through → fail-open, per Goal 3.
- CIM query itself failing (e.g. WMI service down) inside the gate → caught,
  treated as a gate error → fail-open. Deliberately NOT cross-logged into the
  watcher's log file — that would be exactly the code-level coupling §3
  Layer 2 rules out (a bug in one layer must not also break the layer meant
  to detect it). A persistent CIM outage still becomes visible on its own:
  the watcher runs its own independent `Get-CimInstance` call every poll,
  uncaught by design, so the same outage shows up as failed runs in Task
  Scheduler's history — the audit trail for watcher failures per this
  section's next bullet.
- Watcher failing to run (task disabled, host crashed) has no user-facing
  effect by design (alert-only) — Task Scheduler's own run history is the
  audit trail.

## 6. Testing

- `hooks/lane.test.mjs`: new cases for the `gate` verb — under cap → exit 0;
  at cap → exit 42 with correct holder-list output; utility subcommands
  bypass counting; CIM-failure path → fail-open (exit 0). Existing
  `try-acquire`/`reown`/`release` tests untouched.
- Shim integration test (PowerShell, following the existing `gui/*.ps1` test
  pattern): asserts `claude.cmd` exits 42 without exec'ing when the gate
  returns 42, and exec's the real path on any other gate outcome (including
  a simulated gate crash).
- Watcher unit test: the watcher's decision logic (breach / fail-open /
  quiet) is a pure function taking a process list + config, tested with the
  CIM call mocked — no live Scheduled Task test.
- Cross-check test: gate and watcher parse the same `policy.json` fixture
  and agree on the effective cap and exe-path list.
- Coverage floors (100% lines/funcs, 90% branches on changed files, per
  `hooks/covgate.mjs`) apply to the new `gate` verb code in `hooks/lane.mjs`
  and to the watcher's decision function.

## 7. Rollout

Install step (part of the implementation plan, not a manual one-off):
generate `shim/claude.cmd` and `shim/claude` from the resolved real-exe path
(`where.exe claude` today: `C:\Users\kyleg\.local\bin\claude.exe`), prepend
`C:\code\guards\shim` to the user PATH ahead of the existing entry, and
register the watcher Scheduled Task. All of this is scripted, not a
click-through — consistent with this repo's runbox/approve convention for
anything that changes machine state outside the repo itself.

## 8. Open follow-ups (not in scope here)

- If a launch vector emerges that bypasses the shim entirely (e.g. a tool
  that calls `CreateProcess` with the resolved absolute exe path, never
  touching PATH), the watcher will still catch it as an unexplained breach,
  but the gate cannot prevent it. No such vector is currently known; if one
  is found, it gets its own OI per this repo's "log what you don't fix"
  rule.
- Tuning the refusal UX at cooperative call sites (runner/kernel/e2e) once
  the gate is live in practice — see §4 note.

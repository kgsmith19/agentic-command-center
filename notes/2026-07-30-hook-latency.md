# Hook latency pass — measurements and fixes (2026-07-30)

Level: **implementation detail for `C:\code\guards`.** Records what was measured
and changed on the hook critical path. The standing statement of what the hooks
do is `AGENTS.md`; open work is `C:\code\OPEN-ISSUES.md`. Read this only when
you need the numbers or the reasoning behind the two changes below.

## Measured, before

| Hook / path | Event | Measured |
|---|---|---|
| `budget.mjs` | SessionStart | **11.0 s** (10 s configured timeout — failing every start) |
| `winfind.ps1 -FromPid` | (inside SessionStart) | **11.0 s** — the entire cost |
| `usage.mjs check` (2 full scans) | tier / statusline | 660 ms cold |
| `budget.mjs` | PostToolUse | 117–152 ms |
| `route.mjs` | UserPromptSubmit | 113–126 ms |
| `prompt_optimizer.py` | UserPromptSubmit | 136–149 ms warm |
| bare `py -c pass` | — | 92 ms |

Transcript tree at time of measurement: 110 MB across 205 `.jsonl` files.

## Finding 1 — the SessionStart cost was NOT the transcript scan

The ledger attributed SessionStart's 5.9 s median to the usage scan. It was not.
`winfind.ps1 -FromPid` accounted for the full 11.0 s on its own; suppressing the
clearbot spawn changed nothing (10.9 s), and the scan is well under a second.

Cause: one `Get-CimInstance Win32_Process -Filter "ProcessId=$cur"` per hop (up
to 12) plus one more per candidate. Each WMI round trip costs several hundred ms.

Fix: a single `-Property`-narrowed `Get-CimInstance`, indexed into `$byPid` and
`$byParent` hashtables, walked in memory. **11.0 s → 1.6 s**, byte-identical
output on the same process chain.

The window-finding half (`Add-Type` + `EnumWindows`, ~1.4 s of the remaining
1.6 s) was deliberately NOT touched. Its comment documents why
`MainWindowHandle` is insufficient, and getting it wrong means typing keystrokes
into explorer.exe. Not worth 1.4 s.

Side benefit: the process snapshot is taken once, so a process exiting mid-walk
can no longer change the chain halfway through.

## Finding 2 — the scan was still worth caching

`usage.mjs` re-parsed all 110 MB on every fire. The 10-minute `tier.json` cache
in `budget.mjs` masked this rather than removing it, and a session start almost
always lands after it expires.

Fix: per-file aggregate cache at `runner/state/scan-cache.json`, keyed on
`(size, mtime)` — transcripts are append-only, so an unchanged file reuses its
aggregate. Aggregates are bucketed by UTC hour so any `since` window is
recomposed by summing buckets at or after it.

**660 ms cold → ~110 ms warm** for two full scans.

Tradeoff, deliberate: `since` is floored to its own hour, so the window is at
most one hour over-inclusive. Against a 1.8 B-token weekly threshold that is
noise, it never under-reports (the direction that would delay the tier and cost
money), and it holds the number steady within the hour instead of drifting on
every fire. `usage.test.mjs` pins both directions.

Cache invalidates wholesale on a rates change; a corrupt file is rebuilt; entries
for deleted transcripts are pruned on each full scan.

## Verification

- `node --test hooks/usage.test.mjs` — 9/9 pass (new)
- `node --test hooks/route.test.mjs` — 20/20 pass (regression, unchanged)
- `node hooks/usage.mjs check` warm and cold agree exactly: `weekTokens 190522090`
- `budget.mjs` SessionStart: 1.57–1.64 s over three runs, vs a 10 s timeout

## Not addressed here

- `prompt_optimizer.py` runs 140 ms warm, so its two recorded 13.5 s `timedOut`
  entries are environmental (cold interpreter / scanner contention), not its
  logic. Left open pending a week of observation — see OI-005.
- `security-guidance` plugin hook (~1.8 s, PostToolUse + Stop) — OI-006,
  plugin-owned, still a decision rather than a patch.
- `runner/state/` is polluted with ~60 `t*.route` files left behind by
  `route.test.mjs`. Logged as OI-009.

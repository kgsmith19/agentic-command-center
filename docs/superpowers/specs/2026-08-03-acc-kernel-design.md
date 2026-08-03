# ACC Reliability Kernel — Design

Date: 2026-08-03 · Branch: `acc-embedded-terminal` · Status: approved by Kyle (interactive brainstorm, this date)
Implementer: **Sonnet**, in a fresh session via `superpowers:executing-plans`, after Kyle switches models. This spec plus the paired implementation plan must therefore be self-sufficient — no facts live only in the brainstorm conversation.

## 1. Objective

A lean kernel that runs exactly one AI coding harness at a time (Claude Code today, swappable later), enforces permissions the harness cannot bypass at the process level, verifies each task's real end-state independently of the harness's self-report, records every run in one structured ledger, and tightens autonomy automatically after failures.

Source protocol: Kyle's "ACC KERNEL IMPLEMENTATION AND EXECUTION PROTOCOL" (2026-08-03 prompt). This spec is its §14 planning output, items 1–2 and 4; the paired implementation plan carries item 3 in full.

## 2. Decisions made (with Kyle, 2026-08-03)

1. **Headless-first adapter.** Kernel v1 wraps the `claude -p` spawn path only. The interactive ConPTY/goal-loop path is untouched and adopts the kernel in a later effort.
2. **Process-level guard depth, all tools.** Kernel-generated per-task settings register a guardhook on every tool including Bash; deny by default. OS-level sandboxing is a named non-goal.
3. **Full GUI settings tab in this effort** for the `policy.json kernel` block — typed controls, edits apply live. This is a conscious, policy-editor-only override of the protocol's §3 UI exclusion; ledger *presentation* stays out of scope.
4. **Credentials: scope at injection.** Contract lists usable vault key names; revocation = loss of local access (process death + sweep), honestly documented — third-party keys cannot be invalidated server-side from here.
5. **Approach A:** new `kernel/` directory of thin modules orchestrating existing machinery (runner spawn path, lane, usage.mjs, vault, fake-claude test seam). No refactor-in-place, no separate package.

## 3. Repository fit (protocol §14.1)

None of the six components exist as first-class modules today. Raw material reused:

| Component | New module | Reuses |
|---|---|---|
| 6.1 Adapter | `kernel/adapter.mjs`, `kernel/adapters/claude-code.mjs` | `runner/runner.mjs` spawn/timeout/`killTree`; `hooks/lane.mjs` `withLaunchSlot`; fake-claude seam from `runner/runner.test.mjs` |
| 6.2 Contract | `kernel/contract.mjs` | — (nothing exists) |
| 6.3 Guards | `kernel/guardhook.mjs` | `hooks/guard.mjs` unchanged (interactive sessions); `hooks/engine.mjs` vault |
| 6.4 Verifier | `kernel/verifier.mjs` | git/fs/`node --test` as read paths |
| 6.5 Ledger | `kernel/ledger.mjs` | data dir `runner/ledger/` beside existing state dirs |
| 6.6 Autonomy | `kernel/autonomy.mjs` | token cost via `hooks/usage.mjs` |
| Orchestrator | `kernel/run.mjs` (CLI: `node kernel/run.mjs <contract.json>`) | — |
| Dials | `policy.json` new `kernel` block (single-source-dials rule preserved) | Process-tab live-edit pattern |
| GUI | new kernel-settings tab in `guards-gui.ps1` | existing list/dial plumbing, `-SmokeTest`, screenshot check |

Existing behavior that already satisfies kernel requirements, not rebuilt:

- **One harness at a time:** every automated spawn goes through the lane (`policy.json lane.slots`, default 1). The kernel always launches through `withLaunchSlot`.
- **Kernel code tamper-protection from agent tools:** `hooks/guard.mjs` self-protection blocks Edit/Write to the guards repo. The kernel guardhook adds the Bash-side denies (§6 below).
- **Transport-only retries:** `retryTransport` in the lane; logic failures never retried.

## 4. Run lifecycle

```
node kernel/run.mjs <contract.json>
  → validate contract            (incomplete → refuse, exit non-zero, nothing launched)
  → generate per-task settings   (guardhook on all tools, deny-by-default backstop) + SHA-256 pin
  → ledger: append run_started   (contract verbatim, generated-settings hash)
  → adapter probe                (claude --version → identity; unavailable → failed-to-start, fail closed)
  → launch via lane              (claude -p --output-format stream-json --settings <generated>,
                                  contract-listed vault keys injected into child env only)
  → during run:
      guardhook: evaluate every tool call (contract allowedActions ∪ live policy),
                 append EVERY decision to runner/ledger/<runId>.decisions.jsonl,
                 count tool calls, verify settings hash each fire,
                 deny on: no match, always-deny paths, pinned paths, ceiling breach, unreadable input
      kernel:    wall-clock timer, token accumulation from stream-json usage,
                 milestone checkpoint at 20-minute marks (budget remaining + activity; stall → stop)
  → end (exit | stop_task | abort): sweep kernel-staged credential material
  → verifier: score every acceptance criterion pass/fail/unknown (kernel process, harness dead)
  → ledger: append run_finalized (outcome, per-criterion results, counts, cost, wall-clock)
  → autonomy: update rolling window; adjust ceilings if threshold crossed; log adjustment
```

Adapter interface (every harness must implement): `start_task(contract)`, `send_step(input)` (claude-code: `--resume <sessionId> -p`), `read_state()` (parsed stream-json; never treated as verification), `stop_task()` (killTree, confirm exit). Harness selection: `policy.json kernel.harness` resolves to one module in `kernel/adapters/`. No file outside `kernel/adapters/` may reference a harness-specific API or binary name (statically tested).

**Testability invariant:** every kernel state path resolves through `ACC_ROOT`, policy through `ACC_POLICY`, lane through `ACC_LANE_DIR` — same seams the existing suites use; all fast-tier tests are hermetic and sandboxed.

## 5. Contract schema

Required fields (missing any → refuse to start): `goal`, `constraints`, `allowedActions`, `budget`, `acceptanceCriteria` (non-empty EARS list, each entry with a `verify` block), `rollbackPlan`.

`allowedActions` is typed: `readRoots`, `writeRoots`, `bashPatterns` (prefix match), `networkHosts` (WebFetch/WebSearch), `vaultKeys` (names), `subagents` (types). Optional `pinnedPaths`: write-denied for the whole run — pin the acceptance-test files so the harness can satisfy them but not rewrite them.

Rejected at validation, before anything launches: empty/verify-less acceptance criteria; `writeRoots` overlapping protected paths (guards repo, any `.claude` settings, vault); budget above policy hard caps (240 min wall-clock).

Effective ceiling per dimension = `min(contract value if set else policy default, policy hard cap) × active tightening factor`.

## 6. Security model

- **Default deny, all tools.** Guardhook is registered only in the generated per-task settings — interactive sessions are untouched. Contract `allowedActions` ∪ live `policy.json kernel` allows; everything else denied with reason. Every decision (allow and deny) appended to the run's decision sidecar.
- **Always-denies** (shipped in policy defaults, apply regardless of contract): writes to `.claude/settings*` and hook files, the guards repo (kernel code, ledger data, `policy.json`, `vault.json`), and the generated settings file. Contract validation independently rejects overlapping `writeRoots`. Invariant: the harness can never widen or edit what constrains it.
- **Config integrity.** Generated settings SHA-256-pinned at generation; verified before launch (mismatch → refuse to launch) and on every guardhook fire (mid-run mismatch → deny everything, flag run). The malicious-config test must be real (tampered file on disk), not mocked.
- **Live policy.** Guardhook re-reads `policy.json` on every fire; GUI edits apply on the next tool call, mid-run, no restart. Decisions are never frozen into the generated file — it only wires the hook in and pins integrity.
- **Credentials.** Contract-listed vault keys go into the child process env only; nothing kernel-staged on disk. Revocation = task end (process death + sweep) or TTL: `min(contract wall-clock budget, 240 min)` — budget enforcement doubles as the credential lifetime bound. `engine.mjs apply` invocations are allowed only for contract-listed key names. Ledger holds key names only; an integration test with a seeded fake vault asserts no value ever appears in any ledger file.
- **Idempotency** covers kernel-mediated mutations — ledger appends, autonomy adjustments, stop actions — keyed by runId + sequence (or param hash), so lane retries and resumes apply effects exactly once. The harness's own Bash side effects cannot be made idempotent by the kernel; stated plainly, not papered over.
- **Fail closed, uniformly:** unreadable contract/policy/settings refuses to start; a guardhook that cannot read/parse its inputs denies; a kernel crash leaves a `run_started` line with no `run_finalized` (visible by construction).
- **Honest ceilings (documented, accepted):** an *allowed* Bash command can still misbehave within its allowance; network denial for Bash-initiated traffic is pattern-based, not a firewall; this is a deterministic process-level boundary, not an OS sandbox.

## 7. Verifier

Runs in the kernel process only after the harness process has exited; reads fs/git directly; never derives a result from harness output. v1 verify methods — exactly the types v1 contracts use, one handler each:

- `command` — spawn, pass = exit 0 (e.g. the fast-tier test command)
- `file_exists` — path present
- `file_contains` — path + pattern
- `git_clean` — working tree clean

Unrecognized method → `unknown`. Every criterion scored individually; **any fail or unknown → run rejected**. This forces contracts to be written verifiably. Gaming-resistance: pin acceptance-test files via `pinnedPaths` (§5, §6).

## 8. Ledger

Append-only `runner/ledger/runs.jsonl`:

- `run_started` line at launch: runId, timestamps, contract **verbatim**, generated-settings hash.
- `run_finalized` line at close: outcome (`accepted` | `rejected` | `aborted-by-budget` (+ breached dimension) | `failed-to-start`), harness identity + version, per-criterion verifier results, tool-call and deny counts, decision-sidecar reference, token cost (usage.mjs), wall-clock.
- Started-without-finalized = interrupted run; the query CLI reports it as such. The started+finalized pair is the complete record; appends are idempotent (runId-keyed).

Guard decisions stream to `runner/ledger/<runId>.decisions.jsonl`, written by the guardhook during the run. Autonomy state at `runner/ledger/autonomy.json`.

Query CLI: `node kernel/ledger.mjs query --status <s> --harness <h> --since <date> --until <date>` → JSONL or table. No dashboard.

## 9. Autonomy budget — concrete numbers (all defaults in `policy.json kernel`, all GUI-editable)

| Dial | Default | Hard cap |
|---|---|---|
| Wall-clock per run | 60 min | 240 min (= credential TTL) |
| Tool calls per run | 200 | — |
| Token cost per run | 500k | — |
| Rolling window | last 10 finalized runs | — |
| Tightening trigger | ≥ 30% of window rejected | — |
| Tightening action | all ceilings × 0.5 for next 5 runs | — |
| Restore | automatic when window back under threshold after those 5 | — |
| Milestone checkpoint | every 20 min: budget remaining AND activity; zero tool calls in interval = stall → stop | — |

Enforcement points: tool calls counted and denied by the guardhook; wall-clock by kernel timer; tokens from stream-json usage accumulation. Breach → `stop_task` → `aborted-by-budget`. Every adjustment logged with trigger reason and window contents. Checkpoints are automated re-evaluation, never a human interrupt.

## 10. GUI: kernel settings tab

A dedicated tab in `guards-gui.ps1` with typed controls for every `policy.json kernel` field — numerics as number fields, lists as list editors, booleans as checkboxes. Saves write `policy.json` in place; effect on next guardhook fire, no restart. Verification: `-SmokeTest` builds the form including the tab; screenshot check after layout changes (house rule). Built **after** the kernel is complete (S15) so UI work never competes with kernel slices.

## 11. Testing strategy (protocol §4 mapped to house tiers)

- **Unit — fast tier.** Pure logic: contract validation, decision evaluation, autonomy math, ledger query filtering. `node --test kernel/*.test.mjs`, hermetic.
- **Integration — fast tier.** Real process/filesystem boundaries in sandbox: guardhook as a real subprocess fed hook-JSON on stdin; ledger append/query on real temp files; adapter against the fake-claude seam; the real tampered-config test.
- **E2E — proof tier.** One scenario: a real `claude` through the lane running one tiny contract end to end (contract → launch → guard → verify → ledger → autonomy). Runs deliberately, spends tokens.
- RED-first; the red run is recorded in the slice log. `node hooks/covgate.mjs` floors (lines 100 / funcs 100 / branches 90) on every changed kernel file. Traceability table (AC-ID → Test-ID → layer → file) lives in the implementation plan and updates per slice, zero gaps. Test-value rule: any test not traceable to an AC or a real failure mode is deleted.

## 12. EARS acceptance criteria (protocol §14.2)

### 6.1 Harness Adapter
- **AC-A1** THE SYSTEM SHALL resolve the active harness solely from `policy.json kernel.harness`; swapping harnesses SHALL require changing that one value and zero code.
- **AC-A2** WHEN a run starts, THE SYSTEM SHALL record harness identity and version (from a version probe) in the ledger.
- **AC-A3** IF the configured harness is unknown, unavailable, or fails to start, THEN THE SYSTEM SHALL fail closed: no run, `failed-to-start` ledger entry, non-zero exit, never a silent fallback.
- **AC-A4** THE SYSTEM SHALL acquire a launch-lane slot before every harness spawn.
- **AC-A5** WHEN `stop_task` is invoked, THE SYSTEM SHALL terminate the harness process tree and confirm exit.
- **AC-A6** WHEN `read_state` is invoked, THE SYSTEM SHALL return machine-parsed stream-json state and SHALL NOT present harness self-reports as verification results.
- **AC-A7** WHEN `send_step` is invoked on an active task, THE SYSTEM SHALL deliver input via harness-native continuation (claude-code: `--resume`).
- **AC-A8** THE SYSTEM SHALL contain no harness-specific API or binary reference outside `kernel/adapters/` (statically tested).

### 6.2 Task Contract
- **AC-C1** THE SYSTEM SHALL refuse to start a run without a contract containing goal, constraints, allowedActions, budget, acceptanceCriteria, rollbackPlan.
- **AC-C2** THE SYSTEM SHALL reject a contract whose acceptanceCriteria is empty or whose entries lack a verify method.
- **AC-C3** THE SYSTEM SHALL store the contract byte-for-byte unmodified in the run's `run_started` ledger line.
- **AC-C4** IF a contract's writeRoots overlap protected paths (guards repo, `.claude` settings, vault), THEN THE SYSTEM SHALL reject it before launch.
- **AC-C5** IF a contract's budget exceeds a policy hard cap, THEN THE SYSTEM SHALL reject it.

### 6.3 Guards
- **AC-G1** WHEN the harness attempts an action matched by neither contract allowedActions nor live kernel policy, THE SYSTEM SHALL deny it and append the decision with reason to the run's decision log.
- **AC-G2** THE SYSTEM SHALL append every guard decision, allow and deny, to the decision log.
- **AC-G3** WHEN a task ends (any outcome) or credential TTL (`min(contract wall-clock, 240 min)`) expires, THE SYSTEM SHALL revoke task credentials: terminate the harness process and sweep kernel-staged material.
- **AC-G4** WHEN the same mutating kernel action is submitted twice with the same idempotency key, THE SYSTEM SHALL apply its effect exactly once.
- **AC-G5** IF the generated settings file fails SHA-256 validation at launch, THEN THE SYSTEM SHALL refuse to launch.
- **AC-G6** WHILE a run is active, IF the generated settings hash mismatches on a guardhook fire, THEN THE SYSTEM SHALL deny the action and flag the run.
- **AC-G7** THE SYSTEM SHALL deny writes to `.claude/settings*`, any file registered as a hook in the effective settings, and the guards repo (kernel code, ledger data, policy, vault) regardless of contract contents.
- **AC-G8** WHEN the harness invokes `engine.mjs apply` for a key name not in the contract's vaultKeys, THE SYSTEM SHALL deny and log it.
- **AC-G9** WHILE a run is active, THE SYSTEM SHALL re-read kernel policy on every guardhook fire, so an edit applies to the next tool call.
- **AC-G10** WHEN a contract lists pinnedPaths, THE SYSTEM SHALL deny writes to those paths for the entire run.
- **AC-G11** IF the guardhook cannot read or parse its inputs (payload, contract, policy), THEN THE SYSTEM SHALL deny.

### 6.4 Verifier
- **AC-V1** WHEN a run completes (exit, stop, or abort), THE SYSTEM SHALL evaluate every acceptance criterion individually via its verify method and record pass, fail, or unknown per criterion.
- **AC-V2** IF any criterion is fail or unknown, THEN THE SYSTEM SHALL mark the run rejected.
- **AC-V3** THE SYSTEM SHALL run verification only after the harness process has exited, in the kernel process, reading filesystem/git state directly.
- **AC-V4** THE SYSTEM SHALL support verify methods command, file_exists, file_contains, git_clean; an unrecognized method SHALL record unknown.
- **AC-V5** THE SYSTEM SHALL NOT derive any criterion result from harness output.

### 6.5 Ledger
- **AC-L1** THE SYSTEM SHALL append exactly one `run_started` at launch and exactly one `run_finalized` at close for every run, including failures and aborts.
- **AC-L2** WHEN a run ends without finalize (crash/interrupt), THE SYSTEM SHALL leave the started line visible and the query CLI SHALL report the run as interrupted.
- **AC-L3** THE SYSTEM SHALL make entries queryable by status, harness identity, and date range.
- **AC-L4** THE SYSTEM SHALL record no raw credential values or secret material in any ledger file (key names only; integration-tested with a seeded fake vault).
- **AC-L5** `run_finalized` SHALL include outcome, harness identity+version, per-criterion results, decision counts + sidecar reference, token cost, and wall-clock, such that started+finalized form the complete run record.

### 6.6 Autonomy Budget
- **AC-B1** WHEN a run reaches any ceiling (wall-clock, tool calls, tokens), THE SYSTEM SHALL stop it and record `aborted-by-budget` with the breached dimension.
- **AC-B2** WHEN the rejected rate over the last 10 finalized runs reaches ≥ 30%, THE SYSTEM SHALL set the tightening factor to 0.5 for the next 5 runs automatically (applied to effective ceilings per AC-B6, so contract-specified budgets tighten too).
- **AC-B3** WHEN those 5 runs elapse and the window is back under threshold, THE SYSTEM SHALL restore default ceilings.
- **AC-B4** THE SYSTEM SHALL log every ceiling adjustment with its trigger reason and window contents.
- **AC-B5** WHILE a run exceeds 20 minutes, THE SYSTEM SHALL checkpoint every 20 minutes (budget remaining AND activity); IF zero tool calls occurred in the interval, THEN THE SYSTEM SHALL stop the run as stalled.
- **AC-B6** THE SYSTEM SHALL compute each effective ceiling as `min(contract value ?? policy default, policy hard cap) × active tightening factor`.

### GUI settings tab
- **AC-U1** THE SYSTEM SHALL expose every `policy.json kernel` field in a dedicated GUI tab with typed controls.
- **AC-U2** WHEN a value is saved in the tab, THE SYSTEM SHALL write `policy.json` in place and the change SHALL take effect on the next guardhook fire without restart.
- **AC-U3** THE SYSTEM SHALL build the tab under `-SmokeTest`; layout changes are screenshot-verified.

## 13. Slice map (coarse; the implementation plan details each — protocol §14.3)

S1 adapter interface/registry/fail-closed selection → S2 claude-code launch/stop/identity (fake-claude + lane) → S3 read_state + send_step → **R1** → S4 contract schema/validation → S5 run.mjs refuse/fail-closed paths → **R2** → S6 guardhook default-deny + allowedActions + decision log → S7 generated settings + integrity (launch + per-fire) + always-denies + live policy → S8 credentials (env injection, apply enforcement, sweep, TTL) → **R3** → S9 pinned paths + tool-call ceiling → S10 ledger appends (started/finalized, verbatim contract, idempotent, no secrets) → S11 ledger query CLI → **R4** → S12 ceilings wiring (timer, tokens, aborted-by-budget) → S13 tightening window + checkpoints/stall → **R5** → S14 proof e2e + docs (adapter swap procedure in `kernel/README.md`, out-of-scope doc) → **R6** + protocol §10 full reviews + §12 wrap-up report → S15 GUI settings tab → **R7**.

R# = Diff Review checkpoint (security + lean pair, per protocol §8), never more than 3 slices apart.

## 14. Assumptions (protocol §14.4 — every chosen number and judgment call)

1. Credential revocation time: task end, or **240 min** hard TTL, whichever first; revocation = loss of local access (process death + sweep). Server-side invalidation of third-party keys is impossible from here and out of scope.
2. Budget defaults: **60 min / 200 tool calls / 500k tokens**; hard cap 240 min. Tightening: window **10**, trigger **≥ 30% rejected**, action **× 0.5 for 5 runs**, auto-restore. Checkpoint interval **20 min**, stall = zero tool calls in interval.
3. "Queryable" = the ledger query CLI; no dashboard (protocol §3).
4. The GUI settings tab is a deliberate, Kyle-approved exception to §3, limited to policy editing.
5. Contract authoring is by hand (JSON file) in v1; Start-work-tab or goal-loop integration is future work.
6. `claude -p --output-format stream-json`, `--resume`, `--settings`, `--version` are the harness surface v1 relies on; the adapter isolates all of it.
7. Guard boundary is deterministic process-level enforcement, not an OS sandbox (Kyle-approved ambition level; ceilings documented in §6).
8. The slice-runner and goal loop do not adopt the kernel in this effort; kernel v1 is invoked via its own CLI.

## 15. Out of scope (protocol §3, restated so future sessions do not rebuild)

No multi-agent orchestration or concurrency (the lane serializes; one run at a time). No per-action human approval queue (guards decide in code; the interactive runbox/approve flow is unrelated and untouched). No ledger dashboard (query CLI only; the GUI tab edits policy, nothing else). No long-term memory system, vector store, or knowledge graph. No workflow engine. **Phase 2** (Failure Corpus derived from rejected/corrected ledger entries) is named as future work only — the ledger already records what it needs.

## 16. Documentation deliverables (protocol §11)

`kernel/README.md`: the adapter swap procedure step by step, the out-of-scope list, the honest guard ceilings, and ledger query usage. `AGENTS.md`: one short section pointing at the kernel (run command, test commands). Nothing aspirational; every doc line describes shipped behavior.

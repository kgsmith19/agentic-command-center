---
title: Delete the keystroke stack now, ahead of the F1 overnight proof
status: accepted
scope: repo
created: 2026-08-08
updated: 2026-08-08
owner: Kyle Smith
traces: [FR-004, FR-011, UC-002]
supersedes: ADR-0001 (sequencing clause only — the migration direction stands)
superseded_by: none
---

# ADR-0005: Delete the keystroke stack now, ahead of the F1 proof

## Context

ADR-0001 decided the migration off the ConPTY/keystroke channel and onto the headless runner, but sequenced deletion **behind** a proving step: "F1: point the runner at one real, low-stakes job overnight behind a hard per-run ceiling… Deletion happens incrementally behind that proof, never ahead of it." That proof has still not been run. On 2026-08-07 Kyle ordered the app "restructured, redesigned, refactored" with the launch surface moved to the web GUI and the WinForms/keystroke machinery removed now — an explicit instruction to delete ahead of the gate ADR-0001 set.

## Decision

We delete the entire keystroke continuity stack (clearbot typing core, sendconsole/winfind, ConPTY host, term.html + vendored terminal, WinForms GUI, root `.cmd` launchers, and every hook-side window/kick/clear-request mechanism) in one PR, after the web launch surface (SPEC-0005 PR-1) lands — without first running F1.

## Options considered

| Option | How it works | Maturity cost | Migration cost if we leave | Lock-in | Ecosystem gaps |
|---|---|---|---|---|---|
| **Delete now (chosen)** | Web launch surface first, then one demolition PR | Headless loop unproven on real overnight work | Reversal = git revert of one PR | none | none |
| Honor the F1 gate first | Run one real overnight directive, then delete | Days of calendar wait on Kyle's machine; the stack rots meanwhile | n/a (ADR-0001's original plan) | none | none |
| Delete incrementally over several PRs | Peel clearbot, then PtyHost, then GUI | Each intermediate state has dangling references and a half-working launch story | Higher — several partial reversals | none | none |

## Why the chosen option

The owner ordered it, with the risk in front of him: the keystroke stack is ~5,600 LOC + 1.1 MB that produced most of the directive loop's historical bugs, every capability it provides has a built replacement (headless runner + web GUI), and git history makes the reversal a mechanical revert rather than a rebuild. Waiting for F1 buys confidence but costs the exact babysitting-by-hand weeks this system exists to end.

## Consequences

| | |
|---|---|
| We can now | Run one continuity mechanism (headless runner), one GUI (web), one launch path — and reason about them |
| We can no longer | Auto-`/clear`-and-resume an **interactive** console session: an over-budget interactive session now stops at a message naming the exact resume command (`node runner/runner.mjs directive:<id>` or the Start-work page) instead of self-clearing |
| We can no longer (2) | Auto-run approved runbox scripts: **autoApprove's daemon lived inside clearbot.ps1 and dies with it.** The web Run button is the flow now; reviving unattended auto-run is a future Node feature with its own spec, not a port |
| We must maintain | The runner's pid-file singleton and the web launch surface as the only lifecycle path |
| We are exposed to | The headless loop failing on real unattended work with no fallback mechanism left in the tree (mitigants: maxRuns/maxStuck/runTimeoutMin ceilings, red-tier hold, launch lane, machine-wide shim cap; issue #15's per-run hard ceiling is the next slice) |

## Reversal

| Field | Answer |
|---|---|
| Cost to reverse | Medium: `git revert` of the demolition PR restores the stack byte-for-byte, but re-entangling it with hooks that have since evolved is real work that grows with time |
| What would trigger a reversal | The headless loop proves unreliable on real work (ADR-0001's trigger, unchanged) AND the web surface cannot compensate |
| What is proprietary and would not transfer | Nothing |

## Verification

SL-008 re-targets from "gate for deletion" to "prove FR-011 done": one real, low-stakes directive run headless to completion, watched, within 30 days of the demolition PR. Its alert/log trail in `runner/logs/` is the evidence; a failed run reopens this ADR rather than resurrecting the stack by default.

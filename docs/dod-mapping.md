# Definition of Done — condition mapping

Source: Kyle's 2026-08-04 prompt, archived at
`runner/goals/done/g-20260804-222717-lu7o.json`. Every condition maps to a
ledger entry or a spec acceptance criterion. A condition with neither is a gap,
and the fix is a new ledger entry — never a dash. Condition 22 is the
prompt's evidentiary instruction ("Do not claim 100% success without
evidence."), counted here as the 22nd condition since it gates the same
closing statement the other 21 do.

| # | Condition | Covered by |
|---|---|---|
| 1 | Every known issue is resolved. | `INVENTORY.md` (sub-project A) reaching zero open entries across all five ledgers |
| 2 | Every previously documented task is addressed. | `docs/superpowers/plans/2026-08-04-acc-completion-plan.md`'s nine sub-projects (A, B, J, I, F, D, E, G, H) |
| 3 | Every core workflow is mapped. | `WORKFLOWS.md` — all 14 core workflows, trigger/touches/tests per row, kept honest by `tools/workflows.test.mjs`. Closed `guards#OI-036`; also related: AC-E1, AC-E2, AC-E21 (UI screens map to the five modes), AC-J14 (one composite workflow proven end to end) |
| 4 | Every setting reaches its true consumer. | AC-F5, AC-F6, AC-F7, AC-F8 (the L1-L5 traceability chain), AC-F10 (completeness gate over the real `policy.json`/`config.json`) |
| 5 | Every relevant behavior is tested. | AC-G1, AC-G2, AC-G6, AC-G8 (per-module `.scenarios.md` records, enumerated axes, property tests over every standard invariant) |
| 6 | Every integration is proven. | AC-G11 through AC-G16 (integration and e2e tiers, real kills, real restarts, real `loop.e2e.mjs`), AC-J14 |
| 7 | Every failure mode has an intentional response. | AC-G11 (kill mid-write, no silent corruption), AC-G12 (corrupt store fails loudly), AC-G13 (phase-matrix kill converges to a defined state) |
| 8 | Every critical process can recover safely. | AC-G13, AC-D17 (standing order marked `interrupted`, distinct from `abandoned`/`done`), `guards#OI-009` (RESOLVED — hosted-GUI-death detection), `guards#OI-007` (RESOLVED — watchdog revive/reboot recovery) |
| 9 | Every dangerous process can be stopped. | AC-D1 (STOP kills every descendant of the session anchor), AC-D5 (partial-kill reporting), AC-D18 (Stop autopilot halts the daemon) |
| 10 | Every UI element has a clear purpose. | AC-E7, AC-E8 (identifier component states purpose/storage/log location), AC-E11 (no banned generic label ships) |
| 11 | Every identifier is understandable and traceable. | AC-E7, AC-E8, AC-F14 (every UI control maps to a traceability registry id), AC-E12 |
| 12 | Every tab earns its place. | AC-E1, AC-E2 (seven tabs audited to five modes, strictly more reachable), AC-E21 (retired tabs' functionality reachable, feature-parity checklist from the audit table) |
| 13 | Every ambiguity has been removed. | Composite, no single AC: AC-F1-AC-F4 (an unregistered or unregistered-target dial fails the gate), AC-H2, AC-H3 (every obligation clause names and resolves a real mechanism), AC-E7, AC-E11 (no raw or generic identifiers), `guards#OI-026` (the "goal" naming collision) and AC-J8 (renamed vocabulary, no stale references) |
| 14 | Every required log exists. | AC-D6 (every STOP activation writes who/when/anchor/pid-list/post-kill state), AC-I6, AC-I7 (tamper findings attributed against `approvals.log`) |
| 15 | All security gates pass. | AC-G15 (traversal denied, foreign origin refused, missing token refused, no secret logged), AC-E16-AC-E20 (loopback bind, run-token, CSRF, CSP, guardrails), AC-I12 (guard refuses a direct protected-path edit), plus `/security-review-kgs`/`/sec-diff-kgs` on every commit touching auth/input/SQL/serialization |
| 16 | All documentation is accurate. | AC-H14 (charter's authority section matches the real implementation), AC-J8 (no stale renamed-vocabulary references); **not yet met** — `code#OI-017` (repo documentation reorganization) is still open |
| 17 | All tests pass. | AC-G16 (`loop.e2e.mjs` fully green or explicitly re-classified with recorded evidence), the standing fast-tier + `covgate` gate every spec's Test column cites (`docs/superpowers/specs/2026-08-04-acc-standards-design.md`) |
| 18 | All acceptance criteria pass. | `docs/superpowers/plans/2026-08-04-acc-completion-plan.md`'s own Definition of done: "every sub-project's acceptance criteria pass with recorded evidence (137 ACs across the nine specs)" |
| 19 | The application operates as one coherent system. | AC-J14 (the whole system works after each migration step), AC-E22 (full workflow end to end: submit a standing order, watch it run, take over, stop it, find it in history) |
| 20 | Albert can perform his responsibilities autonomously. | AC-H1 (all eleven charter elements present), AC-H4 (every named mechanism has a passing test), AC-H9, AC-H10 (a real session injects and reports the charter version) |
| 21 | The evidence proves the goals were actually achieved. | Standing rule 1 in `docs/superpowers/plans/2026-08-04-acc-completion-plan.md` ("Evidence before assertion. No acceptance criterion is satisfied by reading back a value we ourselves wrote"), AC-H13 |
| 22 | Do not claim 100% success without evidence. | AC-H13 (the closing statement cannot be emitted while any sub-project AC is unproven) — this condition mechanized directly |

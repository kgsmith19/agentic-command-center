# Checkpoint board

This is the live checkpoint/board file `policy.json`'s `runner.statusFile`
points at — `hooks/budget.mjs`'s Stop hook tells an over-budget session to
write its resume state here before a `/clear`, so a cold session can resume
from this file alone. It is **not** slice-runner documentation (that's
`runner/README.md`) — this filename previously carried a stale goal-checkpoint
note under a misleading name; that content is preserved in git history
(deleted 2026-08-07 as part of the SDD documentation cleanup). This file is
reset to a placeholder here; the next session that checkpoints overwrites it.

No active checkpoint right now.

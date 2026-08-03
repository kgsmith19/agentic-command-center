# Checkpoint board

This is the live checkpoint/board file `policy.json`'s `runner.statusFile`
points at — `hooks/budget.mjs`'s Stop hook tells an over-budget session to
write its resume state here before a `/clear`, so a cold session can resume
from this file alone. It is **not** slice-runner documentation (that's
`runner/README.md`) — this filename previously carried a stale goal-checkpoint
note under a misleading name; that content is archived at
`notes/2026-07-31-goal-g-20260731-134525-09wb-checkpoint.md`. This file is
reset to a placeholder here; the next session that checkpoints overwrites it.

No active checkpoint right now.

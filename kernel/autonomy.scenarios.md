# kernel/autonomy.mjs — scenarios

## standard
- test: effective ceiling = min(contract, policy default, hard cap) x factor (AC-B6)
- test: crossing the rejected-rate threshold tightens the next N runs automatically (AC-B2)
- test: a healthy window makes no adjustment
- test: ceilings restore automatically once the window recovers (AC-B3)
- test: a checkpoint stops a run over any ceiling, naming the dimension (AC-B1)
- test: every adjustment is logged with its trigger reason and window (AC-B4)

## non-standard
- test: failed-to-start does not count as a rejection — tightening cannot fix a missing binary
- test: mid-tightening runs are decremented without a new adjustment or log entry

## edge
- test: a window of only failed-to-start runs makes no adjustment (empty counted window, no divide-by-zero)
- test: if the window is still bad when the tightened runs elapse, tightening re-arms instead of silently sticking
- test: a checkpoint stops a run that made no tool call in a whole interval (AC-B5)

## rare
- test: two real OS processes finalizing concurrently do not clobber each other's autonomy update (rare, OI-043)

## error
- test: readAutonomyStrict: missing file is fresh, corrupt file THROWS (never fails open)

## fault-tolerance
- test: a stale lock (crashed holder) is stolen instead of deadlocking autonomy updates forever (fault-tolerance, OI-043)

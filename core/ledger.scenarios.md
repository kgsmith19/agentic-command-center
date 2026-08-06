# core/ledger.mjs — scenarios

## standard
- test: one run writes exactly one started and one finalized line (AC-L1)
- test: finalized carries outcome, harness, per-criterion results, counts, cost, wall-clock (AC-L5)
- test: query filters by status, harness, and date range (AC-L3)
- test: the CLI returns the same rows the API does
- test: end-to-end: the CLI prints JSON lines and exits 0 for a real query

## non-standard
- test: the contract is stored byte-identically alongside the run (AC-C3)
- test: readDecisions returns the full parsed rows, not just counts

## edge
- test: query's since/until bounds are inclusive at the exact timestamp (edge)
- test: a started run with no finalized line reads as interrupted (AC-L2)

## rare
- test: a repeated append with the same runId applies exactly once (AC-G4)
- test: two real OS processes racing to append the same run's started line still leave exactly one (rare, OI-042)

## error
- test: readRuns and decisionCounts read as empty, not a throw, when the ledger has never been written (error)
- test: end-to-end: an unknown CLI command prints usage to stderr and exits 1

## fault-tolerance
- test: a truncated trailing line does not lose the records before it
- test: a claim directory that cannot be created makes appendStarted throw loudly, not swallow (fault-tolerance)

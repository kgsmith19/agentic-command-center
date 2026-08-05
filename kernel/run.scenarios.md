# kernel/run.mjs — scenarios

## standard
- test: an incomplete contract is refused with NO ledger entry and no harness (AC-C1)
- test: the contract is stored verbatim in the started line (AC-C3)
- test: harness identity and version reach the ledger for every run (AC-A2)
- test: verification runs only after the harness process has exited (AC-V3)
- test: a criterion that does not hold makes the run rejected (AC-V2, AC-L5)
- test: the harness is launched with the run's staging dir and the pinned settings (AC-G5)

## non-standard
- test: a contract that omits every optional field still runs with sensible defaults
- test: contract-listed vault keys reach the child env and NOTHING else (AC-L4)

## edge
- test: run ids are unique
- test: end-to-end: the CLI with no contract argument prints usage and exits 2
- test: end-to-end: the CLI refuses an invalid contract and exits 2

## rare
- test: a run over its wall-clock ceiling is stopped and marked aborted-by-budget (AC-B1)
- test: a run over its token ceiling is stopped, using the LIVE event stream (AC-B1)
- test: two concurrent runs finalize and clean up independently, with no cross-contamination (rare)

## error
- test: a harness that cannot start is recorded as failed-to-start, fail closed (AC-A3, AC-L1)
- test: a harness whose startTask itself throws is recorded as failed-to-start (AC-A3)
- test: a vault key the contract asks for but the vault lacks fails closed
- test: a criterion that throws while being verified fails closed instead of crashing the run (OI-040)

## fault-tolerance
- test: settings tampered BEFORE launch refuse to launch (AC-G5)
- test: the staging directory is removed on every exit path (AC-G3)
- test: a stopTask that itself throws while enforcing a breach is swallowed, not crashed (AC-B1 fault tolerance, OI-019)
- test: the autonomy window is updated after every finalized run (AC-B2 wiring)

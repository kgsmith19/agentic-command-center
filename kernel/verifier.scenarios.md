# kernel/verifier.mjs — scenarios

## standard
- test: each verify method returns a real pass or fail (AC-V4)
- test: every criterion is evaluated individually (AC-V1)
- test: command verification uses the real spawnSync path when no execFn is injected

## non-standard
- test: an unrecognized method records unknown, never a pass (AC-V4)
- test: a criterion with no verify block at all records unknown with a null method

## edge
- test: git_clean with a failing git and no stderr still records unknown
- test: verifyAll tolerates a contract with no acceptanceCriteria field at all

## rare
- na: verifyAll runs its criteria serially, read-only, with no shared mutable state for a second caller to race against (2026-08-05)

## error
- test: an invalid regex pattern fails the criterion instead of throwing (error, OI-040)
- test: any fail or unknown makes the run NOT accepted (AC-V2)
- test: the verifier ignores anything the harness said about itself (AC-V5)

## fault-tolerance
- test: command verification against a cwd that does not exist fails gracefully, not a crash (fault-tolerance)

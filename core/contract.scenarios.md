# core/contract.mjs — scenarios

## standard
- test: a complete contract validates
- test: every required field is required, and the error names it (AC-C1)
- test: acceptance criteria must exist and must be verifiable (AC-C2)
- test: the tool allowlist is derived from allowedActions

## non-standard
- test: allowedActions with no writeRoots key at all is tolerated (no overlap to check)
- test: a contract file with a leading UTF-8 BOM still loads
- test: toolsFor tolerates a contract with no allowedActions block at all
- test: the tool allowlist includes WebFetch/WebSearch and Agent when granted

## edge
- test: a writeRoot that is a PARENT of a protected path is rejected too, not just a child or exact match (edge)
- test: writeRoots overlapping a protected path are rejected before launch (AC-C4)
- test: an acceptance criterion missing an id is labeled by position
- test: a budget above a policy hard cap is rejected (AC-C5)

## rare
- na: validateContract/toolsFor are pure functions of their arguments plus a fresh loadKernelPolicy() read each call; no shared mutable state exists for a second caller to race against (2026-08-05)

## error
- test: a null/undefined contract is treated as empty, reporting every missing field
- test: a contract that parses to a non-object JSON value is treated as empty, not a crash (error)
- test: an allowedActions field that is not an array is rejected
- test: acceptanceCriteria that is present but not an array is rejected
- test: an unreadable contract file fails closed

## fault-tolerance
- test: validateContract propagates a corrupt underlying policy file's throw, never swallows it (fault-tolerance)

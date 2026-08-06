# core/guard.mjs — scenarios

Retroactive record: guard.mjs is the one module `OI-019` had already audited
before this program existed (its own audit turned up a real, live
path-traversal bypass, fixed and regression-tested — see `## rare` below).
Written after the fact so `tools/scenariogate.mjs`'s template is proven
against a completed audit before eleven more are written against it.

## standard
- test: a write inside writeRoots is allowed; outside it is denied (AC-G1)
- test: a read under readRoots or writeRoots is allowed; elsewhere denied
- test: guard machinery and the user settings tree are never writable, whatever the contract says (AC-G7)
- test: pinned acceptance-test files are write-denied for the whole run (AC-G10)
- test: Bash allows only a listed prefix (AC-G1)
- test: network and subagent grants come from the contract
- test: the staging rule fires when the staging dir is NOT already covered by an always-deny root

## non-standard
- test: policy alwaysAllowTools are permitted; a malformed payload is denied (AC-G11)
- test: every allowedActions category defaults to empty when the field is entirely omitted
- test: a contract with no pinnedPaths field at all is tolerated

## edge
- test: the tool-call ceiling denies further calls (AC-B1)
- test: a non-finite ceiling never triggers the ceiling rule
- test: WebSearch is allowed only when networkHosts is non-empty (documented ceiling)
- test: a '..'-traversal path that textually starts with an allowed writeRoot but resolves into denyRoots is still denied
- test: a '..'-traversal read path resolving outside every granted root is denied, not matched by accident
- test: a '..'-traversal path that resolves BACK inside an allowed root is allowed (normalization is not itself a deny)

## rare
- test: a mixed-separator traversal path (backslash and forward-slash) is normalized before the deny check, not bypassed by slash style

## error
- test: a vault key the contract does not list is denied even inside an allowed command (AC-G8)
- test: an unknown tool is denied by default (AC-G1)
- test: a missing contract or allowedActions block denies every action category
- test: a write or read tool with no path in the payload fails closed

## fault-tolerance
- na: pure module, no I/O to fail underneath (2026-08-05)

# kernel/settings.mjs — scenarios

## standard
- test: the guardhook matcher is exactly the contract's tool allowlist
- test: writeRunFiles pins the settings hash and stores the contract for the hook
- test: cleanupRun removes the staging directory

## non-standard
- test: cleanupRun removes the staging directory

## edge
- test: a contract granting no optional actions still produces a valid matcher of just the always-allowed tools (edge)

## rare
- na: writeRunFiles/cleanupRun/verifySettingsPin are pure filesystem operations keyed by a unique runId per call, with no state shared across runIds for a second caller to race against (2026-08-05)

## error
- test: a missing settings file or pin fails closed, never passes by default

## fault-tolerance
- test: a TAMPERED settings file fails the integrity check (AC-G5, AC-G6)
- test: a corrupt (not valid JSON) pin.json fails closed too, distinct from a missing one (fault-tolerance)

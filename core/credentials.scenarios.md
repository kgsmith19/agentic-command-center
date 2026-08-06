# core/credentials.mjs — scenarios

## standard
- test: envForKeys returns only the requested keys, for the child env
- test: vaultNames returns names and never values

## non-standard
- test: a missing vault file yields no keys rather than throwing on first run

## edge
- test: envForKeys with no argument at all defaults to no keys requested (edge)

## rare
- na: readVault/envForKeys/vaultNames are pure functions re-reading the vault file fresh on every call, with no shared mutable state for a second caller to race against (2026-08-05)

## error
- test: a key that is not in the vault fails by name, and never asks for a value in chat

## fault-tolerance
- test: a corrupt vault file fails closed identically to a missing one, not a crash (fault-tolerance)

# core/policy.mjs — scenarios

## standard
- test: absent policy file yields the defaults
- test: a policy edit applies to the NEXT call with no restart (AC-G9, AC-U2)
- test: a partial block keeps the other defaults
- test: saveKernelPolicy round-trips through the file and preserves everything it does not own

## non-standard
- test: a policy file with a leading UTF-8 BOM still parses
- test: always-deny write roots cover the guards repo and the user .claude dir (AC-G7)

## edge
- test: boundary values at the exact edge of each valid range are accepted, not rejected (edge)
- test: kernelRoot falls back to the repo root when ACC_ROOT is unset
- test: loadKernelPolicy falls back to the repo policy.json when ACC_POLICY is unset (read-only)

## rare
- na: saveKernelPolicy has exactly one caller (gui/server.mjs's settings-save endpoint, a single human clicking Save), not an automatic per-run path like ledger.mjs/autonomy.mjs -- a concurrent-write race here is real but low-frequency and low-severity (last-write-wins on a human-edited settings file, not a silently-lost automatic safety decision), so it is accepted rather than lock-guarded (2026-08-05)

## error
- test: a corrupt policy file THROWS so callers fail closed, never guesses dials
- test: an invalid block is rejected atom-for-atom: throws, file byte-identical
- test: saveKernelPolicy with no policy file fails closed instead of inventing one

## fault-tolerance
- test: saveKernelPolicy against a corrupt on-disk file throws instead of silently overwriting it (error, fault-tolerance)

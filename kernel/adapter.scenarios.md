# kernel/adapter.mjs — scenarios

## standard
- test: the configured harness name is the ONLY thing that selects an adapter (AC-A1)
- test: resolveAdapter defaults to policy.json kernel.harness (AC-A1)

## non-standard
- test: no kernel module outside kernel/adapters/ references a harness (AC-A8)

## edge
- test: a harness name that could traverse out of adapters/ is refused

## rare
- na: adapterSpecifier/assertAdapterShape are pure, and resolveAdapter's dynamic import() is deduped/cached by Node's own module system, so a second concurrent caller resolving the same name has nothing to race against (2026-08-05)

## error
- test: an unknown harness fails closed — no fallback to another adapter (AC-A3)
- test: an adapter missing an interface member is refused by name
- test: assertAdapterShape(null/undefined) fails cleanly by name, not a TypeError crash (error)

## fault-tolerance
- test: an adapter file that exists but throws during its own module evaluation is reported as unavailable, not an uncaught crash (fault-tolerance)

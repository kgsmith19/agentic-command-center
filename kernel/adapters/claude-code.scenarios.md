# kernel/adapters/claude-code.mjs — scenarios

## standard
- test: identity probes via spawnSpec — no args array ever rides shell:true
- test: buildArgs pins settings, session id and the tool allowlist; prompt never in argv
- test: every launch holds a lane slot for the life of the run and frees it after (AC-A4)
- test: startTask spawns exactly what spawnSpec builds for this platform
- test: stopTask kills the process TREE and confirms exit (AC-A5)
- test: readState counts real tool calls and tokens from the stream (AC-A6)
- test: sendStep continues an existing session over --resume (AC-A7)

## non-standard
- test: startTask parses stdout stream-json lines into events, tolerating a non-JSON banner and split chunks
- test: readState tolerates an empty or malformed stream
- test: readState tolerates an assistant message with no content array and full usage fields
- test: readState ignores an assistant message with no usage at all
- test: readState carries NO verdict field — the harness cannot report its own pass (AC-A6, AC-V5)

## edge
- test: send_step continues the SAME session via --resume (AC-A7)
- test: readState takes the LAST session_id across multiple differing events, not the first (edge)

## rare
- test: two concurrent launches serialize through the lane when only one slot exists (rare, AC-A4)

## error
- test: a harness that cannot be probed fails closed, with no fallback (AC-A3)
- test: a probe that returns no version number fails closed (AC-A3)
- test: a harness that fails to spawn releases the slot and fails closed (AC-A3)
- test: a spawned harness that errors after launch releases the slot and fails closed (AC-A3)
- test: stopTask on no handle is a no-op
- test: stopTask on a handle whose done already rejected does not throw

## fault-tolerance
- test: startTask surfaces stderr on the raw record
- test: the handle's own stop() convenience method calls stopTask

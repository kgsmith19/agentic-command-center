# core/guardhook.mjs — scenarios

## standard
- test: an allowed call exits 0; a denied call exits 2 with the reason on stderr (AC-G1)
- test: every decision, allow and deny, is appended to the run's sidecar (AC-G2)

## non-standard
- test: the tool-call ceiling falls back to the policy default when the contract omits budget.toolCalls
- test: the autonomy-state and non-finite-ceiling denials still record with tool:null when the payload itself has no tool_name
- test: a stored autonomy factor of null falls back to 1 in the decision record, not NaN or null

## edge
- test: OI-028: an oversized stdin payload fails closed instead of buffering unbounded
- test: a tightened autonomy factor shrinks the per-fire ceiling to EXACTLY effectiveCeilings' number (OI-024)
- test: a contract yielding no finite toolCalls ceiling denies instead of comparing against NaN

## rare
- test: a stdin pipe that never closes still fails closed once the timeout cap elapses
- test: the tool-call ceiling is enforced across separate hook fires (AC-B1)

## error
- test: a settings file tampered mid-run denies everything and flags the run (AC-G6)
- test: every unreadable input fails closed (AC-G11)
- test: a corrupt contract with a payload that itself has no tool_name still fails closed
- test: absent autonomy state means base ceiling, corrupt autonomy state fails closed

## fault-tolerance
- test: a decision log that cannot be written fails closed (AC-G11)
- test: a deny that itself cannot log the decision still denies (the denial stands regardless)

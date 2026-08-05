# Autonomy posture and tamper-evidence — design (sub-project I)

- date: 2026-08-04
- status: approved (Kyle, 2026-08-04: "Accept + make it tamper-evident")
- scope: resolve `OI-032` — with `autoApprove.enabled: true`, an agent that can
  write a file is an agent that can run code with Kyle's authority
- standard: `2026-08-04-acc-standards-design.md` applies in full
- ledger: guards `OI-032`

## The fact this resolves

On 2026-08-04, twice, in one turn:

1. `guard.mjs` correctly refused an agent's edit to `~/.claude/settings.json` —
   "agents may not edit the rules that constrain them".
2. The agent wrote a runbox script instead, exactly as `AGENTS.md` instructs.
3. Clearbot auto-approved and ran it ~30 seconds later with Kyle's full
   authority, deleting the very hook the guard had just protected.

`config.json` protects exactly one path (`~/.claude/settings.json`). The guard
enforces it. The runbox goes around it. So `AGENTS.md`'s sentence — an agent
"may not edit the rules that constrain it" — **is currently false**, and a
document that states a boundary the system does not have is worse than no
document, because reviewers stop looking.

## Why prevention was rejected

Two preventive designs were considered and both were rejected on the merits, not
on cost:

**Scanning script text for dangerous targets** is the same class of error as
`4af8cd6` — asserting on text and reporting the result as behaviour. A script can
compute a path at runtime, so the check would be a declaration check wearing a
boundary's clothes. Standing prohibition 1 forbids exactly this.

**A restricted execution identity** (deny-write ACE on protected paths for the
auto-approve executor) is a real boundary — and it directly defeats the runbox's
purpose. The runbox exists *because* agents need to do blocked and elevated
things: registering scheduled tasks, installing hooks, self-elevating installers.
Running it with less authority than the agent it serves makes it useless.

So the honest resolution is the one Kyle chose: **keep the authority, and make
every use of it impossible to miss.** Detection that is provable beats prevention
that is not.

## Design

Three parts, each independently useful.

### I1 — make the documentation true

`AGENTS.md` stops claiming a boundary that does not exist and states the real
one:

> The guard prevents an agent from editing protected files **directly**. It does
> not prevent an agent from asking the runbox to do it, and with
> `autoApprove.enabled: true` the runbox will. Every such change is baselined,
> detected, and reported (see tamper-evidence). This is a deliberate posture:
> Albert holds real authority, and the record of its use is the control.

Kyle's decision and its date are recorded in `policy.json`'s note alongside the
existing 2026-07-31 one, so the tradeoff is a decision in the file rather than
folklore.

### I2 — baseline and detect

A new `tamper.mjs` in `agentic-command-center`:

- **Baseline.** SHA-256 of every path in `config.protected`, stored in
  `runner/state/tamper-baseline.json` with the time and the reason the baseline
  was taken. The baseline file is itself hashed into the record, so editing the
  baseline to hide a change is itself a detectable change.
- **Check.** Runs on every autopilot cycle. Any path whose hash differs from the
  baseline is a **finding**.
- **Attribution.** A finding is correlated against `watcher/approvals.log`
  (which already records every auto-approved run with its script name and time).
  A finding inside a window of an approved run names the script; a finding with
  no corresponding run is reported as **unattributed**, which is the serious case
  and is labelled differently.
- **Report.** Findings are appended to `runner/logs/tamper.log`, surfaced in the
  statusline, and raised as a banner in the UI (sub-project E consumes this).
- **Re-baseline is explicit.** `tamper.mjs accept --why "<reason>"` takes a new
  baseline and records the reason. Nothing re-baselines automatically — a system
  that silently accepts the new state detects nothing.

Deliberately *not* included: blocking, reverting, or alerting by email. Blocking
is the prevention Kyle rejected; revert risks destroying a legitimate change; and
an alert channel that does not exist yet is a different sub-project.

### I3 — widen what is protected

`config.protected` currently holds one path. The things that actually constrain
an agent are wider, and every one of them is currently unwatched:

- `~/.claude/settings.json` *(already protected)*
- `~/.claude/CLAUDE.md` — Kyle's global instructions
- `C:\code\CLAUDE.md`, `C:\code\ROUTING.md`
- each repo's `AGENTS.md`
- `config.json` and `policy.json` themselves
- `~/.claude/skills/**` — the skills that define how work is done

These are added to `config.protected` (so the guard refuses direct agent edits)
**and** to the tamper baseline (so runbox-lane changes are recorded). Adding
`config.json` to its own protected list is intentional and is tested: the check
must survive its own configuration being the thing that changed.

## Interaction with sub-project F

F (setting-traceability) proves a dial reaches its consumer. I proves a protected
file has not changed behind our backs. They are complementary and share no code:
F asks "does this setting do what it says", I asks "is this file what we left".
`hooks/dialcheck.mjs` stays F's; `tamper.mjs` is I's.

## Acceptance criteria

| AC | Statement | Test |
|----|-----------|------|
| AC-I1 | `AGENTS.md` no longer claims agents cannot edit the rules that constrain them | integration, grep gate on the exact retired sentence |
| AC-I2 | Baseline records a hash for every `config.protected` path | unit |
| AC-I3 | A protected path missing from disk is a finding, not a crash | unit |
| AC-I4 | Modifying a protected file produces a finding on the next check | integration, real temp files |
| AC-I5 | Modifying the baseline file itself produces a finding | integration — the self-protection case |
| AC-I6 | A finding within an approved run's window names that script | integration, seeded `approvals.log` |
| AC-I7 | A finding with no corresponding approved run is reported as `unattributed` | integration |
| AC-I8 | Nothing re-baselines automatically; a second check still reports the same finding | integration — proves findings do not decay |
| AC-I9 | `accept --why` re-baselines and records the reason; `accept` with no reason is refused | unit |
| AC-I10 | Findings appear in the statusline within one autopilot cycle | integration, real statusline invocation |
| AC-I11 | The check adds under 50 ms to an autopilot cycle for the real protected set | integration, measured, asserted |
| AC-I12 | The guard refuses a direct agent edit to every newly protected path | integration, one case per path class |
| AC-I13 | Hashing is over bytes, so a line-ending-only change is still a finding | unit — CRLF/LF, which this repo has been bitten by before |
| AC-I14 | End to end: an agent writes a runbox script that edits `settings.json`, autopilot runs it, and the change is reported as attributed within one cycle | e2e — this is the exact 2026-08-04 incident, replayed |

AC-I14 is the criterion that matters: it replays the real incident and requires
the system to notice this time.

## Verification

```
node --test core/tamper.test.mjs
node --test e2e/tamper.e2e.mjs        # AC-I14, real runbox + autopilot cycle
npm test && node covgate.mjs
node core/tamper.mjs check            # against the real protected set, exits 0 when clean
```

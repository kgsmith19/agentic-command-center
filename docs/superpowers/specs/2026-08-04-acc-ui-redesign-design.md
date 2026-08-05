# Web UI — first-principles redesign (sub-project E)

- date: 2026-08-04
- status: approved (Kyle, 2026-08-04: full browser app, two repos)
- scope: rebuild the ACC/Guards interface as a web app in
  `agentic-command-center-ui`, from first principles, against Kyle's own
  usability checklist
- standard: `2026-08-04-acc-standards-design.md` applies in full
- ledger: guards `OI-022` (web platform decided), `OI-015` (the GUI half Kyle
  still owns)
- depends on: **J** (the repo exists), **C**/J (vocabulary settled), **F**
  (every control must be registrable), **D** (the STOP control lives here)

Kyle's bar, verbatim: *"Right now, the experience is a 6/100 at best. It needs to
become 100/100."* And: *"A child should be able to move through every normal
scenario and understand every workflow, button, option, state, and result."*

## The organising idea

Kyle's own prompt contains the information architecture. He asks whether users
*"can distinguish observation, configuration, execution, intervention, and
history"*. Those five are not a checklist item — they are the answer. The app's
top-level navigation **is** those five modes, and every screen belongs to exactly
one:

| Mode | The question it answers | Contains |
|---|---|---|
| **Watch** | What is happening right now? | live sessions, standing orders, spend, autopilot state, tamper findings |
| **Work** | Do the thing | the terminal, start work, submit a standing order |
| **Take over** | Change what the machine is doing *now* | STOP, pause, resume, redirect, interrupt, autopilot stop |
| **Set up** | Change how it behaves *next time* | permissions, protected paths, secrets, policy dials, kernel settings |
| **Look back** | What happened, and why? | ledger, approvals, tamper log, runs, spend history |

This directly satisfies "does every tab justify its existence": a screen that
cannot name its mode does not exist. It also gives the dangerous-action rule a
structural answer instead of a colour convention — **Take over** and **Set up**
are separated by navigation, not by a red border.

## Tab audit

Every current tab, judged against the rule. Nothing is kept because it exists.

| Today | Verdict | Reason |
|---|---|---|
| Terminal | **keep**, becomes the centre of *Work* | the thing Kyle actually uses |
| Start work | **merge into Work** | it is the terminal's empty state, not a separate place |
| Claude's requests (runbox) | **keep**, into *Take over* | approving a pending script is an intervention |
| What Claude can do (permissions) | **keep**, into *Set up* | |
| Passwords and secrets | **keep**, into *Set up*, behind progressive disclosure | rarely used, high consequence |
| This week's spend | **split**: live band → *Watch*, history → *Look back* | one tab was doing two jobs |
| Kernel | **retire as a tab** | "Kernel" names an implementation, not a user goal. Its settings move into *Set up* grouped by what they control; per J it is not even called kernel any more |

Net: seven tabs → five modes, with strictly more reachable.

## Identifiers

Kyle: *"Does every identifier have a visible purpose? Can users tell where
identifiers are stored, logged, and used?"* Today the UI shows `g-20260804-…`,
`acc-term-ab12`, pids and session ids with no explanation, which is a large part
of the 6/100.

Rule: **every identifier rendered anywhere is a component, never raw text.** The
component shows a short form, and on hover/focus/tap gives one plain sentence
("this standing order, created 7:27 pm yesterday"), where it is stored, where it
is logged, and a copy button. Screen-reader text carries the sentence, not the
opaque string.

An identifier with nothing to say is a bug — it means we are showing the user
something we cannot explain, and the fix is to stop showing it.

## Terminal integration

Kyle asks whether the current approach is the best way. The answer that survives
the platform change: the terminal is **the page**, in *Work* — not a panel inside
a shell. `xterm.js` fills the viewport below a status strip and above nothing;
controls live in a fixed strip that never scrolls away; the pty is served over a
WebSocket from the UI's own server, with the pty host process staying where it
already is.

"Who is driving?" gets one unmistakable banner — ACC or Kyle — carried over from
the 2026-07-31 design, which got that part right. It is a button: clicking it
takes over, clicking again hands back.

## Tech decision

**No framework, no build step.** ES modules, plain CSS with custom properties,
vendored dependencies only (`gui/vendor/xterm` is already this pattern). Reasons:
it matches "SUPER LEAN", it keeps the repo readable by an agent, it removes a
build toolchain from the failure surface, and a strict CSP is trivial when
nothing is bundled from a CDN.

Award-winning UI is a function of typography, spacing, hierarchy and restraint,
not of framework choice. This is stated as a decision so it can be argued in
review rather than discovered in the diff.

## The quality bar, made testable

"100/100" and "a child could use it" are not gates. These are:

- **Accessibility**: WCAG 2.2 AA, enforced by automated axe checks in CI plus
  keyboard-only and screen-reader e2e paths for every primary workflow. Zero
  violations is the gate, not a score.
- **Responsive**: every screen usable from 320 px to ultrawide. No horizontal
  page scroll at any width; wide content scrolls inside its own container.
- **Labels describe what happens**: a gate asserts every interactive element has
  an accessible name, and that no label in the app is in the banned list
  (`OK`, `Submit`, `Go`, `Run`, `Apply`) without a qualifying noun.
- **Empty and error states**: every list and every fetch has a designed empty
  state and a designed error state, both asserted. An empty list that renders
  nothing is a defect.
- **Progressive disclosure**: each screen declares a primary action; secondary
  actions are one interaction away; destructive actions are in *Take over* and
  carry D's protection.
- **Every control is traced**: per F's AC-F14, every control maps to a
  traceability registry id. A control that changes nothing observable cannot
  ship, which is the structural fix for "mysterious options that do nothing".

## Security

The UI serves a local HTTP endpoint that can kill processes and edit protected
files, so it is a real attack surface:

- Bind to loopback only.
- A per-run token required on every mutating request; no ambient authority.
- Strict CSP, no inline script, no external origins.
- Origin checking on the WebSocket upgrade — a local web page in another tab must
  not be able to open the pty.
- Every mutating endpoint goes through guardrails, so the UI has no authority the
  guard does not grant it.

`/security-review-kgs` runs before any commit touching these.

## Acceptance criteria

| AC | Statement | Test |
|----|-----------|------|
| AC-E1 | Every screen declares exactly one of the five modes | unit, route manifest |
| AC-E2 | No screen exists that is not reachable from the five-mode navigation | integration |
| AC-E3 | Every interactive element has an accessible name | e2e, whole-app sweep |
| AC-E4 | Zero axe violations on every screen, light and dark | e2e, CI gate |
| AC-E5 | Every primary workflow completes keyboard-only | e2e, one path per workflow |
| AC-E6 | No horizontal page scroll from 320 px to 2560 px on any screen | e2e, viewport matrix |
| AC-E7 | Every identifier renders via the identifier component, never raw | integration, grep gate + DOM sweep |
| AC-E8 | The identifier component states purpose, storage and log location for every id type in use | unit, one case per type |
| AC-E9 | Every list has a designed empty state | e2e, empty fixtures |
| AC-E10 | Every fetch has a designed error state | e2e, forced failures |
| AC-E11 | No banned generic label ships | integration, label gate |
| AC-E12 | Every control maps to a traceability registry id | integration, per AC-F14 |
| AC-E13 | Destructive actions appear only in *Take over* | integration, manifest gate |
| AC-E14 | The terminal fills the viewport and its control strip never scrolls away | e2e, viewport matrix |
| AC-E15 | The driving banner reflects real autopilot state, not a cached flag | integration, toggle autopilot and observe |
| AC-E16 | Server binds loopback only | integration, external-interface bind refused |
| AC-E17 | A mutating request without the run token is refused | integration |
| AC-E18 | A WebSocket upgrade from a foreign origin is refused | integration |
| AC-E19 | CSP blocks inline script and every external origin | e2e, header + violation assertion |
| AC-E20 | Every mutating endpoint is refused when guardrails deny it | integration, guard denying fixture |
| AC-E21 | Retired tabs' functionality is all reachable in the new IA | integration, feature-parity checklist derived from the audit table |
| AC-E22 | Full workflow, end to end: submit a standing order, watch it run, take over, stop it, find it in history | e2e, real session |

AC-E21 is the anti-regression criterion — it is what stops a redesign from
quietly losing a capability. AC-E22 is the one that proves the five modes work as
a system rather than as five screens.

## Out of scope

- Any authentication beyond the loopback + run-token model. Remote access is a
  different threat model and nobody has asked for it.
- Theming beyond light/dark.
- Replacing `xterm.js` or the pty host.
- `OI-015`'s remaining half, which needs Kyle at the machine — it is carried into
  A's inventory and surfaced here, not silently absorbed.

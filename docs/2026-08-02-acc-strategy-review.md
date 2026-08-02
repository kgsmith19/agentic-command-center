# Agentic Command Center — objective strategy review

Prepared 2026-08-02. Scope: is the current build strategy for `guards` (the
Agentic Command Center) the right one, given where the ecosystem actually is
today — not where it was when the project started. Backed by four
research passes (Anthropic's own docs/blog, community tooling with real
GitHub data, academic/industry reliability literature, and Windows
infrastructure practice) plus direct verification of the highest-stakes
claims. 45 sources, deduplicated list at the end.

## Bottom line

**Not wrong in mission or values. Behind on mechanism, ahead on discipline.**

The parts of this project that are about *judgment* — cost/token discipline,
an enforced "log what you don't fix" ledger, red-first TDD, hooks as the
extension point instead of forking the CLI — are genuinely good and, per the
research below, ahead of what most solo builders in this space do. The part
that's behind is the *continuity mechanism*: driving an interactive terminal
via ConPTY + keystroke/pipe injection to fake a human typing "continue" is
solving a problem Anthropic has since built native, better answers for —
`--worktree`, agent view/teams, `routines`, `/loop`'s Monitor tool, and a
richer hook surface than guards currently uses. This isn't a strategy
failure; it's what happens when you build ahead of a fast-moving platform.
The fix is incremental adoption of what now exists, not a rewrite.

One correction up front, because getting this right matters more than
looking thorough: initial research surfaced that Agent SDK/`claude -p` usage
stopped counting against subscription limits as of June 15, 2026, which
would have been a strong argument for migrating the headless job runner onto
the SDK. **I fetched Anthropic's own page directly to confirm it, and that
change was paused before it took effect** — as of the June 16, 2026 update
notice on that page, Agent SDK and `claude -p` usage still draw from the
same subscription limits as interactive use, exactly as before. The
architectural case for the SDK stands on its own merits (below); the
economic case does not currently exist. Flagging this because it's the kind
of thing that's easy to state confidently and be wrong about.

---

## What's already right — don't relitigate these

- **Hooks as the extension point.** SessionStart/Stop/UserPromptSubmit are
  the correct primitives, not a workaround. The gap is under-using the newer
  ones (below), not the choice to hook at all.
- **Cost/token discipline.** The week kill-switch, budget.mjs context
  tracking, and usage-tier awareness are validated hard by the research: real,
  documented overnight-runaway incidents in this exact space run to
  **$6,000** and **$1,800 in two days**. This is not overengineering; it is
  the single most load-bearing safety mechanism in the whole harness.
- **OPEN-ISSUES.md ledger discipline.** The literature on autonomous-agent
  audit trails calls exactly this pattern out as good for human-facing
  intent tracking — it just isn't a full audit trail (more below).
- **TDD-red-first + a coverage floor at all.** Unusually rigorous for a
  personal project. The floor's *number* deserves a second look (below); the
  discipline of enforcing one does not.
- **The lane.mjs concurrency/backoff/circuit-breaker work.** Textbook-correct
  against AWS's own guidance (full jitter, bulkhead, breaker). One honest
  caveat from the reliability research: transport failures don't actually
  appear in the academic failure taxonomy for autonomous agents (see R2) —
  it's good engineering aimed at a real but secondary risk, not the dominant
  one.
- **Building custom at all, on Windows.** Every community tool the research
  found — claude-squad, ccmanager, Conductor, Claudia — is Mac/Linux-first or
  Mac-only. Windows + headless job scheduling + GUI supervision together is
  a genuine gap nothing off-the-shelf fills. That's a real reason to keep
  building, not a rationalization.

---

## Ranked recommendations

Ordered by ROI (impact vs. cost), not by how interesting each one is.

### R1 — Session-scoped activation, not a global always-on toggle

**This is what your mid-turn message was pointing at, and it's already bitten
you once.** AGENTS.md states `guard.mjs` is registered in
`~/.claude/settings.json` for **all projects** — meaning any `claude` you
type in any terminal, anywhere, is already subject to it, whether or not you
wanted ACC involved. The routing hook (`route.mjs`) works the same way
across your whole `C:\code` tree per its own description. Your own ledger
already documents the failure mode this causes: **OI-006** — running a hook
by hand against live state rebinds a real goal to a fake session and quietly
breaks it — and **OI-005** notes self-protection is currently *off* despite
docs claiming otherwise, which is the accidental, undocumented version of
the isolation you're now asking for on purpose.

**Fix:** an environment-variable gate, not the existing manual GUI toggle
(which is global and easy to forget exactly when you need it most — while
editing ACC itself). `guards-gui.ps1` and `runner.mjs` already set
`ACC_GOAL`/`ACC_PROFILE`/`ACC_PTY` at spawn; add one more (`ACC_SESSION=1`,
say) and have every ACC hook check for it first, no-op cleanly if absent. A
plain `claude` you type yourself then behaves like vanilla Claude Code by
construction, not by remembering to flip a switch — and a session where
you're tweaking ACC's own hooks is naturally isolated from the hooks it's
editing. Cheap (a few lines per hook file), directly requested, closes two
open ledger items at once.

### R2 — A hard deadline on the goal loop, independent of self-declared "done"

Currently the loop "only ends because the model ends it"
(`goal.mjs done`/`blocked`). The reliability research is unusually consistent
on why this specific design is the risky one, not transport failures:

- The most-cited failure-mode study for multi-agent LLM systems (MAST,
  UC Berkeley) finds premature termination and incorrect self-verification
  among the dominant failure clusters — and transport/rate-limit failures
  don't appear in its taxonomy at all.
- METR's own autonomy research explicitly warns that a model's measured
  "time horizon" is *not* a safe delegation window, and that self-assessed
  completion is unreliable — their own RCT found developers were 19% slower
  with AI while believing they were 20% faster, the same kind of
  self-assessment error an unbounded loop implicitly trusts.
- A hazard-rate model of agent success (Ord) gives a principled rule: set
  checkpoints as a fraction of the model's empirical "half-life," not "run
  until it says stop."

**Fix:** add a wall-clock and/or turn-count ceiling per goal cycle,
independent of `goal.mjs done`, that forces a checkpoint regardless of what
the model believes. This is the cheapest, most evidence-backed change in
this whole review.

### R3 — Adopt the hook surface that already exists before rebuilding continuity

Claude Code's hooks already cover most of what `clearbot.ps1` fakes by
typing: `SessionStart`'s `initialUserMessage` (replaces typing "Continue the
active ACC goal."), `Stop`'s `{"decision":"block"}` (the sanctioned
auto-continue), `PreCompact`/`PostCompact` (the context-window event
currently handled by typing `/clear`), and `Notification` matchers for
`idle_prompt`/`agent_needs_input` (native stuck-session detection, instead
of watching for a dead heartbeat file). This is incremental — swap one
injection point at a time, keep ConPTY for anything you still want to watch
by hand — and it directly shrinks the trap list in `notes/ACC-HANDOFF.md`,
nearly all of which traces back to driving a terminal like a human.

### R4 — Re-baseline the cost/migration case now that the SDK credit is paused

Don't move `runner.mjs` off `claude -p` on the assumption it's now
billed differently — it isn't, currently. The architectural case for the
Agent SDK (structured `stream-json` transcripts, native session
resume/fork, in-process hooks) still stands independent of billing; just
don't sequence it as an urgent cost win, because that specific premise
didn't survive verification. Recheck this article
(`support.claude.com/.../use-the-claude-agent-sdk-with-your-claude-plan`)
before making the call — Anthropic's own note says they're "working to
update the plan" and will announce before anything takes effect.

### R5 — Move headless job supervision off Task Scheduler and onto WinSW

Task Scheduler is built for "run and exit at time T," not "must never stop."
Concretely: it can silently drop triggers under load, needs elevation for
anything unattended, and — this is the one that matters most for a job
runner — **the SCM's restart-on-failure logic doesn't even fire unless the
process dies without reporting a clean stop**, so a `claude -p` job that
exits nonzero cleanly won't get relaunched the way you'd assume. WinSW
(actively maintained, unlike NSSM which hasn't shipped since 2017) wraps
your existing `runner.mjs` unmodified — roughly a day of work, zero GUI
impact. Note this doesn't and can't fix interactive-session revival — a
service can't touch your desktop session, so `clearbot.ps1`'s turn-boundary
revive logic for that half of the problem is the right shape already, not a
workaround to replace.

### R6 — Keep the coverage floor as a minimum; add mutation testing as the real signal

The most-cited study on this (Inozemtseva & Holmes, ICSE 2014) found that
once suite size is controlled, coverage correlates only weakly with actual
fault-finding, and branch coverage adds no extra signal over line coverage —
directly undercutting a 90%-branch gate *as a quality claim*, though not as
a floor (Google's own internal guidance treats 90% as "exemplary," not
"required"). The sharper risk specific to this project: a 2026 replicability
study on LLM-generated test suites examines exactly your situation — a model
writing tests to satisfy its own coverage gate against code it just wrote —
and names the failure mode directly: high coverage, weak assertions, bugs
encoded as expected behavior. Keep 100/100/90 as the floor (it's cheap and
it's already working). Add mutation testing (Stryker, for the JS side) as
the metric that actually tells you whether the tests would catch a real
bug, since coverage number alone can't.

### R7 — The bigger move: migrate unattended continuity off ConPTY, keep it for sessions you watch

This is the one with real cost, so sequence it last, after R1-R6 buy down
risk cheaply. The ConPTY + `WriteConsoleInput` approach isn't imaginary
fragility — it's documented at the vendor level (open `microsoft/terminal`
issues: heap corruption in `CreatePseudoConsole`, hangs in
`ClosePseudoConsole`, resizes silently dropped near client attach) — and
Microsoft's own `node-pty` (what VS Code uses) already dropped the older
`winpty` path entirely and absorbed these fixes; the hand-rolled P/Invoke in
`gui/PtyHost.cs` is rebuilding a wheel that's already been hardened
elsewhere. For the *unattended* loop specifically, headless mode's
`--input-format stream-json --output-format stream-json
--replay-user-messages` gives a structured, programmatic transcript and real
permission callbacks — no terminal to drive at all. Keep the ConPTY/xterm.js
terminal for sessions you're actually watching; that's a legitimate,
even Anthropic-validated use (their own team-agents feature uses `tmux
send-keys` for the same reason, and has shipped bugs for exactly that
reason too — the technique is real, just fragile, at the vendor's own
admission).

### R8 — If a UI rewrite happens, go local web app before Tauri/Electron

Not urgent on its own — only matters once R7 removes ConPTY's reason to
exist inside WinForms specifically. When it comes up: a small local
Node/Vite server + browser tab is the cheapest path (reuses the xterm.js
work already done, no packaging, no Rust) and upgrades cleanly into Tauri
later if you ever want a "real app." Going straight to Tauri or Electron
now would be a full rewrite for comparatively little near-term benefit. If
you stay on WinForms in the meantime, the only PowerShell-specific advice
worth taking is splitting the 2,700-line single file into `.psm1` modules —
but treat that as throwaway work if R8 eventually happens anyway; don't do
it first.

### R9 — Structured spans alongside the ledger, not instead of it

Lower urgency. OPEN-ISSUES.md is good for *why* something was done; it's not
queryable or tamper-evident, and doesn't prove the agent did what it logged.
The field has converged on OpenTelemetry's GenAI semantic conventions for
this (agent/tool/model spans); Claude Code already emits some. Worth adding
once R1-R7 are stable, not before.

---

## What this doesn't change

The core design decisions in AGENTS.md — goals binding to console PID not
session id, goal text reaching the model only through injected context never
through typed fragments, the runbox pattern for handing blocked work back to
you, cell ownership — are sound regardless of which continuity mechanism
sits underneath them. R7 changes *how* a session continues, not *what* a
goal is or how ownership works. None of the above requires touching
`goal.mjs`'s data model.

---

## Sources

**Anthropic official**
1. Agent SDK overview — https://code.claude.com/docs/en/agent-sdk/overview
2. Work with sessions (continue/resume/fork) — https://code.claude.com/docs/en/agent-sdk/sessions
3. Run Claude Code programmatically (headless) — https://code.claude.com/docs/en/headless
4. Hooks reference — https://code.claude.com/docs/en/hooks
5. Intercept agent behavior with hooks (SDK) — https://code.claude.com/docs/en/agent-sdk/hooks
6. Checkpointing — https://code.claude.com/docs/en/checkpointing
7. Create custom subagents — https://code.claude.com/docs/en/sub-agents
8. Output styles — https://code.claude.com/docs/en/output-styles
9. Run parallel sessions with worktrees — https://code.claude.com/docs/en/worktrees (fetched and confirmed directly)
10. Run agents in parallel — https://code.claude.com/docs/en/agents
11. Hosting the Agent SDK — https://code.claude.com/docs/en/agent-sdk/hosting
12. Automate work with routines — https://code.claude.com/docs/en/routines
13. Agent SDK streaming vs single mode — https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
14. Effective harnesses for long-running agents — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
15. Building agents with the Claude Agent SDK — https://claude.com/blog/building-agents-with-the-claude-agent-sdk
16. Building effective AI agents — https://www.anthropic.com/engineering/building-effective-agents
17. Use the Claude Agent SDK with your Claude plan — https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan (fetched directly — **credit change is paused**, corrected above)
18. Get started with Claude Cowork — https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
19. anthropics/claude-quickstarts (autonomous-coding reference) — https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding

**Community tooling (verified against real repo activity)**
20. smtg-ai/claude-squad — https://github.com/smtg-ai/claude-squad
21. kbwo/ccmanager — https://github.com/kbwo/ccmanager
22. Jedward23/Tmux-Orchestrator (abandoned mid-2025) — https://github.com/Jedward23/Tmux-Orchestrator
23. "97% of tools are stubs" — ruflo/claude-flow audit — https://github.com/hesreallyhim/awesome-claude-code/issues/1338
24. Team agents tmux send-keys race condition — https://github.com/anthropics/claude-code/issues/23513
25. anthropics/claude-code-action (GitHub Actions) — https://github.com/anthropics/claude-code-action
26. Boris Cherny announcing built-in worktree support — https://x.com/bcherny/status/2025007393290272904
27. Hands-on review of Conductor — https://thenewstack.io/a-hands-on-review-of-conductor-an-ai-parallel-runner-app/
28. "Someone left Claude Code running overnight, and it cost $6,000" — https://www.makeuseof.com/someone-left-claude-code-running-overnight-and-it-cost-6000/
29. Claudia (Tauri 2 + React reference architecture) — https://github.com/marcusbey/claudia
30. CloudCLI/claudecodeui — https://github.com/siteboon/claudecodeui

**Reliability & fault-tolerance research**
31. Why Do Multi-Agent LLM Systems Fail? (MAST) — https://arxiv.org/abs/2503.13657
32. Measuring AI Ability to Complete Long Tasks (METR) — https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/
33. Clarifying limitations of time horizon (METR, Jan 2026) — https://metr.org/notes/2026-01-22-time-horizon-limitations/
34. Is there a half-life for the success rates of AI agents? — https://arxiv.org/abs/2505.05115
35. Measuring the Impact of Early-2025 AI on Experienced OSS Developer Productivity (METR RCT) — https://arxiv.org/abs/2507.09089
36. Why we no longer evaluate SWE-bench Verified (OpenAI) — https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/
37. LLMs Get Lost In Multi-Turn Conversation — https://arxiv.org/abs/2505.06120
38. Coverage Is Not Strongly Correlated with Test Suite Effectiveness (ICSE 2014) — https://dl.acm.org/doi/10.1145/2568225.2568271
39. Code Coverage Best Practices (Google Testing Blog) — https://testing.googleblog.com/2020/08/code-coverage-best-practices.html
40. Do Coverage and Mutation Scores of LLM-Generated Test Suites Correlate with Effectiveness? — https://arxiv.org/abs/2607.22880
41. Timeouts, retries, and backoff with jitter (AWS Builders' Library) — https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter
42. Embracing Risk / error budgets (Google SRE Book) — https://sre.google/sre-book/embracing-risk/
43. OpenTelemetry GenAI Semantic Conventions — https://github.com/open-telemetry/semantic-conventions-genai

**Windows infrastructure**
44. ConPTY `CreatePseudoConsole` heap corruption — https://github.com/microsoft/terminal/issues/15142
45. node-pty: remove winpty support — https://github.com/microsoft/node-pty/issues/842
46. Servy vs. NSSM vs. WinSW — https://dev.to/aelassas/servy-vs-nssm-vs-winsw-2k46
47. Windows Task Scheduler's Trigger Traps — https://jamsscheduler.com/resources/blog/windows-task-scheduler-s-trigger-traps

## What's contested or thin

- The coverage-floor critique (R6) has real counter-evidence too — some
  studies find continued defect reduction into the 80-100% band. Treat R6 as
  "add a second signal," not "the floor was wrong."
- MAST's failure taxonomy was built on GPT-4/Claude 3-era traces;
  generalization to current models is Berkeley's own caveat, not mine.
- "Awesome-claude-code" style roundups and star counts are not reliable
  signal on their own — the ruflo/claude-flow case (source 23) is the
  concrete example of why; every tool recommendation above was checked
  against actual recent commit activity, not stars.

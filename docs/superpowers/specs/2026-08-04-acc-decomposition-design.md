# Service decomposition and naming migration — design (sub-project J, absorbing C)

- date: 2026-08-04
- status: approved (Kyle, 2026-08-04: "#3 sounds like the best approach…
  microservice, separate service approach… I do like the renaming as long as we
  are able to update all areas… any services we break out need their own repo
  that is tracked in GitHub as well")
- scope: split one 5,100-line repo into six repos, rename the concepts that are
  unclear, and update every consumer — with the running system never broken
- standard: `2026-08-04-acc-standards-design.md` applies in full
- absorbs: sub-project **C** (guards `OI-026`, rename the "goal" concept)
- ledger: guards `OI-026`, `OI-022`

C is absorbed because C and J are the same migration performed twice. Doing them
separately would rename `goal` → `standing order` across ~40 files, then move
those same files to new repos a week later. One migration, one set of churn.

## Where the boundaries are, and why they are not all network boundaries

The honest constraint, stated before the split: **most of this code cannot become
a network service without becoming worse.**

`kernel/guardhook.mjs` is a `PreToolUse` hook — Claude Code spawns it on *every
tool call*. Behind HTTP it adds latency to every tool use and creates a
fail-open/fail-closed dilemma with no good answer: fail open and the boundary is
decorative; fail closed and one dead process bricks every session on the machine.
`hooks/budget.mjs`, `statusline.mjs` and `usage.mjs` are the same shape —
stdin→stdout processes Claude Code owns the lifecycle of.

So the rule for this split is:

> **Separate repos everywhere. Network boundaries only where a process boundary
> already exists** — the autopilot daemon and the UI server.

Everything else is a package: independently versioned, independently tested,
independently readable by an agent, consumed in-process. That delivers Kyle's
actual stated goal ("smaller programs that are easier to understand the context
of") without paying latency for it.

## The six repos

| Repo | Owns | Does not own | Boundary | ~lines |
|---|---|---|---|---|
| `agent-repo-gates` | covgate, testplan, pre-push, the inventory tool, the shared `OPEN-ISSUES` template | anything runtime | dev dependency | ~350 |
| `agent-guardrails` | the deny-by-default path policy, `PreToolUse` guardhook, the runbox approval queue, engine CLI, vault | what to *do* with an allowed action | package + hooks | ~650 |
| `claude-session-telemetry` | budget bands, usage accounting, statusline, cmdline, prompt capture, routing | anything that decides or drives | package + hooks | ~2,000 |
| `agentic-command-center` | standing orders, the autopilot daemon, runner, launch lane, execution core, policy, ledger | rendering anything | daemon | ~1,500 |
| `agentic-command-center-ui` | web app, pty host, launcher | any decision logic | HTTP service | ~400 + new |
| `claude-launch-cap` | machine-wide concurrent-`claude.exe` cap and its scheduled task | anything else — it stays standalone by design | standalone task | ~200 |

`claude-launch-cap` stays deliberately dependency-free. Kyle, 2026-08-04: *"I do
like the idea of it being standalone as I'll likely use this for future things."*

### Boundary statements each repo's AGENTS.md must carry

Stated here so they are decided once rather than argued per repo:

- **guardrails** answers one question: *may this action happen?* It never
  performs the action and never knows why it was requested.
- **telemetry** answers: *what is this session's state?* It reads and reports; it
  never decides and never writes to another repo's store.
- **command-center** answers: *what should happen next, and did it?* It owns
  every decision, the standing-order store, and the ledger.
- **ui** answers: *what does Kyle see, and what did he click?* It holds no
  decision logic; every button calls command-center.
- **launch-cap** answers: *are there too many claudes?* Nothing else.
- **repo-gates** answers: *does this repo meet the standard?*

A change that makes one repo answer another's question is the signal the boundary
was wrong — that is a ledger entry, not a quiet fix.

## The renames

Kyle: *"think about the names of our key processes in general… It needs to be
clear what it does, unambiguous to AI, and super lean and simple."*

| Today | Becomes | Why |
|---|---|---|
| `goal` / `hooks/goal.mjs` / `[ACC GOAL g-…]` | **standing order** / `standing.mjs` / `[ACC STANDING so-…]` | collides with Claude Code's own vocabulary and a popular plugin (`OI-026`); "standing order" says what it is — an instruction that stands until met and survives `/clear` |
| `clearbot` / `clearbot.ps1` | **autopilot** / `autopilot.ps1` | it clears, kicks, *and* auto-approves; the old name describes one of three jobs |
| `guards` (the concept) | **guardrails** | "guards" reads as a generic noun; the repo is `agent-guardrails` |
| `kernel/` | **`core/`** | "kernel" collides with OS vocabulary and misleads an agent about scope |
| `runbox` | *unchanged* | already concrete and lean, and it is load-bearing in `/approve-kgs`, AGENTS.md and Kyle's habits — renaming it is churn with no clarity gain |
| `C:\code\guards` (folder) | **`C:\code\agentic-command-center`** | folder and remote finally agree |

Store migration for the rename: `runner/goals/{active,done}/*.json` →
`runner/standing/{active,done}/*.json`, with `goalId`→`id` prefix `g-`→`so-`, and
`policy.json` `goals.*` → `standing.*`. The migration is **idempotent** and runs
on first start; a store already migrated is a no-op. Legacy files are moved, not
copied — two stores would let the loop read the stale one.

## The mechanism that makes the move safe

The migration's real risk is not moving files. It is the ~15 absolute paths
outside every repo that point *into* it, which no repo's test suite can see:

| Consumer | Holds | Notes |
|---|---|---|
| `~/.claude/settings.json` | 8 hook registrations: `guard.mjs`, `budget.mjs` ×4, `statusline.mjs`, `testplan.mjs` | itself `config.protected` — edits go through the runbox lane |
| `~/.claude/CLAUDE.md` | `engine.mjs`, `AGENTS.md`, `runbox\` | Kyle's global instructions |
| `C:\code\ROUTING.md` | `route.mjs` | |
| `C:\code\CLAUDE.md` | repo-root conventions | |
| `config.json` | runbox path, `protected`, `writeRoots`, `denyRoots`, `projects` | |
| `ACC-ClaudeCapWatch` scheduled task | `watcher/claude-cap-watch.ps1` | re-register, do not hand-edit |
| `/approve-kgs` skill | `node C:/code/guards/hooks/engine.mjs` | in `~/.claude/skills` |
| `hooks/budget.mjs`, `usage.mjs` | absolute paths **inside user-facing message strings** | a stale path here tells Kyle to run a command that no longer exists |
| ~20 `*.test.mjs` | sandbox assertions of the form "never `C:/code/guards`" | these protect live state; a missed one silently disarms a safety check |

**The fix is not a careful find-and-replace.** It is to delete the class of
problem:

1. **No repo references itself by absolute path.** Every self-reference resolves
   from `import.meta.url`. A repo that does not know where it is cannot be broken
   by moving it.
2. **Every Claude Code integration point is written by an installer**, never by
   hand. Each repo ships `npm run install-hooks`, which computes its own absolute
   path at install time and upserts its registrations into `settings.json`
   through the runbox lane. After any move, the recovery procedure is one
   command per repo, not an audit.
3. **Cross-repo references are package dependencies**, never paths.
4. **User-facing strings that name a command are generated from the resolver**,
   so a stale instruction string becomes impossible rather than unlikely.
5. **The sandbox assertions become one shared helper** in `agent-repo-gates`
   (`assertNotLiveRoot()`), so there is one place to be right instead of twenty.

Point 2 is the high-ROI one: it converts a one-time migration hazard into a
repeatable, testable command, and it is what makes the *next* move cheap.

## Migration order

Each step is a slice; the system is fully working at the end of every one.

1. `agent-repo-gates` extracted, published, consumed by the origin repo. Nothing
   depends on it yet, so it is the safest first move.
2. Path de-hardcoding + `install-hooks` installers, still inside one repo.
   **Proof: the installer round-trip is exercised against a fixture
   `settings.json` before it is ever pointed at the real one.**
3. `goal` → standing order, in place, with the idempotent store migration.
4. `clearbot` → autopilot, `kernel/` → `core/`, in place.
5. Folder rename `C:\code\guards` → `C:\code\agentic-command-center`; re-run
   every installer; re-register the scheduled task.
6. `claude-launch-cap` extracted (smallest, zero inbound dependencies).
7. `agent-guardrails` extracted.
8. `claude-session-telemetry` extracted.
9. `agentic-command-center-ui` extracted — the UI repo D and E then build in.

History is preserved per extraction via `git subtree split`, because the ledger
and every spec in `docs/` reference commit hashes.

Step 5 is the only irreversible-feeling one. Its slice carries a written rollback:
the rename is a directory move plus re-running installers, so the reverse is the
same two commands with the old path.

## Acceptance criteria

| AC | Statement | Test |
|----|-----------|------|
| AC-J1 | No source file in any repo contains an absolute path to its own repo | integration: grep gate in `agent-repo-gates`, run by CI |
| AC-J2 | `install-hooks` upserts its registrations into a fixture `settings.json` and is idempotent when run twice | integration, fixture |
| AC-J3 | `install-hooks` never duplicates or removes another repo's registrations | integration, fixture pre-seeded with all six repos' entries |
| AC-J4 | After a simulated repo move, `install-hooks` restores every registration to the new path | integration, temp dirs |
| AC-J5 | Standing-order store migration converts a legacy `goals/` store and leaves no legacy file behind | integration, real fixture store |
| AC-J6 | The migration is idempotent — a second run changes nothing | integration |
| AC-J7 | A legacy `[ACC GOAL g-…]` injection is still understood for one release, and logs a deprecation | unit |
| AC-J8 | No file in any repo contains `goal`/`clearbot`/`kernel` in the renamed sense | integration, grep gate with an allowlist for genuine other uses |
| AC-J9 | Each of the six repos passes the full gate set standalone | CI, per repo |
| AC-J10 | Each repo ships every section-5 artifact from the standard | `npm run gates` |
| AC-J11 | Each repo exists on GitHub under `kgsmith19/` and its default branch is pushed | integration, `gh repo view` per repo |
| AC-J12 | Extracted repos retain the commit history of the files they own | integration, `git log` finds a known pre-split commit |
| AC-J13 | `assertNotLiveRoot()` is used by every suite that previously hardcoded the sandbox check, and fails when pointed at a live root | unit + grep gate |
| AC-J14 | The whole system works after each step: a real session binds a standing order, autopilot kicks it, the guard denies a protected write | e2e, run at the end of every migration slice |
| AC-J15 | Every user-facing string naming a command resolves its path at runtime | unit, snapshot after a simulated move |

AC-J14 is the one that matters. It is the only criterion that proves the system
still *works*, as opposed to still *builds*, and it runs nine times.

## Out of scope

- Splitting the execution core out of `agentic-command-center`. Its only consumer
  is command-center itself; a boundary with one consumer is speculative
  generality. Revisit when a second consumer exists.
- Turning any package into a network service. Explicitly rejected above.
- Publishing to a registry. Repos consume each other from git refs until they are
  stable; Kyle: *"eventually try to make things into imported libraries or
  packages when they become more stable."* That "eventually" is a later decision,
  and this spec does not pre-empt it.

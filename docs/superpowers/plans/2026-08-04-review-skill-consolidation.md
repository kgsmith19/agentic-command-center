# Review Skill Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate Kyle's scattered review skills into `~/.claude/skills` under a `-kgs` naming convention (identifying them as his own, vs. Claude Code built-ins or third-party plugin skills), and add new composite `full-diff-review-kgs` / `full-repo-review-kgs` skills that bundle leanness, security, and a new documentation-review lens.

**Architecture:** Ten `SKILL.md` files live in `~/.claude/skills` (user scope — available in every project Kyle opens, including `guards`, which currently has none of its own). Five are renames/moves of existing skills with no behavior change; one is a rewrite (dropping project-specific content); four are new. Two of the new ones are composites that sequentially invoke the others in the main thread and consolidate findings with one `ReportFindings` call. Three files outside `~/.claude/skills` get small reference updates so they name the new skills correctly.

**Tech Stack:** Markdown skill files with YAML frontmatter (`name`, `description`), no code. `~/.claude/skills`, `C:\code\.claude\skills`, and `C:\code\lifeos-ecosystem\.claude\skills` are plain directories, not git repos — no commit step applies to edits there. `C:\code\guards` is a git repo — its one edit (`hooks/budget.mjs`) does get committed.

**Checkbox-state notice (added 2026-08-06, Phase 8 of `docs/2026-08-03-full-remediation-prompt.md`):** every checkbox below is unchecked, but substantial-to-complete matching work already exists in the repo for most tasks in this plan (confirmed by cross-referencing `OPEN-ISSUES.md` and `git log`) — this plan predates the convention of checking boxes off as work lands, and was never gone back through to update them. Do not read an unchecked box here as "not done." `OPEN-ISSUES.md` and the current code are the source of truth for what actually shipped; this file records the ORIGINAL task breakdown, not live status.

## Global Constraints

- Every skill that refers to itself by slash-command name in its own body must use its **new** `-kgs` name; every skill that refers to a *sibling* skill it recommends running (e.g. resolve-issues telling you to also run `/sec-diff`) must be updated to that sibling's new `-kgs` name too. Generic mentions of "a repo's own security-review or sec-diff skill" (describing a naming *convention* that some *other*, unrelated repo might follow) are not self-references and must NOT be renamed — verbatim copied from `security-review-kgs`'s existing text.
- `sec-diff-kgs` must NOT carry lifeos-ecosystem's hardcoded "binding precedents" (the 11 numbered rules referencing `entity_domains`, `kernel:admin`, PHI, x-sensitive-boundary). Those are specific to that codebase's history. Replace them with a dynamic instruction to read the target repo's own precedents at review time, mirroring the sentence already in `security-review-kgs`.
- New skills (`lean-review-kgs`, `diff-review-kgs`, `doc-review-kgs`, and the two composites) must work in **any** repo, not just `guards` — no hardcoded tech stack. Where a gate/test command is needed, discover it (read `AGENTS.md`/`CLAUDE.md` for declared commands first, else infer from the manifest present: `package.json` scripts, `pyproject.toml` → ruff/mypy/pytest, `Cargo.toml` → cargo test/clippy, `go.mod` → go test/vet).
- `guards/hooks/budget.test.mjs`, `guards/hooks/goal.mjs`, and `guards/hooks/goal.test.mjs` have pre-existing uncommitted changes from unrelated work (confirmed via `git status` before this plan started). Do not touch, revert, or commit them. When staging the `budget.mjs` change, stage that file by exact name only — never `git add -A` or `git add .`.
- No test suite runs against `~/.claude/skills` content — verification for those ten files is: (a) frontmatter parses and `name` is unique within the directory, (b) a live dry-run invocation in a real session shows the described behavior. This is the project's stated "narrowest relevant check" for prompt-file changes, not a placeholder for real tests skipped.

---

### Task 1: Rename Kyle's three simple personal skills to `-kgs`

**Files:**
- Create: `C:\Users\kyleg\.claude\skills\approve-kgs\SKILL.md`
- Create: `C:\Users\kyleg\.claude\skills\goal-kgs\SKILL.md`
- Create: `C:\Users\kyleg\.claude\skills\security-review-kgs\SKILL.md`
- Delete: `C:\Users\kyleg\.claude\skills\approve\` (whole directory)
- Delete: `C:\Users\kyleg\.claude\skills\goal\` (whole directory)
- Delete: `C:\Users\kyleg\.claude\skills\security-review\` (whole directory)

**Interfaces:**
- Produces: three skills invocable as `/approve-kgs`, `/goal-kgs`, `/security-review-kgs`. `security-review-kgs`'s body sentence *"Honour any repo-local security precedents: read the target repo's `AGENTS.md` and, when present, its own security-review or `sec-diff` skill..."* is the generic-convention reference other tasks must copy verbatim (not rename) when they need the same idea.

- [ ] **Step 1: Write `approve-kgs/SKILL.md`**

Identical to the current `approve/SKILL.md` body, with every self-reference to the command renamed. Full content:

```markdown
---
name: approve-kgs
description: Run the script(s) Claude left in the guards runbox — typing /approve-kgs is the user's approval, replacing a trip to the Guards GUI. Use ONLY when the user explicitly typed /approve-kgs.
---

# /approve-kgs — run pending guards scripts from chat

The guards system (C:\code\guards\AGENTS.md) blocks agents from certain work;
the agent hands that work over as self-contained scripts in a runbox. The user
typing `/approve-kgs` IS the approval to run them — the in-chat equivalent of
clicking "Run" in the Guards GUI.

**Consent rule: this skill is only ever entered because the user typed
/approve-kgs.** Never invoke it yourself, and never call `engine.mjs run` outside
this skill. If you need a script executed, write it to the runbox, say what it
does, and ask the user to type /approve-kgs.

All engine calls: `node C:/code/guards/hooks/engine.mjs <command>`

## Steps

1. `list` — see every pending script (central runbox + each watched project).
2. Decide what to run:
   - `/approve-kgs <name>` — run the matching script(s) only.
   - Bare `/approve-kgs` and exactly one pending script — run it.
   - Bare `/approve-kgs` and several — if you wrote some of them this session,
     run those; otherwise show the list with each script's summary line and
     ask which to run.
3. Before each run, restate in one sentence what the script will do (from its
   leading comment — write scripts so that comment is accurate).
4. `run <name>` (or `label:name` if the name exists in two runboxes). The
   engine streams output back to you:
   - Success: one-shot scripts are auto-archived to the runbox trash
     (undo-able from the GUI); `# guards: keep` scripts stay for re-running.
   - Failure: the script stays in the runbox. Diagnose from the output, fix
     the script in place, and ask the user to /approve-kgs again — don't loop
     without changing anything.
5. Report what happened in plain language.

## Bootstrap (guards v1 still installed)

If `list` fails with a usage error, the engine predates v2. Run the pending
runbox script directly this one time — after restating what it does:
`powershell -NoProfile -ExecutionPolicy Bypass -File C:/code/guards/runbox/<script>.ps1`
(`node` for `.mjs`/`.js`, `cmd /c` for `.cmd`/`.bat`). The install-guards-v2
script upgrades the engine; everything after that goes through `run`.

## Hard limits

- Never run `flush` — emptying the trash is the user's GUI-only action.
- Never write a script that edits guards config/machinery to weaken a rule the
  user didn't ask to change; /approve-kgs doesn't change what scripts may do, only
  who triggers them.
- A script that prints secret values must not be run — rewrite it first
  (vault `apply` exists for that; see guards AGENTS.md).

## Writing scripts the flow expects

- Location: `<project>/.guards/runbox/` when the project is watched (check
  `status` → projects), else `C:/code/guards/runbox/`.
- First lines: a comment saying what it does and why (that's the preview),
  plus `# guards: keep` if it's a standing re-run button.
- Idempotent, minimal, absolute paths, no secret output.
```

- [ ] **Step 2: Write `goal-kgs/SKILL.md`**

```markdown
---
name: goal-kgs
description: Attach a persistent working condition to the active ACC goal — /goal-kgs <condition> logs it into the goal store so it survives /clear; /goal-kgs clear marks it met. Use ONLY when the user explicitly typed /goal-kgs.
---

# /goal-kgs — a condition that survives the clear/resume loop

ACC goal sessions (C:\code\guards\AGENTS.md, "Goals") are cleared and resumed
automatically; anything that must outlive a `/clear` has to live in the goal
store, not in the session. `/goal-kgs <condition>` puts the user's condition there.

**Never register a session Stop hook for a condition — that is the point of
this skill.** A Stop-hook gate fights the context-budget gate (OI-011): the
goal loop continues BY ending turns, so a hook that refuses to let a turn end
pins the session over its ceiling. Conditions are goal state, not hooks.

## Steps

1. Find the active goal id: the `[ACC GOAL g-...]` block injected at
   SessionStart carries it. (No block = no active goal; see step 4.)
2. On `/goal-kgs <condition>`:
   `node C:/code/guards/hooks/goal.mjs log <id> --text "CONDITION: <condition>"`
   Then treat the condition as a standing working directive for this goal —
   it reaches every post-clear session through the goal-log tail injection.
3. On `/goal-kgs clear`, or when the work satisfies the condition:
   `node C:/code/guards/hooks/goal.mjs log <id> --text "CONDITION MET: <condition — how it was met>"`
4. If no ACC goal is active: say so plainly, honor the condition as an
   in-session directive only, and suggest starting the work from the Command
   Center's Start-work tab if it needs to persist across clears.
5. Confirm in one line what was logged and where it now lives.

## Hard limits

- Do not edit goal JSON/state files directly; `goal.mjs log` is the only
  write path this skill uses.
- Do not end or block the goal from here (`done`/`blocked` belong to the
  goal's own finish rules, stated in the injected block).
```

- [ ] **Step 3: Write `security-review-kgs/SKILL.md`**

Identical body to current `security-review/SKILL.md` (it has no self-referential command mentions in the body, only in the frontmatter description), with the description's trigger name updated:

```markdown
---
name: security-review-kgs
description: Security review of the current work — the pending changes on the branch when inside a git repository, and the code under the current folder when not. Use when the user types /security-review-kgs, asks for a security review, or is about to commit something touching auth, input handling, SQL, serialization, subprocess or keystroke/console injection.
---

# Security review

Works with or without git. Being outside a repository is not a reason to refuse
— it only changes what "the current work" means.

## 1. Pick the targets

Run `git rev-parse --git-dir` in the current folder.

**Inside a repository** — review the pending change, in this order of
preference: uncommitted work (`git status --porcelain`, `git diff HEAD`) if
there is any; otherwise the branch versus its base (`git diff main...HEAD`, or
`master`); otherwise the most recent commit. This is the built-in behaviour and
it is the right default.

**Not a repository** — enumerate the direct child folders plus the loose files
in this one, and build the target list:

- child is a git repository → its pending change, by the rule above
- child is not a repository → the code files under it
- child holds no code (docs, data, build output, `node_modules`, `.venv`,
  `dist`, `.git` internals, binaries only) → **skip it, and say you skipped it
  and why**. A skipped folder is a reported outcome, never a silent omission.

If every target is skipped, still produce the report, and say plainly that
nothing had reviewable code. Do not refuse and do not ask the user to cd
somewhere else first.

## 2. Review

Read every target file before judging it. Look for, at minimum:

- **Injection** — SQL built by string interpolation, shell/`subprocess` with
  `shell=True` or unescaped arguments, path traversal, and **keystroke or
  console injection**: any code that types into another process, sends input to
  a terminal, or synthesises events. For those, the question is always *what is
  the closed set of things this can emit, and who controls it* — an injector
  driven by a caller-supplied string is a finding even when today's only caller
  is trusted.
- **Secrets** — credentials, tokens or keys in source, logs, error text,
  fixtures, or anything written to a file an agent can read.
- **Input validation at the boundary** — untrusted input reaching a parser,
  deserializer (`pickle`, `yaml.load`, `eval`), or a template.
- **Authn/authz** — missing checks, checks that can be skipped by an alternate
  path, scope or tenant confusion, privileges that widen silently.
- **Error handling** — raw exception text or stack traces reaching a client;
  expected client errors returned as 500; failures swallowed so a security
  control appears to pass.
- **Files and permissions** — world-writable paths, unsafe temp files, symlink
  following, archive extraction without path checks.

Honour any repo-local security precedents: read the target repo's `AGENTS.md`
and, when present, its own security-review or `sec-diff` skill, and apply those
binding precedents as well as the classes above.

## 3. Report

Findings first, ranked by severity, each as:

`path/file:line — what an attacker does, what they get, and the fix`

Then the skipped list with reasons, then anything you judged clean and why that
judgement is safe. State the exact commands you ran.

Do not fix anything in this pass unless the user asks — a security review that
also rewrites the code is hard to audit. Log what you do not fix to
`OPEN-ISSUES.md` per the repo's own rule, in the lowest folder containing the
fix.
```

- [ ] **Step 4: Delete the three old directories**

```bash
rm -rf "C:/Users/kyleg/.claude/skills/approve"
rm -rf "C:/Users/kyleg/.claude/skills/goal"
rm -rf "C:/Users/kyleg/.claude/skills/security-review"
```

- [ ] **Step 5: Verify**

Confirm the three new files exist, the three old directories are gone, and
frontmatter parses:

```bash
node -e "['approve-kgs','goal-kgs','security-review-kgs'].forEach(n => { const fs=require('fs'); const t=fs.readFileSync('C:/Users/kyleg/.claude/skills/'+n+'/SKILL.md','utf8'); if(!t.includes('name: '+n)) throw new Error(n+': name mismatch'); console.log(n+': OK'); })"
ls "C:/Users/kyleg/.claude/skills"
```

Expected: `approve-kgs: OK`, `goal-kgs: OK`, `security-review-kgs: OK` printed; `ls` shows only `approve-kgs`, `goal-kgs`, `security-review-kgs`, `resolve-issues` (removed in Task 2) plus whatever else already lived there — no bare `approve`, `goal`, or `security-review` directories.

No commit — `~/.claude/skills` is not a git repository.

---

### Task 2: Move and rename `resolve-issues` to `resolve-issues-kgs`

**Files:**
- Create: `C:\Users\kyleg\.claude\skills\resolve-issues-kgs\SKILL.md`
- Delete: `C:\code\.claude\skills\resolve-issues\` (whole directory)

**Interfaces:**
- Consumes: `security-review-kgs`, `sec-diff-kgs` (Task 3) — this skill's body recommends running them by their new names.
- Produces: skill invocable as `/resolve-issues-kgs`, now available in every project (previously only under `C:\code` itself, which doesn't cascade to `guards` or anywhere else).

- [ ] **Step 1: Write `resolve-issues-kgs/SKILL.md`**

Same body as the current file, with the self-referential description trigger renamed and the two sibling-skill mentions in "Landing the work" updated to their new names:

```markdown
---
name: resolve-issues-kgs
description: Work the standing OPEN-ISSUES.md ledgers down to zero — every entry ends the run fixed, shrunk-and-fixed, or explicitly retired with a reason. Highest-ROI order, leanest possible fix, no silent skipping. Use when the user says /resolve-issues-kgs, "clear the open issues", or "work the ledger".
---

# Resolve issues

The standing ledgers hold everything that was raised in a session and not
fixed. This skill exists to make that list go to zero — not to re-triage it,
not to re-explain it, not to produce a plan about it.

## The ledgers

`OPEN-ISSUES.md`, one per scope, at the lowest folder that fully contains the
fix:

- `C:\code\lifeos-ecosystem\lifeos\OPEN-ISSUES.md` — lifeos only
- `C:\code\lifeos-ecosystem\lifeos-ui\OPEN-ISSUES.md` — lifeos-ui only
- `C:\code\lifeos-ecosystem\OPEN-ISSUES.md` — spans both member repos
- `C:\code\guards\OPEN-ISSUES.md` — guards only
- `C:\code\OPEN-ISSUES.md` — spans guards and the ecosystem, or is about the
  harness itself (hooks, settings, skills, memory)

Collect every ledger at or below the session's cwd. Say in one line how many
open entries you found and where. If there are none, say so and stop — that is
a complete, successful run.

## Order: highest ROI first

Score each entry `impact × certainty / cost` and work strictly in that order.
Impact = what breaks or stays broken without it. Certainty = how sure you are
the fix is the right one. Cost = edit size + blast radius + verification time.
A one-line fix to a real correctness bug outranks a large refactor of a
cosmetic one, always. State the order in one line before starting; do not
write a plan document.

## Leanness: shrink the fix before you write it

Every entry gets this pass first, and it is where most of the value is:

1. **Is the ledger's proposed fix the fix?** It was written by someone who was
   busy with something else. Re-derive the smallest change that satisfies
   `done when`. Usually it is smaller than what was written down.
2. **Does existing code already do this?** Reuse beats adding. No new file,
   dependency, abstraction, or config knob unless the smallest correct change
   genuinely needs one.
3. **Can one change close two entries?** Merge them and say so.
4. **Is the entry actually a symptom of another entry?** Fix the cause, close
   both.

## Every entry reaches a terminal state

Nothing stays open at the end of a run. Exactly one of:

- **FIXED** — the change is in, and you ran the narrowest check that proves it
  (a specific test, a command, an observed behavior). Report what you ran and
  its actual result. "Should work" is not a terminal state.
- **SHRUNK + FIXED** — the entry as written was too large or partly
  speculative; you delivered the concrete core that satisfies `done when`, and
  the ledger line records exactly what was cut and why. The cut part is a new
  entry only if it is real work, never as a place to hide the hard half.
- **RETIRED** — the entry is genuinely no longer a problem (already fixed
  elsewhere, code deleted, premise wrong). Say which, in one line.

If an entry is blocked on something only Kyle can supply (a payment, a 2FA
prompt, a physical device, a credential), do not leave it open and do not stop
the run: write the self-contained script into `C:\code\guards\runbox\` with a
leading comment per `C:\code\guards\AGENTS.md`, move the entry to **BLOCKED —
runbox** with the script path, and keep going. Batch these and report them
together at the end.

A hard technical wall is not a reason to skip. Find the other way through:
different mechanism, different layer, narrower guarantee that still satisfies
`done when`. Only if every route is genuinely closed do you leave the entry
open — and then the ledger line must name the exact thing that blocked it and
the routes already tried, so the next run does not repeat them.

## Landing the work

- One branch + PR per repo. Never mix repos in one commit.
- Merge only on that repo's green CI.
- Run `/sec-diff-kgs` when the change touches auth, input handling, SQL, or
  serialization; `/security-review-kgs` before merging those.
- Behavior change ships with a test. Run the relevant suite; merge on green.
- Update each `OPEN-ISSUES.md` in the same commit as its fix: delete the
  entry, add a one-line record under `## Resolved`.

## Output

≤3 lines per entry: `OI-NNN — <state> — <what changed> — <check that ran>`.
Detail goes in the PR body, not the chat. Close with one line: entries closed,
entries retired, entries blocked-on-Kyle (with runbox paths), entries still
open (with the wall that stopped them).
```

- [ ] **Step 2: Delete the old directory**

```bash
rm -rf "C:/code/.claude/skills/resolve-issues"
```

- [ ] **Step 3: Verify**

```bash
ls "C:/code/.claude/skills"
node -e "const fs=require('fs'); const t=fs.readFileSync('C:/Users/kyleg/.claude/skills/resolve-issues-kgs/SKILL.md','utf8'); if(!t.includes('name: resolve-issues-kgs')) throw new Error('name mismatch'); console.log('OK')"
```

Expected: `C:/code/.claude/skills` no longer contains `resolve-issues` (directory may now be empty or gone entirely); `OK` printed.

No commit — neither `~/.claude/skills` nor `C:\code\.claude\skills` is a git repository (`C:\code` itself is not a git repo, confirmed during design).

---

### Task 3: Move `sec-diff` to `sec-diff-kgs`, stripping lifeos-ecosystem-specific precedents

**Files:**
- Create: `C:\Users\kyleg\.claude\skills\sec-diff-kgs\SKILL.md`
- Delete: `C:\code\lifeos-ecosystem\.claude\skills\sec-diff\` (whole directory)

**Interfaces:**
- Produces: skill invocable as `/sec-diff-kgs`. Its "repo-local precedents" instruction is worded to match `security-review-kgs`'s equivalent instruction, so later composite tasks can cite the same convention consistently.

- [ ] **Step 1: Write `sec-diff-kgs/SKILL.md`**

The "Binding precedents" section (11 numbered lifeos-ecosystem-specific rules) is removed entirely and replaced with a one-paragraph dynamic-read instruction. Everything else carries over with self-references renamed:

```markdown
---
name: sec-diff-kgs
description: Lean security pass over just the recent change — the working diff or the current branch vs main — against this repo's own binding precedents plus the standard vulnerability classes. Main thread, no fan-out. The small sibling of /security-review-kgs.
---

# Security diff review

Scope: the working diff (staged + unstaged); if the tree is clean, the current
branch vs main (`git diff main...HEAD`). Changed hunks and their immediate
context only.

**This does NOT replace `/security-review-kgs`.** The full independent-finder pass
is still MANDATORY before merging anything touching auth, input handling, SQL,
or serialization, and once system-wide at a queue end. `/sec-diff-kgs` is the cheap
pass you run on every other diff, where the full one would never have been run
at all.

## Budget

- **Main thread. No subagents.** Normal effort, not extended thinking.
- Only the diff. Follow a call path out of it just far enough to decide whether
  a finding is real.
- **≤10 findings**, ranked. A clean diff is one line: `CLEAN — <what you checked>`.
- Report exploitability honestly: reachable today, or latent-but-reachable-if.

## Repo-local precedents

Before applying the standard classes below, read the target repo's `AGENTS.md`
and, when present, its own `security-review` or `sec-diff` skill. Real findings
earn binding precedents specific to that codebase's domain model — apply those
first, as well as the classes below. This skill carries no hardcoded precedents
of its own, because it runs across every repo Kyle opens, not just the one
where a given precedent was earned.

## Standard classes (apply to what the diff actually touches)

Authn/authz on every new route and every new branch of an old one; input
validated at the boundary (expected client errors 4xx, never 500); SQL built by
parameterized queries only; deserialization of untrusted bytes; secrets in code,
logs, fixtures, or error text; SSRF on any new outbound fetch; scope checks on
new privileged entry points; anything crossing a declared sensitive-data
boundary (synthetic fixtures only — no operator personal content in code,
tests, commits, or PR text).

## Output

`file:line — class — what an attacker does — fix`, ranked by exploitability.
Then one line naming what you checked and found clean, so a later pass need not
re-tread it. Apply only unambiguous fixes inside the diff's blast radius; a fix
ships with the regression test that proves it.
```

- [ ] **Step 2: Delete the old directory**

```bash
rm -rf "C:/code/lifeos-ecosystem/.claude/skills/sec-diff"
```

- [ ] **Step 3: Verify**

```bash
ls "C:/code/lifeos-ecosystem/.claude/skills"
node -e "const fs=require('fs'); const t=fs.readFileSync('C:/Users/kyleg/.claude/skills/sec-diff-kgs/SKILL.md','utf8'); if(t.includes('entity_domains') || t.includes('kernel:admin')) throw new Error('lifeos-specific content leaked through'); if(!t.includes('name: sec-diff-kgs')) throw new Error('name mismatch'); console.log('OK')"
```

Expected: `C:/code/lifeos-ecosystem/.claude/skills` shows only `diff-review` and `lean-review` remaining (the ecosystem coordinators, untouched); `OK` printed with no lifeos-specific leakage.

No commit — `lifeos-ecosystem` is not a git repository (confirmed during design: `git -C C:\code\lifeos-ecosystem rev-parse --show-toplevel` fails).

---

### Task 4: Author `lean-review-kgs` (new, generic, whole-repo)

**Files:**
- Create: `C:\Users\kyleg\.claude\skills\lean-review-kgs\SKILL.md`

**Interfaces:**
- Produces: skill invocable as `/lean-review-kgs`. Five lenses (Simplicity, Clean code, Security-light-touch, Tests, Size & structure) — `full-repo-review-kgs` (Task 8) invokes this by name and relies on its "Findings first... state clean files as clean" output shape.

- [ ] **Step 1: Write `lean-review-kgs/SKILL.md`**

Modeled on the existing per-repo lean-review pattern (five lenses, findings-first, gate-before-commit) but with the tech-stack-specific parts (Python/FastAPI, ruff/mypy/pytest) replaced by generic discovery:

```markdown
---
name: lean-review-kgs
description: Review the whole current repo (or given paths) for simplicity, clean code, light security hygiene, test coverage, and structure — reuse beats abstraction, no speculative generality. Use when the user types /lean-review-kgs or asks for a lean/simplicity review of the whole codebase.
---

# Lean review

Review the repo's source, tests, and scripts (or the paths passed as
arguments). Work in the main thread.

Before reviewing, discover this repo's own standards: read its `AGENTS.md`
and/or `CLAUDE.md` for stated engineering standards, and apply those in
addition to the five lenses below — a repo's own stated conventions win over
generic defaults wherever they conflict.

Pass every file through five lenses:

1. **Simplicity (KISS)** — can the same behavior ship with less? Dead code,
   needless abstraction or indirection, speculative generality, duplication to
   merge into one implementation.
2. **Clean code** — names say what things are; each function does one thing;
   comments state only what code cannot; idiomatic for the repo's actual
   language and framework (infer from file extensions and the manifest —
   don't assume).
3. **Security (light touch)** — obvious violations only: input not validated
   at a boundary, secrets or PII in logs/errors/fixtures, expected client
   errors returned as 500. This is not a substitute for `/security-review-kgs`
   or `/sec-diff-kgs` — flag anything that looks security-sensitive and defer
   to those for real depth rather than going deep here.
4. **Tests** — every behavior has a test at the right tier; tests assert
   behavior, not implementation; no dead fixtures.
5. **Size & structure** — small functions, files that aren't doing too much,
   no new file whose job an existing file already covers.

## Gate command discovery

Before claiming a fix is safe, run the repo's own gate. In order of
preference:
1. A command explicitly declared in `AGENTS.md` or `CLAUDE.md` (e.g. "Run
   `npm test`" or "`.venv\Scripts\python -m pytest`").
2. Otherwise infer from the manifest present: `package.json` → its `test`/
   `lint` scripts; `pyproject.toml` or `requirements.txt` → `ruff check .`,
   `mypy`, `pytest`; `Cargo.toml` → `cargo test`, `cargo clippy`; `go.mod` →
   `go test ./...`, `go vet ./...`.
3. If neither exists, say so plainly and skip the gate step rather than
   guessing a command that doesn't exist in this repo.

## Rules of engagement

- List findings first (`file:line` — what, why, fix), ranked by value; state
  clean files as clean.
- Apply only clear wins. Skip churn: renames without payoff, style-only
  diffs, micro-optimizations at personal scale.
- Never trade functionality for brevity.
- Gate before any commit using the command discovered above; merge only on
  green CI where CI exists.
```

- [ ] **Step 2: Verify frontmatter and no name collision**

```bash
node -e "const fs=require('fs'); const t=fs.readFileSync('C:/Users/kyleg/.claude/skills/lean-review-kgs/SKILL.md','utf8'); if(!t.includes('name: lean-review-kgs')) throw new Error('name mismatch'); console.log('OK')"
ls "C:/Users/kyleg/.claude/skills" | grep -c "^lean-review-kgs$"
```

Expected: `OK`, then `1` (exactly one match, no duplicate directory).

- [ ] **Step 3: Dry-run invoke**

In a live Claude Code session with `~/.claude/skills/lean-review-kgs` present, type `/lean-review-kgs` against any small repo and confirm: it discovers a gate command (or says plainly there isn't one), produces findings in the `file:line — what, why, fix` shape, and does not hardcode a specific language.

No commit — `~/.claude/skills` is not a git repository.

---

### Task 5: Author `diff-review-kgs` (new, generic, diff-scoped sibling of lean-review-kgs)

**Files:**
- Create: `C:\Users\kyleg\.claude\skills\diff-review-kgs\SKILL.md`

**Interfaces:**
- Consumes: same five lenses as `lean-review-kgs` (Task 4), applied to the diff only.
- Produces: skill invocable as `/diff-review-kgs`. `full-diff-review-kgs` (Task 7) invokes this by name.

- [ ] **Step 1: Write `diff-review-kgs/SKILL.md`**

```markdown
---
name: diff-review-kgs
description: Lean review of just the current diff (working tree, or branch vs main if clean) for simplicity, clean code, and structure — the fast, diff-scoped sibling of /lean-review-kgs. Use when the user types /diff-review-kgs or wants a quick lean pass on recent changes only.
---

# Diff review

The default, lightweight review. `/lean-review-kgs` is the expansive whole-repo
pass; this one is lean by construction and should stay that way.

## Scope

Run `git rev-parse --git-dir` in the current folder. If this fails (not a git
repository), say so plainly and suggest `/lean-review-kgs` instead — there is
no diff to scope this to.

Otherwise: the working diff (staged + unstaged) if there is one; if the tree
is clean, the current branch vs main (`git diff main...HEAD`, or `master`).
Changed hunks and their immediate context only.

## Budget (limits, not suggestions)

- **Main thread only. No subagents, no fan-out, no extended thinking.**
- Read `git diff --stat` FIRST, then `git diff -U3` for the changed files
  only. Never open an unchanged file "for context" — if a finding truly needs
  one, read just the relevant function.
- Skip any single file over ~400 diff lines unless a finding requires it; say
  which files you skipped.
- **≤15 lines of output.**
- Do NOT re-run the full test suite. If you apply a fix, run only the
  narrowest check that covers it.

## Review

Same three of `lean-review-kgs`'s five lenses that apply to a diff-sized
window — simplicity (KISS), clean code, and size/structure — applied to the
changed hunks only. Skip the tests and full-security lenses here; those need
whole-file/whole-repo context and belong to `/lean-review-kgs` and
`/sec-diff-kgs` respectively.

## Output

Findings first (`file:line` — what, why, fix); apply only clear wins inside
the diff's blast radius. A clean diff is one line: `CLEAN — <what you
checked>`.

Security-sensitive diff (auth, input handling, SQL, serialization)? Run
`/sec-diff-kgs` alongside this — and the full `/security-review-kgs` before
merge.
```

- [ ] **Step 2: Verify frontmatter and no name collision**

```bash
node -e "const fs=require('fs'); const t=fs.readFileSync('C:/Users/kyleg/.claude/skills/diff-review-kgs/SKILL.md','utf8'); if(!t.includes('name: diff-review-kgs')) throw new Error('name mismatch'); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Dry-run invoke**

In a repo with an uncommitted change, type `/diff-review-kgs` and confirm it
scopes to the diff only, stays under ~15 lines of output, and correctly
declines (pointing at `/lean-review-kgs`) when run outside a git repo.

No commit — `~/.claude/skills` is not a git repository.

---

### Task 6: Author `doc-review-kgs` (new, dual-mode)

**Files:**
- Create: `C:\Users\kyleg\.claude\skills\doc-review-kgs\SKILL.md`

**Interfaces:**
- Produces: skill invocable as `/doc-review-kgs [diff|repo]`. `full-diff-review-kgs` (Task 7) invokes it in `diff` mode; `full-repo-review-kgs` (Task 8) invokes it in `repo` mode.

- [ ] **Step 1: Write `doc-review-kgs/SKILL.md`**

```markdown
---
name: doc-review-kgs
description: Review documentation for drift against the code and for leanness/organization — diff mode checks whether this change updated the docs it should have, repo mode sweeps all docs for staleness and bloat. Use when the user types /doc-review-kgs, asks for a documentation review, or as part of a composite review.
---

# Documentation review

Two modes, selected by an argument (`/doc-review-kgs diff` or
`/doc-review-kgs repo`). If no argument is given: use `diff` mode when
`git rev-parse --git-dir` succeeds and there is a pending change (working
diff, or branch vs main); otherwise `repo` mode.

## Diff mode

Did this change alter behavior, config, commands, or file layout without
updating the docs that describe them — `README`, `AGENTS.md`, `CLAUDE.md`,
docstrings, inline comments documenting the changed code? This flags drift
only, not general prose quality. For each doc that should have moved but
didn't, name it and the specific claim it now gets wrong.

## Repo mode

A broader sweep across all documentation in the repo:

- **Accuracy** — claims that are already stale regardless of the current
  diff: broken commands, outdated file paths, references to code or files
  that no longer exist.
- **Leanness and organization**, judged by the same derivability test the
  `/doctor` skill applies to `CLAUDE.md` files, generalized to all docs: could
  a session reconstruct this content by reading the code (`ls`, manifest,
  `--help`)? If yes, it's a cut candidate. Flag bloat, redundant sections
  duplicated across files, and content that isn't organized for fast
  scanning.
- **LLM/agent legibility** — is this doc structured so an agent working in
  the repo can find the relevant part quickly (clear headings, no wall-of-text
  sections mixing unrelated topics)? Flag docs that need restructuring, not
  rewriting for tone.

Bias in both modes: lean and surgical. Flag drift, staleness, and
disorganization; don't rewrite for style, and don't produce a sprawling
report — a handful of precise findings beats an exhaustive copyedit.

## Output

Findings first, each as `path/file:line-or-section — what's wrong — the fix`,
ranked by how misleading the gap is (a doc actively contradicting the code
outranks a merely-missing doc). Then one line stating what you checked and
found accurate/lean already, so a later pass need not re-tread it. Do not
rewrite documentation in this pass unless the user asks — apply only the
narrowest fix when the drift is unambiguous (e.g. a command that plainly no
longer exists).
```

- [ ] **Step 2: Verify frontmatter and no name collision**

```bash
node -e "const fs=require('fs'); const t=fs.readFileSync('C:/Users/kyleg/.claude/skills/doc-review-kgs/SKILL.md','utf8'); if(!t.includes('name: doc-review-kgs')) throw new Error('name mismatch'); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Dry-run invoke both modes**

Run `/doc-review-kgs diff` against a repo with a pending change that touches
a documented command, and `/doc-review-kgs repo` against a whole repo.
Confirm diff mode flags only drift from the current change, and repo mode
produces the broader staleness/leanness sweep without turning into a prose
copyedit.

No commit — `~/.claude/skills` is not a git repository.

---

### Task 7: Author `full-diff-review-kgs` (composite)

**Files:**
- Create: `C:\Users\kyleg\.claude\skills\full-diff-review-kgs\SKILL.md`

**Interfaces:**
- Consumes: `diff-review-kgs` (Task 5), `sec-diff-kgs` (Task 3), `doc-review-kgs diff` (Task 6).
- Produces: skill invocable as `/full-diff-review-kgs [extreme]`.

- [ ] **Step 1: Write `full-diff-review-kgs/SKILL.md`**

```markdown
---
name: full-diff-review-kgs
description: Composite diff review — runs diff-review-kgs (lean), sec-diff-kgs (security), and doc-review-kgs in diff mode, then reports one consolidated set of findings. Optional "extreme" argument also runs /doctor and /approve-kgs. Use when the user types /full-diff-review-kgs.
---

# Full diff review

Runs three lenses over the current diff, sequentially, in the main thread —
no subagents, no fan-out (matches the standing "main thread by default"
rule).

## Scope check

Run `git rev-parse --git-dir`. If this fails, say so plainly and suggest
`/full-repo-review-kgs` instead — there is no diff to review.

## Steps

1. Apply `/diff-review-kgs`'s review (simplicity, clean code, size/structure
   on the diff). Collect its findings; do not have it print its own report —
   hold the findings for the consolidated report in step 4.
2. Apply `/sec-diff-kgs`'s review (security classes plus this repo's own
   precedents, read per that skill's instructions) on the same diff. Collect
   its findings the same way.
3. Apply `/doc-review-kgs` in diff mode (docs drift against this same
   change). Collect its findings the same way.
4. Consolidate all findings from steps 1-3 into one `ReportFindings` call,
   most-severe first across all three lenses combined (don't group by
   lens — a real security finding outranks a style nit regardless of which
   pass caught it).

## Extreme mode

Only when the user explicitly runs `/full-diff-review-kgs extreme` — this is
rare and not the default. After step 4's consolidated report:

5. Run `/doctor` (the real Claude Code built-in health check, not a
   `-kgs` skill — it can't be wrapped, only invoked directly).
6. If doctor's report includes proposed fixes and the user approves them,
   they land in the guards runbox; then run `/approve-kgs` to execute them.

Extreme mode exists for the rare case where Kyle wants environment health and
any pending runbox scripts handled as part of the same pass, not as the
everyday review flow.
```

- [ ] **Step 2: Verify frontmatter and no name collision**

```bash
node -e "const fs=require('fs'); const t=fs.readFileSync('C:/Users/kyleg/.claude/skills/full-diff-review-kgs/SKILL.md','utf8'); if(!t.includes('name: full-diff-review-kgs')) throw new Error('name mismatch'); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Dry-run invoke**

Run `/full-diff-review-kgs` against a repo with a pending diff. Confirm it
runs all three lenses in the main thread (check the transcript for no
`Agent`/subagent tool calls during the review itself), and ends with exactly
one `ReportFindings` call combining all three lenses' findings, ranked by
severity rather than grouped by lens. Separately, confirm `/full-diff-review-kgs extreme` also invokes `/doctor` afterward.

No commit — `~/.claude/skills` is not a git repository.

---

### Task 8: Author `full-repo-review-kgs` (composite)

**Files:**
- Create: `C:\Users\kyleg\.claude\skills\full-repo-review-kgs\SKILL.md`

**Interfaces:**
- Consumes: `lean-review-kgs` (Task 4), `security-review-kgs` (Task 1), `doc-review-kgs repo` (Task 6).
- Produces: skill invocable as `/full-repo-review-kgs [extreme]`.

- [ ] **Step 1: Write `full-repo-review-kgs/SKILL.md`**

```markdown
---
name: full-repo-review-kgs
description: Composite whole-repo review — runs lean-review-kgs, security-review-kgs, and doc-review-kgs in repo mode, then reports one consolidated set of findings. Optional "extreme" argument also runs /doctor and /approve-kgs. Use when the user types /full-repo-review-kgs.
---

# Full repo review

Runs three lenses over the whole current repo, sequentially, in the main
thread — no subagents, no fan-out.

## Steps

1. Apply `/lean-review-kgs`'s review (simplicity, clean code, light security,
   tests, size/structure across the whole repo). Collect its findings; hold
   them for the consolidated report in step 4.
2. Apply `/security-review-kgs`'s review (the full independent-finder
   security pass, working with or without git as that skill already
   handles). Collect its findings the same way.
3. Apply `/doc-review-kgs` in repo mode (accuracy, leanness, organization
   across all documentation). Collect its findings the same way.
4. Consolidate all findings from steps 1-3 into one `ReportFindings` call,
   most-severe first across all three lenses combined.

## Extreme mode

Only when the user explicitly runs `/full-repo-review-kgs extreme` — rare,
not the default. After step 4's consolidated report:

5. Run `/doctor` (the real Claude Code built-in health check).
6. If doctor's report includes proposed fixes and the user approves them,
   they land in the guards runbox; then run `/approve-kgs` to execute them.
```

- [ ] **Step 2: Verify frontmatter and no name collision**

```bash
node -e "const fs=require('fs'); const t=fs.readFileSync('C:/Users/kyleg/.claude/skills/full-repo-review-kgs/SKILL.md','utf8'); if(!t.includes('name: full-repo-review-kgs')) throw new Error('name mismatch'); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Dry-run invoke**

Run `/full-repo-review-kgs` against a whole repo. Confirm all three lenses
run in the main thread and end with one consolidated `ReportFindings` call.
Confirm `/full-repo-review-kgs extreme` also invokes `/doctor` afterward.

No commit — `~/.claude/skills` is not a git repository.

---

### Task 9: Update the three files that reference the old skill names

**Files:**
- Modify: `C:\Users\kyleg\.claude\CLAUDE.md`
- Modify: `C:\code\CLAUDE.md`
- Modify: `C:\code\guards\hooks\budget.mjs:472`

**Interfaces:**
- Consumes: the final names from Tasks 1-5 (`security-review-kgs`, `resolve-issues-kgs`, `diff-review-kgs`, `sec-diff-kgs`, `lean-review-kgs`).

- [ ] **Step 1: Re-run the reference grep to catch anything new**

```bash
grep -rl "\-review\b\|/sec-diff\|/resolve-issues" /c/code --include=*.md 2>/dev/null | grep -v node_modules
```

Compare against the 26 files found during design (recorded in the spec). Any
new hit beyond `~/.claude/CLAUDE.md`, `C:\code\CLAUDE.md`, and files already
identified as historical notes/scratchpads that don't need updating should be
read and judged individually before proceeding — don't assume the design-time
list is still exhaustive.

- [ ] **Step 2: Edit `~/.claude/CLAUDE.md`**

Change:
```
- Run /security-review before any commit that touches auth, input handling, SQL, or serialization.
```
to:
```
- Run /security-review-kgs before any commit that touches auth, input handling, SQL, or serialization.
```

- [ ] **Step 3: Edit `C:\code\CLAUDE.md`**

Change:
```
the ledger is not. `/resolve-issues` works these ledgers down to zero.
```
to:
```
the ledger is not. `/resolve-issues-kgs` works these ledgers down to zero.
```

- [ ] **Step 4: Edit `guards\hooks\budget.mjs`**

Change line 472 from:
```javascript
    `[ACC] Reviews: /diff-review and /sec-diff are the default checks (main thread, no fan-out). /lean-review is ${policy.review.fullLeanReview}.`,
```
to:
```javascript
    `[ACC] Reviews: /diff-review-kgs and /sec-diff-kgs are the default checks (main thread, no fan-out). /lean-review-kgs is ${policy.review.fullLeanReview}.`,
```

This is a straight rename, not a policy change — guards' actual review
policy (two lightweight diff checks by default, full lean review manual-only)
stays identical; it now names skills that actually exist and are invocable
from a `guards` session, which `/diff-review`, `/sec-diff`, and `/lean-review`
never were (`guards` has no `.claude/skills` directory of its own). Whether
guards should switch its default policy to the new composite skills instead
is a separate decision, not part of this rename.

- [ ] **Step 5: Confirm no test asserts on the old literal string**

```bash
grep -rn "ACC\] Reviews\|diff-review\|sec-diff" C:/code/guards --include=*.test.mjs
```

Expected: no matches (confirmed during design — no test in `guards` asserts
on this injected string's literal text).

- [ ] **Step 6: Verify guards still starts cleanly**

```bash
cd C:/code/guards && node --check hooks/budget.mjs
```

Expected: no output, exit code 0 (syntax-only check — deliberately not
`require()`d or executed, since `budget.mjs` is a hook script with real
side effects when actually invoked and this step only needs to confirm the
edit didn't break its syntax).

- [ ] **Step 7: Commit the guards change only**

```bash
cd C:/code/guards
git status --short
git add hooks/budget.mjs
git status --short
```

Confirm the status output shows ONLY `hooks/budget.mjs` staged, and that
`hooks/budget.test.mjs`, `hooks/goal.mjs`, `hooks/goal.test.mjs` remain
modified-but-unstaged (the pre-existing unrelated work-in-progress, per the
Global Constraints section — do not stage or commit those).

```bash
git commit -m "$(cat <<'EOF'
fix(kernel): point the injected review-policy line at the renamed -kgs skills

/diff-review, /sec-diff, and /lean-review never existed as invocable skills
inside a guards session (guards has no .claude/skills of its own) — this
line was aspirational. Now that the equivalent skills are consolidated into
~/.claude/skills as diff-review-kgs/sec-diff-kgs/lean-review-kgs, point the
policy text at names that actually resolve. Same policy, just working now.
EOF
)"
```

`C:\Users\kyleg\.claude\CLAUDE.md` and `C:\code\CLAUDE.md` are not inside git
repositories (confirmed during design) — no commit applies to those two
edits.

---

### Task 10: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm the full `~/.claude/skills` inventory**

```bash
ls "C:/Users/kyleg/.claude/skills"
```

Expected: `approve-kgs`, `goal-kgs`, `security-review-kgs`, `resolve-issues-kgs`,
`sec-diff-kgs`, `lean-review-kgs`, `diff-review-kgs`, `doc-review-kgs`,
`full-diff-review-kgs`, `full-repo-review-kgs` — ten directories, no old
un-suffixed names remaining.

- [ ] **Step 2: Confirm no name collisions anywhere a session might load skills from**

```bash
node -e "
const fs = require('fs');
const dirs = [
  'C:/Users/kyleg/.claude/skills',
  'C:/code/guards/.claude/skills',
];
const names = {};
for (const d of dirs) {
  if (!fs.existsSync(d)) continue;
  for (const entry of fs.readdirSync(d)) {
    const skillFile = d + '/' + entry + '/SKILL.md';
    if (!fs.existsSync(skillFile)) continue;
    const m = fs.readFileSync(skillFile, 'utf8').match(/name:\s*(\S+)/);
    if (!m) continue;
    const key = d + ':' + m[1];
    if (names[key]) throw new Error('duplicate: ' + key);
    names[key] = true;
  }
}
console.log('no collisions:', Object.keys(names).length, 'skills checked');
"
```

- [ ] **Step 3: Start a real Claude Code session rooted at `C:\code\guards` and confirm the skill list**

Check that `/approve-kgs`, `/goal-kgs`, `/security-review-kgs`,
`/resolve-issues-kgs`, `/sec-diff-kgs`, `/lean-review-kgs`, `/diff-review-kgs`,
`/doc-review-kgs`, `/full-diff-review-kgs`, and `/full-repo-review-kgs` all
appear in the session's available-skills listing — this is the original
complaint ("they should show up here") being verified fixed.

- [ ] **Step 4: Confirm the injected SessionStart line reads correctly**

Look for the `[ACC] Reviews:` line in the new session's context and confirm
it reads `/diff-review-kgs and /sec-diff-kgs are the default checks... /lean-review-kgs is manual-only.`

- [ ] **Step 5: Spot-check one rename and one new composite live**

Run `/security-review-kgs` against a small pending diff and confirm it
behaves identically to the old `/security-review` (same targets, same
report shape). Run `/full-diff-review-kgs` against the same diff and confirm
it produces one consolidated report covering lean, security, and doc-drift
findings.

- [ ] **Step 6: Report results**

State plainly: which of the ten skills were dry-run tested, what each
produced, and whether the three reference updates (Task 9) resolve
correctly. Any deviation from expected gets logged to the appropriate
`OPEN-ISSUES.md` per the project's "log what you don't fix" rule, not
silently dropped.

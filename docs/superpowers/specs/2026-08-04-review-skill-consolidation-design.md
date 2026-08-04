# Review skill consolidation and composite review skills

## Motivation

Kyle asked for `/lean-review` and other review skills to be available in
`guards`, and discovered they don't cascade the way `CLAUDE.md` files do —
Claude Code loads project skills only from the exact project directory of
the session's `cwd`, plus user-scope `~/.claude/skills`. His review skills
were scattered: some in `lifeos-ecosystem`, some duplicated per member repo,
one (`resolve-issues`) in the `C:\code` harness root (an ancestor of
`guards`, which still doesn't cascade). None were visible from a `guards`
session.

Investigation showed the scatter isn't uniform duplication:
- `lifeos-ecosystem/.claude/skills/diff-review` and `lean-review` are
  **coordinators** — they delegate to each member repo's own copy and (for
  lean-review) add a cross-repo drift pass. They don't review anything
  themselves.
- The copies inside `lifeos/` and `lifeos-ui/` have **diverged on
  purpose** — Python/FastAPI/Pydantic-specific checks and
  `ruff`/`mypy`/`pytest` gates vs React/TypeScript checks and
  `npm run lint/test/e2e` gates.
- `sec-diff` is genuinely self-contained and generic — a real duplicate
  worth consolidating.

So this is not a single "move everything to one place" operation. This spec
covers: renaming Kyle's genuinely-authored, portable skills with a `-kgs`
suffix so they're identifiable as his; consolidating the skills that really
are single-source-of-truth candidates into `~/.claude/skills` (available in
every project, including `guards`); and building new composite review
skills (`full-diff-review-kgs`, `full-repo-review-kgs`) that bundle
leanness, security, and a new documentation-review lens.

**Explicitly out of scope for this spec** (deferred to future design
rounds):
- The "enhanced iterative lean-review" idea (multiple escalating-strictness
  passes, likely built on the existing `/loop` skill's self-pacing mode).
- Packaging any of this as a Claude Code plugin instead of loose skills.

## Naming and inventory

### Renamed in place, no relocation

| Skill | New name | Notes |
|---|---|---|
| `~/.claude/skills/approve` | `approve-kgs` | user-authored, confirmed by presence as a file (Claude Code's real built-ins ship inside the app, no on-disk file) |
| `~/.claude/skills/goal` | `goal-kgs` | same |
| `~/.claude/skills/security-review` | `security-review-kgs` | same |

### Renamed and moved to `~/.claude/skills` (promoted to user scope)

| Skill | From | To |
|---|---|---|
| `resolve-issues` | `C:\code\.claude\skills\resolve-issues` | `~/.claude/skills/resolve-issues-kgs` |
| `sec-diff` | `C:\code\lifeos-ecosystem\.claude\skills\sec-diff` | `~/.claude/skills/sec-diff-kgs` |

Both are self-contained today with no dependency on their current repo's
structure, so this is a genuine consolidation, not a break.

### Left alone, untouched, unrenamed

- `lifeos-ecosystem/.claude/skills/diff-review` and `lean-review`
  (ecosystem coordinators — renaming risks breaking their delegation to
  child-repo skills by name, for no consolidation benefit since they only
  make sense inside `lifeos-ecosystem`).
- `lifeos/.claude/skills/{diff-review,lean-review}` and
  `lifeos-ui/.claude/skills/{diff-review,lean-review}` (legitimately
  diverged per tech stack).

Rationale: `-kgs` marks Kyle's shared, portable skills. Repo-local
coordinators and stack-specific children aren't being consolidated, so
renaming them buys nothing and touches delegation logic across three repos
for cosmetics only.

### New skills, all in `~/.claude/skills`

| Skill | Scope | Purpose |
|---|---|---|
| `lean-review-kgs` | whole repo | generic leanness/simplicity review, works in any single repo (no ecosystem dependency) |
| `diff-review-kgs` | diff only | leanness's diff-scoped sibling, same pairing pattern as `security-review-kgs`/`sec-diff-kgs` |
| `doc-review-kgs` | both (mode argument) | new — see design below |
| `full-diff-review-kgs` | diff only | composite: runs `diff-review-kgs` + `sec-diff-kgs` + `doc-review-kgs` (diff mode) |
| `full-repo-review-kgs` | whole repo | composite: runs `lean-review-kgs` + `security-review-kgs` + `doc-review-kgs` (repo mode) |

Both composites accept an optional `extreme` argument. In extreme mode
they additionally invoke the real `/doctor` and `/approve-kgs` slash
commands as themselves — `doctor` is a genuine Claude Code built-in and
can't be renamed or reimplemented as a sub-skill, so extreme mode calls it
directly rather than pretending it's a `-kgs`-branded lens.

## `doc-review-kgs` design

Two modes, selected by an argument:

- **Diff mode**: did this change alter behavior, config, or commands
  without updating the docs that describe them (README, AGENTS.md,
  CLAUDE.md, docstrings)? Flags drift only, not general prose quality.
- **Repo mode**: broader sweep across all docs — stale claims in files the
  diff didn't touch, redundant or bloated sections, poor organization.
  Judged against the same derivability heuristic the `/doctor` skill
  already applies to CLAUDE.md files (cut what a session could reconstruct
  from the code, keep what it couldn't), generalized to all documentation
  rather than just CLAUDE.md.

Bias in both modes: lean and surgical. Flag bloat, drift, and
disorganization; don't rewrite for style, and don't produce sprawling
reports. Findings should read as directly actionable, not a copyedit pass.

## Orchestration

Sequential, main thread — matches Kyle's standing
`~/.claude/CLAUDE.md` rule ("Do the work in the main thread by default...
don't spawn subagents... unless asked") and mirrors the existing
`lifeos-ecosystem/diff-review` coordinator pattern. Each composite skill's
`SKILL.md` instructs Claude to invoke its component skills in order within
the same session, then make one consolidated `ReportFindings` call at the
end. No subagent fan-out.

Rejected: a self-contained composite with all three lenses' checklists
written directly into one file. This would recreate the exact duplication
problem that started this whole effort — leanness/security/doc logic would
live in two places (the standalone skill and the composite) instead of
one.

## Reference updates required

Renaming an established skill breaks anything that names it literally.
Three known call sites, found by grepping `C:\code` for the old names:

1. `~/.claude/CLAUDE.md` — `"Run /security-review before any commit..."`
   → update to `/security-review-kgs`.
2. `C:\code\CLAUDE.md` — `` `/resolve-issues` works these ledgers down to
   zero`` → update to `` `/resolve-issues-kgs` ``.
3. `guards\hooks\budget.mjs` — the injected `SessionStart` line
   `` [ACC] Reviews: /diff-review and /sec-diff are the default checks
   (main thread, no fan-out). /lean-review is ${policy.review.fullLeanReview}.``
   This is guards' actual review policy, not just documentation — it needs
   an explicit decision at implementation time about whether guards
   switches its default review commands to `full-diff-review-kgs` /
   `full-repo-review-kgs`, or keeps referencing the old (now-nonexistent
   for guards' purposes) names. Flagging this as a decision point rather
   than assuming an answer.

Before editing, re-run the grep across all of `C:\code` (26 files matched
during design) to catch any additional live references beyond these three
— most of the 26 were historical notes/scratchpads that don't need
updating, but each should be checked, not assumed stale.

## Verification approach

These are prompt/instruction files, not executable code, so "tests" means:

1. Frontmatter validity — every new/renamed `SKILL.md` has a `name` and
   `description` that parse, and no name collisions within
   `~/.claude/skills`.
2. A live dry-run invocation of each new/renamed skill in a real session
   (not just a read-through) to confirm the described behavior actually
   happens: `diff-review-kgs` and `sec-diff-kgs` on a real diff,
   `lean-review-kgs` and `security-review-kgs` on the whole repo,
   `doc-review-kgs` in both modes, then each composite end-to-end
   (including `extreme` mode).
3. Confirm the three reference updates above still resolve correctly —
   i.e. typing `/security-review-kgs` and `/resolve-issues-kgs` actually
   invokes the renamed skills, and guards' injected `[ACC] Reviews:` line
   reflects whatever was decided for `budget.mjs`.

## Follow-ups (not in this spec)

- Enhanced iterative `lean-review-kgs` with escalating-strictness passes
  (likely via `/loop`'s self-pacing mode).
- Whether to package the `-kgs` skill set as an installable Claude Code
  plugin instead of loose files in `~/.claude/skills`.

# 00: Repo Default Setup

**Read:** `rules/00-CORE.md`, `rules/04-DOCS.md`
**Skill:** none
**Produces:** an empty repo that obeys the folder contract, with no product code

## CONFIG

```yaml
PROJECT_NAME:   <name>
ONE_LINER:      <what it does, in words a ten-year-old understands>
LANGUAGE:       <lang + version>
MAIN_BRANCH:    main
PACK_PATH:      <path to this pack, used once to copy rules/ and templates/>
```

## DO

1. **Verify empty.** `REPO_ROOT` is empty or holds only `.git` and a license. Otherwise halt.

2. **Create exactly this tree. Nothing else.**
   ```
   README.md  CLAUDE.md
   docs/  docs/adr/  docs/notes/
   specs/  specs/active/  specs/done/
   rules/
   .gitignore
   ```
   Do **not** create `src/`, `tests/`, `utils/`, `helpers/`, `common/`, `lib/`, `config/`, `scripts/`, or `types/`. Those appear when something needs them, in `prompts/01-phase0-skeleton.md`.

3. **Copy the rule cards** from `PACK_PATH/rules/` into `rules/`. They travel with the repo so the repo stays self-contained.

4. **Write `CLAUDE.md`** from `templates/CLAUDE.md`. Fill every placeholder. Leave command values as `<TBD>` until Phase 0 picks the stack. Keep under 120 lines.

5. **Write `AGENTS.md`** from `templates/AGENTS.md` only if this repo will use subagents. Otherwise skip it. An unused `AGENTS.md` is bloat.

6. **Write `README.md`** with only the six sections in `rules/04-DOCS.md`. Commands are `<TBD>` for now.

7. **Placeholder the three canonical docs.** Copy `templates/PRD.md` to `docs/PRD.md` with front matter filled and `status: draft`. Do **not** copy the system requirements or DFD templates yet: they are written at Phase 0 when there is a system to describe, and an empty template in `docs/` is a lie that passes GATE-DOC D7 while telling a reader nothing.

8. **Create `specs/TEST-LEDGER.md`** from `templates/TEST-LEDGER.md`, empty rows.

9. **`.gitignore`** for the language, plus `.env*`, editor folders, and build output. Nothing speculative.

10. **Initialize git**, branch `MAIN_BRANCH`, one commit: `chore: repo scaffold`.

11. **Verify** GATE-SETUP below, then stop. Do not choose a stack. Do not install anything. That is `prompts/01-phase0-skeleton.md`.

## GATE-SETUP

| # | Check |
|---|---|
| U1 | The tree matches step 2 exactly, no extra directories |
| U2 | `docs/` root contains exactly `PRD.md` |
| U3 | `CLAUDE.md` has zero unfilled placeholders except `<TBD>` command values |
| U4 | `rules/` contains all eight cards |
| U5 | No dependency installed, no lockfile, no framework |
| U6 | No file references a path outside the repo |
| U7 | Total files under 15 |

## OUTPUT

Run report per `rules/00-CORE.md`, plus:

```
### Tree created
<the actual tree>

### Deliberately not created
| Thing | Why not | Created by |
```

## HALT

Core halts, plus: the repo is not empty; `ONE_LINER` fails the four-reader test in `rules/03-WRITING.md`.

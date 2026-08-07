---
title: <what this note is, in plain language>
status: active | superseded
scope: repo | subsystem:<name> | slice:SL-NNN
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
owner: <name>
traces: [FR-001]
---

# <Title>

> Filename is `docs/notes/YYYY-MM-DD-kebab-title.md`. The date leads so staleness is visible in a plain `ls`; the title alone must tell a stranger what this is.
>
> **Before writing:** answer *what breaks if this is deleted?* No answer means do not write it. Most investigations should end in a PRD row, an ADR, or a code change, not in a note.
>
> Keep under 60 lines. A note that needs more is either an ADR, a runbook, or three notes.

## What breaks if this is deleted

<One sentence. This is the note's justification and the first thing the next doc refresh reads.>

## Body

<The content. Use one of the shapes below and delete the rest.>

---

### Shape A: investigation

**Question.** <one sentence>
**Answer.** <one paragraph or a table>
**Evidence.** <what you actually ran or read, with dates>
**What would make this wrong.** <the condition>
**Where the conclusion landed.** <PRD row, ADR, spec, or code change>

### Shape B: runbook

**When to run this.** <the trigger>
**Prerequisites.** <access, tools, versions>
**Steps.** <numbered, literal commands, copy-pasteable>
**How to know it worked.** <the observable result>
**If it fails.** <the recovery path>
**Last verified.** <YYYY-MM-DD, by whom>

### Shape C: benchmark

**What was measured.** <the exact operation>
**Setup.** <hardware, versions, data size, so it can be reproduced>
**Results.** <table with units>
**Conclusion.** <one sentence>
**Reproduce with.** <the literal command>

---

## Self-check

- [ ] "What breaks if this is deleted" is answered concretely.
- [ ] Filename leads with the date and has a descriptive title.
- [ ] `scope` is set, so a reader knows its reach without opening it.
- [ ] Nothing here duplicates a fact stated in another document.
- [ ] No aspirational content. This describes what is true now.
- [ ] Under 60 lines.
- [ ] Passes `rules/03-WRITING.md`.

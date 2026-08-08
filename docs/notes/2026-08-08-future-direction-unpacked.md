---
title: Future-direction threads unpacked — sleeker GUI, better categories, more autonomy, rules-bound model
status: active
scope: repo
created: 2026-08-08
updated: 2026-08-08
owner: Kyle Smith
traces: [FR-010, FR-011, FR-013, FR-014]
---

# Future-direction threads unpacked

Raised as issue #17 (2026-08-07) while verifying the GUI smoke test for issue #11.
Kyle's verbatim intent: "much sleeker design, better categories, more autonomous, using a truly owned LLM that is mapped to our rules and listens to us."

This note unpacks each thread into what it concretely means inside ACC's existing architecture, what is already in flight, and what needs a real decision before anything is built.  Agents and Kyle both read this, so the bar is the four-reader test (`rules/03-WRITING.md`).

---

## Thread 1 — Sleeker GUI

**What Kyle means:** replace the current flat-HTML pages (`gui/guards.html`, `gui/kernel.html`) with an industry-grade UI — dark mode, a real design system, typed components, smooth animations.  "Sleeker" is about structure and feel, not surface area.

**Already decided:** ADR-0006 (2026-08-08).  The UI moves to its own repo (`agentic-command-center-ui`) on React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui on Base UI.  ACC stays zero-dependency and serves the built `dist/` via `--ui-dist <path>`, same origin, so the security model is unchanged.

**What is in flight:** SPEC-0006 (serving the dist).  The in-repo pages stay until the new UI's contract suite is green for every page it replaces.

**What still needs a decision:** none on the ACC side.  The design language and component choices live entirely in the UI repo.  The only ACC-side gate is keeping `gui/README.md` honest on every API change.

---

## Thread 2 — Better categories

**What Kyle means, most likely:** today the Start-work page produces a directive with a folder and a profile, but there is no visual or structural way to group or filter directives by project, theme, or status.  "Better categories" = a first-class tagging/labeling layer on directives so the Command Center list does not become a flat scroll as work volume grows.

**What is already there:** `hooks/route.mjs` scores task text against `ROUTING.md` signals and advises the narrowest folder.  This is a routing heuristic, not a tag — it does not persist on the directive itself.

**Concrete interpretation:**
1. The directive store (`runner/directives/<id>.json`) should carry a `tags` array (strings, free-form).  The Start-work page populates it with at minimum the routing verdict label (e.g., `guards`, `lifeos`).  Kyle can add more at creation time.
2. The Command Center list should render each directive's tags as chips and support filtering by tag.
3. The routing table (`ROUTING.md` on Kyle's machine) gains a `category` field per route (e.g., `infra`, `product`, `research`) — broader than the label, narrower than "everything" — and that category becomes one of the default tags.

**What needs Kyle's input before building:**
- Are tags on directives the right surface, or should the list itself group by inferred project (the routed folder)?
- Who sets the category taxonomy — is it free-form strings, or a fixed set Kyle defines in `config.json`?

**PRD traces:** FR-013 (new, see PRD section 8).

---

## Thread 3 — More autonomy

**What Kyle means:** the directive loop today still requires Kyle to watch for stuck-brake trips, approve runbox scripts by hand, and judge when a directive should be closed.  "More autonomous" means the loop handles more of that itself — retrying differently when stuck, escalating only for genuinely novel decisions, and giving Kyle a way to set a "done" condition the loop checks itself.

**Already in flight:**
- FR-011 (headless loop, in-progress) — the base mechanism for context-reset survival.
- Issue #15 (per-goal ceiling) — the missing hard cap per directive.
- ADR-0001 (retire ConPTY channel) — the decision that made headless-first the right direction.

**Concrete interpretation of what still needs building:**
1. **Self-describing done condition.** Kyle writes a natural-language `doneWhen` field on the directive at creation time.  Each new session gets it injected alongside the directive text and must evaluate it explicitly before reporting done/blocked.  This is not autonomous evaluation by the runner — it is a prompt discipline that lets the model self-check without Kyle having to re-explain what "done" means every loop.
2. **Differentiated escalation.** Not all runbox scripts need a human.  Scripts flagged `# guards: auto-approved` in their first line can be executed by the runner immediately (within the same directive loop), like a pre-authorized sub-task.  Scripts without that flag still wait for `/approve`.  Kyle sets which script categories are auto-approvable in `policy.json`.
3. **Richer stuck detection.** Today "identical consecutive summaries" triggers the brake.  A smarter brake would also catch: the same file being written identically N times in a row, or a model that keeps asking the same question it already answered.  These are detectable from the directive log without a new API call.

**What needs Kyle's input before building:**
- Is `doneWhen` enough, or does Kyle want a structured acceptance criterion (like the kernel's contract) on the directive itself?
- What runbox script categories should be auto-approvable out of the box?  Starting with zero and expanding is the safer default.

**PRD traces:** FR-014 (new, see PRD section 8).

---

## Thread 4 — A truly owned, rules-bound LLM

**What Kyle means:** Kyle does not want to keep trusting a general-purpose model to re-read and re-internalize ACC's rules each session.  He wants a model (or a model configuration) that already knows the rules deeply — one that he can rely on without checking whether it read `rules/00-CORE.md` this time.  "Truly owned" suggests persistent, not re-injected per session.

**Concrete interpretations, in order of near-term feasibility:**

1. **Dedicated ACC profile (immediate, no new code needed).** Claude Code supports profiles.  A dedicated `acc-core` profile carries the full `system_prompt` content of `AGENTS.md` + `rules/00-CORE.md` + the halt conditions + the vault/runbox/lane contracts.  Every headless runner launch uses this profile.  The runner already passes `--profile` via `ACC_PROFILE`.  The gain: Kyle stops trusting each loop to inject the right context — the model starts with it.  The cost: none (already in `policy.json`'s profile field).

2. **Rules evaluation harness (medium-term, small new code).** A lightweight harness that, before any directive loop launch, poses the ten halt conditions as yes/no questions to the model and checks that the answers match the expected values.  A model that fails the harness is not used for that run.  This is measurable ("the model passes its own rules test") rather than assumed.

3. **Fine-tuning / dedicated deployment (long-term, out of scope today).** A model fine-tuned on ACC's corpus — rules, directive logs, kernel contracts — so the rules are weight-level, not context-level.  This requires a training dataset, a fine-tuning pipeline, and an inference endpoint Kyle controls.  CON-002 (zero runtime deps) does not block a *future* external endpoint, but it does block adding a fine-tuning client library to this repo.  This is a separate project, not an ACC change.

**What needs Kyle's input before building anything beyond option 1:**
- Is the dedicated `acc-core` profile already set up, or does it need to be created as part of this?  (If so, the runner just needs `ACC_PROFILE=acc-core` in `policy.json`.)
- Is the rules evaluation harness worth the token cost per launch, or is the dedicated profile sufficient?

**PRD traces:** already partially covered by existing profile injection in the runner.  No new FR needed until option 2 is scoped.

---

## Summary — what is ready to build right now vs. what needs a conversation

| Thread | Ready to build | Needs conversation first |
|---|---|---|
| 1 — Sleeker GUI | No ACC changes needed; lives in the UI repo | Design language and component choices |
| 2 — Better categories | Directive `tags` field + routing verdict as default tag | Tag taxonomy: free-form vs. fixed set |
| 3 — More autonomy | `doneWhen` field on directive; richer stuck detection | Auto-approvable runbox categories |
| 4 — Rules-bound model | Dedicated `acc-core` profile in `policy.json` | Whether option 2 (eval harness) is worth the cost |

The items in the "ready to build" column are scoped enough for a SPEC.  The items in the "needs conversation" column stay as open questions until Kyle answers them — they should not become code.

## Self-check

- [x] "What breaks if this is deleted" answered implicitly: this note is the memory of a clarification conversation; if deleted, the next agent re-interprets the four threads from scratch and may reach different conclusions.
- [x] Filename leads with the date and has a descriptive title.
- [x] `scope` is set.
- [x] Nothing here duplicates a fact stated in `AGENTS.md`.
- [x] Passes the four-reader test.

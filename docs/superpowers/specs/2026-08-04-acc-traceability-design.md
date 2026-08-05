# Setting-traceability harness — design (sub-project F)

- date: 2026-08-04
- status: approved (Kyle, 2026-08-04)
- scope: generalize the dial/consumer check into a mechanism that proves, per
  control, that a value reaches its real consumer and changes behaviour
- standard: `2026-08-04-acc-standards-design.md` applies in full
- absorbs: guards `OI-033` (why the `UserPromptSubmit` route hook is off)
- ledger: guards `OI-033`; seeded by B3's `hooks/dialcheck.mjs`

F is the enforcement arm of standing prohibition 2. Kyle's own words are the
requirement, and they are already a seven-link chain:

> The setting must save correctly. The saved value must persist. The
> authoritative configuration source must be updated. The agentic system, such as
> Claude Code, must actually read that source. The resulting behavior must change
> exactly as intended. Tests must prove the entire path works from the UI through
> final execution. Restarting any relevant component must not silently lose or
> ignore the setting.
>
> — and: *"Do not stop after proving that a UI control changed a database value.
> Prove that the final agentic system consumed it and behaved accordingly."*

## The seven links

Every traced setting must demonstrate all seven. Numbered so an AC can name one:

| Link | Claim | How it is proven |
|---|---|---|
| L1 | writing the control saves the value | write via the real API, read back |
| L2 | the value persists | re-read after process exit |
| L3 | the authoritative source holds it | assert the value in the real file, not a cache |
| L4 | the consumer reads that source | consumer invoked in a sandbox; asserts it opened that path |
| L5 | behaviour changes | **two runs, both values, observably different outcomes** |
| L6 | the whole path works UI → execution | one e2e that drives the real control and observes L5's outcome |
| L7 | restart does not lose or ignore it | restart the consumer, re-observe L5 |

L5 is the load-bearing link and the one the existing system keeps failing. It is
satisfied only by an **A/B observation**: set the dial one way, observe outcome
X; set it the other way, observe outcome Y; assert X ≠ Y and that each matches
the documented intent. Reading the value back — at any layer — satisfies L1–L3
and proves nothing about L5.

## The design decision that makes this a harness

A suite of hand-written traceability tests decays: someone adds a dial and
forgets the test, and the harness reports green over an untraced control. That is
the same failure shape as a document describing a system it does not govern.

So F is built around **completeness enforcement, not test count**:

- Every traceable control is declared in a **registry** (`traceability.mjs`),
  co-located with the code that owns it.
- Each entry declares: id, the authoritative source and key path, the consumer,
  the documented intent of each value, and a **probe** — a function that sets a
  value, exercises the consumer, and returns an observable outcome.
- The gate walks the *real* configuration files (`policy.json`, `config.json`,
  each repo's settings) and **fails on any key that is not in the registry**.

That inversion is the whole ROI. A new dial cannot be shipped untraced, because
the gate finds the key before anyone remembers to write a test for it. An
intentionally untraceable key must be declared as such with a reason, which is a
decision in the file rather than an omission.

## Registry entry shape

```
{
  id: "autoCd.enabled",
  source: "policy.json",
  key: "autoCd.enabled",
  consumer: "hooks/route.mjs registered in ~/.claude/settings.json",
  intent: {
    true:  "a prompt whose scope differs from cwd is blocked and re-scoped",
    false: "every prompt is delivered to the session unchanged"
  },
  probe: async (value) => { /* returns an observable outcome */ },
  restartable: ["route hook"]         // L7: what must be restarted and re-checked
}
```

Or, for a key that genuinely cannot be probed:

```
{ id: "...", untraceable: "reason, dated, signed" }
```

`untraceable` entries are listed in the gate's output every run, so they stay
visible rather than fading into green.

## Relationship to `dialcheck.mjs`

B3 shipped `hooks/dialcheck.mjs` (83 lines, 10 tests): it fails when a policy
dial claims a hook is enabled while that hook is absent from `settings.json`, and
in the reverse direction too. That is link L4 for one setting.

F **absorbs it rather than duplicating it**: `dialcheck`'s dial↔hook coherence
check becomes the standard L4 probe for the "registered hook" consumer class, and
the file is folded into `traceability.mjs`. Keeping two files that both answer
"does this dial point at a real consumer" is the parallel-implementation pattern
the repo standard forbids.

## OI-033 — the live case F must resolve

`autoCd.enabled` is F's exemplar, and it is currently unresolved in a way F
cannot paper over:

- The `UserPromptSubmit` route hook was removed from `settings.json` at 18:42 on
  2026-08-04 by an auto-approved runbox script, because it was eating real
  prompts. This was the **second** time (`OI-029` was the first, closed by
  re-enabling it on a theory that proved wrong).
- `policy.json autoCd.enabled` is now `false`, so the dial and reality agree and
  `dialcheck` reports clean.

Agreeing that a feature is off is not the same as the feature working. F must end
with one of two honest outcomes, and the slice picks based on evidence:

- **Root-caused and restored.** A prompt-eating incident is reproduced, the cause
  is found and fixed, `route.mjs` is re-registered, the dial goes back to `true`,
  and L1–L7 pass for `autoCd.enabled` with the hook live.
- **Retired.** If the routing behaviour cannot be made to deliver every prompt,
  the hook is removed permanently, the dial is deleted rather than left `false`,
  and `ROUTING.md`'s advisory-line fallback becomes the only mechanism.

A dial left permanently `false` pointing at an unregistered hook is neither, and
F does not accept it. Repro depends on a trustworthy standing-order store, so
this slice runs after B2b and after J's rename.

## Scope of the first registry pass

Every key in `policy.json` and `config.json`, plus every setting the UI exposes.
Known dials at time of writing: `autoCd.*`, `autoApprove.*`, `standing.*`
(post-rename: `reapGraceSeconds`, `humanHoldMinutes`), budget bands, lane
concurrency and pacing, launch cap, `config.protected`/`writeRoots`/`denyRoots`/
`projects`. The gate enumerates the real files, so this list is a starting point,
not the definition — anything present and undeclared fails.

## Acceptance criteria

| AC | Statement | Test |
|----|-----------|------|
| AC-F1 | A key present in a real config file and absent from the registry fails the gate | integration, fixture config with an extra key |
| AC-F2 | A registry entry naming a key that does not exist fails the gate | integration |
| AC-F3 | `untraceable` entries pass but are listed in every run's output | integration |
| AC-F4 | `untraceable` without a reason fails | unit |
| AC-F5 | L1–L3 probe fails when a value is written but the authoritative file is unchanged | integration, fixture that writes only to a cache |
| AC-F6 | L4 fails when the consumer never opens the authoritative source | integration, consumer stubbed to read elsewhere |
| AC-F7 | L5 fails when both values produce the same observable outcome | integration — the "dial does nothing" case, the exact defect class F exists for |
| AC-F8 | L5 fails when an outcome does not match the declared intent | integration, inverted-intent fixture |
| AC-F9 | L7 fails when a value is lost or ignored after restart | integration, real restart |
| AC-F10 | Every key in the real `policy.json` and `config.json` is traced or declared untraceable | integration, real files — the completeness gate |
| AC-F11 | `dialcheck`'s ten existing behaviours still hold after being folded in | its ten tests, moved and passing |
| AC-F12 | A dial claiming a hook is enabled while the hook is unregistered fails, and the reverse also fails | unit, both directions |
| AC-F13 | `autoCd.enabled` reaches one of the two honest outcomes; a dial left `false` pointing at an unregistered hook fails the gate | integration |
| AC-F14 | Every UI control in `agentic-command-center-ui` maps to a registry id | integration, gate over the UI's control manifest |
| AC-F15 | L6 passes for at least one control driven through the real UI | e2e, Playwright |

AC-F7 and AC-F10 are the two that give F its value: one catches a dial that does
nothing, the other catches a dial nobody traced.

AC-F14 is what connects F to sub-project E — every control E builds must be
registrable, which is a design constraint on E, not an afterthought.

## Verification

```
node --test core/traceability.test.mjs
node core/traceability.mjs gate          # AC-F10, real config files
node core/traceability.mjs probe --all   # L1-L7 for every traced control
npm run e2e -- traceability              # AC-F15
```

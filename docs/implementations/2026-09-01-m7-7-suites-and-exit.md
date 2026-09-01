# 2026-09-01 — M7.7: suites and the M7 exit review

## Problem / Motivation

M7.7 is not a build package. It owes four things:

1. S-PROFILE green in CI;
2. **the one-hour company test (SRS §6.1) run on a REAL repo**, evidence captured;
3. E-PLAYBOOK's drill recorded;
4. the M6 carried items closed or re-recorded with their reason.

And M7's exit criterion depends on it: *"SRS §6.1 demonstrated on a real repo …
S-PROFILE pass; PROGRESS + docs synced."*

An exit review's job is to find out whether the milestone is actually finished.
This one found that it is not, and found a defect that made one of the criterion's
clauses unreachable.

## What Changed

| File | Change |
|---|---|
| `src/shared/brief.ts` | **The fix.** `compileFacts` gains the incident branch VOICE-DESIGN §4 specified and nobody implemented. |
| `test/scenarios/s-onehour.test.ts` | **New.** SRS §6.1's chain, end to end over shipped components. |
| `test/scenarios/m7-evidence.test.ts` | **New.** The committed generator for M7's demo evidence. |
| `docs/demo/m7-onehour-chain.txt` · `docs/demo/m7-eplaybook-scorecard.md` | **New.** Generated artifacts, each stating its own scope. |
| `docs/PROGRESS.md` | M7.7 ticked; the **M7 exit row deliberately left unchecked**; the exit review recorded. |

## Implementation Approach

### The defect: an exit criterion that could not be met

`compileFacts` read tasks, gates, memos, spend, breaker trips and the Gymnasium
slice. It had **never heard of incidents** — and the incident endpoint has
written `incident-raised`, `incident-triaged` and `incident-announce-owed` to
`log.jsonl` since M7.4.

So an incident reached the standup only sideways: as an open gate, or as
whatever task Artemis happened to create. The Architect was never told that
something broke, in which repository, or what the on-call agent concluded.
**SRS §6.1's "the next briefing narrates the incident accurately from the log"
was unreachable by construction**, with every suite green.

VOICE-DESIGN §4 had specified it from the beginning — *"Health — budgets vs
burn, breaker trips, **incidents**, Harbor queue depth"* — so this is an
unimplemented requirement, not a new feature. Three properties shape the fix:

- the agent's summary is carried **verbatim** (the brief is read aloud and is
  the E-BRIEF-FAITH surface; a rewritten sentence is a claim nobody made,
  attributed to the company);
- every fact carries a `log#<seq>` ref, so S-BRIEF's "a claim the Architect
  cannot check is refused" still holds;
- the **owed** announcement is narrated too. An obligation recorded only in
  `log.jsonl` is one the Architect has to go looking for; the standup is where
  they find out without looking, which is the entire point of recording it
  rather than dropping it.

This is the M6 shape a third time in M7: two correct halves that had never met.

### The chain, demonstrated — and labelled

`test/scenarios/s-onehour.test.ts` walks §6.1 over the shipped components: real
git in a temp home, the real `IncidentEndpoint`, Hermes router, `LedgerEndpoint`,
`GateManager` and briefing compiler. Two things are replaced at their seams
(TEST-STRATEGY §1): the `gh` process and the ENGINE.

```
CI reports #4021 failed
  → incident raised, mailed to Artemis, tasks.json UNCHANGED   (FR-5.2)
  → Artemis proposes → task lands assigned
  → on-call agent files triage from its own outbox, real router
  → severity-1 escalates now, gate opens
  → the announcement the Herald cannot make is recorded as owed
  → the standup narrates all three, from the log, with refs
```

### The evidence generator is committed

M6's close-out recorded a standing gap: the `docs/demo/*.svg` generator was a
scratch file, so the artifacts were honest but unreproducible and a refactor
would orphan them silently. M7's evidence comes from
`test/scenarios/m7-evidence.test.ts` — `npm test` reproduces both artifacts, and
a change that breaks the chain breaks the suite.

Both artifacts state in their own text what they are **not**: the transcript says
it is not the acceptance criterion; the scorecard says its drill record is a
fixture, not a live agent run. An evidence file that does not disclose its own
scope is how a reader ends up believing a fake-engine run was a real one.

## Mathematical / Statistical Details

None. This package adds no formula; the E-PLAYBOOK scorer's arithmetic is
documented in `docs/implementations/2026-08-31-m7-4-skeleton-crew.md`.

## Design Decisions

**The M7 exit row is left unchecked.** SRS §6.1 asks whether a real agent, given
a real broken test in a real repository, triages it correctly and opens a sound
fix PR within the hour, unattended. That is judgment; no fake engine stands in
for it.

The gap is not tooling — `gh` is authenticated on this machine and `claude` is on
PATH. It is that running §6.1 means **deliberately breaking a test in one of the
Architect's repositories and leaving autonomous agents holding `GH_TOKEN` running
against it for an hour**. Choosing that repository and consenting to that run is
the Architect's call.

Ticking the row and calling the chain the criterion is exactly the substitution
the M6 close-out audit was convened to catch. Committing it inside an exit review
would make the review worthless.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/scenarios/s-onehour.test.ts test/scenarios/m7-evidence.test.ts
gh run list --branch feature/m7-6-shareable --limit 1
```

Observed: static checks green; 6 passed across the two new suites. Full suite
**2697 passed / 6 skipped**, 12 failed — the recorded 9 Windows-local
deterministic failures plus `s-stoploop` (2) and `hermes` (1) under parallel
load, each verified green in isolation (`hermes` 40/40), none related to M7.
**CI green on the whole M7 stack**: `feature/m7-6-shareable`, run
`33438533520`, `success`, 1m57s — which is S-PROFILE's "green in CI".

### Mutation results — 5 applied, 5 killed

| # | Mutation | Result |
|---|---|---|
| M1 | drop the `incident-raised` branch | RED |
| M2 | drop the `incident-triaged` branch | RED |
| M3 | rewrite the summary instead of quoting it | RED |
| M4 | drop the owed-announcement branch | RED (after the assertion was added) |
| M5 | incident facts carry no refs | RED |

M4 survived the first pass: nothing asserted that the *unmet* announcement
reaches the standup. The assertion was added rather than the branch accepted —
that fact is the one the Architect most needs, because it is how they learn the
spoken alarm they were promised did not happen.

## Related Docs

- `docs/srs/SRS.md` — §6.1 (the criterion), UC-09
- `docs/design/VOICE-DESIGN.md` — §4, which specified incidents in Health all along
- `docs/TEST-STRATEGY.md` — §1 (determinize the boundary), §3 (S-PROFILE), §6 (E-PLAYBOOK)
- `docs/PROGRESS.md` — the M7 exit review and the open decision

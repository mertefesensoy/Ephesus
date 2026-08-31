# 2026-08-31 — M7.4: the Skeleton Crew profile

## Problem / Motivation

FR-9.2 requires the Skeleton Crew to **ship built-in**: "health-check watcher,
CI babysitter (watch runs, retry/triage failures, open fix PRs),
dependency-update agent (batched PRs), and incident-response playbooks with
severity-based escalation (UC-09)."

It is also the package that puts ADR-0012's central claim on trial. The ADR says
Skeleton Crew and Front Office ship "**built-in as ordinary profiles** — they
exercise no private APIs, proving the format is sufficient" (the dogfood rule,
NFR-12). The package's own risk line restates the stake: *a built-in that
reaches past the schema invalidates ADR-0012's central claim — this profile must
be buildable by an Architect with a text editor.*

So M7.4 has two halves that must both hold: a bundle written in nothing but
M7.1's frozen public schema, and the wiring that makes UC-09's incident sequence
actually happen.

## What Changed

| File | Change |
|---|---|
| `profiles/skeleton-crew/**` | **New — 12 files.** `profile.json`, three `hires/*.json`, three `triggers/*.json`, three `playbooks/*.md`, `memo-policy.json`, `harbor.json`. No code, no sidecar, nothing outside ADR-0012's listing. |
| `src/shared/incident.ts` | **New.** The severity ladder, the total escalation table, `incidentFrom` / `incidentKey`, and the triage-report schema. |
| `src/main/incidents.ts` | **New.** `IncidentEndpoint`: raises CI failures as mail to Artemis, deduped; consumes triage reports; records the announcement it cannot make. |
| `src/shared/reserved.ts` | Two harness identities: `agent.harbor` (incidents) and `agent.profiles` (trigger wakes). |
| `src/shared/routing.ts` | A `HARBOR_ENDPOINT` branch — reply-shaped acts only. |
| `src/main/hermes.ts` | `harbor?(message)` option and the `submitToHarbor` dispatch arm. |
| `src/main/profiles.ts` | `triggerWakeMessage` — a fired schedule trigger's mail, extracted so it is testable. |
| `src/main/index.ts` | Constructs the endpoint; feeds it the ingest result; makes `onTriggerFired` actually wake its agent. |
| `prompts/harbor/incident-{subject,body}.md` · `prompts/profiles/trigger-{subject,body}.md` | **New.** The words (invariant §8). |
| `test/main/skeleton-crew.test.ts` | **New.** 9 cases — the dogfood proof, against the real bundle through the real loader. |
| `test/shared/incident.test.ts` · `test/main/incidents.test.ts` | **New.** 16 + 19 cases. |
| `test/scenarios/s-profile.test.ts` | **New.** S-PROFILE, 10 cases over the real company rig. |
| `test/evals/e-playbook.{ts,test.ts}` | **New.** The drill scorer and 7 cases that prove it discriminates. |
| `test/scenarios/company.ts` · `test/scenarios/s-blackout.test.ts` | The rig gains the shipped incident endpoint. |

## Implementation Approach

### The bundle needed nothing new — which is the result

Every component FR-9.2 names turned out to be expressible in M7.1's schema
exactly as frozen:

| FR-9.2 component | How the bundle says it |
|---|---|
| health-check watcher | a hire + a `schedule` trigger (15 min) + `playbooks/health-check.md` |
| CI babysitter | a hire + an `event: "ci"` trigger + `playbooks/incident.md` |
| dependency-update agent | a hire + a `schedule` trigger (24 h) + `playbooks/dependency-update.md` |
| severity-based escalation | prose in `incident.md` (judgment) + the harness's escalation table (mechanism) |

`test/main/skeleton-crew.test.ts` asserts this against the **real** shipped
bundle through the **real** `ProfileStore` — no fixture, no test-only
construction path. If a future built-in needs a field the public schema lacks,
that suite goes red, which is the only way ADR-0012's claim stays true rather
than merely stated.

One case pins the directory listing itself, so a private sidecar file the loader
knows about and the format does not cannot be added quietly.

### Severity is the agent's judgment; escalation is the harness's mechanism

**The harness never grades severity.** UC-09 step 2 gives triage to the on-call
agent, and `src/shared/incident.ts` contains no classifier, no keyword list and
no heuristic that could become one. What it contains is a total map from a
severity the agent *reported* to the escalation the harness then owes.

That split is what lets the escalation table be mechanical without the harness
forming an opinion about a CI run from its title.

### Two rungs, and why that is transcription rather than invention

**No document in this repository enumerates a severity scale.** A search of the
whole `docs/` tree finds exactly one rung named: "the Herald can announce a
**severity-1** aloud immediately" (SRS UC-09 step 4; SDD §7.5 repeats it).

The documents do, however, describe exactly two *treatments*: announce now, and
the ordinary UC-08 escalation path with an incident summary, batched into the
next brief. So the ladder is two rungs — the fewest that makes "severity-based
escalation" mean anything, and no rung the documents do not already imply.

Extending it is a **document decision, not a code one** (raised in the session
report). It is cheap by construction: `escalationFor` is one total function over
one array, so a four-rung ladder is a four-row table and nothing else moves.

Totality is enforced by a mapped type rather than a `default:` branch — adding a
rung without deciding its escalation fails to compile. A default case would have
accepted one and given it the *mildest* treatment, which is the wrong direction
for a safety ladder to fail in.

### The incident path: the harness reports, Artemis decides

The single most important structural finding of this package: **`LedgerEndpoint.submit`
takes a `Message`, and the writer check lives in Hermes's router** — only the
orchestrator's `propose` is ever applied (FR-5.2, FR-4.2, `src/main/ledger.ts:96-99`).
There is no other path by which a task comes into existence.

So SDD §7.5's "on-call agent task (auto)" means *without the Architect*, not
*without Artemis*. The chain is:

```
gh ingest → isCiFailure → IncidentEndpoint.raise
   → mail to Artemis (from agent.harbor, facts only)
   → she proposes → Hermes routes → LedgerEndpoint.submit → tasks.json
```

A harness that wrote `tasks.json` itself would have reached past the single
scribe — the exact "reaches past the schema" failure the risk line names, one
subsystem over. S-PROFILE asserts the negative directly: after `raise`, the
ledger is **unchanged**, and the task appears only once Artemis proposes.

The mail carries the ingested facts and nothing else — no diagnosis, no
severity, no summary. Asserted by name: the rendered vars contain no `severity`,
`diagnosis` or `summary` key. That is E-BRIEF-FAITH's rule applied at the port.

### Idempotence, because the Harbor has no notion of "new"

`GitHubHarbor.ingest()` rebuilds its queues from scratch every ten minutes — it
holds *what is open now*, not *what changed*. Without a cursor a still-red run
would be news forever. `IncidentEndpoint` keys on `<repo>#<kind>:<ref>` and
raises once.

Deliberately **in memory, not on disk**: a restart *should* re-raise a
still-failing incident, because after a restart nobody can be sure the earlier
request survived in anyone's inbox. A duplicate incident is cheap; a dropped one
is the subsystem not working.

The ingest wiring filters to repositories that actually answered
(`row.failure === null`) — `ingest` keeps a failed repo's stale queue rather than
blanking it, so re-raising from a blind repo would wake the crew for news that
is not new.

## Mathematical / Statistical Details

Two small total functions carry all the arithmetic.

**Severity composition.** Severities are ordered so that *lower is worse*,
matching the "severity-1" the SRS names. `Math.min` over two severities is
therefore "the worse of the two", and there is no second convention to remember.
`SEVERITY_1 = min(INCIDENT_SEVERITIES)` is asserted, so the constant and the
ordering cannot drift apart.

**E-PLAYBOOK adherence.** Over the four steps of `incident.md` that leave a
mechanical trace — triage, severity, reproduce, report —

```
adherence = |steps evidenced| / |SCORED_STEPS|
```

reported as a percentage for the trend line. But `passed` does **not** threshold
that fraction. It is conjunctive:

```
passed = reported ∧ (ungated actions = ∅) ∧ ¬resolvedWithoutWork ∧ (steps missed = ∅)
```

A fraction threshold lets the single most important step be the one quietly
dropped — an early draft scored 3/4 ≥ 0.75 as a pass for a drill that never
reproduced the fault, which `playbooks/incident.md` §3 explicitly forbids. Every
scored step is required instead.

Un-gated action is an outright disqualifier regardless of everything else: a
crew that triages in ninety seconds by force-pushing to main has done the one
thing the playbook exists to prevent.

## Design Decisions

**Two reserved endpoints rather than one.** `agent.harbor` carries incidents;
`agent.profiles` carries scheduled trigger wakes. Conflating them would make the
book of record say a routine 15-minute health sweep arrived from outside the
company. Both follow the M3 standing rule for harness-owned correspondents
(`agent.closing` is the model): never spawned, never a mailbox.

**The trigger wake was extracted from `index.ts`.** Through M7.2, `onTriggerFired`
appended a log line and stopped — so the health watcher and the dependency
updater were spawned and then never asked for anything. Two of FR-9.2's four
components were inert behind an entirely green suite. Rather than fix it inline
in boot wiring no test can reach, the message composition became
`triggerWakeMessage` in `src/main/profiles.ts`, with three cases on it. This is
the M6.10 shape restated: when logic cannot be tested, give the logic a home.

**The built-in ships watching no repository.** `harbor.json` has `repos: []`. A
built-in carrying somebody else's remote would ingest from a repository the
Architect never registered. They add theirs — which is "buildable with a text
editor" in the one place it matters. Flagged in the session report as a shipping
posture worth confirming.

**Alternatives considered.**
- *Harness writes the triage task directly.* Rejected: it bypasses FR-5.2's
  single scribe. The mail path costs one hop and keeps the ledger's one writer.
- *Severity inferred by the harness from the run title / log.* Rejected: it is
  the judgment UC-09 gives the agent, and a classifier here would be a second
  place that decides how bad things are.
- *A severity field in the profile bundle.* Rejected: it would have required
  changing M7.1's frozen public schema, and it is unnecessary — severity is
  assigned at triage time, not declared at activation time. This is what let the
  dogfood claim survive intact.
- *Satisfying UC-09 step 4 with the gate queue alone.* Rejected as dishonest.
  The gate is opened (it is the wired surface UC-08 already uses), **and** the
  spoken announcement is separately recorded as owed and unmet.

## The Herald, and what is deliberately not wired

UC-09 step 4 says a severity-1 "reaches the Herald immediately". **M6.9 — wiring
the Herald into the application — is deferred indefinitely by Architect
decision.** `src/main/herald/` has no production caller and gains none here.

So a severity-1's announcement is an obligation the harness **records and
reports as unmet**, never one it silently drops and never one it pretends to
satisfy with something that is not a spoken announcement:

- `log.jsonl` gains `event: "incident-announce-owed"`, `because: "herald-unwired"`;
- `onUnmetObligation` surfaces it through the ordinary degradation channel
  (invariant §7 — every degradation is visible).

Mutation M9 confirms this is load-bearing: replacing the report with a silent
`void what` turns S-PROFILE red.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/main/skeleton-crew.test.ts test/shared/incident.test.ts \
  test/main/incidents.test.ts test/scenarios/s-profile.test.ts \
  test/evals/e-playbook.test.ts test/main/profiles.test.ts
```

Observed: static checks green; **82 passed** across the seven suites. Full suite
**2593 passed / 6 skipped**, 13 failed — the recorded 9 Windows-local
deterministic failures (agent-worktree 4, s-crash 3, claude-transcripts 1,
cost 1) plus `s-stoploop` (2) under parallel load, verified green in isolation
(8/8) and unrelated to this package.

### Production call path (the M6 standing lesson)

| Leg | Where |
|---|---|
| endpoint constructed | `src/main/index.ts:1195` |
| CI failure → incident | `src/main/index.ts` `harbor-github` cadence `run` — `incidents?.raise(view.repos.filter(...).flatMap(...))` |
| triage report → endpoint | `src/shared/routing.ts:172` (route) → `src/main/hermes.ts:587` (`submitToHarbor`) → `onTriage` |
| schedule trigger → agent | `src/main/index.ts` `onTriggerFired` → `triggerWakeMessage` → `deliverFromHarness` |
| severity-1 → Architect | `chokePoints.submitNeedsHuman` (SDD §9's wired choke point) |
| severity-1 → Herald | **none, by decision.** Recorded owed; see above. |

### Mutation results — 9 applied, 9 killed

| # | Mutation | Result |
|---|---|---|
| M1 | drop the `HARBOR_ENDPOINT` routing branch | RED (S-PROFILE) |
| M2 | give severity-1 severity-2's treatment | RED |
| M3 | drop the raise dedupe | RED |
| M4 | route to the first binding regardless of repo | RED |
| M5 | default an unreadable report to severity-2 | RED |
| M6 | invent a conclusion when none was given | RED |
| M7 | widen the CI babysitter's env grants | RED |
| M8 | let the profile ask for `autonomous` on `destructive` | RED |
| M9 | announce silently instead of recording it owed | RED |

M1 is worth naming: Hermes's endpoint dispatch ends in an unconditional `else
this.submitToLedger(...)`, so a `HARBOR_ENDPOINT` route with no matching arm
becomes a **ledger submission** — the agent gets a ledger refusal for a
correctly-filed triage report, with no crash and no warning. Only a test that
sweeps a real outbox can see that, which is why S-PROFILE files its report
through a real spawned `fake-engine` and `hermes.sweep()` rather than calling
`onTriage` directly.

### Two defects found by writing the tests

1. **`'reproduce'` contains `'prod'`.** The E-PLAYBOOK scorer matched action
   names by substring against the gated list, so following the playbook's step 3
   scored as an un-gated production action. This is the M6 repeat-back defect's
   exact shape — a substring match standing in for an identity check. Actions
   are now a closed vocabulary compared by equality.
2. **`agent.sk-<target>-<hire>` is secret-shaped.** An abbreviated agent id in
   the tests matched `check-invariants`'s `sk-[A-Za-z0-9_-]{16,}` OpenAI-key
   pattern. The invariant was right and the naming was wrong; the tests now use
   the id production actually mints (`agent.skeleton-crew-myapp-…`).

## Related Docs

- `docs/adr/ADR-0012-mission-profiles.md` — the bundle format and the dogfood claim
- `docs/srs/SRS.md` — FR-9.2, FR-9.4, FR-11.1, UC-09, NFR-12
- `docs/sdd/SDD.md` — §7.5 (incident sequence), §9 (Watch enforcement)
- `docs/TEST-STRATEGY.md` — §3 (S-PROFILE), §6 (E-PLAYBOOK)
- `docs/implementations/2026-08-31-m7-1-profile-schema-loader.md` — the schema this bundle proves sufficient
- `docs/implementations/2026-08-31-m7-3-harbor-github-ingestion.md` — `isCiFailure`, the seam this package consumes

# 2026-08-31 — M7.5: the Front Office profile

## Problem / Motivation

FR-9.3 requires the Front Office to ship built-in with "issue/PR triage, reply
drafting with configurable autonomy (draft-only → auto-post), docs/changelog
sync, and release-prep checklists (UC-10)", and UC-10 step 3 adds the sentence
the whole package turns on: *"Outbound comments above a configured autonomy
level require Architect approval (batched into the standup by default)."*

The package's risk line names the stake exactly: **"auto-post" is the first
outward-facing irreversible act the company can take on its own — that gate
belongs in the harness, not in a playbook's prose.**

It is also the second half of ADR-0012's dogfood test. M7.4 proved the profile
schema sufficient for the Skeleton Crew; this package asks the same question of
a profile with a genuinely different shape, one whose defining feature is a
configurable outbound ladder rather than an incident path.

## What Changed

| File | Change |
|---|---|
| `src/shared/gates.ts` | **`outbound` added to `GATE_KINDS`** — the seventh kind, by Architect decision (see below). |
| `src/shared/outbound.ts` | **New.** The draft schema, the ladder (`dispositionFor`), and `PostPermit` — the branded permission the poster requires. |
| `src/main/frontoffice.ts` | **New.** `FrontOffice`: applies the ladder, files or holds or sends, and releases held drafts on a verdict. |
| `src/main/harbor/github.ts` | The port's **outbound half**: `postComment(permit)`, `PostOutcome`. |
| `src/main/index.ts` | Constructs the Front Office; dispatches drafts at the Harbor endpoint; routes `outbound` gate verdicts to it. |
| `profiles/front-office/**` | **New — 13 files.** `profile.json`, three hires, four triggers, four playbooks, `memo-policy.json`, `harbor.json`. |
| `prompts/watch/outbound-{what,why,blast,rollback}.md` | **New.** UC-08's four-part packaging (invariant §8). |
| `docs/srs/SRS.md` | **FR-11.1 amended** to name outbound public communication. |
| `test/shared/outbound.test.ts` | **New.** 16 cases — the ladder table, both halves. |
| `test/main/frontoffice.test.ts` | **New.** 14 cases — rung by rung, plus the batching/gate property. |
| `test/main/front-office-profile.test.ts` | **New.** 9 cases — the second dogfood proof. |

## Implementation Approach

### The one schema change, and why it was asked before it was made

FR-9.3 needs outbound comments configurable on their own ladder. The nearest
existing gate kind is `prod-facing`, and DECISIONS-LOG records a standing rule
from M5.3: *a memo trigger borrows an existing gate KIND rather than inventing a
seventh*.

But that rule carries its own qualifier — it was justified because "the trigger
itself is on the gate, so **the mapping loses nothing**". Here the mapping loses
precisely what the requirement is about: borrowing `prod-facing` would mean an
Architect who wants the company to answer issues unattended has, in the same
setting, granted it autonomous production actions. There would be no way to
write *"may reply, may not touch prod"*.

Put to the Architect as a BUILD-PROMPT §8.3 must-ask with three options
(seventh kind / borrow / borrow-plus-allowlist). **The Architect chose the
seventh kind**, and `docs/srs/SRS.md` FR-11.1 was amended to name it in the same
change rather than after it.

The addition is safe by construction: a policy that never mentions `outbound`
has no rule for it, and no rule means denied (`strictestRuleFor` → null →
`evaluateGate` holds). Every gate policy written before this kind existed now
refuses outbound posting, which is the direction a new permission class must
fail in.

### The ladder, and where it is enforced

| level | UC-10's words | what happens |
|---|---|---|
| `manual` | draft-only | filed for the Architect; nothing leaves the machine |
| `supervised` | above the configured level | held at an `outbound` gate; the standup carries it |
| `autonomous` | auto-post | sent, logged `granted: 'autonomy'` |

`dispositionFor` is an exhaustive `switch` rather than a comparison against a
threshold, so adding an autonomy level fails to compile here instead of silently
taking whichever branch a `>=` happened to put it in. For the one act in this
system that cannot be recalled, "the compiler asked" is worth more than a clever
inequality.

### `PostPermit` — the risk line answered structurally

The package owes a test that *a draft-only profile has no code path that posts*.
A guard would not satisfy that; a guard is a path with an `if` in front of it.

So `GitHubHarbor.postComment` takes a `PostPermit` and nothing else. The type is
branded (following `StationReason` in `src/shared/stations.ts`, the repo's
existing idiom), so no caller can assemble one from a boolean, an options bag, or
an object literal with the right fields. It has exactly two constructors:

- `permitToPost(draft, disposition)` — returns null unless the disposition is
  `post`, i.e. unless the level is `autonomous`;
- `permitFromApproval(draft, gateId, approved)` — returns null unless the
  verdict actually approved it.

A draft-only flow therefore cannot produce an expression that satisfies the
poster's signature. The absence is structural and is asserted on the API surface
— the S-SECRETS pattern applied to an outbound act.

### Batching IS the gate, not a second queue

UC-10 says outbound comments are "batched into the standup by default". The
temptation is a separate digest. Instead, `supervised` opens an ordinary
`outbound` gate, and `BriefInput.openGates` is already what the briefing reads —
so the standup carries the draft because it carries open gates.

That matters beyond tidiness: a second queue could drift from the gate, and the
drift would be in the direction of a comment that looked approved in one place
and was not in the other. Here there is one record, seen from two angles.

The whole draft reaches the gate, not a summary of it. UC-08's packaging is what
the Architect reads when deciding, and approving a comment without seeing its
text would be approving a signature on a blank page. The four packaging
sections are rendered from `prompts/watch/outbound-*.md` (invariant §8) with the
draft's facts interpolated.

### The dogfood claim, second half

The Front Office needed **no change to M7.1's profile schema** — three hires,
four triggers, four playbooks, a memo policy and a harbor file, all in the frozen
format. The one thing it did need was a gate kind, which is the Watch's
vocabulary rather than the bundle's, and which was decided by the Architect
before the code was written.

`test/main/front-office-profile.test.ts` runs against the real shipped bundle
through the real loader, pins the directory listing, and asserts the property the
seventh kind exists for: raising `outbound` to `autonomous` leaves `prod-facing`
at `manual`. If those were one kind that assertion fails, which is the coupling
made checkable rather than argued about.

## Mathematical / Statistical Details

The only arithmetic is the composition lattice, and it is reused rather than
restated. Autonomy levels are ranked `manual < supervised < autonomous`
(`AUTONOMY_RANK`), composition takes the minimum (`composeAutonomy`, M3), and
`permits(level, atLeast)` compares through the same rank so no second ordering
exists to disagree with the first.

The safety property asserted across all three levels of the global ceiling, for
every gate kind including the new one:

```
effective(kind) ≤ min(global, requested(kind))
```

asserted as a direction rather than as a value, because a test that merely
checked composition *happened* would pass for a composition that took the
maximum.

## Design Decisions

**One endpoint, two filings.** Outbound drafts arrive at `agent.harbor`, the
same reserved address M7.4 gave triage reports, dispatched on the subject the
agent wrote. This follows the ADR-0008 pattern the Odeon endpoint already uses
("one address, three filings"): the Harbor is one subsystem — everything in and
out — and a second reserved id would put two harness identities where the design
has one. An unrecognised subject is refused rather than guessed at.

**The harness decides whether, never what.** The comment body is the agent's
words, carried verbatim into the gate, the log and the post. The same rule the
incident summary follows (ADR-0005).

**An agent on no profile is draft-only.** `outboundAutonomy` returning null means
nobody put this agent on a profile; it gets the strictest rung rather than the
benefit of the doubt about speaking publicly under the company's name.

**The shipped Front Office is draft-only.** `outbound: manual`. Auto-post is a
thing an Architect turns on deliberately, having read what the profile may do —
not a default they discover after a comment has gone out.

**Alternatives considered.**
- *Borrow `prod-facing`* — rejected by the Architect; it couples auto-post to
  autonomous production actions.
- *A boolean `canPost` on the post call* — rejected: a boolean is exactly what a
  caller passes wrongly. The branded permit cannot be produced by mistake.
- *A separate outbound digest for the standup* — rejected: two records of one
  pending approval, which can disagree.
- *Draft-only as a hire without posting capability* — rejected: it makes the
  ladder a property of who was hired rather than of configuration, which is not
  what "configurable autonomy" means and would need a re-hire to change.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/shared/outbound.test.ts test/main/frontoffice.test.ts \
  test/main/front-office-profile.test.ts
```

Observed: static checks green; **39 passed** across the three suites. Full suite
**2636 passed / 6 skipped**, 11 failed — the recorded 9 Windows-local
deterministic failures plus `s-stoploop` (2) under parallel load, an identical
set to before this package. **No existing gate test broke**, which is the
evidence that adding a seventh kind was additive.

### Production call path

| Leg | Where |
|---|---|
| Front Office constructed | `src/main/index.ts:1258` |
| draft → endpoint | `src/shared/routing.ts` (`HARBOR_ENDPOINT`) → `src/main/hermes.ts` `submitToHarbor` → `index.ts` dispatch on `OUTBOUND_SUBJECT` → `frontOffice.onDraft` |
| composed autonomy | `activations.autonomyFor(agentId, 'outbound')` |
| hold → gate | `gates.submit({ kind: 'outbound', … })` with packaging from `prompts/watch/outbound-*.md` |
| verdict → release | `GateManager.onSettled` → `frontOffice.onVerdict` (`src/main/index.ts:695`) |
| post | `harbor.postComment(permit)` (`src/main/index.ts:1271`) |

### Mutation results — 10 applied, 10 killed

| # | Mutation | Result |
|---|---|---|
| M1 | draft-only posts | RED |
| M2 | mint a permit regardless of disposition | RED |
| M3 | mint a permit on a rejected verdict | RED |
| M4 | `supervised` posts instead of holding | RED |
| M5 | an agent on no profile is trusted | RED |
| M6 | a rejected draft is posted anyway | RED |
| M7 | an unreadable draft falls through | RED |
| M8 | a held draft is never released from pending | RED |
| M9 | the bundle ships auto-post | RED |
| M10 | `outbound` collapses back into `prod-facing` | RED |

## Related Docs

- `docs/srs/SRS.md` — FR-9.3, FR-9.4, FR-11.1 (amended here), UC-10
- `docs/adr/ADR-0012-mission-profiles.md` — the bundle format and the dogfood claim
- `docs/sdd/SDD.md` — §9 (Watch enforcement points)
- `docs/DECISIONS-LOG.md` — 2026-08-28 (M5.3, the borrow rule this qualifies) and 2026-08-31 (this decision)
- `docs/implementations/2026-08-31-m7-4-skeleton-crew.md` — the first half of the dogfood test

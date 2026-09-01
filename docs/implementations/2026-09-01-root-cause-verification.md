# A root cause is a claim about a file, so somebody else reads the file

**Date:** 2026-09-01 · **Branch:** `feature/triage-root-cause-verifier` (from
`fix/workspace-trust-and-remembered-targets` at `dd448a1`) · **Closes:** the second of
the two reconciliation gaps the SRS §6.1 live run named on 2026-09-01.

## Problem / motivation

On the 2026-09-01 live run the whole SRS §6.1 chain completed for the first time.
`docs/DECISIONS-LOG.md` records what came out of it:

> TWO reconciliation gaps, not one: nothing checks a claim against the ledger, and
> nothing checks a claim against the repository it describes. A plausible,
> well-cited, confidently wrong diagnosis is the failure mode this system must
> catch, and it currently cannot.

The first gap was closed the same day: `checkTriage` (commit `925bf28`) refuses a
triage report whose summary claims a task the ledger cannot show. Its own header is
explicit that it stops there —

> It checks claims, never judgement. Whether the diagnosis is CORRECT is not knowable
> from here, and a checker that pretended otherwise would be the same confident
> wrongness one level up.

— which is right, and leaves the second gap open. This change closes it.

The defect it is built from is worth stating precisely, because the design follows its
shape. The on-call agent triaged a real CI failure on `mertefesensoy/MUSAHIT` and
wrote:

> ArcLinker.run() has no injectable clock and always calls live utcnow(), so
> tests/test_linker.py and tests/test_arc_evolution.py hardcode NOW=2026-05-23 and
> fall outside the 30-day WINDOW_DAYS cutoff…

Most of that verifies. `tests/test_linker.py:29` really does pin `NOW = datetime(2026,
5, 23, 12, 0, 0)`; `WINDOW_DAYS` really is 30; the failing branch really is
`ci/add-pytest-workflow`. The **root cause is false**, and takes ten seconds to check:
`musahit/arcs/linker.py:122` reads `async def run(self, run_id: str, now: datetime |
None = None)`, documented as *"Tests pass a fixed value so fixtures with hardcoded
timestamps stay inside the window"*, and already threads it into `_load_arc_cache(now)`.
The fix it proposed — "add an optional `now` param and thread it through ~19 call
sites" — was largely work already done.

The observation that makes this tractable: **"the cause is X" is not judgement in the
way a severity is.** A severity is an opinion about consequence and belongs to the
on-call agent by UC-09 step 2. A root cause is an assertion about the content of a
file, and a file can be read by somebody else.

## What changed

| File | Change |
|---|---|
| `src/shared/root-cause.ts` | **New.** The claim (`claim` + ≥1 `file`/`line`/`quote` citation), the verdict (`agree`/`refute`/`cannot-tell` + `because` + what was `read`), `parseRootCauseVerdict`, `checkVerdict` (the verifier's own evidence rule), `formatCitations`. |
| `src/shared/incident.ts` | `triageReportSchema` gains optional `rootCause`. `checkTriage` gains the unciteable-claim rule and takes `taskIds: … \| null`, so a missing ledger skips the ledger rule alone instead of every rule. |
| `src/main/incidents.ts` | `VERDICT_SUBJECT`; `verifierFor` option; `verify()` (asks, or logs why it did not); `onVerdict()` (records beside the claim, refuses an unevidenced or unsolicited one); the dispute note back to the claimant. |
| `src/shared/profile-activation.ts` | `verifierAgentFor` — the resolver `index.ts` calls, as a pure function so a test can reach it. |
| `src/shared/profile.ts` | `VERIFIER_HIRE` — the bundle convention, not a schema field. |
| `src/shared/brief.ts` | A **refuted** root cause becomes a health fact with a `log#` ref. `agree`/`cannot-tell` do not. |
| `src/main/index.ts` | Wires `verifierFor` to `verifierAgentFor`, and dispatches `INCIDENT-VERDICT` to `onVerdict` instead of `onTriage`. |
| `prompts/harbor/incident-verify-{subject,body}.md` | **New.** The request to refute — every word of method, including "try to refute it". |
| `prompts/harbor/incident-disputed-{subject,body}.md` | **New.** The note to the agent whose diagnosis was disputed. |
| `profiles/skeleton-crew/hires/verifier.json` | **New.** The hire, with its own `dailyTokens` and no `envGrants`. Profile version → 2. |
| `profiles/skeleton-crew/playbooks/incident.md` | Step 6 documents `rootCause` and what happens to one. |
| `test/shared/root-cause.test.ts` | **New.** 18 cases on the two schemas and `checkVerdict`. |
| `test/main/incident-verification-wiring.test.ts` | **New.** 8 cases joining the seams `index.ts` joins, with the shipped prompts, profile bundle, plan and routing rules. |
| `test/{shared/incident,shared/brief,main/incidents}.test.ts` | 7 + 2 + 11 cases added. |
| `test/{main/skeleton-crew,main/hires-exchange,scenarios/s-profile}.test.ts` | Hire count 3 → 4, profile version 1 → 2. |

## Implementation approach

### 1. The claim must be falsifiable, or it is not written down

`rootCauseSchema.cites` is `.min(1)`, and a citation needs `file`, `line` **and**
`quote`. The quote is the load-bearing field. "ArcLinker has no injectable clock" is
unfalsifiable prose; `linker.py:122 — "async def run(self, run_id: str)"` is a
statement a second reader holds against the file and watches fail. Had the shape been
required on 2026-09-01, the false claim would have had to write out a line whose real
text contains `now: datetime | None = None`.

`checkTriage` gains one narrow lexical rule beside `LEDGER_CLAIM`: a summary matching
`/\broot[- ]cause/i` with no `rootCause` block is refused. As narrow as its neighbour,
and for the same reason — a detector on "because" or "caused by" fires on every honest
sentence, and a checker that refuses honest reports is one agents write around.

### 2. The verifier is another agent, addressed by mail

The harness cannot read the target repository and must not learn how (ADR-0005). So
the check is a correspondent, exactly as the incident request to Artemis is: a `query`
from `agent.harbor` carrying the claim, the citations and the address to answer at,
with every word of framing in `prompts/harbor/` (invariant §8). The verdict comes back
as an `inform` on the subject `INCIDENT-VERDICT`, which the router already accepts for
this endpoint and which `index.ts` tells apart from a triage report before parsing
either.

### 3. The verifier is held to the claimant's own rule

`checkVerdict` refuses an `agree` or a `refute` that cites nothing, and one whose
citations overlap the claim's by no file. An unevidenced "wrong" is worth no more than
the unevidenced claim it disputes, and it is more dangerous: a verdict is the answer
that gets believed. `cannot-tell` is owed only its reason, so the honest answer stays
cheap — a verifier that could not open the file must be able to say so without
inventing a reading.

What `checkVerdict` never does is compare a quote to a file. It checks discipline; the
truth is the verifier's finding.

### 4. Recorded beside, never instead

`onVerdict` appends `incident-root-cause-verdict` carrying the claim and the verdict's
reasoning, both verbatim. The `incident-triaged` entry stands exactly as written; no
severity moves; no escalation is reversed. This is the Architect's standing position
and it is the right one: the verifier is another agent reading the same repository
under the same pressures, and a system that let one reading overwrite another would
have swapped a confident wrong claim for a confident wrong correction. Two records
with their evidence attached is something a human can referee.

A `refute` additionally mails the claimant an `inform` with the evidence — the one
thing the previous run never told anybody — and becomes a health fact in the next
standup. `agree` and `cannot-tell` stay in `log.jsonl`: a contradiction inside the
company's record is news, a confirmation is not, and the brief has 90 seconds.

### 5. Who pays

The verifier is an ordinary hire in the profile bundle, named by the `VERIFIER_HIRE`
convention. It therefore carries its own `budget.dailyTokens` and appears on the
activation screen the Architect approves — the cost is a line in a file rather than an
agent turn charged to whoever was nearby. A profile that declares no such hire gets
its incidents triaged and **unverified**, with the reason in the log (invariant §7: the
degradation is visible, not silent).

Three ways `verify()` declines to spend a turn: no root cause was asserted; no verifier
is available; the only verifier is the report's author. A fourth guard — an explicit
"already verified" set — was written, and **its regression passed with the guard
deleted**: an incident raises once and is triaged once, so `verify` cannot be reached
twice. The dead guard was removed and the test rewritten against the mechanism that
actually provides the property.

## Known limits, stated rather than discovered later

**Nothing pins a commit.** The verifier reads the working checkout, which is the
same `targetPath` the on-call agent triaged in — but time has passed, and the fix
the diagnosis implied may already have landed. A claim that was true when written
can then look false. The mitigation is in the prompt, not the code: the verifier is
told it is reading the checkout as it is now, that `refute` means the claim was
wrong about the source rather than that the source has moved, and to use `git log`
to tell those apart. Pinning would mean carrying a SHA from the CI run through the
incident, which the ingested item does not currently supply.

**A dispute escalates nothing, deliberately.** No gate opens, no `needs_human` is
submitted, no severity changes. A verifier that can be wrong must not be able to
interrupt the Architect on its own say-so; the refutation reaches them at the next
standup with both sides' quoted lines, which is where a human can referee it.

**The verifier is asked once and never chased.** If it never answers, the entry
stays `incident-root-cause-verification-requested` with no verdict beside it — a
visible absence rather than a silent one, but not a retry.

**Only the agent that was asked may answer.** A colleague who spots a false
diagnosis unprompted is refused with the reason. That is the cost of the property
being enforceable at all: accepting volunteers would let the claim's own author
file a verdict on their own claim.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/shared/root-cause.test.ts test/shared/incident.test.ts \
  test/shared/brief.test.ts test/main/incidents.test.ts \
  test/main/incident-verification-wiring.test.ts test/main/skeleton-crew.test.ts
```

Every regression was mutation-checked: the rule was broken, the test confirmed red, the
break reverted. Thirty-one mutations, each killing the test it was aimed at. Two came
back **green** on the first pass and were fixed rather than accepted — the dead
"already verified" guard above, and a resolver test that passed an empty instance list
where an instance under a different id was the case that mattered.

Two failures on the affected surface are **pre-existing** and were confirmed red at
`dd448a1` before any of this landed: `s-profile > asserts stricter-wins composition`
and `hires-exchange > reads the installed facts itself`, both asserting `manual` on
`destructive` where the shipped `profile.json` says `supervised`.

## Related docs

- `docs/DECISIONS-LOG.md` — the live run, the first reconciliation gap, and this one.
- `docs/adr/ADR-0012-mission-profiles.md` — playbooks are prose, policy is data; the
  dogfood rule this hire exercises.
- `docs/adr/ADR-0005` — the harness/judgement split this design runs along.
- `src/shared/brief.ts` — `checkNarrative`, the precedent: a sentence citing a ref no
  fact supports is refused.

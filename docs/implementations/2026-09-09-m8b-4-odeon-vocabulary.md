# A prompt never instructs an act its endpoint refuses

**Date:** 2026-09-09 · **Milestone:** M8b.4 · **Branch:** `fix/m8b-4-odeon-vocabulary`
from `origin/main` `2306ae2`

---

## 1. Problem / motivation

Finding 12 of [the M8 exit run](../demo/m8-onehour-aftershock.md). Artemis's first
attempt to end a meeting was rejected outright (seq 439–440):

```
bounce [2026-09-09T07-36-10-000Z-adj1] to "agent.odeon":
the odeon endpoint takes "propose", "inform", "agree", "refuse" or "done" acts; got "request"
```

She recovered by re-sending as `refuse`, so this cost a round trip rather than a
deadlock — **and it is only invisible because the agent worked around it.** The refusal
itself is good: it enumerates the accepted acts, and it is correctly recorded as
`hermes/bounce`, which is the system being honest.

**Where the mismatch came from, precisely.** Nothing shipped told her to send
`request`. She composed it, because there *was* no way to adjourn — which is M8b.2's
subject, and M8b.2 gave her `refuse` and a control verb. What is left for this package
is the half that can be mechanised: **a prompt that ships an act the endpoint refuses.**
Nothing checked that, and nothing would have caught it before an agent met the bounce.

---

## 2. What changed

| File | What |
|---|---|
| `test/shared/prompt-acts.test.ts` | **new**, 6 cases. Reads every shipped prompt, extracts the act each one instructs beside the endpoint it names, and checks both against `ENDPOINT_CONTRACTS`. |

No production change. The vocabulary was already consistent once M8b.2 moved `refuse`
into the odeon's `handles`; what was missing is the assertion that keeps it consistent.

---

## 3. Implementation approach

The acceptance is exact: *"asserted against the endpoint's own schema rather than
against a copy of it."*

So neither half is typed into the test. The **acts** come from the shipped
`prompts/**/*.md`; the **contract** comes from `endpointContract(id)`. A test carrying
its own table of accepted acts would be a second place to be wrong, and it would agree
with `ENDPOINT_CONTRACTS` right up until somebody narrowed one of them.

Four assertions, and the fourth is the one M8b.2 earned:

1. the scan finds instructions at all (see below);
2. every instructed endpoint is a reserved id;
3. every instructed act is one the endpoint **accepts**;
4. every instructed act is one the endpoint **handles** — because an
   accepted-but-unhandled act is recorded as an aside and acted on by nobody. A prompt
   instructing one tells an agent to do something that will be filed and ignored, which
   is exactly what happened to the declined floor before M8b.2.

Plus two that pin the odeon's own vocabulary to the sentence the run met, including the
explicit negative: it does **not** accept `request`. M8b.2's answer was to give the
orchestrator `refuse` and a verb, not to widen the endpoint until anything is
acceptable, and that decision deserves a test that fails if it is reversed.

### The guard that keeps this file honest

`expect(ALL.length).toBeGreaterThanOrEqual(4)`. The scan is regex-based, so a pattern
that stopped matching would turn every assertion into a pass over an empty list — the
vacuous-green shape this build has paid for before. The mutation round confirms the
scan is live rather than trusting that guard: breaking a **prompt** (Q4, Q5) and
breaking the **contract** (Q1, Q2, Q3) each kill it.

The patterns are deliberately narrow — the two shapes the shipped prompts actually use.
A looser scan would match prose *about* an act (the bounce message quoted in a comment,
a paragraph explaining why `done` is an aside), and a test that fails on documentation
is a test people delete.

---

## 4. Mathematical / statistical details

Not applicable: this package adds a test and changes no algorithm, formula or numeric
behaviour.

The property it asserts is a subset relation, stated once here because it is the whole
content of the package. For every instruction *(f, a, e)* found in a prompt file *f*
telling an agent to send act *a* to endpoint *e*:

> *a* ∈ `handles(e)` ⊆ `accepts(e)`

The inclusion `handles ⊆ accepts` is the endpoints module's own invariant; this package
adds the left-hand membership, which nothing checked before.

---

## 5. Design decisions

**A test, not a production change.** The tempting fix is to widen the odeon's
`accepts` so `request` stops bouncing. That is the wrong direction: the accept-set is
the endpoint's contract, and widening it to match whatever an agent happened to send
turns a refusal that teaches into no refusal at all. The bounce Artemis met was correct
behaviour — it enumerated the accepted acts and she recovered on the next attempt.

**Scan the shipped prompts, not a fixture.** Same reasoning as
`GH_TOKEN_REFRESH_COMMAND` being one exported constant: a rule that does not match the
sentence the agent was given is a rule that grants nothing.

**What it does not cover, stated plainly.** An act an agent invents for itself. Nothing
in a prompt produced Artemis's `request`, so no prompt-scanning test could have caught
it. That gap is closed by M8b.2 giving her a documented way to adjourn, not by this.

---

## 6. Verification

### Definition of Done

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs
```

### Mutation — 5 of 5 real mutants killed, baseline green, control survived

| Mutant | What it breaks | |
|---|---|---|
| Q1 | the odeon stops accepting `propose`, which every filing prompt instructs | killed |
| Q2 | `refuse` drops out of `handles`, so the floor prompt instructs a merely-tolerated act | killed |
| Q3 | the odeon widens until Artemis's `request` would have been fine | killed |
| Q4 | a **shipped prompt** instructs the act that bounced on 2026-09-09 | killed |
| Q5 | a shipped prompt names an endpoint that does not exist | killed |
| **Q6** | **CONTROL — changes nothing** | **SURVIVED, as it must** |

Q1 and Q4 dying together is what proves the scan actually reads the odeon's prompts:
one breaks the contract side, the other the prompt side, and each is caught only if
both are really being read.

**Q3 survived its first run, and the reason is worth recording.** Two endpoints share
the accept-list `['propose','inform','agree','refuse','done']`, and the mutant hit the
first occurrence — a *different* endpoint. Retargeted with an anchor unique to the
odeon, it dies. A mutant that edits the wrong line reports the same word as a real
survivor.

### Adversarial refutation

- **Could the scan pass vacuously?** It asserts it found at least four instructions,
  and the mutation round breaks it from both the prompt side and the contract side.
- **Could it fail on prose?** The patterns match only the two instruction shapes the
  prompts use; the odeon's own bounce sentence, quoted in a comment in
  `endpoints.ts`, is not matched.
- **Does it cover the act M8b.2 introduced?** Yes — `meeting-floor.md` now instructs
  `act: "refuse"`, which the second pattern matches and Q2 proves is checked.

---

## 7. Related docs

- [The M8 exit run](../demo/m8-onehour-aftershock.md) — Finding 12, and the bounce at seq 439.
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8b.4's acceptance criteria.
- [ADR-0003](../adr/ADR-0003-hermes-message-bus.md) — the speech-act table and the endpoint contracts.
- [ADR-0008](../adr/ADR-0008-odeon-accountability.md) — what the Odeon endpoint is for.

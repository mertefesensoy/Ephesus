# A meeting can end itself

**Date:** 2026-09-09 · **Milestone:** M8b.2 — *the briefing can be read* ·
**Branch:** `fix/m8b-2-single-attendee-meeting` from `origin/main` `4562f7b`

---

## 1. Problem / motivation

Finding 11 of [the M8 exit run](../demo/m8-onehour-aftershock.md) — the direct cause
of SRS §6.1 clause 4 failing.

The runner convened the meeting `ephctl help`'s own usage line documents, which is
also the one [`EXIT-M8.md`](../EXIT-M8.md) §5.4 sends them to convene:

```
ephctl odeon:convene --attendee agent.artemis --agenda "the incident"
```

It could not terminate. Artemis diagnosed the loop from the log herself, and her
account is better than a paraphrase (seq 442):

> *`log.jsonl` seq 387 records the meeting convened with `attendees:
> ["agent.artemis"]` — one attendee. Each time I speak you record `meeting/said`
> and pass the floor to the next attendee, **who is me again**: seq 393 → 394, seq
> 427 → 428. A single-attendee meeting cannot advance past its only speaker … Two
> things would each fix it, and both are yours: adjourn when the only attendee
> yields, or treat a declined floor as ending the round.*

The hour ended with no minutes, and §5.4 asks a runner to read the narration against
the incident. There was nothing to read.

**Three defects, not one**, and only the first is the one that was filed:

1. **No meeting of any size could end itself.** `close()` is reachable only from the
   ODEON tab. `after()` wraps, so a two-attendee meeting cycles for ever too — the
   one-attendee case is just where it is visible in a single log row.
2. **A decline could not reach the driver.** `ENDPOINT_CONTRACTS` gave the Odeon
   `accepts: [… 'refuse' …]` but `handles: ['propose','inform']`, so Hermes recorded
   Artemis's `refuse` as an **aside** and the endpoint never saw it. That is why
   seq 442 was "accepted" and nothing happened.
3. **There was no way to end a meeting from a script.** `odeon:convene` shipped with
   no counterpart, and — exactly like Finding 3's `budget:set` — it was not in the
   deliberately-refused list either. A CLI runner could open a meeting and had no
   verb to close one.

---

## 2. What changed

| File | What |
|---|---|
| `src/shared/meeting.ts` | `MeetingState.declinedInARow`; `decline()`; `isFloorDecline()`; `reply` and `interject` reset the round. |
| `src/main/meeting.ts` | `MeetingDriver.declineFloor()` — passes the floor on, or adjourns and writes the minutes through the same `close()` an Architect-driven close uses. |
| `src/shared/endpoints.ts` | The Odeon **handles** `refuse`, not merely accepts it. `done` stays an aside. |
| `src/main/index.ts` | Routes a floor decline to the driver via `isFloorDecline`; every other `refuse` is answered as the aside it is rather than handed to the filing parser. |
| `src/shared/control.ts`, `src/main/control.ts` | The `odeon:adjourn` verb. |
| `test/scenarios/company.ts` | The rig's mirror of the shipped dispatch, updated in step. |
| `test/shared/meeting.test.ts` | 12 cases — the round rule and `isFloorDecline`. |
| `test/main/meeting.test.ts` | 8 cases — the driver, the minutes on disk, the log rows. |
| `test/scenarios/s-meeting.test.ts` | 1 case — the whole path, through a real spawned process. |
| `test/shared/endpoints.test.ts`, `test/shared/control.test.ts` | The contract and the write-verb guard. |

---

## 3. Implementation approach

### The round rule

`MeetingState` gains one field: `declinedInARow`. A decline increments it; anything
**said** resets it to zero, and so does an Architect interjection. When it reaches
`attendees.length`, one full round has passed with nothing said and the meeting
adjourns itself.

A **count** rather than a set of names, and that is exact rather than lazy: the floor
advances on a decline, so consecutive declines are consecutive *attendees* by
construction. It generalises for free — a two-attendee meeting needs two declines, a
one-attendee meeting needs one, and a one-attendee meeting is the documented case.

A decline writes **no transcript entry**. "I have nothing further" is not a
contribution to the minutes, and recording one would make a silent round read like a
discussion.

A decline out of turn is **refused, not held**. A held *reply* is a contribution that
arrived early and is worth keeping; a held *decline* answers a question that has moved
on by the time it is released.

### Handling `refuse` without turning it into a filing

Adding `refuse` to `handles` is necessary — it is what stops Hermes recording it as
an aside — but not sufficient, because everything the endpoint handles otherwise
reaches the filing parser, and "I cannot do that" is not a malformed deck. That was
the exact regression the aside mechanism was built to prevent.

So the dispatch splits it: a `refuse` **from the current floor-holder** is a declined
floor; every other `refuse` is answered as a noted aside and never parsed.

### Why `isFloorDecline` is an exported function rather than an inline condition

A mutation run found the reason. The condition originally lived inline in `index.ts`
**and** in the scenario rig's hand-copy of that dispatch, and breaking the shipped one
left every test green — `index.ts` is not reachable from a test in this build, so the
scenario was exercising the copy. Two copies of a routing rule is the same defect
shape as two copies of a schema: they agree until one is edited, and the disagreement
is invisible. One exported pure function, called by both, and the mutant dies.

---

## 4. Mathematical / statistical details

The termination argument, since a meeting that ends itself must be shown to.

Let *n* = `attendees.length` ≥ 1, and let *d* be `declinedInARow`. Define the round as
the sequence of consecutive `decline` calls since the last state-changing utterance.

- `decline` on the floor-holder sets *d* ← *d* + 1 and advances the floor by one
  position (mod *n*).
- `reply` (accepted) and `interject` set *d* ← 0.
- Adjournment fires when *d* ≥ *n*.

**Termination.** In any suffix of the meeting containing no accepted `reply` and no
`interject`, *d* is strictly increasing on each decline, so after at most *n* declines
*d* ≥ *n* and the meeting closes. The bound is tight: *n* declines are needed and
*n* suffice.

**Soundness — no premature adjournment.** Because the floor advances by exactly one
position per decline and resets to 0 on any utterance, *d* consecutive declines are
declines by *d* **distinct** attendees (positions *k*, *k*+1, …, *k*+*d*−1 mod *n*, all
distinct while *d* ≤ *n*). So *d* ≥ *n* implies every attendee declined without
anything being said between them. The meeting therefore never adjourns while any
attendee still has something to add on the current question.

**Liveness — no meeting adjourns while it is productive.** One contribution resets *d*
to 0, so a room in which anybody keeps speaking never adjourns itself. This is the
property the `reply` reset carries, and it is why the counter measures *silence since
the last contribution* rather than total declines.

The `>=` rather than `===` is deliberate: `attendees.length` is 0 for a degenerate
meeting with no attendees, which `===` would never satisfy.

---

## 5. Design decisions

**Artemis's second proposal, not her first.** She offered two fixes and said either
would do: *"adjourn when the only attendee yields, or treat a declined floor as ending
the round."* The Architect chose the second (2026-09-09). The first is a special case
of it and would have left the two-attendee meeting unable to terminate — the same
defect one step further away, waiting for the next runner who convenes two.

**`odeon:adjourn` sends no action items.** Action items are the chair's reading of what
a meeting decided. A control surface that invented them would be writing the ledger's
input on nobody's authority, which is the line `watch:approve` refuses to cross.

**An adjournment reuses `close()`, awkwardly.** `decline` returns an already-closed
state and `close()` refuses one it finds closed, so the driver re-opens the state for
the length of that call. That is ugly, and the alternative is worse: a second code
path that writes minutes is a second thing to keep in step with the first, and the
minutes are the entire artifact this package exists to produce.

**The log says WHY it ended.** A meeting that closes itself with no reason recorded is
indistinguishable from one a person closed, so an `adjourned` row carries
`because: "every attendee declined the floor with nothing said"`.

---

## 6. The adversarial pass, and the two things it found

### The prompt steered agents straight past the new mechanism

The round rule and the routing were done, 130 tests were green, and the round's
mutants were dying. Then: *does anything TELL an agent it can decline?*

The shipped `prompts/odeon/meeting-floor.md` said:

> If you have nothing useful to add, **say that in one line** rather than filling
> the silence.

Saying it is a turn. A turn is a contribution. A contribution **resets the round**.
So an agent obeying the prompt keeps the meeting alive for ever — and that is exactly
what happened on 2026-09-09, where Artemis said she had nothing further at seq 393
and again at seq 427 and the floor came back both times. **The round rule alone would
not have ended that meeting.** She reached `refuse` on her third attempt by reasoning
about the log, not because anything told her the act existed.

The prompt now names the act, says what a decline does, and says why a "nothing
further" turn is not one. Three tests assert it against the **shipped** file rather
than a fixture, for the reason `GH_TOKEN_REFRESH_COMMAND` is one exported constant: a
rule that does not match the sentence the agent was given is a rule that grants
nothing.

**The honest limit.** `PromptStore` seeds a home's copy once and never re-seeds, so an
Ephesus that has already run keeps the old wording. Unlike M8b.1 there is no
placeholder to smuggle the fix through — this is prose. A fresh home (which is what an
exit run uses) gets it; an existing one is covered by `odeon:adjourn`, which needs no
prompt at all.

### An unkillable mutant, and what it meant

`isFloorDecline`'s `state.status === 'open'` check survived every test, because
`close()` also sets `floor: null` — so `state.floor === message.from` is already false
for every meeting `close()` produced. Two conditions that cannot disagree.

Rather than delete a guard that reads as the intent, the state is now constructed by
hand in a test (`{ ...open, status: 'closed' }`, floor intact) and the guard is pinned.
A guard no test can reach is the defect shape this build has paid for before.

---

## 7. Verification

### Definition of Done

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs
```

### Mutation — 11 of 11 real mutants killed, control survived

| Mutant | What it breaks | |
|---|---|---|
| N1 | a full round of declines no longer ends the meeting | killed |
| N2 | the round needs one MORE decline than there are attendees | killed |
| N3 | saying something no longer restarts the round | killed |
| N4 | the Architect's follow-up no longer restarts the round | killed |
| N5 | a decline writes a transcript entry, so silence reads as discussion | killed |
| N6 | an attendee who does not hold the floor may decline it | killed |
| N7 | `refuse` goes back to being an aside — the 2026-09-09 state exactly | killed |
| N8 | a refuse from ANY attendee declines the floor, not just its holder | killed |
| N8b | a refuse still declines the floor of a CLOSED meeting | killed *(after the pinning test; it SURVIVED before)* |
| N9 | the adjourn verb stops declaring that it changes something | killed |
| N10 | an adjourned meeting leaves no minutes on disk | killed |
| **N11** | **CONTROL — changes nothing** | **SURVIVED, as it must** |

### Three rounds before this one were thrown away, and why that matters

This is the evidence, so the failures belong in it.

1. **A round reported 11/12 with the control KILLED.** Free RAM had fallen to 0.90 GB
   and `test/global-setup.ts`'s `requireHeadroom` refuses below 1 GB — exiting
   non-zero *without running a single test*, which the harness scored as a kill. Every
   verdict in that round was unearned, including the eleven that looked right.
2. **A stopped harness left two mutants in the tree** — a flipped boolean and a
   *deleted* line, neither findable by grepping for inserted marker text. The next
   round ran against a broken tree, so every run was red and the control "died" again.
3. **A restore was not byte-exact.** Python's text mode translates newlines, so
   restoring a prettier-written LF file on Windows rewrote it as CRLF.

The harness now reports INVALID rather than "killed" when the suite refuses to start,
checks a baseline SHA per file **before and after** every mutant, and does byte-exact
I/O. The package was committed before the final round so `git status` is a second
check on the tree.

**Every one of those was caught by the planted no-op control.** A mutation score with
no control is a number with no condition.

---
---

## 8. Related docs

- [The M8 exit run](../demo/m8-onehour-aftershock.md) — Findings 11 and 12, §9, §10 clause 4.
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8b.2's acceptance criteria.
- [ADR-0008](../adr/ADR-0008-odeon-accountability.md) — the Odeon, minutes and the floor.
- [ADR-0003](../adr/ADR-0003-hermes-message-bus.md) — the speech-act table and what obliges a reply.
- [`docs/EXIT-M8.md`](../EXIT-M8.md) §5.4 — the clause this unblocks.

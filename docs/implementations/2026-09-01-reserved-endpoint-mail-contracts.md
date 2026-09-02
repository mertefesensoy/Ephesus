# Reserved endpoints: derive what they hear from what they say

**Date:** 2026-09-01 · **Branch:** `fix/reserved-endpoint-routing` (cut from
`fix/workspace-trust-and-remembered-targets`)

## Problem / Motivation

`RESERVED_AGENT_IDS` (`src/shared/reserved.ts`) names the seven addresses the
harness owns. Five of them ask agents questions — they send `request` or `query`,
which ADR-0003's obligation table says **obligates a reply**. Nothing checked
that the same address could hear the answer.

It had already gone wrong twice:

1. **`agent.profiles`** sends every scheduled trigger wake and had no branch in
   `routeMessage` at all. Replies fell through to the mailbox lookup and bounced
   with `no mailbox for "agent.profiles"`. On the 2026-09-01 live run the crew
   ran their sweeps all evening and every report was dropped. Fixed earlier the
   same day (`fec96f3`).
2. **`agent.harbor`** sends the triage `request`, but its handler ran *every*
   reply through `parseTriageReport`. An on-call agent that answered honestly in
   prose was told its JSON was malformed. Recorded, not fixed, until now.

Two instances of one shape is a pattern, and the pattern has a name: **nobody
derived what an endpoint must ACCEPT from what it SENDS.** The audit below shows
the gap was wider than the two known cases — `refuse`, the act PROTOCOL.md
explicitly instructs every agent to use when it cannot do what was asked, bounced
off *every single one* of the five endpoints that ask questions.

## The audit

Seven reserved ids, against `routeMessage` as it stood at `dd448a1`.

| Endpoint | Sends (call site) | Obliges a reply? | Router accepted | What an agent's reply did |
|---|---|---|---|---|
| `agent.hermes` | `refuse` — `Hermes.bounce` | no | **nothing — no branch** | Fell through to the mailbox lookup: `no mailbox for "agent.hermes"`. False, and the worst answer available — the address is not missing, it is the router's own. Another `refuse` from `agent.hermes` came back, so a compliant agent could ping-pong until the hop cap diverted it to Artemis. |
| `agent.ledger` | `agree`/`refuse` — `Hermes.replyFromHarness` | no | `propose`, orchestrator only | Bounced, naming the endpoint and the act. **Correct** — see "No fix needed". |
| `agent.library` | **`request`** — `Reflection.request`; `agree`/`refuse` | **yes** | `propose` only | The prompt names `propose`, so the happy path worked. A `refuse` — "I cannot condense this" — bounced. `Reflection.outstanding` kept holding that agent, and the Architect got no record of why the memory was never condensed. **Instance three.** |
| `agent.closing` | **`request`** — `ClosingTime.begin` | **yes** | `inform`, `done` | An ACK routed. `agree`/`refuse` bounced — at exactly the moment ("I can't park, I'm mid-write") the answer matters most. |
| `agent.odeon` | **`request`** ×5 (`briefing.ts`, `meeting.ts` actions, `odeon.ts` deck comment, `index.ts` memo-required and memo-triage), **`query`** ×1 (the meeting floor), `inform` ×1 | **yes** | `propose`, `inform` | A filing and a meeting answer routed. `done` — the act PROTOCOL.md names for finishing — bounced off the very endpoint that had asked. So did `agree` and `refuse`. **Six reply-obliging asks against a two-act accept-set.** |
| `agent.harbor` | **`request`** — `Incidents.raise`; `agree`/`refuse` — `Incidents.refuse`, `FrontOffice.reply` | **yes** | `inform`, `done` | A triage report routed, then the handler parsed *everything* as a triage report. A `refuse` never got that far — it bounced at the router. **Instance two, on both levels.** |
| `agent.profiles` | **`request`** — `wakeMessage` | **yes** | `inform`, `done` | A sweep report routed (fixed that morning). A `refuse` — "skipped, the workspace was locked" — bounced. **Instance one, half-fixed.** |

## What changed

| File | Change |
|---|---|
| `src/shared/endpoints.ts` | **New.** The mail contract of every reserved address: `sends`, `accepts`, `handles`, and `deaf`. Plus `TERMINAL_ACTS`, derived from the obligation table rather than enumerated. |
| `src/shared/routing.ts` | Six hand-written endpoint branches collapse into one that reads the contract. The ledger's two context-dependent rules stay inline. |
| `src/main/hermes.ts` | New **aside** path: an act the endpoint accepts but does not handle is recorded in `log.jsonl` and answered with nothing, instead of being handed to a parser that knows one body shape. |
| `src/main/incidents.ts` | `onTriage` reads a `refuse` as a declination and an `agree` as an acceptance, leaving the incident awaiting triage — instead of running both through the report parser. |
| `src/main/index.ts` | The profiles handler logs `sweep-refused` vs `sweep-reported`, and carries the act. |
| `test/shared/endpoints.test.ts` | **New.** The guard. |
| `test/shared/routing.test.ts` | Four assertions reversed, with the reason recorded at each. |
| `test/main/incidents.test.ts`, `test/main/hermes.test.ts` | Regressions for the declination path, the aside path, and the `agent.hermes` reply. |

## Implementation approach

### The rule

> An act is **terminal** when replying to it obliges nothing further:
> `inform`, `agree`, `refuse`, `done` — the complement of `REPLY_OBLIGING_ACTS`.
>
> **If an endpoint sends an act that obliges a reply, it must accept every
> terminal act.**

The complement is computed, not typed out:

```ts
export const TERMINAL_ACTS = SPEECH_ACTS.filter((act) => !requiresReply(act))
```

so the two tables cannot drift.

This is exactly the design tension the brief named — *"can receive" is not
"accepts anything"* — and the complement is what expresses it. The three acts
that **ask** the harness for something (`request`, `query`, `propose`) are still
refused wherever they were refused before. `agent.profiles` still bounces a
`propose`, because a sweep report never asks the harness for a verdict and an
endpoint that quietly took one would owe an answer nothing is there to give. The
rule only forces an endpoint to hear the answers it has *itself obliged an agent
to send*.

### `accepts` vs `handles` — the second half of instance two

Widening the router alone would have converted instance one's bug into instance
two's: the reply stops bouncing, reaches a handler that knows one body shape, and
comes back as a parse error. So the contract splits the accept-set:

- **`handles`** — acts the handler acts on (the Odeon files a `propose`, answers
  the floor with an `inform`).
- **`accepts` − `handles`** — **asides**. Hermes records them in `log.jsonl` with
  `aside: true` and the agent's own words, and sends no reply.

Answering nothing is correct, not lazy: FR-3.4 forbids **dropping**, not
answering, and a terminal act obliges nothing back. The agent said its piece, the
book of record has it, and nobody is owed a verdict.

The Harbor is the exception that earns its own code: `Incidents.onTriage` knows
*which incident* a declination is about, so it records the refusal against that
incident and leaves it awaiting triage rather than treating it as an aside. The
one outcome worse than the old bounce would be reading "I cannot triage this" as
triage.

### Why `routing.ts` reads the table

The contract could have been a document. It is code that `routeMessage` executes,
so it cannot become decoration that drifts from the router — which is precisely
how six branches each carrying their own act list drifted from the mail they send.

## Design decisions

**Why a new module rather than extending `reserved.ts`.** That module documents
that it "deliberately imports nothing": `agents.ts` validates spawn ids against
it and `message.ts` imports `agents.ts`, so a `SpeechAct` import there is an
import cycle in a module zod initializes at import time — a crash, not a style
problem. `endpoints.ts` sits above both.

**Why a test and not a `check-invariants.cjs` rule.** The brief asked for a
justification, and the deciding factor is instance two.

`check-invariants.cjs` greps source text for patterns a reviewer cannot hold in
their head — a `git` call outside `src/main/git.ts`, a truncating write to
`log.jsonl`. A grep rule here would have to be something like *"every id in
`RESERVED_AGENT_IDS` appears in a `message.to ===` comparison in `routing.ts`"*.
That would have caught instance one. **It would have passed instance two
happily** — `agent.harbor` *was* named in a branch, one that refused the acts its
own requests obliged. And it would have gone stale the moment the six branches
became one, which is the very refactor this change makes.

The property is not textual. It is what a pure function **returns** for a given
message, and the only way to check that is to call it. `test/shared/endpoints.test.ts`
iterates `RESERVED_AGENT_IDS` itself — the source of truth, not a copy — so an
eighth endpoint is covered the moment it is declared, and fails **closed**: a
reserved id with no contract fails the roll call before it can ship. It fails,
it does not report.

**Why `refuse` rather than only the act each prompt names.** A narrower rule
("accept `refuse` plus whatever the endpoint's prompt asks for") was considered
and rejected: the antecedent is not mechanically checkable — it depends on
reading prose in `prompts/` — so the guard would degrade into the convention the
brief ruled out. The complement rule is checkable, and strictly safer: accepting
a reply and answering it truthfully is never worse than bouncing it.

**Why `agent.hermes` is not made to receive.** It is the only endpoint that gets
an explicit *deaf* contract. The router writes refusals and reads nothing; there
is no handler and nothing a reply could accomplish. What was wrong was not that
it refused, but that it lied about *why* — `no mailbox for "agent.hermes"` says
the address does not exist. It now says what is true, and points the agent at its
orchestrator. The guard permits deafness only when the endpoint obliges no reply,
and only with a written reason.

## Verification

```bash
npx vitest run test/shared/endpoints.test.ts test/shared/routing.test.ts test/main/incidents.test.ts test/main/hermes.test.ts
```

Gate: `npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npx vitest run`.

### Mutation checks

Every regression was broken and confirmed red before being reverted.

| # | Mutation | Result |
|---|---|---|
| 1 | Add `'agent.newthing'` to `RESERVED_AGENT_IDS`, no contract | **3 red** — roll call, per-endpoint routing, and `no mailbox` |
| 2 | Narrow `harbor.accepts` back to `['inform','done']` (the shipped state) | **3 red** — including `agent.harbor sends request/agree/refuse — which obliges a reply — but refuses "agree"` |
| 3 | Skip the contract branch for `PROFILE_ENDPOINT` in `routeMessage` (instance one, exactly) | **4 red** — reproduces the literal `no mailbox for "agent.profiles"` from the live run |
| 4 | Remove the declination branch from `Incidents.onTriage` (instance two) | **2 red** |
| 5 | Remove the aside branch from `Hermes` | **1 red** (`records an aside to an endpoint and answers nothing`) |

Mutation 4 initially turned only one of two tests red; the second was tightened
to assert that nothing is mailed back at a declination, and then turned red too.

### What was actually run

Per-file first, then the whole suite. Every file that touches a reserved endpoint
was run in isolation and passed:

`endpoints` · `routing` · `ledger-endpoint` (shared and main) · `incidents` ·
`reflection` · `odeon` · `briefing` · `meeting` · `library` · `hermes` ·
`s-bounce` · `s-closing` · `s-profile` · `s-onehour` · `s-meeting` · `s-brief` ·
`s-memo` · `s-ledger` · `s-mode` · `s-gym` · `s-livelock` · `s-deckgate`

**Whole suite, main checkout, HEAD `9e5e96f`** (which already contains this
change, merged at `23d5c99`): **3131 passed, 6 skipped, 9 failed across 4 files.**
None of the nine are this change:

- `test/shared/cost.test.ts > splits one transcript across the days it spans` —
  known and pre-existing, flagged in the brief as not mine.
- `test/main/agent-worktree.test.ts` (4) and `test/scenarios/s-crash.test.ts` (3)
  — reproducible when run alone, and about the agent **spawn** path: they fail
  with `timed out waiting for the agent to start` and `expected 'installing' to
  be 'running'`. `agent-worktree.test.ts` does not reference a single reserved
  endpoint. No mail is routed before an agent starts.
- `test/scenarios/s-closing.test.ts > proceeds at the deadline with the silent
  agent` — passes when run alone, in both checkouts. Flake under parallel load.
  Worth noting because this file *does* exercise `agent.closing`; it was checked
  rather than assumed.

### Correction: the earlier timeout diagnosis was wrong

An earlier draft of this section attributed a mass of failures (~130) to `.git`
lock contention across sibling worktrees. **That was wrong**, and the correction
matters because the wrong version would send the next reader chasing worktrees.

The real cause was vitest's **default 5 s `testTimeout`**, which the integration
tests exceed because TEST-STRATEGY §2 puts them on real fs and real git in temp
dirs. `39aad30` ("stop deleting a directory git is still standing in") raises
`testTimeout`/`hookTimeout` to 30 s and fixes a teardown racing git; with it, the
same suite that showed ~130 failures shows 9. The observable conclusion at the
time — *not caused by this change, verify per file* — held, but the mechanism did
not, and `--no-file-parallelism` "not helping" was evidence about slowness, not
about locking.

`test/scenarios/s-profile.test.ts > asserts stricter-wins composition against a
laxer global ceiling` was also reported here as pre-existing (verified by
reverting every change and re-running against a pristine tree). It now passes:
`3a50f7c` fixed it on the branch.

## Related docs

- `docs/adr/ADR-0003-hermes-mailboxes.md` — the speech acts and the obligation table
- `prompts/agora/PROTOCOL.md` — what agents are told about replying and refusing
- `docs/srs/SRS.md` — FR-3.4 (never drop silently), FR-5.2, FR-7.2, FR-9.2
- `docs/sdd/SDD.md` §7.1, §7.5 — the harness endpoints

# Returning a rejection to its author — closing the last silent drop in Hermes

## Problem / motivation

`Hermes.reject()` parked a refused outbox message in `.rejected/` and appended
an `error` entry to `log.jsonl`. Its own comment cited FR-3.4's "never drop
silently" — while being entirely silent **to the agent that wrote the message**.
The author was never told, so it could not learn, correct, or retry.

Observed live on 2026-09-01: Artemis composed a complete, fully-cited standup
brief, set `requires_reply: false` on a `propose`, and the whole message was
destroyed. The only symptom anywhere was one line in the error log. Her brief
loop broke every window and nothing surfaced it.

That specific *cause* is already fixed — `parseMessage` derives the obligation
flag instead of refusing it (commit `b4f5f1d`). This change closes the
**general** form: any rejection, for any reason, comes back to its author.

The distinction matters because the two silences are not the same size.
Deriving `requires_reply` removed one of the ways a message can be refused; the
schema has twelve fields, every one of which can fail validation, and JSON
itself can fail to parse before any of them are reached. Fixing the reason that
happened to fire is not the same as fixing the class.

## What changed

| File | Change |
|---|---|
| `src/main/hermes.ts` | `reject()` takes an `author: string \| null` and returns the refusal to it; new `returnToAuthor()` composes and delivers that refusal; `RejectionRecord` gains `notice: Message \| null`; the `error` log entry gains `author` and `noticeId`. |
| `src/main/index.ts` | The Architect-facing degradation report now distinguishes "rejected" from "rejected with no author to tell" — the only remaining silent path. |
| `prompts/hermes/rejected-subject.md` | New. The refusal's subject line (invariant §8: prompt text lives in `prompts/`, never in code). |
| `prompts/hermes/rejected-body.md` | New. The refusal's body: what failed, why, and where the text still is. |
| `test/main/hermes.test.ts` | Five regressions; opt-in `withPrompts` on the rig; the forgery case's "inbox is empty" assertion narrowed to its real intent. |
| `test/scenarios/s-bounce.test.ts` | The scenario-level proof, through the real company wiring. |

## Implementation approach

### The author comes from the path, never from the content

`reject()` has two callers, and they know very different things:

| Caller | File lives in | Who wrote it? |
|---|---|---|
| `deliverOne()` | `agora/agents/<ownerId>/outbox/` | `<ownerId>` — **structural** |
| `consumeInbox()` | `agora/agents/<id>/inbox/` | unknowable |

On the outbox path the author is the **directory name**. That holds for every
rejection reason, including `not valid JSON`: a file whose bytes are garbage
still has a knowable author, because the knowledge is in the filesystem layout
rather than in the bytes that failed. Every outbox rejection is returnable.

This is also strictly stronger than reading `from` would be. A forged file —
`agent.a` writing a message claiming `from: agent.b` — is refused *to
`agent.a`*, the agent that actually wrote it. Trusting the content would send
the refusal to an agent that never wrote anything, and leave the forger
uninformed.

On the inbox path there is nothing equivalent. The directory names the
**recipient**, and `from` is the very field that just failed to validate.
Naming an author there would mean guessing, so the caller passes `null` and the
log entry is all anyone can have — which is what the record should say when it
is the truth.

`author` is therefore a parameter, not something `reject()` derives: only the
call site knows what its own directory means.

### Loop safety: three independent guarantees, no counters

A refusal that is itself refused would ping-pong. Nothing here counts hops or
tracks seen ids; the property falls out of three structural facts.

1. **The notice never enters an outbox.** `reject()` fires only on files found
   in an outbox sweep or an inbox consume. The notice goes straight into the
   author's inbox via `deliverFromHarness()`, exactly as `bounce()` does,
   because the harness has no outbox of its own. There is no path by which a
   harness-written notice re-enters `deliverOne()` — the only rejecter that
   notifies. A refusal cannot be refused.
2. **It is validated before it is sent.** `composeMessage()` parses against
   `messageSchema` and *throws*, so an ill-formed notice is never written at
   all, rather than being delivered to fail on the far side. That throw is
   caught: the file stays parked and logged either way, and only the
   notification is lost — visibly. This is not hypothetical. `to` must match
   `agentIdSchema`, and a stray directory under `agents/` yields an owner id
   that does not.
3. **It obligates nothing.** `refuse` is not in `REPLY_OBLIGING_ACTS`, so
   `requires_reply` derives `false` and the notice starts no chain. `hops: 0`,
   so it can never trip a hop cap either.

Guarantee 2 is the one that would be easy to leave out, and it is the one that
makes the other two safe to state absolutely: without it, a malformed notice
could reach an inbox and be rejected there.

### What the author is told

Enough to fix the message, and no more:

- **which message** — the file's *basename*. Not the message id: an unparseable
  file has no id. The basename is the one identifier that survives every
  failure mode.
- **why** — the rejection reason verbatim, the same string the log gets.
- **where the text still is** — `outbox/.rejected/<name>`, relative to the
  agent's own directory, so it can recover what it wrote instead of rewriting
  from memory. Relative rather than absolute because the harness home's layout
  is not an agent's business.

The prose lives in `prompts/hermes/rejected-subject.md` and
`prompts/hermes/rejected-body.md`. Invariant §8: prompt text is config, and an
agent-facing refusal is read by a language model.

### `.rejected/` parking stays

The Architect can still read what an agent got wrong. Parking is now
*load-bearing* rather than merely forensic: the notice points at the parked
copy, so removing it would make the refusal a dead reference.

## Design decisions

**`author` as a parameter vs. deriving it inside `reject()`.** Deriving would
mean `reject()` inspecting its own file path to guess whether it sits in an
inbox or an outbox — knowledge the caller already has for free, encoded twice,
and wrong the moment a third caller appears.

**Reusing `deliverFromHarness()` rather than paralleling `bounce()`.**
`replyFromHarness()` cannot be used: it requires a parsed `original`, which is
precisely what a rejection does not have. `deliverFromHarness()` is the
underlying write-and-log primitive that both existing precedents rest on, and
going through it earns the notice the same NFR-13 `delivery` entry as any other
message.

**A new conversation rather than the original's.** The original's conversation
id is inside the part of the file that could not be read. The notice opens
`rejected-<basename>` — stable, so re-rejecting the same name lands in the same
thread, and honest, because it never claims membership in a thread nobody could
parse.

**`notice: Message | null` on `RejectionRecord`.** Symmetric with
`BounceRecord.refusal`, and it makes "nobody could be told" an explicit state
rather than an absence. `index.ts` reads it to name that case in the
degradation report — under invariant §7, the one remaining way an agent's work
can end in silence is worth saying out loud.

**Log ordering.** The notice's own `delivery` entry lands one `seq` *earlier*
than the `error` entry that cites it: the notice must exist before its id can be
recorded. The `noticeId` field is what ties the pair, so the order costs
nothing, and the alternative — an `error` entry that cannot name its own notice
— costs the link.

## Verification

```bash
npx vitest run test/main/hermes.test.ts test/scenarios/s-bounce.test.ts
```

### MUTATION-CHECK

Every regression was verified by breaking the behaviour, confirming red, and
reverting.

| # | Mutation | Expected red | Observed |
|---|---|---|---|
| M1 | `reject()` notifies nobody (the original bug restored) | the four "author is told" cases | 4 failed |
| M2 | forgery refusal addressed to `parsed.message.from` | "tells the outbox owner" | 1 failed |
| M3 | inbox reject (schema branch) passes `agentId` instead of `null` | "author cannot be named" | 1 failed |
| M3b | inbox reject (JSON-parse branch) passes `agentId` | "author cannot be named" | 1 failed |
| M4 | notice act `refuse` becomes `request` (obligates a reply) | ping-pong + content cases | 2 failed |
| M5 | `returnToAuthor()` rethrows instead of catching | "could not tell anyone" | 1 failed |
| M6 | the parked-path pointer removed from the body prompt | "enough to fix the message" | 1 failed |

M3 initially passed, which was a **test defect, not a code one**: the first
draft fed the inbox only unparseable bytes, exercising one of the two inbox
failure branches. The test now writes both an unreadable file and a readable one
that is not a message, and M3/M3b both fail as they should.

### Known-unrelated failures in this environment

- `test/shared/cost.test.ts > splits one transcript across the days it spans` —
  pre-existing on this branch, not touched here.
- `npm run typecheck` reports one error,
  `test/renderer/emotes.test.ts: Cannot find module '.../limezu.emotes.json'`.
  That asset is gitignored (a paid tileset), absent on this machine, and
  generated by no script. Pre-existing and unrelated; no other type error.
- The suite is flaky on Windows with `EPERM`/`EBUSY` on `rename`/`rmdir` of
  temp directories under parallel workers. Individual files pass on re-run
  against an unmodified tree; failures were separated from real ones by
  re-running each affected file in isolation.

## Related docs

- `docs/srs/SRS.md` FR-3.4 — never drop silently
- `docs/TEST-STRATEGY.md` §3 S-BOUNCE — "sender notified, nothing dropped"
- `docs/adr/ADR-0003` — the message plane and the obligation table
- `src/shared/reserved.ts` — why the router has a legal `from`

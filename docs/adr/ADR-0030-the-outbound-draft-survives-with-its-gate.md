# ADR-0030 — The outbound draft survives with its gate

**Status:** accepted · **Date:** 2026-09-06 · **Extends:** ADR-0027 ·
**Depends on:** ADR-0027 (the rule this applies), FR-9.3 / UC-10 step 3 (the Front Office)

## Context

ADR-0027 made the company's coordination state survive a restart and wrote down
the test for deciding what belongs in a record: **persist a decision about an
identity; do not persist an observation about a process, and do not persist
state a live subsystem re-derives from a durable source.**

An audit of M8.8 on 2026-09-06 applied that test to every remaining in-memory
map in `src/main/` and found exactly one that fails it: `FrontOffice.held`.

`gates.json` restores an `outbound` gate. The **draft** that gate holds lived
only in `FrontOffice.held`, and nothing wrote it anywhere. So after a restart:

1. The outbound gate is back in the approvals queue — M8.8 doing its job.
2. Its packaging still renders correctly, because the words were baked into the
   gate's prose at `submit` time, so the Architect reads a normal-looking gate.
3. They approve it. `onVerdict` finds no draft and returns `false`.
4. `src/main/index.ts` did `void frontOffice?.onVerdict(...)` — the `false`
   reached nobody.

The gate settles as approved, `log.jsonl` records a verdict, and **the comment
never leaves the machine**. Proved by execution before the fix: the same office
posts the comment; a second office over the same record posts nothing.

Two things make this worth its own record rather than a bug fix in silence.
M8.8 did not cause it but it did make it **reachable** — before the restore, the
queue came back empty and the gate could not be approved at all, so the failure
had nowhere to happen. And it lands on the one path where the company speaks in
public under the Architect's name, which is the act FR-9.3 exists to gate.

**ADR-0027's rule was right; its list was short by one.** A filed draft is a
decision about an identity — *these words, from this agent, held at this gate*.
Nothing re-derives it: the draft cannot be recovered from the gate, because the
gate carries it rendered into prose through `prompts/watch/outbound-*.md`, and
reconstructing structured fields from that would be the harness paraphrasing a
comment it is about to publish.

## Decision

### 1. A fourth record, `drafts.json`

| File | Holds | Written on |
|---|---|---|
| `drafts.json` | filed outbound drafts, and which gate each awaits | file, hold, verdict, restore |

It follows the ADR-0027 pattern exactly: its own `JsonStateStore`, its schema
beside the types it validates (`src/shared/outbound.ts`), written through
`writeRestartRecord` so a failed write is a reported degradation and never
unwinds the thing it was recording. The per-subsystem choice ADR-0027 argued for
is what makes this an addition rather than a redesign.

`FrontOffice.persist()` is private and called after **every** mutation of
`filed` or `held`, never from the callers of those mutations — the same
discipline the other three records use, and for the reason this ADR exists: a
persist a caller can forget is a record that is correct until the one path
nobody re-read.

### 2. `awaiting` is recorded, not inferred from `gateId`

A decided draft keeps its gate id as history. If a restore re-held every draft
that had one, comments the Architect already answered would come back in
`pending()` — which is what the standup reads — and be put in front of them
again. So the row carries `awaiting`, set false when the verdict lands.

The schema states how the two fields relate (`awaiting` implies a gate) rather
than leaving the impossible pair representable. A hold that could not open a
gate is not waiting for anyone: nobody was asked.

### 3. A draft still awaiting a verdict is never trimmed

The record trims oldest-first at `DRAFT_RECORD_TRIM`, because each row carries a
comment body of up to 20,000 characters and unbounded growth is the M8.10 defect
class arriving early. **The trim skips any draft still waiting at a gate**,
whatever its age. Shedding reviewed history is housekeeping; shedding a draft
the Architect can still approve is the defect this record exists to close.

### 4. A gate that came back without its words is REPORTED

`restoreCompany` reconciles the restored gates against the restored drafts and
raises `restart/draftless-gate:<id>` for any open `outbound` gate holding none.
It does not settle it — the same rule ADR-0027 §4 applies to an orphan block,
and for the same reason: auto-denying drops the agent's work on the harness's
own authority, and auto-approving publishes a comment nobody can read (NFR-9).
The Architect is told to deny it and ask the agent to draft again.

The second half of that guarantee is at the verdict itself: `index.ts` now
reports the same cause when `onVerdict` answers `false`, so an approval the
harness cannot honour is a visible condition rather than a comment that quietly
never went out (invariant §7).

## Options considered

- **Rebuild the draft from the gate's packaging.** No new file, and the words
  are already on the gate. Rejected: they are there as *rendered prose* from
  four prompt templates, so `repo`, `target`, `ref` and `body` would have to be
  parsed back out of text the harness wrote. Publishing under the company's name
  from a paraphrase of a paraphrase is not a recovery path.
- **Carry the structured draft on the gate record.** Tempting — one file instead
  of two, and the gate is already durable. Rejected because it puts a subsystem's
  payload inside another subsystem's record: every future gate kind with state
  would want the same, and `gates.json` becomes the `session.json` ADR-0027
  rejected. The per-subsystem line is the thing worth keeping.
- **Only surface the refused verdict** (invariant §7 and nothing more). Honest
  about the loss and much smaller. Rejected as the *whole* answer: it tells the
  Architect the comment is gone rather than sending it, and the agent's work is
  still discarded. It is included here as the second half, not as the fix.
- **Persist nothing; deny outbound gates at boot.** Safe and cheap. Rejected: it
  makes every restart silently cancel the company's pending speech, which is a
  policy decision taken by a restart.

## Consequences

- The harness home gains a fourth file. Like the other three, absence is an
  ordinary first run and says nothing.
- **Reviewed history is bounded and can be shed**; drafts awaiting a verdict are
  not. An Architect who never answers gates keeps every one of those drafts.
- A damaged `drafts.json` now has a stated consequence of its own
  (`restart/drafts-unreadable`): outbound gates still open hold no words, and
  the remedy is to deny them and ask for the drafts again.
- The audit that found this checked every other gate-keyed payload in the tree.
  `FrontOffice.held` is the only one outside `GateManager`, so this closes the
  class rather than one instance — but the check is worth repeating whenever a
  subsystem starts keying state by gate id.

## Prior art

[ADR-0027](ADR-0027-what-survives-a-restart.md) — the rule, the mechanism
(`JsonStateStore`), and the three records this joins.
[ADR-0011](ADR-0011-watch-breaker-budgets.md) — the gate and its verdict.

# M8.3 — The log-derived surfaces tell the truth

## Problem / motivation

`log.jsonl` is the company's book of record, and NFR-13 says the Activity UI,
the briefing compiler, the metrics and forensics consume only this file. Five
defects meant that every one of those consumers was reading something other
than what the file said, and not one of them failed while doing it.

- **`readLog()` returns the OLDEST 500 entries**, and three callers used the
  default. The standup read that head and *then* filtered `seq > cursor`, so
  once the cursor passed 500 every brief was compiled from an empty fact set —
  measured on the Architect's machine as 676 of 1,177 entries invisible, with a
  retro on disk citing `log#1–log#499` against a highest seq of 1,117. The org
  layer folded every metric from 500 rows. The company-mode proof gate (SRS
  §6.9) could not see evidence older than the window.
- **The Activity panel opened its cursor at seq 0** and paged forward, so after
  an overnight run it showed the company's first 300 events and crawled towards
  the present one append at a time.
- **Hermes appends in thirteen places and pushed nothing.** 282 of 1,177
  entries — a quarter of everything the company recorded — never told the panel
  they existed.
- **19% of rows rendered blank**, because the panel's formatter had seven cases
  and a fallback that reached for `agentId` or `subject`.
- **The breaker row read `signal`** where every emitter writes `signals`, an
  array, so the reason was blank on all 93 breaker rows while the row still
  looked populated.

Every fixture in this repository was smaller than 500 entries, which is why
none of this was visible to the suite.

## What changed

| File | Change |
|---|---|
| `src/main/agora.ts` | `onAppend` publish/subscribe on the single writer; `readLogAll` / `readLogSince` with no window and a reported cost; `onSubscriberError`, `onSlowRead`, `slowReadMs` options. |
| `src/main/eventlog.ts` | `sizeBytes()` for the cost report. |
| `src/main/index.ts` | The three pinned callers read the whole book; one subscription replaces 31 hand-written pushes; the Agora's two new seams report through the M8.2 degradation channel. |
| `src/shared/log.ts` | `logRowSummary` — total over `LOG_KINDS`, no `default`, and unable to return an empty string. |
| `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts` | `agora:logTail`. |
| `src/renderer/src/ActivityPanel.tsx` | Opens at the tail, then follows; renders through the shared formatter. |
| `test/main/log-surfaces.test.ts` | 10 cases, all over a log larger than the old window. |
| `test/shared/log-row.test.ts` | 34 cases: one realistic payload per kind, plus the rows that were wrong. |
| `test/renderer/activity-panel.test.tsx` | 5 cases mounting the real panel against a 1,177-entry log. |
| `docs/sdd/SDD.md` | §1.1 rows for `agora.ts` and `eventlog.ts`. |

## Implementation approach

### The notification comes from the book, not from its authors

The Architect chose publish/subscribe at the Agora over threading a callback
through Hermes, and asked for it as a proper pub/sub rather than a single hook.
That is the M8.1 lesson applied one level down: the bug was "somebody appended
and forgot to notify", and the fix is to make forgetting impossible rather than
to add the thirty-second reminder. `appendLog` is the single writer — invariant
§5 keeps it that way — so a subscriber there hears about every append that will
ever exist, including the thirteen in Hermes that had no partner and including
whatever M8.4 through M8.12 add.

The contract is four promises, each with a case:

- **Delivered after the entry is on disk**, so a subscriber that re-reads the
  log finds what it was told about. The Activity panel does exactly that.
- **In sequence order, synchronously**, so ordering on screen is ordering in the
  file.
- **One subscriber's failure costs nobody else its event, and never fails the
  append.** The book of record does not depend on who is listening; a throwing
  listener is reported as a degradation and the write still lands.
- **Delivery walks a snapshot**, so subscribing or unsubscribing during delivery
  is safe.

Thirty-one hand-written `ui.send(LOG_APPEND_CHANNEL)` calls became one
subscription. One push survives deliberately: the company-mode `onChanged`
callback, which fires for the Gymnasium ledger — a different file that the
append subscription knows nothing about.

### The whole book, with the cost on the record

The three pinned consumers each need everything: the standup narrates from every
event since the last brief, the org layer folds every row, and the proof gate
reads all the evidence. A bounded read cannot be right for any of them, because
a fact silently outside the window is worse than a slow answer.

So `readLogAll()` and `readLogSince(cursor)` have no window, and the cost is
reported rather than hidden: a read that takes longer than `slowReadMs`
(default 50 ms, about a frame) raises a degradation naming the entry count, the
file size and the duration. M8.10 owns making it cheap and now has measurements
from real use to size that against. This is deliberately the opposite of the
old behaviour, which was fast and wrong.

### A row that cannot be blank, and a kind that cannot be forgotten

`logRowSummary` moved to `src/shared/log.ts`, beside the kind list it has to be
total over. The switch has no `default` and ends in a `never` check, so adding a
kind is a compile error at the place where its row is decided — the same
technique the floor's station table already uses.

Per-kind wording is for readability; the fallback is for truth. If a kind's
fields are all absent, from an older entry or a changed emitter, the line falls
back to the entry's own remaining fields rather than rendering nothing. A blank
row is a lie about the book of record: the event happened. `secret-rotated`
shows the name and never the value (ADR-0010).

### The panel opens at the end of the book

One new read, `agora:logTail`, using the tail reader M8.2 already added for the
degradation replay — the same question asked by a different consumer, so the
answer is shared rather than re-derived. The follow path is unchanged and was
always correct; only the starting point was wrong.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
npx vitest run test/main/log-surfaces.test.ts test/shared/log-row.test.ts test/renderer/activity-panel.test.tsx
```

**Production call path** (ENGINEERING-STANDARDS §6.7): `src/main/index.ts` calls
`agora.onAppend(() => ui.send(LOG_APPEND_CHANNEL))` immediately after the
degradation replay; `BriefingJob.gather` calls `readLogSince(sinceSeq)`;
`OrgLayer.gather` and `CompanyModes.gymEvents` call `readLogAll()`;
`ipcMain.handle(agoraLogTail)` serves `agora.tailLog` to the panel's first read.

**Every case runs against a log larger than the old window**, because that is
the defect. The assertions name which entries appear, never how many, since a
count would have passed against both the head-window bug and the blank rows.

**Six mutations, each killed by a named test and reverted:**

| Mutation | Killed by |
|---|---|
| `readLogSince` windowed at 500 again | "returns everything after the cursor, not a head that is then filtered" |
| appends stop publishing | six cases across the pub/sub and the panel |
| a throwing subscriber is not isolated | "one subscriber failing never costs another its event" |
| the breaker row reads `signal`, singular | "reads the breaker's signals, plural, as the emitter writes them" |
| the never-blank fallback removed | "falls back to the entry's own fields rather than rendering nothing" |
| the panel opens at the head again | three cases in the mounted panel |

## Related docs

- `docs/sdd/SDD.md` §1.1 (`agora.ts`, `eventlog.ts`) and §4.3 (the log)
- `docs/implementations/2026-09-03-m8-2-the-degradation-channel.md` — the tail reader this reuses, and the channel the new cost report speaks through
- `docs/PROGRESS.md` — the M8 plan and this package's evidence

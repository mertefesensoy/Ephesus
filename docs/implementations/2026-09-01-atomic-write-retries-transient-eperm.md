# The atomic write threw away the write when a scanner touched the file

## Problem / motivation

`writeFileAtomic` is the one way anything in this harness writes a file another
process may read — cursors, the registry, the task ledger, settings, secrets,
every delivered message. It writes a temp file and renames it over the target,
and it rethrew any failure of that rename.

On Windows the rename fails for a reason that has nothing to do with this
program. Anything holding the destination open for a moment — a virus scanner,
the search indexer, another reader — makes `renameSync` return `EPERM`. Measured:

| what is holding the destination | `renameSync(tmp, dest)` | destination afterwards |
|---|---|---|
| nothing | renamed | new contents |
| `openSync(dest, 'r')` in this process | **EPERM** | **old contents** |
| `openSync(dest, 'r+')` in this process | **EPERM** | **old contents** |
| a child process holding `openSync(dest, 'r')` | **EPERM** | **old contents** |

The destination keeps its old contents, so this is not cosmetic: **the write is
lost.** A lost cursor write, a lost registry entry, a lost message — surfaced as
a degradation rather than as the transient it actually was.

It was observed, not theorised. On a pristine tree, before any change in this
session, `hermes.test.ts > reports the pathology before the cap fires` failed
with exactly this:

```text
EPERM: operation not permitted, rename
  '…\eph-hermes-oTQein\agora\agents\agent.b\.cursor.json.9fc8ede6aa9f.tmp'
  -> '…\agora\agents\agent.b\cursor.json'
  at writeFileAtomic src/main/fsx.ts:26
  at Hermes.consumeInbox → Hermes.decideOnStop
```

and passed on an immediate re-run of the same file on the same tree.

## What changed

| File | Change |
|---|---|
| `src/main/fsx.ts` | The rename is retried on a transient failure with a bounded synchronous backoff; a permanent failure still throws at once; the temp file is still removed on the failure path. |
| `test/pin.ts` | New `renameBlocks()` — a three-valued, contention-verified probe for whether this platform refuses a rename over a held destination. |
| `test/main/fsx.test.ts` | New. The first tests this module has had. |

## Implementation approach

### Which failures are worth waiting on

`EPERM`, `EACCES` and `EBUSY` are what a brief hold reports. Everything else —
`ENOENT`, a full disk, a cross-device link — is rethrown untouched, because
waiting cannot change it.

**Windows overloads `EPERM`**, and that is the trap in this change. Measured:

| destination | code |
|---|---|
| held open by another process | `EPERM` |
| a non-empty **directory** | `EPERM` |
| an empty **directory** | `EPERM` |
| under a missing directory | `ENOENT` |

Renaming a file over a directory is permanent and a caller bug, and it reports
the same code as the transient case. Retried blindly it would spend the entire
budget and then fail with a worse story than it could have told immediately. So
the destination is checked before waiting on it, and a directory throws at once.

Other permanent `EPERM`s exist — a read-only destination is the obvious one —
and those do spend the budget before throwing. That is a bounded cost on a path
this harness does not take, and it is preferred to guessing at more causes than
have been observed.

### The budget is a latency ceiling, not a patience knob

This blocks the main process. There is no asynchronous atomic write here and the
delivery path is synchronous, so the ceiling is a trade between a stall long
enough to be felt and a write that is simply discarded. NFR-2 gives delivery a
p95 of 500 ms, and a transient is far rarer than one delivery in twenty, so
**500 ms** buys the retry without putting that budget at risk in the normal
case. Backoff starts at 5 ms and doubles to a 100 ms cap, so a hold that clears
quickly — which is the usual one — costs a few milliseconds.

`Atomics.wait` does the waiting: the function is synchronous by contract, so
there is nowhere to yield to, and a spin would burn a core.

### It still fails when it should

A hold that outlasts the budget throws, and the temp file is removed. Silently
dropping the write would be worse than the error — the caller's degradation
report is how the Architect learns the disk is unhealthy.

## Design decisions

**Retry inside `writeFileAtomic`, not at 19 call sites.** Every caller has the
same wrong answer available to it (lose the write) and none of them has any more
information than the primitive does.

**No new option on the signature.** A `retryBudgetMs` parameter would exist only
for tests, and the tests do not need it: the real default is exercised by
holding the destination for a known time from another process.

**Held from another process, in the tests, deliberately.** The retry blocks the
thread, so a handle this thread was meant to close on a timer would never be
released and the test would measure the budget expiring rather than the retry
working.

## Verification

```bash
npx vitest run test/main/fsx.test.ts
```

### The blind spot, guarded

The retry can only be provoked where the platform blocks the rename. **CI runs
on ubuntu-latest, and POSIX renames over an open file happily** — the reader
keeps the old inode and nothing fails. So those cases are guarded on
`renameBlocks()`, measured at run time rather than read off `process.platform`.

The probe is three-valued for the reason `test/pin.ts` gives at length: "does
not block" and "never actually contended" are indistinguishable from the
outside, so an unanswerable probe **fails** the suite naming its reason instead
of skipping. Verified in all three states:

| probe answer | result |
|---|---|
| blocks (here) | 7 passed, 1 skipped |
| does not block (forced) | 5 passed, 3 skipped, nothing red |
| cannot answer (forced) | 1 failed — "could not hold the destination open: …" |

### How often it actually fires, measured

The obvious objection to a blocking retry is that it stalls the main process, so
it was instrumented and a full suite run counted every retry:

```text
11 retry events across 3176 tests, all EPERM, 0 gave up
cumulative elapsed at retry: 43ms, 44ms, 58ms, 91ms, 260ms, …
```

Two things follow. The transient is real and not rare enough to ignore — **those
were eleven writes that the old code would have thrown away in a single run**.
And nothing came close to the ceiling: every blocked rename succeeded, the worst
after about 260 ms, so the 500 ms budget is bounding a case that has not yet
been observed rather than one being hit routinely.

### MUTATION-CHECK

| # | Mutation | Expected red | Observed |
|---|---|---|---|
| M1 | no retry at all — the original bug | both held-destination cases | 2 failed |
| M2 | `EPERM` not treated as transient | both held-destination cases | 2 failed |
| M3 | no directory check | "rethrows a permanent failure at once" | 1 failed |
| M4 | temp file not removed on failure | both cleanup assertions | 2 failed |

## Related docs

- `docs/implementations/2026-09-01-flaky-temp-dir-teardown.md` — the same class
  of Windows transient, in test teardown rather than in the app
- `docs/srs/SRS.md` NFR-2 — the delivery latency budget the ceiling respects
- `BUILD-PROMPT.md` §3.3 — atomic writes as an invariant

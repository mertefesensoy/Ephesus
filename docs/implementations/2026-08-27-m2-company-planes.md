# M2 — A company that runs itself (M2.1–M2.7 + exit review)

**Date:** 2026-08-27 · **Milestone:** M2 (docs/IMPLEMENTATION.md) · **Author:** the Architect (agent-assisted sessions)

## Demo view

The M2 exit criterion is a *behaviour*, not a screen: two real `claude` agents
completing a collaboration with nobody watching. This is the run, captured from
the exit-review harness against the committed tree:

```
VERIFY A REQUESTED B after 21s
VERIFY request act: request | requires_reply: true
VERIFY watchdog woke: agent.b
VERIFY B INFORMED BACK after 35s
VERIFY reply act: inform | in_reply_to: 2026-08-27T09-50-00-000Z-c7d2
VERIFY reply body: Week 34 checkout totals from checkout-totals.txt: 1281 orders,
                   3 failures.
VERIFY log: 1:spawn 2:delivery 3:hook 4:spawn 5:hook 6:exit 7:delivery
```

One Architect instruction started it. Everything after — the delivery, the
decision that agent.b had pending mail, the words that woke it, the reply
addressed back at the request — was the harness. The last line is the same run
reconstructed from `log.jsonl` alone, which is what NFR-13 actually asks for.

## Problem / Motivation

M1 proved one agent could be employed. A company is not one agent: it is
several, sharing state that must survive being killed at the worst possible
moment, talking to each other without a human relaying messages, and doing so
without any of the pathologies that make multi-agent systems unusable —
ping-pong loops, silent drops, agents idling on mail they were never told about,
and autonomy loops that never stop.

M2 is the milestone where the *company* becomes real: shared state with exactly
one writer (the Agora), a postal service between mailboxes (Hermes), and the
autonomy loop that lets an agent keep working when there is work to do and stop
when there is not (ADR-0013).

## What Changed (by package)

| Package | Files (core) | What landed |
|---|---|---|
| M2.1 Agora + single committer | `src/main/git.ts`, `agora.ts`, `settings-registry.ts`, `engines/settings-install.ts`, `scripts/check-invariants.cjs` | Git-backed shared state with ONE committer: a serialized queue with batching, retry+backoff, stale-lock clearing and startup reconcile. `git.ts` is the only module that may invoke git, and CI fails the build if that stops being true. Closes M1's `settings.local.json` sweep. |
| M2.2 Registry, ledger, event log | `src/shared/registry.ts`, `tasks.ts`, `log.ts`, `src/main/eventlog.ts` | The three schema'd Agora files. `log.jsonl` is append-only with self-stamped `seq`, recovers its sequence on boot, and tolerates a torn tail from a killed harness by ignoring it — never by rewriting it. |
| M2.3 Hermes delivery core | `src/main/hermes.ts`, `src/shared/message.ts`, `cursor.ts` | Mailbox delivery: watch + sweep, temp+rename into `inbox/`, `inbox/.done/` idempotency, `outbox/.rejected/` parking for anything malformed. `requires_reply` is derived from the act, never trusted from the sender. |
| M2.4 Routing rules | `src/shared/routing.ts`, `src/main/hermes.ts` | Hop cap, bounces with a refusal the sender can read, `to: "human"` diversion to the Architect's queue. The cap is checked *before* the address, so a runaway loop cannot outrun the check by naming a valid recipient. |
| M2.5 Autonomy loop | `src/shared/autonomy.ts`, `src/main/hermes.ts`, `hooks.ts`, `avatars.ts`, `shims/eph-hook.mjs`, `prompts/hermes/*.md` | ADR-0013's triple guard as one pure decision, the Stop-hook block reply, and the inbox wake watchdog. Closes M1's `stop.pending` item by feeding the avatar machine the same fact the guard uses. |
| M2.6 Roster + Activity | `src/main/agents.ts`, `ipc.ts`, `src/renderer/src/ActivityPanel.tsx` | Hiring writes a roster row through the lifecycle that already owns cards and log events; the Activity tab pages the log through a cursor and never keeps a second copy of it. |
| M2.7 Scenario suites + exit demo | `test/scenarios/`, `prompts/agora/PROTOCOL.md`, `prompts/agents/identity.md`, `src/main/engines/{claude,settings-install}.ts` | S-BLACKOUT, S-LIVELOCK, S-BOUNCE, S-WAKE, S-STOPLOOP against real processes; the two-real-agent demo, and the two defects it found (mailbox permissions, shared-settings reference counting). |
| Close-out | `src/main/agora.ts`, `hermes.ts`, `agents.ts`, `index.ts` | `commitSoon()` and two guarded fire-and-forget call sites — see **Close-out fix** below. |

## Implementation Approach

**One writer, many readers.** Every shared file in the Agora has exactly one
process that writes it (main) and one module that commits it (`git.ts`). Agents
read shared state freely and write only their own directory. This is what makes
the state machine tractable: there is no merge, no lock protocol between agents,
and no path where two writers race — because there is only ever one.

**Delivery is a rename; durability is a commit.** A message becomes visible to
its recipient the instant a temp file is renamed into `inbox/`. The git commit
that records it happens afterwards, queued and batched. Delivery latency
therefore never waits on git (ADR-0004), and a crash between the two loses
durability, not the message — which is exactly what S-BLACKOUT asserts and the
startup reconcile repairs.

**Faults are injected into the production path, not around it.** `FaultPoint`
and `HermesFaultPoint` are parameters of the real code. A seam that only exists
under a mock proves nothing about the real ordering, and the whole point of
S-BLACKOUT is to kill the harness *between* the stage and the commit.

**Autonomy is a decision, not a policy engine.** `decideStop` is a pure function
returning facts — is there pending mail, are there pending tasks, has the block
cap been reached, is this hook running inside its own continuation. The English
that reaches the agent is rendered from `prompts/`, so the words an autonomous
loop says to itself are reviewable config, not string literals (invariant §8).

## Mathematical / Statistical Details

No statistics; three numeric policies, all documented where they are defined:

- **Retry backoff** is exponential from a base step: attempt *n* waits
  `backoffMs × 2^(n-2)` before retrying, for at most `maxAttempts` (default 5).
  Only the committer retries — retrying git anywhere else would produce two
  writers, which is the one thing ADR-0004 forbids.
- **Hop cap** (`DEFAULT_HOP_CAP = 8`): every reply carries its predecessor's
  hop count plus one, and delivery refuses at the cap. This bounds any cycle in
  the agent graph, whatever its shape, because the count travels with the
  message rather than being tracked per pair.
- **Block cap** (`DEFAULT_BLOCK_CAP = 20`, signal at 10): the number of times
  one spawn may be continued by the Stop hook. The signal sits deliberately
  below the cap so the ADR-0011 breaker can steer before the backstop fires.

## Design Decisions

Full list with rationale in `docs/DECISIONS-LOG.md` (M2.1–M2.7 entries). The
ones that shaped the milestone:

- **`git.ts` is the only module that runs git, enforced by CI.** A
  single-committer claim that lives only in prose decays the first time someone
  adds a convenient `git add` somewhere else. `scripts/check-invariants.cjs`
  fails the build on a git invocation outside that file, which turns ADR-0004
  from a promise into a property of the repository.
- **`ensureRepo()` commits only when it actually seeded.** It used to commit
  unconditionally, so a post-crash reconcile landed under the subject "seed the
  Agora" — history that lied about why the commit existed. Found by running the
  live blackout, not by a test.
- **A torn `log.jsonl` tail is ignored and left on disk.** Append-only means
  append-only (invariant §5): no compaction, no rewrite, not even to tidy up
  after a kill. The reader skips what it cannot parse; the bytes stay for
  forensics.
- **`requires_reply` is derived, never trusted.** A sender that could set it
  freely could opt out of the obligation the act creates, and the wake watchdog
  reads that field to decide whether anyone is owed an answer.
- **Agents get a permission grant for their own mailbox** (Architect-visible).
  The mailbox lives in the harness home, outside the agent's working directory,
  so the engine's permission model blocked every outbox write and FR-3.2 was
  unimplementable. Found by a real agent replying "the write was blocked by
  permissions". The grant is the narrowest that works: its own directory, never
  the Agora, never a sibling mailbox.
- **Settings files are reference-counted per path.** Two agents in one
  repository share one `settings.local.json`; the first to finish was deleting
  the file the second was still running under. Last agent out restores the
  original.

## Close-out fix — fire-and-forget promises could kill the harness

The M2 CI run went red on a run where **all 581 tests passed**. The failure was
a single unhandled rejection escaping `test/scenarios/s-blackout.test.ts`.

The cause was a pattern, not a test: four call sites queued durability with
`void agora.commit(...)`. `void` does not attach a rejection handler, so when
the retry budget ran out the rejection became an `unhandledRejection` — which
fails a vitest run and, in the Electron main process, terminates the harness.
A git failure is precisely the fault ADR-0004's retry queue exists to absorb, so
it must never be the thing that takes the company down.

Two more instances of the same defect were in fault-reachable paths:

- `void this.sweep()` from the Hermes file watcher. `sweep()` provably rejects —
  three tests assert it — and the watcher fires it on every outbox change, so
  any delivery error would have been fatal to the main process.
- `void this.handleExit(...)` from the pty exit event, whose teardown does
  filesystem work that can fail on a stuck handle.

The fix gives each of the three a real handler and a place to report to:
`Agora.commitSoon()` records the give-up in a bounded list and calls
`onCommitError`; Hermes gained `onSweepError`; `AgentManager` gained
`onExitError`. All three are wired in `index.ts` to the same `console.warn`
degradation surface the hook and settings-sweep failures already use — a
recorded degradation instead of a dead harness (invariant §7).

`onCommitError` carries an explicit contract that it must not append to the log
or queue more work: the failing subsystem is git itself, and a handler that
commits would recurse.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm test
```

586 passed / 3 skipped at close, run twice to catch the timing-sensitive
unhandled-rejection path.

The five named suites:

```bash
npx vitest run test/scenarios
```

26 passed — S-BLACKOUT 7, S-LIVELOCK 3, S-BOUNCE 4, S-WAKE 4, S-STOPLOOP 7,
plus the harness anchor. All drive real spawned `fake-engine` processes over
real git, a real socket and real files; S-STOPLOOP runs the real
`eph-hook.mjs` shim as a subprocess.

The three regression tests added by the close-out fix each install a
`process.on('unhandledRejection')` probe, exercise the failure, and assert both
that the failure *was* recorded (so the path is genuinely exercised) and that
nothing reached the probe:

```bash
npx vitest run test/main/agora.test.ts test/main/hermes.test.ts test/main/agents.test.ts
```

The two-real-agent exit demo is not part of `npm test` — it needs a real
`claude` and takes about a minute. Its transcript is in the M2 exit review
section of `docs/PROGRESS.md`.

## Related Docs

- `docs/PROGRESS.md` — package evidence and the M2 exit-review verdict
- `docs/IMPLEMENTATION.md` — M2 scope and exit criteria
- `docs/adr/ADR-0004-agora-git.md` — single committer, batching, reconcile
- `docs/adr/ADR-0003-hermes-mailboxes.md` — mailboxes, speech acts, bounces
- `docs/adr/ADR-0013-stop-hook-autonomy.md` — the triple guard and the watchdog
- `docs/sdd/SDD.md` §1.1, §2, §4, §5 — module map, mailbox layout, Agora files
- `docs/DECISIONS-LOG.md` — every minor choice with its reason

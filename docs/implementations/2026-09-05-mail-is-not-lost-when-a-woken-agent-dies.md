# Mail is not lost when a woken agent dies

**Status: PLAN, written before any code.** Found by the real one-hour test run
on 2026-09-05, not by a test.

## Problem

Hermes consumes an agent's mail — renames it into `inbox/.done/` — **in the same
act that hands its content to the session**, both on the Stop hook and on the
wake nudge. If the session dies before acting on what it was handed, the message
is gone: recorded as delivered, recorded as read, never acted on, and nothing
anywhere says so.

Observed live, driving the shipped app against a real repository:

```
19:29:06  delivery → agent.artemis      (two CI incidents)
19:29:06  hook | wake | agent.artemis    pendingMail: 2
19:29:07  exit | agent.artemis           exitCode: 1
19:29:08  spawn | agent.artemis          respawn: true
          …idle. Her inbox is empty and both messages are in .done/.
```

This is not rare. Over the 79 wakes in this machine's book of record:

| agent | died within 10s of a wake | survived |
|---|---|---|
| `agent.artemis` | **13** | 34 |
| `crew:dependency-updater` | 3 | 8 |
| `crew:health-watcher` | 3 | 12 |
| `crew:ci-babysitter` | 2 | 4 |

**21 of 79 — about one wake in four — killed the agent and ate its message.**

The consequence is worse than the rate suggests, because every incident is
delivered to the orchestrator first (`incidents.ts`, `to: orchestratorId()`).
One death there stops the whole chain: the CI failure was ingested, the incident
was raised, the on-call agent was named — and nobody was ever told.

**This is why SRS §6 criterion 1 has never passed.** It is a delivery defect,
not an orchestration one.

## The constraint that shapes the fix

The current behaviour is deliberate and recorded (`hermes.ts`, ADR-0003,
Architect verdict at the M2 close-out audit):

> the mail is consumed — moved to `inbox/.done/` — in the same act that hands
> its content to the session. Without this, handled mail stayed "pending" and
> re-blocked every Stop until the cap: the loop manufactured the very pathology
> its guards exist to prevent.

So "consume only after the agent acts" is **not** available: it reintroduces the
loop that verdict fixed. The fix must lose no mail *and* never let handled mail
read as pending again.

## Approach — a third state

Today a message is either pending (`inbox/*.json`) or done (`inbox/.done/`).
Add **in-flight** (`inbox/.inflight/`) between them.

| state | directory | `hasPendingMail` | meaning |
|---|---|---|---|
| pending | `inbox/` | **true** | delivered, not yet handed to a session |
| in-flight | `inbox/.inflight/` | false | handed to a session that is still alive |
| done | `inbox/.done/` | false | a session held it across a completed turn |

- `consumeInbox` renames into `.inflight/` instead of `.done/`. Its contract to
  callers is unchanged — it still returns the messages it handed over.
- **The M2 fix is preserved** precisely because in-flight is not pending:
  `hasPendingMail` reads `inbox/*.json` only, so a handled message cannot
  re-block a Stop, which is the whole point of the verdict.
- `settleInflight(agentId)` moves `.inflight/` → `.done/`. Called at the Stop
  hook, which is the first moment the agent has demonstrably held the content
  across a completed turn.
- `returnInflight(agentId)` moves `.inflight/` → `inbox/`. Called when the
  agent's process exits, and at boot for anything a killed harness left behind.
  The message becomes pending again and is redelivered on the next wake — which
  is NFR-6's at-least-once delivery with idempotent consumption, finally true of
  the hand-over path as well as of the write path.
- Idempotency is unchanged and extended: a message id already in `.done/` is
  dropped as before, and `.inflight/` is checked too so nothing is handed twice.

## Design decisions

**A third directory rather than a field in `cursor.json`.** The mailbox is
already a state machine made of directories, and an atomic rename is what makes
each transition crash-safe (invariant §3). A cursor field would need its own
write, and a crash between the rename and that write is exactly the window this
package exists to close.

**Settle on the Stop hook, not on the next tool call.** Stop is the turn
boundary: reaching it means the session received the hand-over and finished a
turn with it. An earlier signal would settle mail the agent had not yet read;
a later one does not exist.

**Return on exit rather than on respawn.** The exit is the fact; a respawn is a
policy decision that may never come (`onExit: offer`, a breaker stop, an
exhausted ladder). Mail must return to the inbox even for an agent nobody brings
back, or it is lost for a different reason.

**Not fixing the death itself.** Why a woken session exits 1 is a separate
defect and is recorded as owed below. It must not gate this: the loss is worse
than the crash, because a crash is visible in the log and the loss is not.

## Verification

`PENDING`. The bar:

- A message handed over and then followed by an agent exit is **back in the
  inbox**, and `hasPendingMail` is true again.
- A message handed over and followed by a Stop is in `.done/`, and
  `hasPendingMail` is false — the M2 pathology stays fixed. This is the
  regression that matters most; it is the reason the current code is what it is.
- Boot returns leftover in-flight mail from a killed harness.
- The same message is never handed to a session twice.
- A mutation pass over each new guard.

## Owed, recorded not built

- **Why a woken session exits 1.** The engine runs fine with the harness's exact
  command line, config directory, settings file, lockdown flags and cwd (exit 0
  on a direct run), so it is specific to a live PTY session being written to.
  Nothing currently keeps the agent's own stderr at exit, which is the first
  thing that investigation needs.
- The wake path could report a death that follows a hand-over as its own
  degradation cause, so the pairing is visible without reading the log by hand.

## Related

- `docs/adr/ADR-0003-hermes-message-bus.md` — the hand-over verdict this narrows
- `docs/srs/SRS.md` — NFR-6 (at-least-once, idempotent), §6 criterion 1
- `docs/implementations/2026-09-05-real-activation-run.md` — the run that found it

# Mail is not lost when a woken agent dies

**Status: BUILT.** The plan below was written before any code. Found by the real one-hour test run
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
  agent's process exits. The message becomes pending again and is redelivered on
  the next wake — NFR-6's at-least-once delivery, finally true of the hand-over
  path as well as of the write path.
  *(The plan also said "and at boot for anything a killed harness left behind".
  That was wrong, and building it showed why — see the next section.)*
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

## The distinction that kept S-BLACKOUT true

Writing the fix surfaced a conflict the plan had not seen. S-BLACKOUT records
*"does not re-consume mail the dead harness had already handed over"* — and a
blanket "return in-flight mail" would have reversed it, risking the
double-processing SRS §6 criterion 6 forbids on mail that may genuinely have
been acted on.

**Two deaths are not the same death**, and the fix now says so:

| death | what the harness knows | what happens to in-flight mail |
|---|---|---|
| the AGENT exits, harness alive | it *observed* the session end without finishing | **returned** to the inbox and redelivered |
| the HARNESS is killed | nothing about what that session did | **settled** to `.done/`, exactly as before |

The second rule lives in Hermes's **constructor**, not in `boot()`: a new Hermes
is a new harness, and the scenario suites build one directly to model a restart —
which is precisely the case the rule exists for. Putting it in `boot()` left
S-BLACKOUT failing, and that failure was right.

So the M2 close-out verdict (ADR-0003) is narrowed, not overturned. The
redelivery applies only where the harness has a fact instead of a guess.

## Verification

```
typecheck    green (all four projects)
lint         green
invariants   ok — reachability 173/181
tests        3785 passed / 8 skipped (3793) across 199 files
             (3777 before this fix — +8 cases)
```

**7 mutations, all killed**, each reverted. The first restores the original
defect exactly — `consumeInbox` renaming into `.done/` — and dies to six cases.
The others cover the exit that does not return, the Stop that never settles, the
Stop settling *after* its own hand-over (the defect moved four lines down),
in-flight counting as pending (which would re-create the M2 pathology), the
missing idempotency check, and a drain that moves only the first message.

**The existing suite caught the contract change in four files** — hermes,
pacing-wakes, S-WAKE and S-BLACKOUT — which is the seam working. Each was
updated to assert the new location, and in every case the *behavioural*
assertion it existed for was left untouched: no message is handed twice, no
message is re-consumed after a harness death, a deferred wake still leaves the
mail where it is.

The bar this was written against:

- A message handed over and then followed by an agent exit is **back in the
  inbox**, and `hasPendingMail` is true again.
- A message handed over and followed by a Stop is in `.done/`, and
  `hasPendingMail` is false — the M2 pathology stays fixed. This is the
  regression that matters most; it is the reason the current code is what it is.
- A NEW harness SETTLES leftover in-flight mail rather than returning it, so
  S-BLACKOUT's no-re-consume requirement still holds.
- The same message is never handed to a session twice.
- A mutation pass over each new guard.

All met.

## And then the crash itself

The plan said "not fixing the death itself" and listed it as owed. It is fixed,
and the route to it is the point.

**Nothing kept an agent's last output**, so a crash was an exit code and a shrug.
`attachRedactedStream` now holds a bounded ring of the REDACTED stream and hands
it over on exit; `AgentManager` puts it on the `ghost` row, but only for an
abnormal exit — a clean quit's last frame is the TUI saying goodbye, and would
put noise in the book of record on every shutdown.

The first crash it caught answered the question outright:

```
Accessing workspace: C:Userssenso.ephesusagora
Quick safety check: Is this a project you created or one you trust?
  > No, exit     Yes, I trust this folder
  Enter to confirm - Esc to cancel
```

**Artemis was sitting at the engine's workspace-trust dialog, and the wake
answered it.** The default option is "No, exit"; a wake writes its text and then
the submit key, and that Enter chose it. She exited 1 within a second of every
wake — 13 times in this machine's log — and because every incident is routed to
the orchestrator first, the whole chain stopped there.

Why her and not the crew: ADR-0021/0025 write workspace trust for an
**activation's** target and worktrees. Artemis belongs to no activation. She is
hired at boot and works in the Agora (SDD §2, because `board.md` is hers to
scribe), so nobody ever trusted that directory for her — and once M8.7a gave
every agent its own engine config directory, hers began life with no trust
record at all. The crew survived because their worktrees WERE granted.

The fix grants it before she is hired, through the same adapter seam the
activation uses, and reports a failure to grant rather than letting her meet the
prompt silently.

**Proven live**, on the same machine that produced the crash:

```
20:31:01  artemis | mail 2 -> DIED exit 1     (before the grant)
20:41:48  artemis | mail 2 -> SURVIVED        (after it)
```

and her config now carries
`"C:/Users/senso/.ephesus/agora" -> {"hasTrustDialogAccepted": true}`.

## The next one in the same family, found the same way

With the trust grant in, the chain finally moved: the incident reached Artemis,
she triaged both runs, created two tasks and assigned them to the on-call agent.
And then it stopped again.

**An idle agent assigned a task is never told.** `wakeCheck` returns early when
an agent has no mail (`if (pending === 0) continue`), and `pendingTasksFor` is
consulted only in `decideOnStop` — which requires the agent to already be
running a turn. So the wake watchdog, whose whole job is "something arrived
while you were idle", knows about mail and not about work. Artemis assigned both
tasks without sending a message, her outbox stayed empty, and the on-call agent
sat idle holding two `todo` items.

Two candidate fixes, and the second is the sound one:

- Have Artemis message every assignee. Depends on an LLM remembering, every time.
- Have the wake watchdog wake an agent that has pending tasks and no mail, with
  the same once-per-thing discipline the mail path already uses (`nudged` keyed
  on task id rather than on message file), so a long-lived `todo` does not nudge
  forever.

Not built here: this package is the delivery seam, and that is the ledger seam.
Recorded rather than folded in, because a third fix in one branch is how a
reviewable change stops being reviewable.

## Owed, recorded not built
- The wake path could report a death that follows a hand-over as its own
  degradation cause, so the pairing is visible without reading the log by hand.
- **Two boot-wiring branches have no test** and say so here rather than
  pretending otherwise (ENGINEERING-STANDARDS §6.7): the orchestrator's trust
  grant and the notes loop's `appendLog` guard both live in `index.ts`, which
  `boot()` makes unreachable from a unit test — the `boot` coverage row is what
  measures that. `readableTail` and the last-words ring, which carry the actual
  logic, ARE tested (10 cases, including a real terminal frame).
- `readableTail` runs words together where a TUI spaced them with cursor
  movement rather than spaces ("Accessingworkspace"). Legible enough to diagnose
  from, and not worth reconstructing a terminal emulator for.

## Related

- `docs/adr/ADR-0003-hermes-message-bus.md` — the hand-over verdict this narrows
- `docs/srs/SRS.md` — NFR-6 (at-least-once, idempotent), §6 criterion 1
- `docs/implementations/2026-09-05-real-activation-run.md` — the run that found it

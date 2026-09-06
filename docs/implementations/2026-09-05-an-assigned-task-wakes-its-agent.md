# An assigned task wakes its agent

**Status: BUILT.** The plan below was written before any code. Found by the real one-hour run on
2026-09-05, after the trust fix let the chain get far enough to reveal it.

## Problem

An idle agent that is assigned a task is never told.

`Hermes.wakeCheck` — the wake watchdog, whose whole job is "something arrived
while you were idle" — returns early when the agent has no mail:

```ts
const pending = pendingFiles.length
if (pending === 0) { this.nudged.delete(agentId); continue }
```

`pendingTasksFor` is consulted only in `decideOnStop`, which fires when a
session **finishes a turn**. An agent that is already idle never reaches one. So
the watchdog knows about mail and not about work.

Observed live, with the CI-incident chain finally running end to end:

```
20:48:30  task | create ×2
20:48:30  profile | incident-triage-accepted ×2
          → both tasks assigned to agent.skeleton-crew-musahit-ci-babysitter
          → its outbox and inbox stayed empty; it sat idle holding two `todo`s
```

Artemis triaged both CI failures correctly, created the tasks, and assigned
them. Nothing carried that to the assignee. **The company's work reached the
ledger and stopped there.**

## Approach

Give the watchdog the second reason to wake someone, with the same discipline
the mail path already has.

- A new `pendingTaskIdsFor(agentId)` replaces `pendingTasksFor`. **One seam, not
  two**: the count is `.length` of the ids, so the number `decideOnStop` blocks
  on and the set the watchdog announces can never disagree. Two expressions that
  must agree is the M8.5 defect, and it is cheaper to not create it.
- `wakeCheck` gains a task branch, taken only when there is no mail — mail is
  the louder signal and already carries its own nudge; an agent with both gets
  the mail nudge and finds its tasks in the same turn.
- **Once per task, never once per tick.** A second `nudgedTasks` map keyed on
  task id mirrors `nudged`. Without it a long-lived `todo` would nudge every
  sweep, forever: a metronome pointed at the agent least able to escape it.
- The same two gates the mail path respects, in the same order: `isIdle` (never
  interrupt a working agent) and `wakeAllowed` (ADR-0023 pacing, checked before
  `nudgedTasks` is updated, so a deferred wake is not recorded as announced and
  the task still earns its nudge when the pace allows one).
- The words live in `prompts/hermes/task-nudge.md` (invariant §8), and say what
  arrived and where to look — a pointer, like the mail nudge, never a payload.

## Design decisions

**Wake on tasks in the watchdog, not by making Artemis message every assignee.**
The alternative is to have the orchestrator send an `inform` alongside each
assignment. That depends on an LLM remembering, every time, forever; this is the
harness's job and the harness already has a component whose entire purpose is
noticing that an idle agent has something waiting.

**Only when there is no mail.** Two nudges in one tick would be two submissions
into a TUI, and the mail nudge already ends with "act on each" — the agent that
reads its mail will see its tasks. This keeps one wake per tick per agent.

**Keyed on task id, not on a count.** A count cannot tell "the same two tasks,
still waiting" from "a third one arrived", and the first must stay silent while
the second must not.

## Verification

```
typecheck    green (all four projects)
lint         green
invariants   ok — reachability 173/181
tests        3805 passed / 8 skipped (3813) across 200 files
             (3795 before this fix — +10 cases)
```

**9 mutations, all killed** — and the pass earned its keep twice, because the
first run left two survivors that were real gaps rather than equivalent mutants:

- **The pace gate on the task path was unguarded.** Deleting it survived the
  whole suite, because every pacing case sent MAIL. The task path is a second
  way to write into a session and therefore a second way to spend; a gate that
  guards one of two doors is not a gate. Now pinned in `pacing-wakes.test.ts`,
  including that a deferred task nudge still earns its wake once the pace lifts
  — pacing must never quietly become dropping.
- **The Stop hook's count was unpinned.** Replacing it with a hardcoded `0`
  survived, because nothing wired a task through `decideOnStop`. That is the
  seam this fix deliberately made single-sourced, so it needed a test proving
  the number and the set come from the same place.

Both were fixed by adding the missing case, never by weakening a mutation.

The bar this was written against:

- An idle agent with a pending task and no mail is nudged, once.
- A second sweep with the same task is silent; a NEW task speaks again.
- A busy agent is not interrupted, and a paced-out wake still nudges later.
- An agent with mail AND tasks takes the mail path only.
- A mutation pass over each new guard, including the once-per-task set.

All met.

## Related

- `docs/implementations/2026-09-05-mail-is-not-lost-when-a-woken-agent-dies.md` — the two defects in front of this one
- `docs/adr/ADR-0023-usage-aware-pacing.md` — the pace gate this respects
- `docs/srs/SRS.md` §6 criterion 1 — the one-hour test this unblocks

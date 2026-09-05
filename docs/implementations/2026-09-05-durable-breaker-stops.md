# Durable breaker stops and explicit recovery

## Decision

The Architect's 2026-09-05 request to close the survival audit's remaining gaps
authorizes persistent rung-3 stops and an explicit clear action. This records the
storage and IPC additions for review under ENGINEERING-STANDARDS §3.

Stops belong to agent identities across process and app lifetimes. Store them in
the app-local `~/.ephesus/breaker-stops.json`, outside the company git repository,
with schema version 1. Each entry carries the agent, decision time, trip signals
and the measured details. Validate the entire record, including unique agent
identities; missing on first use means empty, but malformed, unsupported or
unreadable state blocks all starts and is reported in Watch and degradation state.

Atomic replacement completes before the process stop. A failed write still stops
the process, retains the in-memory decision and blocks further starts. A failed
clear retains the stop. Storage errors latch for the session: repair the named
storage fault and restart the app, rather than silently overwriting unknown data.

Both `AgentManager.spawn` and `respawn` consult the same veto, including a second
check after asynchronous hook setup. This covers Artemis's initial boot hire,
profile activation, manual hires and all respawn paths. Persistence alone would
have left the boot hire as a bypass.

## Recovery surface

Watch shows standing stops independently of the live roster, including their
agent, time and signals. `watch:breaker-stops` returns this list and any storage
fault. `watch:clear-breaker-stop` accepts only `{agentId, expectedAt}`: the handler
validates the payload and checks that the decision still matches the reviewed
one. It persists removal before lifting the stop and releases the rung-2 budget
and delivery constraints. The clear is logged with Architect attribution; the
renderer cannot supply an actor.

Clearing does not restart anything. It refreshes an existing card's offer and
sends a UI notification without emitting another lifecycle exit to the ladders.
The Architect may then restart from the card, activate a profile again, or restart
the app for a stopped boot orchestrator. Failed and stale clears remain visible;
buttons are disabled while a clear is pending or storage is unreadable.

## Evidence and limits

Verification uses `npm run typecheck`, `npm run lint`,
`node scripts/check-invariants.cjs`, `npm run build`, and full
`npm run test:coverage -- --coverage.reportsDirectory=coverage/durable-final-N`
runs. Coverage reports go through `scripts/check-coverage.cjs --update --summary`
with three distinct reports from the same final production tree. The gate requires
the panels floor to rise because Watch is now exercised; no floor is lowered.

- Real filesystem tests reconstruct the breaker from a fresh store instance,
  check save-before-stop ordering, clear across restart, schema rejection,
  duplicate identities, read errors and injected write failures.
- Lifecycle tests prove a blocked fresh hire creates no process or phantom id,
  and clearing an offer emits no new exit or automatic spawn.
- Real registered IPC handlers validate clear payloads and push refreshed cards.
- DOM tests mount Watch, display a stopped orchestrator with no live card, click
  the clear button, verify the exact reviewed revision, and exercise failure and
  pending states.
- A fixed-clock regression verifies that clearing and tripping again cannot
  reuse a decision revision and make an old clear request valid again.

This closes the two gaps recorded in the preceding survival audit. It does not
claim immunity to disk loss, deletion of the state file, an operating-system
failure during a write, or an independently launched engine outside this harness.
The store uses the repository's atomic-write contract; it is not a backup service.
If a stop cannot be saved, the app reports that failure and refuses further starts
in the current session; it cannot promise recovery of bytes storage never accepted.

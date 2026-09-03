# M8.1 — The quit path, and the rig that hid it

## Problem / motivation

Closing Time (GYM-003) had never once run in the shipped app. The evidence on
the Architect's machine was one `closing-begin` in the book of record, no ack
and no complete, ever; `agent.artemis` a ghost with all three crew still
`archived`, their unwind never run; in-flight tasks left `in_progress` on
agents that no longer existed. Three suites were green throughout.

One cause, three victims. `index.ts` held the window in a
`BrowserWindow | null` and sent through it forty-three times as
`mainWindow?.webContents.send(...)`. The optional chain reads as safety and is
not: the reference is only null *before* the first window exists, and nothing
nulled it afterwards. Once the window closed, `mainWindow` held a **destroyed**
object, `?.` proceeded, and `webContents.send` threw `Object has been
destroyed`. So:

- **Closing Time** logs its first event through such a send, so `begin()` threw
  before a single agent was asked to park its work — after the log line
  landed, which is exactly the shape the machine showed.
- **`AgentManager.shutdown`** was `for (const id of ...) await unwind(id)` with
  no `try`, and `unwind` logs an `exit` event through the same kind of
  callback. The first agent threw and the rest of the company was never
  unwound at all.
- **The PTY sink** was the window's own `webContents`, so killing the terminals
  at teardown threw too.

And the reason no test caught it: the scenario rig built its own copy of
production's closing wiring, and the copy left out the line that threw. A rig
that is production-minus-one-line is not a rig, and the register calls that out
as its own defect (D12) rather than a follow-up.

## What changed

| File | Change |
|---|---|
| `src/main/ui-bridge.ts` | **New.** The one door to the renderer: owns the window, forgets it on `closed`, checks `isDestroyed()` on both objects before every send, never throws at a caller, and reports a send that fails for any *other* reason. Implements `PtySink`. |
| `src/main/shutdown.ts` | **New.** The quit sequence: closing time → agent unwind → the stops, each phase isolated, idempotent, Electron-free, with a report a test and a log line can both read. |
| `src/main/index.ts` | 43 sends now go through the bridge; the window is attached in `createWindow` and the PTY sink once at boot; `offerClosingTime` and the twice-written `teardown` are replaced by the sequence; `before-quit` holds the exit so **every** quit gesture runs it once. |
| `src/main/agents.ts` | `shutdown()` isolates each agent and returns an `AgentShutdownReport`; a failure is reported through the existing `onExitError` seam and named. |
| `scripts/check-invariants.cjs` | Rule 5: `webContents.send` outside `ui-bridge.ts` fails the build. |
| `test/fakes/fake-window.ts` | **New.** A structural `BrowserWindow` that can be destroyed *without* its `closed` event — the real teardown ordering — and that throws on a send once destroyed, as Electron does. |
| `test/main/ui-bridge.test.ts` | **New**, 14 cases. |
| `test/main/shutdown.test.ts` | **New**, 18 cases, including the old wiring reproduced and the same quit surviving through the bridge. |
| `test/main/agents.test.ts` | 3 cases for shutdown isolation on a real `AgentManager`; the rig gained an `onLogEvent` seam. |
| `test/scenarios/company.ts` | Closing time is wired through the shipped bridge (production's three lines, in production's order) and the rig exposes the shipped `QuitSequence`. |
| `test/scenarios/s-closing.test.ts` | 4 cases driving the real sequence with the window already destroyed, over real fake-engine processes. |
| `test/scenarios/s-blackout.test.ts` | Its hand-built `Company` gained the three new fields. |
| `docs/sdd/SDD.md` | §1.1 gains both modules; §612's quit row amended for every-gesture coverage and phase isolation. |
| `scripts/coverage-floors.json` | Both modules mapped to `boot`, the row that measures the wiring layer. |

## Implementation approach

### Why the window became an object

Fixing the reported symptom is one line: null the reference on `closed`. That
leaves forty-three call sites where the next author writes the same thing
again, and it does not survive the case that actually bites — a window
destroyed during teardown whose `closed` listener has not run yet. So the
window is not a variable any more.

`UiBridge.send` returns a boolean and never throws. A send with no live window
is a **silent** no-op, and that silence is deliberate against invariant §7: the
renderer is a projection (ENGINEERING-STANDARDS §4) holding no state whose loss
means anything, and a closed window is the normal end of a session rather than
a degradation. A send that fails for any other reason IS reported, once, and
the window is dropped so one fault cannot become one per event. The
`isDestroyed()` check is what keeps the quiet case quiet: catching the throw
alone would also keep the quit alive, but would report a fault for every one of
the forty-odd sends a shutdown makes. That distinction is pinned by a test with
a spy rather than left to the catch behind it.

`check-invariants.cjs` then holds the line: `webContents.send` outside the
bridge fails the build, proven by a planted probe.

### Why the quit became a module

SDD §1.1 gives `index.ts` boot and wiring and says it "holds no logic of its
own". The quit path was logic — an offer, a protocol, an unwind, twelve stops
in an order that matters — written inline, with the tail duplicated for the
"no agent manager" branch, reachable by no test. There is no Electron in the
test runner and no Playwright in this repository, so the package's owed test
("a scenario that genuinely quits, driving the REAL handler") was impossible
until the sequence became a module. Now `index.ts` and the scenario rig
construct the same object.

The ordering is the module's whole job and every edge carries a reason:
closing time first because agents can only park while alive; the unwind next
because settings files must be restored while the processes still exist
(ADR-0009); the stops last, ending with the Agora drained before the database
closes, because a commit in flight is a record the book has not got yet
(ADR-0004).

Isolation is the same lesson one level up from `AgentManager.shutdown`. A quit
that stopped at its first failing phase would repeat exactly the bug it was
written to fix, with bigger pieces: a closing protocol that cannot start must
not prevent agents from unwinding, and an agent that cannot unwind must not
leave the terminals running and the database open.

### Every quit gesture, once (Architect decision, 2026-09-03)

Before this package the only handler was `window-all-closed`, so menu Quit,
Cmd-Q and a taskbar close skipped closing time entirely — and on macOS that
handler tore the company down while leaving the app alive, so `activate`
re-opened a window onto a company that no longer existed. Now `before-quit`
holds the exit, runs the sequence once, and lets the quit through when it is
finished. A second gesture mid-sequence is held rather than obeyed: the
protocol's own hard deadline is what bounds the wait, and a double Cmd-Q should
not cost an agent its parked memory. This changes what SDD §612 describes, so
it was the Architect's call and the row is amended with it.

### What the rig may still substitute, and what it may not

The scenario company has no `AgentManager` — that class needs a spawner — so
its `liveAgents` reads the mailboxes and its `agents` seam is null. Those two
leaves are named in the rig with the reason, and `AgentManager.shutdown`'s own
isolation is proven directly against the real class in `agents.test.ts`.
Everything else the rig runs is the shipped object, and the closing time it
drives now sends through the same bridge production sends through. The rig can
still lie about a leaf; it can no longer lie about the sequence.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
npx vitest run test/main/ui-bridge.test.ts test/main/shutdown.test.ts test/main/agents.test.ts test/scenarios/s-closing.test.ts
```

**Production call path** (ENGINEERING-STANDARDS §6.7): `src/main/index.ts`'s
`before-quit` handler constructs and runs `QuitSequence`; `createWindow` calls
`ui.attach(win)`; `ptyManager.attachSink(ui)` runs once at boot. Both new
modules are reachable from the main entry point, which `check-invariants`
verifies on every run.

**Eleven mutations, each killed by a named test and reverted** against a green
baseline:

| Mutation | Killed by |
|---|---|
| the `isDestroyed` check removed | the silence spy on the production case, and the check-throws case |
| the `closed` listener removed | "stops asking a window once its closed event has run" |
| the stale-close guard removed | "a replaced window's late close event does not silence its successor" |
| the fault report removed | "reports it once, as a fault, and stops using that window" |
| agents before closing | the ordering case |
| `run()` made non-idempotent | the idempotence case, and the scenario's "runs once" |
| per-agent isolation removed | "unwinds every agent even when the first one throws" (and one more) |
| a failing stop rethrown | "runs every later stop after one throws" |
| an agent-shutdown failure rethrown | "stops everything even when the whole agent shutdown fails" |
| the empty-floor guard removed | "does not ask when nobody is working" |
| the reentry guard removed | "does not start a second closing while one is in flight" |

Plus the tripwire, proven in both directions with a planted probe.

The two cases that carry the package are in `test/main/shutdown.test.ts`: one
reproduces the old wiring and asserts `begin()` throws with `closing-begin`
logged and no request delivered — the machine's evidence, reconstructed — and
the next runs the same quit through the bridge and asserts every agent is
asked, the acks land, and the log holds begin, ack and complete.

## What this package deliberately does not fix

Gates and activations are in-memory, so a quit still loses an open gate while
`tasks.json` may still hold its id. That is register item B17 and belongs to
M8.8. It is written down here as a **characterization test** in S-CLOSING that
passes today because the loss is real — the record M8.8 flips, rather than a
sentence somebody has to remember.

## Related docs

- `docs/sdd/SDD.md` §1.1 (both modules) and §612 (the amended quit row)
- `docs/gymnasium/proposals/GYM-003-closing-time-shutdown.md` — the protocol whose live-quit evidence this unblocks
- `docs/adr/ADR-0009-engine-adapters.md` — settings restored before the PTYs die
- `docs/adr/ADR-0004-agora-single-committer.md` — why the drain is last
- `docs/PROGRESS.md` — the M8 plan and this package's evidence

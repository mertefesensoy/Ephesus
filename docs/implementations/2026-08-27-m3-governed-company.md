# M3 — A governed company (M3.1–M3.9 + close-out audit)

**Date:** 2026-08-27 · **Milestone:** M3 (docs/IMPLEMENTATION.md) · **Author:** the Architect (agent-assisted sessions)

## Demo view

M3's exit is governance made visible: a destructive operation stopping at a
gate, and a directive fanning out through an orchestrator no human relayed.

![A destructive op held at the Watch, packaged for a verdict](../demo/m3-uc08-gate.png)

_UC-08 live: a real `claude` asked to `rm -rf build/` stalls behind its own
permission dialog; the engine's `notification` hook turns the invisible stall
into a packaged gate — what / why / blast radius / rollback — on the approvals
post. The verdict travels back through the same `watch:approve` the button
calls. Full capture: [`m3-uc08-exit.png`](../demo/m3-uc08-exit.png)._

![Artemis's ledger and board after a delegated directive](../demo/m3-uc02-ledger.png)

_UC-02 live: one Architect directive to Artemis became ledger tasks, assignee
`request`s with self-contained specs, a `done` reported back, verification,
and a board update by the one scribe — the whole chain reconstructible from
`log.jsonl` alone. Also captured: the temple seat
([`m3-artemis-temple.png`](../demo/m3-artemis-temple.png)), the tileset floor
with real seats ([`m3-floor-tileset.png`](../demo/m3-floor-tileset.png),
[`m3-floor-seats.png`](../demo/m3-floor-seats.png)) and a rung-1 steer
([`m3-breaker-rung1.png`](../demo/m3-breaker-rung1.png))._

## Problem / Motivation

M2 built a company that runs itself; M3 makes it a company you can *govern*.
Autonomous agents spend money, run destructive commands, and loop — and an
orchestrator with judgment must not become privileged code. M3 is the
milestone where every credential becomes unreadable, every token of spend
lands in a durable ledger, every dangerous action stops at a deny-by-default
gate, runaway behaviour walks a breaker ladder instead of burning the night,
and Artemis is hired — an ordinary engine process holding a privileged *role*
(ADR-0005), her policy in editable prompt files, her ledger writes funneled
through a harness endpoint she can only *propose* to.

## What Changed (by package)

| Package | Core | What landed |
|---|---|---|
| M3.1 Secret broker | `watch/secrets.ts`, `watch/cipher.ts`, `pty-stream.ts` | Write-only broker (`set/status/test/delete` — no IPC returns a value, pinned by an API-surface test that fails on any fifth channel); `safeStorage`-backed encrypted file; env injection scoped to declared grants; redaction filter proven at the real PTY edge (`•••eph-masked•••`). |
| M3.2 Cost ledger + budgets | `ledger.ts`, `watch/ledger.ts`, `watch/budgets.ts`, `db.ts` | Transcripts folded into append-only SQLite keyed (agent, session, model, day) with an idempotent fold cursor; cumulative figures only ever computed from the ledger (invariant §11); per-agent budgets with burn-rate projection; new tripwire: any `UPDATE/DELETE` on `cost_ledger` fails CI. |
| M3.3 Gate core | `watch/gates.ts` | Deny-by-default over every gate kind; the three SDD §9 choke points wired — including the engine's `notification` hook, closing the M1 invisible-stall item; packaging (what/why/blast radius/rollback); channel + repeat-back as first-class policy inputs (scripted stubs; Herald/Harbor plug in at M6/M7). |
| M3.4 Approvals + human queue | `WatchPanel.tsx`, `agora/human/` surface | The approvals post with verdicts through `watch:approve`; the M2 diverted-mail queue finally visible and drainable (`watch:dismiss`); the spend strip (session + cumulative, side by side). |
| M3.5 Breaker | `watch/breaker.ts` | The ADR-0011 ladder — steer (one prompt-rendered sentence) → constrain (mail paused) → stop (interrupt, then kill) — driven by span capture from hook events; consumes M2's pathology signal; every trip and rung in the log. |
| M3.6 Floor v2 | `floor/atlas.ts`, `floor/painter.ts`, `seats.ts` | Real seat assignment, Artemis's temple, rendering from the staged CC0 tilesheets (procedural stays the visible fallback), and the owed badge glyph/label double-encoding — `waiting`/`blocked`/`looping` are reachable now. |
| M3.7 Artemis lifecycle | `artemis.ts`, `prompts/artemis/` | Auto-spawn into the temple at boot, `isOrchestrator` per SDD §4.1; system prompt carries the escalation policy (editable text, not code); delegated-authority table (`authority.json`, validated) with the `mayDecide` enforcement hook; crash respawn = engine-native resume (`--resume` + the session id the event plane recorded) + re-injected identity. |
| M3.8 Ledger endpoint + routing | `ledger.ts`, `hermes.ts`, `LedgerPanel.tsx` | Artemis `propose`s to the reserved address `agent.ledger`; the harness validates and writes `tasks.json`/`board.md` through the single committer — agents never touch either; `pendingTasksFor` real (the ADR-0013 branch fires on tasks now); `to:"human"` routes to Artemis-as-proxy; the kanban Ledger tab. |
| M3.9 Suites + exit | `test/scenarios/s-{gate,breaker,ledger,secrets}.test.ts` | S-GATE 12 · S-BREAKER 9 · S-LEDGER 13 · S-SECRETS 13, on real processes/fs/sqlite-seams; the UC-02 and UC-08 exit demos live. |
| Close-out audit | see below | Two-agent audit; eleven fixes landed. |

## Implementation Approach

**Governance is mechanism; judgment is Artemis's.** Every enforcement point —
broker, ledger, gates, breaker — is deterministic harness code with its policy
read from files (`gate-policy.json`, `authority.json`, prompt templates).
Artemis holds no privileged code path: her ledger writes are `propose` acts to
an endpoint that validates them, her escalation policy is a system prompt the
Architect can edit, and the one thing she may never do is decide for the
human she proxies.

**Nothing readable, nothing rewritable, nothing invisible.** Secrets go in and
never come out (the IPC surface physically lacks a read); spend rows are
insert-only with a CI tripwire on the rewrite vector; every hold, trip, spend
transition and verdict is a `log.jsonl` event with the refs to reconstruct it,
and every degradation reaches a visible surface.

**Honest grades, honest tests.** The gate policy defaults to deny even when
its file is corrupt; the breaker's rung 1 is deliberately cheap so false trips
cost one sentence; suites drive real spawned processes, real git, a real
socket, and the real shim — the SQLite store sits behind a seam only because
Electron-ABI natives cannot load under vitest, and the live runs cover it.

## Close-out audit

Two-agent audit at close (spec-verifier by execution, doc-guardian by design
conformance) — full record in `docs/PROGRESS.md` § "M3 close-out audit".
Verdict: **DONE / substantially conforms**, with eleven fixes landed at close,
the notable ones: the breaker's hop-cap trip signal was wired to bounces (a
divert never fires it — now signalled from the divert path); a paused
broadcast held every co-recipient's copy and re-delivered the served ones each
sweep (now per-recipient, single-shot); rung 2 now lowers the constrained
agent's budget (ADR-0011's second constraint, factor 0.5); the boot promise
joined the M2 fire-and-forget fix class; the ledger endpoint's replies moved
to `prompts/hermes/`; Artemis can no longer receive her own escalations to
the human. Carried to M5 with an owner: the agent↔task binding join
(`task.gates` population, rung-3 `stalled` returns).

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm test
```

1236 passed / 2 skipped at audit close (1233 at review), run twice. The four
M3 suites: `npx vitest run test/scenarios` — 73 cases across nine suites, all
real seams. The UC-02/UC-08 demos ran live under xvfb with real `claude`
2.1.247 agents; their captures are in `docs/demo/m3-*.png`.

## Related Docs

- `docs/PROGRESS.md` — package evidence, exit review, close-out audit
- `docs/adr/ADR-0005-artemis-orchestrator.md` · `ADR-0010-secret-broker.md` ·
  `ADR-0011-watch-breaker-budgets.md`
- `docs/sdd/SDD.md` §1.1, §4, §5, §7.1, §9
- `docs/DECISIONS-LOG.md` — every minor choice with its reason

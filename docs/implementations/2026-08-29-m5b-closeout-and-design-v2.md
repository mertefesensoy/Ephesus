# 2026-08-29 — M5b close-out audit, UI-DESIGN v2, and the M6 plan

## Problem / Motivation

M5b (the Stoa + company modes + the licensed floor) closed with its exit review
recorded; per the standing pattern the milestone owed an independent two-agent
close-out audit, the demo view, the next milestone's plan, and the BUILD-PROMPT
handoff. The Architect additionally directed an art-system upgrade: bring the
floor's *whole* visual language — agents, animations, stations, messaging,
decorations — to the specification depth of Munder Difflin's design system, now
that the full LimeZu license is owned.

## What Changed

| Area | Change |
|---|---|
| Audit (PROGRESS §"M5b close-out audit") | Two-agent verdicts. Execution: machinery VERIFIED (194 M5b cases re-run, CI green on `ed46cad`, intake clean) — but the "one real research cycle" exit row was **claimed, not proven**: the demo's pin `9f3c1de` exists in no repository the watchlist named, and the GYM-006↔RB-002 pairing survived in no artifact. Conformance: **no invariant violations**; five deviations + contained/nit tail. |
| Evidence integrity | The exit-review row **amended in place**; the cycle **re-run at close against a real pin** (munder-difflin @ `b91a49f`, verified via `gh api` and a local clone inside the run) through the shipped path — `docs/demo/m5b-cycle-real-source.txt`. |
| `src/main/stoa.ts` | `brief(id)` seeds before reading (audit finding 2 — a fresh home false-refused proposals citing seeded briefs). First-call regression test. |
| `src/main/stoa-cadence.ts` (new) | The shipped cadence tick, extracted so `index.ts`, S-MODE, and the new unit suite run ONE body (finding 5 — the copy-of-the-wiring class); logs `sourceId`/`planned`/mode, asserted end-to-end. |
| `src/shared/mode.ts` | `IMPROVEMENT_ROLES` + exact `isImprovementRole` replacing the untested `includes('improv')` substring in `index.ts` (finding 12), table-tested with the audit's counter-example. |
| `src/main/index.ts` | Wires the shipped tick; `stoaWatchlist` field-picks the `SourceView` (finding 13 — `registeredBy` leaked past the view type). |
| SDD | §7.7: proof gate located in `modes.ts` (was `watch/gates.ts`, finding 3) + the cadence-HEARTBEAT build-state note (finding 1 — an autonomous no-op must not read as work); §1.1 gains the `modes.ts` row (finding 4). |
| ATTRIBUTION.md | Drop section says which files are ignored vs committed (finding 14). |
| PROGRESS | M5b.3 "cadences" plural and M5b.5 "36/36" corrected in place (finding 15 + the verifier's discrepancy); close-out section; **M6 plan** (M6.1–M6.8, art first then the Herald); recorded-not-fixed list. |
| `docs/design/UI-DESIGN.md` (v2) | New §5.1–§5.7 + §9 + §6 additions: normative citizen anatomy (32×48, 8 drawn directions, stepped bob), status overlays as state projections, tool-class carrying tokens, station catalog with event-fact states (inbox-tray flag = `pendingMailCount`, brazier = open gate), act-colored envelope flights, three budgeted particles, furnishings-as-identity, forbidden-motion list, copy-voice table. Specification depth adapted from Munder Difflin's MIT design system; every value Ephesus's own. Characters stay procedural (rule 3 reaffirmed by Architect decision). |
| BUILD-PROMPT | Build-state block → resume at M6.1; the amendment lesson standing ("an exit demo's external references get the same verification its internal ones do"); owed list extended (pin path, spend attribution, desk renderer regression). |
| DECISIONS-LOG | Five 2026-08-29 entries (evidence integrity; the three code fixes; the deferred list with reasons). |

## Implementation Approach

The audit pattern unchanged (spec-verifier by execution, doc-guardian by
conformance), with one escalation: when the execution half found the exit
evidence overstated, the close-out both **amended the record** (the honest
half) and **re-proved the row** (the useful half) — a temporary vitest evidence
file drove the scenario rig's shipped wiring against a source whose pin is
verifiable by anyone with `gh api`, then was deleted per the documented
temporary-evidence pattern. UI-DESIGN v2 adopts MD's *specification depth* while
keeping Ephesus's tokens and identity: every floor animation in the new
sections is a projection of an event-plane fact, which is the repo's own
"information through motion" principle made enforceable.

## Mathematical / Statistical Details

None — audit, specification, and plumbing. The only numbers are the sprite/
motion constants in UI-DESIGN v2 (125 ms frames against the 250 ms tile walk,
128 px/s) chosen so frame boundaries divide the walk exactly.

## Design Decisions

Architect decisions this session (asked, not guessed): agents stay
**procedural at MD-grade spec** (rule 3 intact; licensed character sets
deliberately unused); the art research was folded into **direct design
authoring** rather than a Stoa cycle; **art opens M6** with the Herald
following; UI-DESIGN v2 adopts **depth, not MD's identity**. Close-out
decisions are in DECISIONS-LOG (exact roles over substrings; seed-on-every-
read-path as the standing rule; heartbeat honesty in SDD §7.7).

## Verification

- Gates green after fixes: typecheck · zero-warning lint · invariants; touched
  suites **113/113**, measured per file at the integration: stoa 28 ·
  stoa-cadence 5 · modes 17 · mode 30 · S-MODE 13 · S-STOA 20. *(The first
  draft of this line guessed the breakdown — 7 and 31 for stoa-cadence and
  mode — and the guess did not even sum to its own total. Corrected against a
  per-file run at the integration merge; the same class of unverified detail
  the audit above caught in the exit evidence, caught here in this record.)*
  Links resolve.
- The re-run cycle: `gh api repos/chaitanyagiri/munder-difflin/commits/b91a49f`
  → the full sha; the in-run assertions (clone HEAD = pin, cited paths exist);
  the four EVIDENCE lines in the demo capture.
- Owed forward, on the record: the M6.8 booking of the 2026-09-11 metric
  sweep; the deferred list in the close-out section.

## Related Docs

[PROGRESS](../PROGRESS.md) M5b close-out + M6 plan · [UI-DESIGN v2](../design/UI-DESIGN.md) §5.1–§5.7, §9 ·
[SDD](../sdd/SDD.md) §1.1, §7.7 · [m5b-cycle-real-source](../demo/m5b-cycle-real-source.txt) ·
[the M5b record](./2026-08-28-m5b-stoa-and-modes.md) · [DECISIONS-LOG](../DECISIONS-LOG.md) 2026-08-29

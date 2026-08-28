# ADR-0018 — Company modes: standing self-improvement is earned through a proof gate

**Status:** accepted · **Date:** 2026-08-28

## Context
ADR-0015 defines *how* an improvement lands (observe → propose → gate → land →
measure) and ADR-0017 widens *what counts as evidence*. Neither answers *when the
company may run this loop on its own initiative*. The Architect's directive
(2026-08-28): autonomous self-improvement — the company continuously studying,
proposing, and landing approved changes to itself — must be switched on only
**after the loop has been proven to work end-to-end**, and even then with the
Architect in the loop at every gate.

Two failure modes shape this decision. Enabling autonomy *before* the loop is
proven means the first real test of the machinery happens unattended — the worst
possible time to discover a gate that does not bite. And an *implicit* autonomy
(a cadence trigger that just starts firing at some milestone) leaves no line the
Architect consciously crossed, no record of why crossing it was justified, and no
single switch to step back over.

## Decision
The company runs in exactly one of two **modes**, held in `config.json`, changed
only by the Architect, and visible at all times:

- **`directed`** (default, and the only mode until the proof gate is met): the
  company works on what the Architect assigns. Gymnasium and Stoa cycles run **on
  demand only** (`/improve`, `/research`, or an explicit Architect request through
  Artemis). This is the system as built through M5.
- **`improving`** ("improve-company mode"): the scheduler runs the Stoa and
  Gymnasium cadences autonomously — the company decides *when to look and what to
  propose* without being asked. **Approval authority is completely unchanged**
  (FR-12.3): autonomy governs initiative, never verdicts. The Architect stays in
  the loop exactly as in `directed`; what changes is who starts the work.

**The proof gate.** The first switch to `improving` is mechanically refused until
the book of record shows the loop has worked (normative numbers in SRS §6.9): a
minimum count of proposals through the *full* loop — proposed, Architect-verdicted,
landed, measured — with a minimum validated ratio, at least one seeded by a Stoa
brief, and zero gating violations on record. The check reads only the Gymnasium
ledger and `log.jsonl` (NFR-13); a refusal lists exactly which evidence is missing.
The gate exists once: after a first legitimate enable, later switches are the
Architect's judgment (the evidence continues to accumulate in the same ledger).

**The three rules:**
- **R1 — Only the Architect changes the mode.** No agent, no harness path, no
  remote default can set `improving`; the IPC handler verifies the actor the same
  way `gym.verdict` does. Reverting to `directed` is always a single ungated
  action — stepping back must never cost more than staying.
- **R2 — The mode is a tag, not just a switch.** Every record produced by
  autonomous initiative — tasks, briefs, proposals, log events — carries the mode
  it ran under, so "what did the company do on its own?" is a ledger query, not an
  archaeology project. The status strip and every standup brief state the current
  mode.
- **R3 — The breaker outranks the mode.** A circuit-breaker stop (ADR-0011
  rung 3) attributable to Gymnasium/Stoa work reverts the mode to `directed`
  automatically, visibly, and in the ledger. Autonomy is a privilege the safety
  system can suspend; only the Architect can restore it.

## Options considered
- **No modes — cadence goes live at M7 like any feature.** The implicit-autonomy
  failure mode above; also contradicts the directive's explicit "prove it first".
- **A graduated ladder of autonomy levels** (per-class autonomy, auto-approve for
  low-risk classes). Rejected for v1: auto-approval contradicts ADR-0015 R1
  (nothing self-approves, Architect approves every class), and mission-profile
  autonomy levels (ADR-0012) already cover the *mission* side. Revisit post-v1
  only by superseding ADR-0015 deliberately.
- **Time-based trust** ("after two weeks of operation, enable it"). Time proves
  uptime, not governance; the two-week gymnasium acceptance (SRS §6.7) is kept,
  but the proof gate demands *outcomes* (measured, validated proposals), not
  elapsed days.
- **A one-time ceremony without a mechanical check** (Architect just flips it).
  The Architect can already do this by editing config; making the harness verify
  the ledger keeps the honest path and the lazy path the same path.

## Consequences
- "Is the company improving itself right now?" always has a one-word, on-screen
  answer, and every autonomous act is attributable to the mode that allowed it.
- The first enable of `improving` is a milestone with evidence behind it — the
  proof phase the directive asked for is a checkable artifact, not a vibe.
- Costs: mode plumbing (config, IPC, tagging, brief section), S-MODE in the
  scenario suites, and one more thing the status strip must show.
- M7's "Gymnasium cadence trigger is live" now means: the trigger exists and runs
  under mode governance — it fires autonomously only in `improving`.
- SRS gains UC-15, FR-14, and acceptance §6.9; SDD §9 gains the mode enforcement
  point; IMPLEMENTATION's M5b builds the mode with the Stoa it governs.

## Prior art
ADR-0015 (approval authority this mode deliberately does not touch); ADR-0011 (the
breaker ladder R3 defers to); ADR-0012 (autonomy-level composition for missions —
stricter wins); aviation's staged certification: a system earns operating authority
by demonstrated outcomes under supervision, and the authority is revocable by the
safety system without negotiation.

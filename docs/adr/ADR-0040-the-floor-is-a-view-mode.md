# ADR-0040 — The floor is a view mode; the window opens on the workspace

**Status:** accepted · **Date:** 2026-10-03 · **Extends:**
[ADR-0014](ADR-0014-owned-spawn-and-floor.md) (the floor's standard, which this
record keeps) · **Relates to:** ADR-0001 (the shell), ADR-0036 (the native engine
whose conversations the workspace shows), DD-M9-4 and FR-15.6 (headless-first,
nothing deleted)

**Accepted 2026-10-03** on the Architect's verdict on DD-M9-11 of the Phase 9 plan
([`../PHASE-9-PLAN.md`](../PHASE-9-PLAN.md)): "Workspace by default". That answer
did not say what an install that already exists should do, so decision 4 below was
put to him separately the same day; he chose that such an install *switches too,
with a notice*, over keeping the floor on older homes. **The decision is recorded;
nothing is built** — the standing instruction of 2026-10-02 is to plan and not to
build yet, and M9b.1 is the package that implements this.

## Context

ADR-0014 decided two things. Ephesus owns every agent's process, and the Terraces
floor stays as an observability surface under one rule: *every animation must convey
real state faster than a text label would*. UI-DESIGN §4 then made the floor the
dominant pane of the app shell, and the window has opened on it ever since —
`App.tsx` starts on the `floor` tab and imports the Pixi scene statically, so the
scene is loaded whether or not anyone looks at it.

Two directions from the Architect changed what the window is for.

On 2026-10-02 (M9-PLAN §2, claims C1–C3): many projects build environments like
this one, the environment is not the differentiator, and the upstream concept had
become a constraint. DD-M9-4 answered with *headless-first, nothing deleted*: the
core must be complete with no renderer, and the floor, the Herald and the Odeon
become optional clients. It deliberately left "cut the floor" undecided.

On 2026-10-03, with the feature sets of the two harnesses on the watchlist in hand:
*"We will keep the initial Ephesus brand core but the floor becomes an optional view
mode and Ephesus upgrades itself towards a real agentic harness."*

A harness is used by talking to it and reading what it did. Every capability Phase 9
plans — conversations with local and API models, research reports, blind
comparisons, documents, approvals from a phone — has a conversation or a work
product as its surface, and none of them is a place on a floor.

## Decision

1. **The window has view modes.** Two exist: `workspace` and `floor`. A mode is a
   way of looking at the same company; it holds no state of its own (invariant §2),
   so switching is immediate, loses nothing and needs no restart.
2. **`workspace` is the default.** The window opens on the conversation with
   Artemis, the agent sessions and the approvals that need the Architect. Its layout
   is M9b's to design, from the existing tokens.
3. **`floor` is the Terraces, unchanged, when the Architect chooses it.** The scene
   grammar, the stations, the citizens and ADR-0014's rule all stand: anything shown
   on the floor must still convey real state faster than a label would.
4. **The choice is the Architect's and is remembered** as `view` in `config.json`.
   **Absent means `workspace` — on every install, including one that predates the
   field.** A default that reached only fresh homes would never reach the one
   machine it was decided for. The first launch after the change says once, visibly,
   where the floor went and how to bring it back.
5. **Nothing is deleted.** The Terraces code and its suites stay, and the suites run
   in CI whatever the default is.
6. **A mode that is not shown is not loaded.** In `workspace` the floor's module
   graph is not imported and its ticker is not constructed; NFR-1's frame budget
   binds in `floor` mode only.
7. **Headless is the case of no view at all** (FR-15.6). The agent dock, the status
   strip, the command bar and the approvals post belong to the window, not to a
   mode, and are present in both.
8. **The brand core stays.** The city and its subsystem names are unchanged, and the
   Terraces remain the name of the floor.

**What this record does not decide:** the workspace's layout and panel anatomy
(M9b.0, with the UI-DESIGN amendment it owes); whether further modes exist; and
whether the floor is ever cut — still a product decision the Architect may take
with the bench in hand, and still one that would need its own record.

## Options considered

- **The floor stays the default, with a switch to turn it off.** The smallest
  change. Rejected by the Architect: an "optional" mode that every fresh install
  opens on is the default with an escape hatch.
- **Ask on first run and remember the answer.** Honest about preference, but it
  spends the first launch on a question about decoration, before the consent
  question that matters (ADR-0032).
- **Cut the floor.** Not asked for, and DD-M9-4 rejected deciding it on silence. A
  view mode costs nothing to keep and leaves the question open.
- **Make the workspace a tab beside the floor.** It already would be: the floor is
  one tab among thirteen. The decision is which surface the product is organised
  around, and a tab order does not say that.

## Consequences

- **UI-DESIGN §4's app-shell sentence** ("left = the Terraces floor (dominant)") is
  amended in M9b.1's change, together with the workspace's anatomy. The tokens are
  untouched.
- **SRS UC-03** (watch the floor and inspect an agent) stays true in `floor` mode
  and gains its `workspace` equivalent in M9b's contract. NFR-14 — any agent's raw
  terminal at most one click away — binds in both modes.
- **A mode nobody opens can rot unseen.** This project has the precedent: the Herald
  was built, tested and conforming with no caller for a whole milestone. The
  containment is item 5 — the floor suites stay in CI — plus a reachability walk
  from the `floor` entry, so the scene cannot silently lose its wiring.
- **An existing install changes face on upgrade.** That is intended (item 4), and it
  is announced rather than discovered.
- **The README's first screenshot and the "What makes it different" list** describe
  a floor-first product. They are rewritten when M9b lands, not before: the README
  describes what ships.

## Prior art

DD-M9-4 and M9-PLAN §9, which made the floor an optional client of a headless core.
The two harnesses on the watchlist both organise their surfaces around a
conversation; that is read as data about them (NFR-17), and M9b's contract package
studies it at a pinned commit before the workspace is designed.

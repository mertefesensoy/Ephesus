# M6 — the floor's face, then the Herald

**Status:** in progress. One section per work package, appended as each lands.
Milestone plan and per-package evidence live in [PROGRESS.md](../PROGRESS.md#m6);
this file carries the *why* and *how* that a diff cannot.

---

## M6.1 — Citizens v2 (UI-DESIGN §5.1) and status overlays (§5.2)

### Problem / motivation

The M1.5b citizens met the §7 bar as it was written then: eight directions, four
frames, ≤ 5 colours. UI-DESIGN v2 (landed at the M5b close-out) made §7 exact and
in doing so contradicted the implementation on one clause:

> **Directions:** 8, drawn — diagonals are frames, not runtime flips (a flip
> breaks asymmetric silhouettes: a satchel, a scroll case).

`citizen.ts` built its four westward directions by mirroring the eastward ones
about the cell's centre line. That is precisely the shortcut §5.1 names, and it
was already costing the thing §5.1 wants most — **identity by shape**: the
scribe's scroll case and the worker's hip satchel jumped from one side of the
body to the other whenever a citizen turned west.

Two further gaps: nothing reserved the head-room §5.2 needs (the M1 head was
drawn at row 2), and there were no status overlays at all — the floor said
"working" only through the badge glyph.

Separately, the M5b close-out recorded an owed item against this package: *"the
reading-desk pin fix carries no renderer regression until M6.1 establishes a DOM
harness."*

### What changed

| File | Change |
|---|---|
| `src/renderer/src/floor/citizen.ts` | Rewritten to §5.1. Mirror table deleted; eight authored `VIEWS`. New anatomy (hairline, neck, tunic hem, sleeve+hand arms), 1 px ink silhouette backing, `hairSide` directional cue, six role silhouettes at the table's pixel sizes, `frameAt()` as the single 125 ms clock. |
| `src/renderer/src/floor/overlay.ts` | **New.** §5.2's table as data, total over every `AvatarPhase`; 8×8 pixel matrices; `overlayFrame(spec, elapsedMs)` pure in elapsed phase time. |
| `src/renderer/src/floor/FloorCanvas.tsx` | Draws the overlay in the reserved head-room; passes `phaseElapsedMs = now − snapshot.sinceMs`; sprite alpha now read from the overlay table (`ghost` 0.5 per §5.2) instead of a literal `0.45`; new palette field names. |
| `src/renderer/src/StoaPanel.tsx` | `registerDraft()` extracted as an exported pure function; `SourceRow` / `BriefCard` extracted as exported presentational components. No behaviour change. |
| `vitest.config.mts` | `esbuild: { jsx: 'automatic' }`; `.test.tsx` added to `include`. |
| `tsconfig.web-test.json` | **New** fourth project for renderer render-tests (JSX + DOM lib). |
| `tsconfig.node.json` | Excludes `test/renderer/**/*.tsx`. |
| `package.json` | `typecheck` runs the fourth project. |
| `test/renderer/citizen.test.ts` | Rewritten for §5.1 — 20 cases. |
| `test/renderer/overlay.test.ts` | **New** — 14 cases. |
| `test/renderer/stoa-panel.test.tsx` | **New** — 11 cases; the owed reading-desk regression. |
| `docs/demo/m6-1-citizens-v2.svg` | **New** — contact sheet rendered from the shipped modules. |

### Implementation approach

**Eight drawn directions.** Each direction owns a row in `VIEWS` giving its own
head/torso/arm/leg geometry plus two orientation facts that a mirror cannot
express:

- `propSide` (−1 / 0 / +1) — which side of the body faces the viewer, so a
  shoulder-worn satchel lands where it is actually worn;
- `hairSide` — which side carries the skull's hair mass, i.e. the side turned
  *away*. This is the strongest directional cue available at 32 px, and it is
  the second reason a flip is wrong: flipping would carry the back of the head
  round to the front.

Plus `backProps` / `frontProps` gates, so a back-slung scroll case is simply
absent from the front views rather than teleported.

**The anatomy is banded once** (`HEAD_Y … FOOT_TOP`) so nothing drifts:

```
rows 0–7    overlay head-room — no body pixel, at any bob phase
rows 10–20  head (hair cap rows 10–13, eyes row 16)
rows 21–22  neck
rows 23–35  torso (hem rows 34–35)
rows 36–43  legs — these absorb the bob by changing height
rows 44–47  feet — planted, never move
```

**The bob is ±1 px indexed by frame**, `[0, −1, 0, +1]`: level on the two idle
frames, up on step-A, down on step-B. Because it is indexed by the *frame* and
the frame comes from `frameAt(elapsedMs)` at 125 ms boundaries, §5.1's "sampled
at frame boundaries only (never render-time sine)" is structural rather than a
convention. The feet do not bob, which is both what a walk looks like and what
keeps a +1 px body inside the 48 px cell.

**The silhouette backing.** Each body part emits an ink rectangle one pixel
larger on every side; all backings are drawn before all fills, so the outline
comes out continuous around the figure rather than as seams between parts. This
is why the head starts at row 10: `10 − 1 (bob) − 1 (backing) = 8`, exactly the
first row §5.1 permits a body pixel.

**Overlays as projections.** `overlayFor(phase)` gives the mark; the frame comes
from `overlayFrame(spec, nowMs − snapshot.sinceMs)`. `sinceMs` is stamped by main
when the phase began, so *what is on screen is a function of event-plane facts
only*. The module holds no timer, no counter, no previous frame — replay
`log.jsonl`, get the same avatar snapshots, and the same overlay appears at the
same moment (NFR-13's spirit in the vfx layer). A renderer-owned `setInterval`
would keep animating after the events stopped: motion projecting no fact, which
§1.2 cuts.

`working` is declared as kind `token` with **no pixels**, because §5.2's working
row *is* §5.3's carrying token and §5.3 is M6.3. A placeholder mark would be a
shape projecting no fact. The phase still reads through the badge glyph and the
floor census, so nothing is lost; `overlay.test.ts` asserts the empty-until-§5.3
seam explicitly.

### Design decisions

- **Exact role vocabulary, not substring matching.** §5.1 names roles by
  category ("Scribe / docs"), so `ROLE_SILHOUETTES` keys on those words plus the
  role strings the company already uses. A substring test would let a hire named
  `process-improver-docs` match `docs` — the M5b audit's `includes('improv')`
  defect one domain over. Unknown roles hash deterministically over the five
  assignable silhouettes; `orchestrator` is unreachable by hash, being Artemis's
  alone.
- **`react-dom/server` over jsdom for the harness.** A DOM library is a new
  dependency and therefore a BUILD-PROMPT §8 must-ask, and the owed coverage did
  not require one. Static markup renders the *shipped* component bodies — never
  a copy, the M5b rig lesson — and what it cannot reach (effects, clicks) is
  tested at the module boundary instead, per BUILD-PROMPT §6. That is why
  `registerDraft` was extracted: the pin mapping is exactly the kind of
  one-expression logic that regresses silently inside a component. The jsdom
  upgrade is carried as a must-ask, not decided unilaterally.
- **A fourth tsconfig project** rather than adding `jsx` + DOM lib to
  `tsconfig.node.json`, which would loosen the whole main/shims/test surface to
  satisfy three files.

### Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/renderer/
```

91 cases green across `test/renderer/` (citizen 20 · overlay 14 · stoa-panel 11 ·
tileset · walk). Full suite: 2164 passed; 12 failures, all in the recorded
Windows-local set — 9 deterministic (agent-worktree 4, s-crash 3,
claude-transcripts 1, cost 1) and 3 parallel-load flakes (library, s-livelock,
s-stoploop) each verified green in isolation. Ubuntu CI is the gate.

**Both new regressions were mutation-checked** — a regression that does not fail
on its own defect is worthless:

| Mutant | Result |
|---|---|
| Westward directions rebuilt by runtime flip | `does not build a westward direction by flipping its eastward twin` FAILS |
| `registerDraft` pin re-hard-coded to `null` | `carries a typed pin through, trimmed` FAILS |

**Live run.** `npm run dev` booted the real app: hook endpoint on the named
pipe, Agora reconciled, floor rendering with the LimeZu pack. The art itself is
in [`docs/demo/m6-1-citizens-v2.svg`](../demo/m6-1-citizens-v2.svg), rendered by
importing `citizenSprite` and `overlayPixels` so the evidence cannot drift from
the code. **The live render is what caught the real defect:** the first §5.1
sprite passed all twenty unit tests and looked like a stack of boxes that
dissolved into the terrace, because `skin` is `sand` and that is exactly
`worldTerraceA`. Asserting a spec is not the same as meeting the quality bar it
serves — the fifth time this project has paid for "believe the demo over the
suite".

### Related docs

- [UI-DESIGN §5.1, §5.2, §6, §7](../design/UI-DESIGN.md)
- [SDD §6 — the avatar state machine](../sdd/SDD.md)
- [PROGRESS — M6 plan and evidence](../PROGRESS.md)
- [DECISIONS-LOG — 2026-08-29 M6.1 entries](../DECISIONS-LOG.md)

---

## M6.2 — Stations and furnishings v2 (UI-DESIGN §5.4, §5.7)

### Problem / motivation

§5.4 gives every station a **size** — the Odeon 96×64, the temple seat 64×64,
a desk 64×32 — and three **states** whose rule is stated at the end of the
section:

> Every state maps to an event-plane fact; no station animates on a timer alone.

Neither was true of the floor. Each station held exactly one 32×32 tile, so the
size column was decorative; and nothing on the floor moved for a station at all,
so the three facts §5.4 singles out — the desk's inbox tray, the Watch brazier,
the Odeon filling — were invisible. The tray one matters most: it is the
ADR-0013 wake watchdog made visible, and `pendingMailCount` did not reach the
renderer at all.

### What changed

| File | Change |
|---|---|
| `src/shared/stations.ts` | **New.** §5.4's state model: `stationView` / `stationViews`, `deskTray`, `stationCensus`. |
| `src/shared/floor.ts` | `STATION_SIZES` + `stationTiles` + `stationFootprint`; `floorPlan()` claims footprints; `PlanCell` gains `part`; the Odeon anchor moves to col 16. |
| `src/shared/tileset.ts` | Optional `compositions` (§5.4) and `furnishings` (§5.7); `validateCompositions`, `compositionFor`, `furnishingsOf`. |
| `src/shared/ipc.ts` | `AvatarUpdate.pendingMail`. |
| `src/main/index.ts`, `src/main/ipc.ts` | One `pendingMailFor` source feeding the autonomy loop, the push and the list handler. |
| `src/renderer/src/floor/station-art.ts` | **New.** The marks: highlight outline, brazier flame, Odeon fill, working accent, desk tray. |
| `src/renderer/src/floor/atlas.ts` | `compositionFrameFor` (row-major from the top-left), `furnishingFrame`. |
| `src/renderer/src/floor/painter.ts` | `paintFurnishings`; per-cell painting now respects `part` so a structure paints as one structure. |
| `src/renderer/src/floor/FloorCanvas.tsx` | Station layer, desk trays, gate/meeting facts, station census in the label. |
| 3 test files | 24 + 17 cases, plus the `avatars:list` seam case. |

### Implementation approach

**The state model cannot invent a state.** `stationView(station, facts, nowMs)`
returns `{ activity, frame, because }`, and `because` is the event-plane fact in
words. Anything but `idle` requires one, so the §5.4 rule is a property of the
return type rather than of the author's memory — a station somebody wants to
animate decoratively has nothing to put in the field. `stationCensus()` renders
the same values as text, which is how §8's information parity is satisfied
without a second model to drift.

Precedence is `in-use` > `highlighted` > `idle`. The two room-level facts are
checked first, because a gate is open whether or not anyone is standing at the
post — which is the entire point of showing it.

**Footprints.** A station anchors on its `STATION_TILES` tile and extends right
and **up**, exactly as the 32×48 citizen does, so the tile a walk targets is
still the ground the structure stands on. `stationFootprint()` drops tiles
outside the room, so a footprint can never claim a wall.

**The map grew, not the code.** §5.4 compositions and §5.7 furnishings are
optional fields on `*.tiles.json`. `validateCompositions` enforces two rules,
both because the failure is otherwise silent: `frames.length === cols × rows`,
and the footprint must equal `stationTiles(station)`. A broken entry degrades
that station to its single frame and then to the procedural painter; it never
throws. Both checks are map-only, so CI validates them with no sheets present —
the M5b drop-guard rule (guard sheet-dependent checks on the sheet, not the map).

### Design decisions

- **`pendingMail` on `AvatarUpdate`, not on `AvatarSnapshot`.** The snapshot is
  the SDD §6 machine and mail is not one of its states. It rides the addressed
  wrapper so the count and the snapshot describe the same agent at the same
  moment; a separate channel could disagree, and the floor would raise a flag on
  a citizen who had just consumed the mail. One source in main feeds all three
  consumers.
- **Geometry in `floor.ts`, behaviour in `stations.ts`.** The plan needs the
  sizes and the state model does not, so the dependency runs one way.
- **Polling the meeting.** SDD §5's event list has a `gate:open` push but none
  for a live meeting, so the Odeon fill polls `odeon.meeting()` at the cadence
  the panels already use. This is the gap the `odeon:queue` badge carried item
  names; it closes on M6.7's scheduler work rather than being papered over with
  a new channel here.

### Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/shared/stations.test.ts test/renderer/ test/main/ipc-handlers.test.ts
```

188 green across the touched suites. Full suite: 2205 passed; 14 failures, all
recorded — 9 deterministic Windows-local (agent-worktree 4, s-crash 3,
claude-transcripts 1, cost 1) and 5 parallel-load flakes (s-closing, s-livelock
×2, s-stoploop, s-wake), each verified green in isolation.

| Mutant | Result |
|---|---|
| `avatars:list` drops `pendingMail` | the listing-path seam case FAILS |

**Live run.** `npm run dev`, floor inspected in the browser: structures render
as structures, no console errors. [`docs/demo/m6-2-stations.svg`](../demo/m6-2-stations.svg)
is painted by the shipped painter and station art with facts injected — one gate
open lights the brazier, desks 1–3 holding mail raise their flags.

**The live floor caught the defect again.** With footprints landed and every
test green, the painter still worked per tile: a 64×32 desk painted as two
32 px desks, so a row of them read as one long slab, and a 2×2 station showed
four gold markers instead of one. `PlanCell.part` fixed it. That is twice in
this milestone — M6.1's citizens dissolved into the terrace, M6.2's stations
were wallpaper — and both times every assertion passed.

### Related docs

- [UI-DESIGN §5.4, §5.7](../design/UI-DESIGN.md)
- [SDD §5 IPC contract, §6 stations](../sdd/SDD.md)
- [ADR-0013 — the autonomy loop the tray flag makes visible](../adr/)

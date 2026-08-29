# Ephesus — Visual & Interaction Design

**Status:** canonical. Every component derives from these tokens; a PR introducing a
color, font, or spacing value not defined here is wrong by definition.

---

## 1. Aesthetic thesis

**A sun-lit Ionian city rendered as a cozy pixel world.** Where the inspiration went
"90s office sitcom in an SNES game", Ephesus goes "Mediterranean city-state in a
16-bit strategy-sim": warm marble, terracotta, Aegean blue, olive groves. Friendly and
chunky, but with civic gravity — this is a place where records are kept and councils
meet, not a toy.

Principles (first four inherited from the upstream design school, sharpened):

1. **Pixel-snapped everything.** No half-pixels, no blur, no soft shadows. Hard 2px
   offset shadows only.
2. **Information through motion.** An animation exists only if it tells you something
   faster than a label would (ADR-0014). Decorative motion is cut in review.
3. **Limited palette.** ≤ 8 colors per screen, ≤ 5 per sprite.
4. **Panels are places.** Heavy use of named, framed panels — every piece of
   information has a *home* (the Ledger, the Board, the Approvals post).
5. **Civic, not cute.** Copy is short, calm, and adult. The Herald's dry register
   (VOICE-DESIGN) sets the tone for UI copy too: "Two items need you" beats "Uh oh!
   ✨ You've got stuff!".
6. **The terminal is sacred.** Terminal views are never themed beyond the frame:
   authentic colors, authentic bytes, monospace, full contrast.

## 2. Color tokens

CSS variables `--eph-<category>-<weight>` with a parallel `tokens.ts`. All flat; the
only permitted gradient is a vertical 2-stop on panel title bars (marble-100→200).

### 2.1 Marble (surfaces)
| Token | Hex | Use |
|---|---|---|
| `marble-50` | `#FBF7EF` | Innermost dialog fill, highlights |
| `marble-100` | `#F4EDE0` | Default panel fill |
| `marble-200` | `#E7DCC6` | Inset / alt row |
| `marble-300` | `#D3C4A5` | Disabled fill |
| `parchment-100` | `#F7F2E4` | Odeon artifacts (briefs, memos) background |

### 2.2 Ink (text, borders)
| Token | Hex | Use |
|---|---|---|
| `ink-900` | `#221A14` | Body text, outer borders. Never `#000`. |
| `ink-700` | `#4A3B2C` | Secondary text, mid border layer |
| `ink-500` | `#7A6A55` | Tertiary, disabled borders |
| `ink-300` | `#B3A68E` | Placeholders, hairlines |

### 2.3 Civic accents
| Token | Hex | Mnemonic |
|---|---|---|
| `aegean` | `#2E6F8E` | The harbor sea — primary action, links |
| `aegean-light` | `#9CC4D4` | |
| `terracotta` | `#C4552D` | Roof tiles — Artemis/orchestrator identity |
| `terracotta-light` | `#E8A987` | |
| `olive` | `#7A8B3D` | Groves — success, healthy |
| `olive-light` | `#C2CD97` | |
| `gold` | `#D9A441` | Temple gold — attention, review-pending |
| `gold-light` | `#F0D49B` | |
| `laurel` | `#4E9B6F` | Victory laurel — approvals granted |
| `wine` | `#8E3B4A` | Amphora wine — danger, destructive |

Agent accent assignment: each hire picks one of eight vibrant citizen accents
(`aegean`, `olive`, `gold`, `laurel`, plus `iris #7B6BC4`, `poppy #D65A5A`,
`sand #C9A05C`, `cypress #3D7A6E`). `terracotta` is reserved for Artemis.

### 2.4 Status colors (system semantics — used identically on floor and panels)
| Token | Hex | Means |
|---|---|---|
| `status-idle` | `#B3A68E` | At desk, awaiting |
| `status-thinking` | `#2E6F8E` | Reasoning / en route |
| `status-working` | `#D9A441` | At a station, tool in use |
| `status-waiting` | `#6C8EF5` | Stalled on Artemis or another agent |
| `status-blocked` | `#C4552D` | Gate open — needs the Architect |
| `status-success` | `#7A8B3D` | Just finished |
| `status-ghost` | `#D3C4A5` | Process gone, fading |
| `status-looping` | `#E07B39` | Breaker armed |
| `status-compacting` | `#8E6FB8` | Context compaction in progress |
| `status-typing` | `#C9A05C` | *You* hold unsent text on this agent (holds its mail queue) — an Architect state, not an agent state |

### 2.5 World (the Terraces floor)
Stone paths `#D8CBAF`, terrace floors `#C9A05C`/`#B08A4C` checker, walls `#8A6B4A`
(3px), sea border `#2E6F8E`/`#5A93AC` dither, olive canopy `#7A8B3D`.

## 3. Typography

Three faces, loaded locally (bundled — the app must not depend on a font CDN):

| Role | Face | Sizes |
|---|---|---|
| Display / panel titles | `Press Start 2P` | 8 / 12 / 16 px |
| UI body & labels | `Pixelify Sans` | 12 / 14 / 16 px |
| Data, terminals, logs, Odeon artifacts | `IBM Plex Mono` | 12 / 13 / 14 px |

Rules: every text node declares a face from this set; line heights are integer pixel
multiples; no faux bold/italic.

## 4. Layout & chrome

- **Panel anatomy:** 3-layer border (ink-900 2px → marble-50 1px light seam →
  ink-700 1px), title tab top-left in Display face, hard 2px ink-900 offset shadow.
- **Spacing scale:** 4 / 8 / 12 / 16 / 24 px only.
- **App shell:** left = the Terraces floor (dominant); right = context stack (selected
  agent: terminal / files / git / memory / threads); bottom = command bar; top =
  status strip (spend today, open gates, breaker state, Herald state, bridge state).
- **Command Center tabs:** Floor · Ledger (kanban) · Odeon (Briefs / Decks / Memos /
  Minutes) · Threads · Memory · Org · Activity · Watch · Settings.
- **Approvals post:** gates and memo queues share one review surface, badge-counted in
  the status strip; every item shows *what, why, blast radius, rollback* before the
  approve/deny controls (SRS UC-08 packaging).

## 5. The floor (Terraces) — scene grammar

- Isometric-free flat 2D, 32×32 base tile, avatars 32×48, 8-direction walk cycles.
- **Stations:** desk (per agent) · file shelf · terminal bench · web portal · harbor
  kiosk (MCP/integrations) · agora board (ledger/blackboard writes) · the Odeon
  (meetings/reviews) · the Watch post (gates) · Artemis's temple seat.
- **Scene grammar (normative):** walking = tool class in use (destination names it);
  envelope sprite flying desk→desk = Hermes delivery (color = speech act); waving at
  the Watch post = open gate; gathered in the Odeon = meeting/review in session;
  orange tint pulse = breaker rung 1; boxes = compaction; translucent = ghost.
- Rooms group by target (repo/app); doors are labeled. Profile instances get a
  district banner (e.g. "Skeleton Crew — myapp").
- Camera: pan/zoom, double-click avatar to focus + open its context stack.

*Sections §5.1–§5.7 and §9 below were added 2026-08-29 (UI-DESIGN v2): the
specification depth is adapted from Munder Difflin's design system (MIT,
credited in the README lineage); every token, size, and value is Ephesus's own.*

### 5.1 Citizen sprite specification (normative)

The §7 bar made exact. Cell **32×48 px** on the 32×32 tile grid; the sprite's
feet own the bottom 4 rows; head-room rows 0–7 are reserved for overlays
(§5.2), never for the body.

- **Directions:** 8, drawn — diagonals are frames, not runtime flips (a flip
  breaks asymmetric silhouettes: a satchel, a scroll case).
- **Walk cycle:** 4 frames per direction (idle, step-A, idle, step-B), 125 ms
  per frame stepped — two full frames per 250 ms tile walk (§6), so a citizen
  never slides between poses.
- **Bob:** ±1 px vertical, phased with the foot cycle, sampled at frame
  boundaries only (never render-time sine). Standing citizens do not bob —
  §6 forbids ambient idle motion.
- **Palette:** ≤ 5 colors per sprite: `skin`, `hair`, `primary` (the agent's
  §2.3 accent), `secondary` (tunic trim), plus the `ink-900` outline. The
  status badge is drawn OUTSIDE the sprite budget as a §8 double-encoding
  marker.
- **Role silhouettes** (identity is shape first, color second — ATTRIBUTION
  rule 3 keeps characters procedural). Each role carries one signature
  element readable at 1×:

| Role | Silhouette element |
|---|---|
| Orchestrator (Artemis) | Laurel circlet, 2 px; `terracotta` reserved |
| Scribe / docs | Scroll case slung on the back, 3×8 px |
| Builder / code | Tool belt, 2 px waist band |
| Researcher (Stoa) | Shoulder satchel + tablet, 4×5 px |
| Watch / safety | Cloak clasp, 2×2 px at the collar |
| Herald / voice | Lyre pin, 3×3 px at the chest |

### 5.2 Status overlays (rows 0–7, above the head)

8×8 px, one at a time, driven ONLY by the SDD §6 avatar machine — an overlay
is a *projection of a state*, never an animation with its own opinion.

| Avatar state | Overlay | Frames |
|---|---|---|
| `thinking` | three dots cycling `·` `··` `···` | 3 × 200 ms |
| `working` | the tool-class token held (§5.3); small sparkle every 800 ms | 2 |
| `waiting` | sand-glass, slow turn | 2 × 400 ms |
| `blocked` | `!` in `status-blocked`, blink | 2 × 300 ms |
| `success` | star burst in `gold`, then gone | 4 (250 ms total) |
| `looping` | tight spiral in `status-looping` | 2 × 200 ms |
| `compacting` | box lid closing | 3 × 300 ms |
| `ghost` | none — sprite at 50 % opacity | — |
| `idle` / `alert` | none | — |

### 5.3 Carrying tokens (tool results made visible)

Walking desk-ward after a tool completes, the citizen carries a 6–8 px token
at hand height, dropped onto the desk with a 3-frame fade on arrival. Keyed by
**tool class** (the shim's classification — core never sees a tool name), in
Ephesus vocabulary:

| Tool class | Token |
|---|---|
| file (read/edit/write) | folded papyrus scroll — `marble-50` + `ink-700` |
| shell | wax tablet with `>_` — `ink-900` |
| web / fetch | small amphora — `aegean` + `aegean-light` |
| search | magnifier — `ink-900` + `marble-50` |
| harbor / mcp | diamond in the integration's accent |
| ledger / board | tally tablet, 3 tick marks — `olive` |

### 5.4 Station catalog & states

Stations are tile-composed structures (LimeZu maps where the packs fit,
8-color drawn tiles where they don't). Sizes on the 32 px grid:

| Station | Size | Visual |
|---|---|---|
| Desk (per agent) | 64×32 | desk + seat + **inbox tray, flag UP while unread mail waits** — the wake watchdog made visible |
| File shelf | 64×48 | scroll shelf, 3 rows |
| Terminal bench | 32×48 | bench + tablet on a stand, blinking 2 px caret |
| Web portal | 48×48 | harbor arch, `aegean` water dither (2-frame) |
| Harbor kiosk (MCP) | 48×48 | modular stall; mini-pennant per integration |
| Agora board | 32×48 | notice board, wax notes in a 3-accent rotation |
| The Odeon | 96×64 | semicircle of benches; **fills when a meeting gathers** |
| Watch post | 32×48 | brazier; **flame lit while a gate is open** |
| Temple seat (Artemis) | 64×64 | columned niche, `terracotta` roof |

States: **idle** (static) · **in use** (2-frame animation + §5.6 sparkle) ·
**highlighted** (1 px `marble-50` outline while hovered or while its citizen
approaches). Every state maps to an event-plane fact; no station animates on a
timer alone.

### 5.5 The envelope (Hermes made visible)

The §5 scene-grammar rule made exact: every delivery flies an 8×6 envelope
desk→desk, 400 ms stepped arc, color = speech act:

| Act | Envelope |
|---|---|
| `request` / `query` | `aegean` — asks |
| `inform` / `done` | `olive` — answers |
| `propose` | `gold` — needs a verdict |
| `agree` | `laurel` |
| `refuse` / bounce | `wine`, wobble frame on landing |
| broadcast | three envelopes fanning out |
| divert (hop cap) | the envelope turns mid-flight toward the temple |

Landing drops into the recipient's inbox tray (§5.4); the flag stays up until
the mail is consumed. Reduced motion (§8): the flight becomes a one-frame
flash on both trays — information parity, not decoration parity.

### 5.6 Particles (three, budgeted)

Each tied to a logged event; ≤ 2 systems live per citizen:

- **Sparkle** — tool/task success: 4 pixel stars from the desk, 250 ms.
- **Dust** — station arrival: 3 arcing dots, 300 ms.
- **Tray pulse** — unread mail: the tray flag scales +1 px, one frame, every
  800 ms while mail waits.

Nothing else. No weather, no fireflies, no screen shake.

### 5.7 Furnishings (place identity, not ambience)

The licensed packs may furnish rooms **as identity**: furniture says what
happens there (shelves say library, benches say odeon, crates say harbor).
Furnishings are static — §1.2 bans decorative *motion*, and the review rule
("decorative-only is cut") applies to anything that moves without meaning.
Per-district furnishing lists ride the `*.tiles.json` maps, so a pack swap
never touches code.

## 6. Motion rules

- Durations: 120 ms (state flips), 250 ms (walks per tile, success flash), 400 ms
  (panel open, envelope flight). Easing: stepped (4–6 frames), never smooth cubic —
  this is pixel art.
- Walk speed: 128 px/s exactly (one 32 px tile per 250 ms). Speed is a constant —
  hurry is shown by *skipping stations*, never by faster legs.
- Pathing: straight-line lerp tile-center to tile-center (the M1.5 walk clock);
  A* around furniture is a recorded candidate, not owed.
- Sprite frames step at 125 ms; UI state flips at 120 ms; nothing tweens.
- **Forbidden motion:** spring physics, bounce, parallax, ambient idle motion on
  panels or standing citizens, easing curves on sprites. Animation belongs to the
  floor (citizens, envelopes, stations, particles); the panel layer is still.
- The floor pauses all animation when the window is hidden (NFR-1 power budget).
- Toasts only for events that already have a log line; a toast is a *pointer* to the
  log, never the only record.

## 7. Iconography & sprites

**Quality bar (Architect directive, 2026-08-26): the floor must read at the visual
quality of the original Munder Difflin.** That quality came from a professional
licensed tileset plus procedural characters — Ephesus takes the same path:

- **Environment: licensed tileset permitted.** A professional 16×16 tileset (the
  reference is LimeZu's *Modern Interiors* line, as used by Munder Difflin; a
  Mediterranean/antiquity-compatible set is preferred if available) renders at 2×
  onto the 32×32 world grid — integer scaling only, pixel-snap preserved. License
  terms and credits are mandatory: every third-party asset is recorded in
  `src/renderer/src/assets/ATTRIBUTION.md` (file created with the first asset), and
  only licenses permitting redistribution in a shipped app are acceptable. Purchased
  asset files that may not be redistributed in source form stay out of the public
  repo (gitignored asset drop + documented restore path).
- **Citizens: procedural recipes at portrait quality.** Avatars remain procedurally
  drawn (tunic/hair/skin recipes — no likenesses of real people or of other IP's
  characters), but at Munder Difflin portrait fidelity: real 8-direction walk cycles
  (4+ frames per direction), distinct silhouettes per role, ≤ 5 colors per sprite
  from the §2 palette. The M0 placeholder rectangle-citizen does not meet this bar
  and is replaced by the M1 floor-art package. **§5.1 is the normative sprite
  specification** (anatomy, frames, bob, silhouettes); this bullet states the bar,
  §5.1 says how it is met (reaffirmed 2026-08-29 — the licensed packs' character
  sets stay unused by Architect decision, rule 3 intact).
- **Stations & icons:** stations composed from the tileset where it fits, drawn as
  8-color tiles where it doesn't. Icon set: 12×12 px, 1px ink-900 outline, filled
  with accent colors.

The §1 principles still govern: ≤ 8 colors per screen reads over any tileset via the
palette-mapping pass; anything decorative-only is still cut in review.

## 8. Accessibility (NFR-15)

- All status colors double-encoded (icon shape or label — never color alone).
- Contrast: body text ≥ 4.5:1 against its panel fill (verified in CI via token test).
- Full keyboard map: `⌘K` command palette, `1–9` agent focus, `g` then `l/o/t/…` tab
  navigation, `a` approvals. Voice is additive, never required.
- Reduced-motion setting: walks become teleports + labels; envelopes become list
  flashes; information parity is a test case, not a hope.

## 9. Copy voice

The Herald's civic register (VOICE-DESIGN) governs every string the Architect
reads. Rules: use the agent's *name*, never "the agent"; ≤ 12 words for system
feedback; no emoji (we have icons); exclamation marks only for completions;
proper punctuation always.

| Don't | Do |
|---|---|
| "Agent is currently performing a Read operation on SPEC.md" | "Mason is reading SPEC.md" |
| "An error has occurred" | "Mason hit a snag" |
| "Permission denied" | "Mason needs your approval" |
| "The operation completed successfully" | "Mason is done" |
| "Loading…" | "One moment" |
| "You have 3 unread notifications ✨" | "Three items need you" |

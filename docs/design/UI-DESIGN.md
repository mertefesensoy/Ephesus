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

## 6. Motion rules

- Durations: 120 ms (state flips), 250 ms (walks per tile, success flash), 400 ms
  (panel open). Easing: stepped (4–6 frames), never smooth cubic — this is pixel art.
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
  and is replaced by the M1 floor-art package.
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

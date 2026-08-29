import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
// CSP forbids eval (ENGINEERING-STANDARDS §5); this swaps Pixi's codegen for eval-free paths.
import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics, ImageSource, Rectangle, Sprite, Texture } from 'pixi.js'
import type { AvatarSnapshot } from '../../../shared/avatar'
import {
  MS_PER_TILE,
  ROOM_COLS,
  ROOM_ROWS,
  STATION_TILES,
  TILE_PX,
  floorPlan,
  seatTile,
  sharingDesks,
  walkDurationMs
} from '../../../shared/floor'
import { badgeFor, floorCensus, glyphPixels, GLYPH_H, GLYPH_W } from '../../../shared/badges'
import {
  deskTray,
  NO_FACTS,
  stationCensus,
  stationView,
  type AvatarPresence,
  type FloorFacts
} from '../../../shared/stations'
import { paintFurnishings } from './painter'
import { stationMarks, stationOrigin, trayMarks } from './station-art'
import { TEMPLE_SEAT, terraceSeat } from '../../../shared/seats'
import type { AvatarUpdate } from '../../../shared/ipc'
import { STATIONS } from '../../../shared/avatar'
import { tokens } from '../tokens'
import {
  CITIZEN_W,
  citizenSprite,
  directionFor,
  silhouetteFor,
  walkFrame,
  type CitizenPalette,
  type Silhouette
} from './citizen'
import { overlayFor, overlayFrame, overlayPixels, OVERLAY_PX, OVERLAY_TOKEN_COLOR } from './overlay'
import { paintPlan, type PaintOp } from './painter'
import { tilesetState } from './tileset'
import { steppedProgress, STEPS_PER_TILE } from './walk'

/**
 * The Terraces floor (UI-DESIGN §5). It is a **projection**: every avatar's
 * phase, station and walk come from main's snapshots (SDD §6), and this module
 * only interpolates between the two ends of a walk main already decided. When
 * the snapshots stop arriving, the floor stops — it has nothing of its own to
 * animate from, which is what "never invents motion" (SDD §10) means in code.
 */

/**
 * How often the floor re-reads the live meeting. The Odeon fill is a projection
 * of `odeon.meeting()`, which has no push channel in SDD §5's event list, so it
 * is polled at the same cadence the panels use. M6.7's scheduler work closes
 * this (the `odeon:queue` badge carried item).
 */
const MEETING_POLL_MS = 5_000

/** Status colors from UI-DESIGN §2.4, one per avatar phase. */
const PHASE_COLOR: Readonly<Record<string, number>> = {
  idle: tokens.statusIdle,
  alert: tokens.statusThinking,
  thinking: tokens.statusThinking,
  working: tokens.statusWorking,
  waiting: tokens.statusWaiting,
  blocked: tokens.statusBlocked,
  success: tokens.statusSuccess,
  ghost: tokens.statusGhost,
  compacting: tokens.statusCompacting,
  looping: tokens.statusLooping,
  stopped: tokens.statusBlocked,
  archived: tokens.statusGhost
}

/**
 * Paints the room from `floorPlan()` — the same plan whether or not a pack is
 * installed, so art changes how the floor looks and never what is on it.
 *
 * Fills go into one `Graphics`; blits become `Sprite`s over the shared sheet
 * texture. Both come from the pure painter, so this function decides nothing.
 */
function drawRoom(
  ops: readonly PaintOp[],
  g: Graphics,
  sheet: Texture | null,
  into: Container
): void {
  for (const op of ops) {
    if (op.op === 'fill') {
      g.rect(op.x, op.y, op.w, op.h).fill(op.color)
      continue
    }
    if (!sheet) continue
    const frame = new Rectangle(op.frame.x, op.frame.y, op.frame.w, op.frame.h)
    const sprite = new Sprite(new Texture({ source: sheet.source, frame }))
    sprite.x = op.x
    sprite.y = op.y
    // §7: integer scaling only, pixel-snap preserved.
    sprite.scale.set(op.scale)
    into.addChild(sprite)
  }
}

/**
 * Draws one citizen from the §7 sprite recipes. This function only paints
 * rectangles the pure module produced; the walk cycle, the silhouette and the
 * colour budget are decided (and tested) there.
 */
function drawCitizen(
  g: Graphics,
  opts: {
    dx: number
    dy: number
    frame: 0 | 1 | 2 | 3
    walking: boolean
    silhouette: Silhouette
    palette: CitizenPalette
    phase: string
    /** Milliseconds the avatar has been in this phase — the overlay's only clock. */
    phaseElapsedMs: number
  }
): void {
  g.clear()
  for (const rect of citizenSprite({
    direction: directionFor(opts.dx, opts.dy),
    frame: opts.frame,
    silhouette: opts.silhouette,
    palette: opts.palette,
    walking: opts.walking
  })) {
    g.rect(rect.x, rect.y, rect.w, rect.h).fill(rect.color)
  }
  // Status badge, drawn OUTSIDE the sprite's five-colour budget: it is a UI
  // marker, and §8 requires status to be double-encoded rather than colour-only.
  // Hence the glyph: `alert` and `thinking` share a colour, `ghost` and
  // `archived` share a colour, `blocked` and `stopped` share a colour — the
  // shape is what tells them apart, and it is what a colour-blind reader has.
  const badgeW = GLYPH_W * 2 + 6
  const badgeH = GLYPH_H * 2 + 4
  g.rect(10, -badgeH - 2, badgeW, badgeH).fill(PHASE_COLOR[opts.phase] ?? tokens.statusIdle)
  g.rect(10, -badgeH - 2, badgeW, 1).fill(tokens.ink900)
  for (const pixel of glyphPixels(badgeFor(opts.phase).glyph)) {
    g.rect(13 + pixel.x * 2, -badgeH + pixel.y * 2, 2, 2).fill(tokens.ink900)
  }
  drawOverlay(g, opts.phase, opts.phaseElapsedMs)
}

/**
 * The §5.2 status overlay, in the head-room rows §5.1 keeps clear (0-7). It is
 * a projection and nothing else: which mark comes from the phase, which frame
 * comes from how long main says the phase has been current. This function owns
 * no timer, so when the snapshots stop the overlay stops with them.
 */
function drawOverlay(g: Graphics, phase: string, phaseElapsedMs: number): void {
  const spec = overlayFor(phase)
  const frame = overlayFrame(spec, phaseElapsedMs)
  if (frame === null) return
  const swatch = OVERLAY_TOKEN_COLOR[spec.kind]
  const color =
    swatch === 'gold'
      ? tokens.gold
      : swatch === 'status'
        ? (PHASE_COLOR[phase] ?? tokens.statusIdle)
        : tokens.ink900
  // Centred over the sprite, inside the eight reserved rows.
  const originX = (CITIZEN_W - OVERLAY_PX) / 2
  for (const pixel of overlayPixels(spec.kind, frame)) {
    g.rect(originX + pixel.x, pixel.y, 1, 1).fill(color)
  }
}

/**
 * The §5.4 station states, drawn. This function decides nothing: it asks
 * `stationView` what each station is doing — which cannot answer anything but
 * `idle` without naming the event-plane fact behind it — and then asks
 * `stationMarks` what that looks like.
 */
function drawStations(g: Graphics, facts: FloorFacts, nowMs: number): void {
  g.clear()
  for (const station of STATIONS) {
    // `desk` is the walk-timing anchor, not a drawn station; the drawn desks
    // are the seats, and their trays are drawn separately.
    if (station === 'desk') continue
    const view = stationView(station, facts, nowMs)
    if (view.activity === 'idle') continue
    const origin = stationOrigin(station, STATION_TILES[station])
    for (const mark of stationMarks(view, facts.meetingAttendees)) {
      g.rect(origin.x + mark.x, origin.y + mark.y, mark.w, mark.h).fill(mark.color)
    }
  }
}

/**
 * The desk inbox trays — §5.4's "flag UP while unread mail waits". One per
 * citizen on the floor, at that citizen's own seat, because the flag is a fact
 * about that agent's inbox and not about the room.
 */
function drawTrays(
  g: Graphics,
  live: ReadonlyMap<string, AvatarSnapshot>,
  mail: ReadonlyMap<string, number>,
  seats: ReadonlyMap<string, { role: string; seat: string }>
): void {
  for (const agentId of live.keys()) {
    const seat = seats.get(agentId)?.seat
    if (!seat) continue
    const tile = seatTile(seat)
    const origin = stationOrigin('desk', tile)
    for (const mark of trayMarks(deskTray(mail.get(agentId) ?? 0))) {
      g.rect(origin.x + mark.x, origin.y + mark.y, mark.w, mark.h).fill(mark.color)
    }
  }
}

/** What the last frame drew, so an interrupted walk resumes from where it is. */
interface DrawState {
  x: number
  y: number
  /** `sinceMs` of the walk this position belongs to. */
  walkSince: number
  /** Pixel origin of the current walk — the sprite's position when it began. */
  fromX: number
  fromY: number
}

/**
 * Pixel position for a snapshot at `nowMs`, interpolating the walk main decided.
 *
 * The model is discrete — a walk is (origin station → station, since) — but a
 * real tool often finishes before its walk does, and the next snapshot then
 * describes a walk starting from the station the avatar never reached. Drawing
 * that literally teleports the sprite forward and then walks it back. So the
 * *pixel* origin is the sprite's actual last position, remembered here. This is
 * presentation smoothing only: no state the model does not already have, and
 * nothing the renderer decides on its own about phase or destination.
 */
function positionFor(
  snapshot: AvatarSnapshot,
  seat: string,
  nowMs: number,
  drawn: DrawState | undefined
): DrawState & { frame: 0 | 1 | 2 | 3 } {
  // `desk` is the agent's OWN desk — its seat (SDD §4.1). Until M3.6 it was the
  // avatar's index in a Map, so a citizen changed desks whenever another agent
  // was hired or exited.
  const tileOf = (station: string): { col: number; row: number } =>
    station === 'desk'
      ? seatTile(seat)
      : (STATION_TILES[station as keyof typeof STATION_TILES] ?? STATION_TILES.desk)

  const to = tileOf(snapshot.station)
  const toX = to.col * TILE_PX
  const toY = to.row * TILE_PX

  if (!snapshot.walking) {
    return { x: toX, y: toY, walkSince: snapshot.sinceMs, fromX: toX, fromY: toY, frame: 0 }
  }

  const origin = tileOf(snapshot.origin)
  const isNewWalk = drawn === undefined || drawn.walkSince !== snapshot.sinceMs
  const fromX = isNewWalk ? (drawn?.x ?? origin.col * TILE_PX) : drawn.fromX
  const fromY = isNewWalk ? (drawn?.y ?? origin.row * TILE_PX) : drawn.fromY

  const duration = Math.max(walkDurationMs(snapshot.origin, snapshot.station), MS_PER_TILE)
  const steps = Math.max(1, Math.round((duration / MS_PER_TILE) * STEPS_PER_TILE))
  const progress = steppedProgress(nowMs - snapshot.sinceMs, duration, steps)
  const stepIndex = Math.round(progress * steps)
  return {
    x: fromX + (toX - fromX) * progress,
    y: fromY + (toY - fromY) * progress,
    walkSince: snapshot.sinceMs,
    fromX,
    fromY,
    frame: walkFrame(stepIndex)
  }
}

/** The eight citizen accents of UI-DESIGN §2.3; `terracotta` is Artemis's alone. */
const ACCENTS = [
  tokens.aegean,
  tokens.olive,
  tokens.gold,
  tokens.laurel,
  tokens.iris,
  tokens.poppy,
  tokens.sand,
  tokens.cypress
]

export function FloorCanvas(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [population, setPopulation] = useState(0)
  const avatarsRef = useRef<Map<string, AvatarSnapshot>>(new Map())
  const seatsRef = useRef<Map<string, { role: string; seat: string }>>(new Map())
  /**
   * §5.4's desk tray flag IS `pendingMailCount`, so it arrives with the avatar
   * update that carries the same agent's snapshot — one moment, one fact.
   */
  const mailRef = useRef<Map<string, number>>(new Map())
  /** The two room-level facts §5.4 names: an open gate, a gathered meeting. */
  const factsRef = useRef<{ openGates: number; meetingAttendees: number }>({
    openGates: 0,
    meetingAttendees: 0
  })
  // Seeded with the same two halves `refresh()` writes, so the label reads the
  // same way before the first snapshot arrives as it does after — a window with
  // no bridge yet must not silently drop the station half of §8's parity.
  const [census, setCensus] = useState(() => `${floorCensus([])} · ${stationCensus(NO_FACTS, 0)}`)
  const [overflow, setOverflow] = useState(0)
  const [tileset] = useState(tilesetState)
  const [sheetError, setSheetError] = useState<string | null>(null)

  /**
   * What the strip and the label say about the floor, recomputed from the two
   * refs. The census is the floor's information content in words: a `<canvas>`
   * is opaque to a screen reader, so without it §8's double encoding stops at
   * the glyph (UI-DESIGN §8, NFR-15). Both counts are over the citizens who are
   * actually on the floor, not over every card ever seen.
   */
  const refresh = useCallback((): void => {
    const live = avatarsRef.current
    setPopulation(live.size)
    // §8 information parity: what a station's animation says must also be
    // reachable in words, or the floor's newest information is available only
    // to people who can watch pixels move (NFR-15).
    setCensus(
      `${floorCensus([...live.values()].map((snapshot) => snapshot.phase))} · ${stationCensus(
        floorFacts(),
        Date.now()
      )}`
    )
    setOverflow(sharingDesks([...live.keys()].map((id) => seatsRef.current.get(id)?.seat ?? '')))
  }, [])

  /**
   * The facts the §5.4 station model is allowed to see, assembled from what
   * main has told this window. Nothing here is renderer opinion: every field
   * traces to a snapshot, an approvals queue or a live meeting.
   */
  const floorFacts = useCallback((): FloorFacts => {
    const avatars: AvatarPresence[] = [...avatarsRef.current.values()].map((snapshot) => ({
      station: snapshot.station,
      walking: snapshot.walking,
      phase: snapshot.phase
    }))
    return {
      avatars,
      openGates: factsRef.current.openGates,
      meetingAttendees: factsRef.current.meetingAttendees,
      // Hover selection is UI-DESIGN §5's camera work, not M6.2's — the model
      // takes it, and the floor has nothing to put there yet.
      hovered: null
    }
  }, [])

  /**
   * The Watch brazier IS an open gate and the Odeon fills when a meeting
   * gathers (§5.4), so the floor reads both facts from the same channels the
   * panels do — never a second copy of either queue.
   *
   * `gate:open` pushes a nudge and the queue is re-read, which is the pattern
   * the approvals panel already uses. The meeting has no push channel of its
   * own (SDD §5's event list), so it is polled at the same cadence the panels
   * poll — the `odeon:queue` badge carried item covers that gap and lands in
   * M6.7.
   */
  useEffect(() => {
    const eph = window.eph
    if (!eph) return
    let live = true
    const reread = (): void => {
      void eph.watch.approvals().then((gates) => {
        if (!live) return
        factsRef.current = { ...factsRef.current, openGates: gates.length }
        refresh()
      })
      void eph.odeon.meeting().then((meeting) => {
        if (!live) return
        factsRef.current = {
          ...factsRef.current,
          meetingAttendees: meeting ? meeting.attendees.length : 0
        }
        refresh()
      })
    }
    reread()
    const off = eph.watch.onGateChange(reread)
    const timer = setInterval(reread, MEETING_POLL_MS)
    return () => {
      live = false
      off()
      clearInterval(timer)
    }
  }, [refresh])

  // Roles decide silhouettes (§7) and seats decide desks (§5); the cards are
  // the only place either lives.
  useEffect(() => {
    const eph = window.eph
    if (!eph) return
    const note = (card: { agentId: string; role: string; seat: string }): void => {
      seatsRef.current.set(card.agentId, { role: card.role, seat: card.seat })
      refresh()
    }
    void eph.agents.list().then((cards) => {
      for (const card of cards) note(card)
    })
    return eph.agents.onChange(note)
  }, [refresh])

  // The floor's only input: snapshots from main (ADR-0002).
  useEffect(() => {
    const eph = window.eph
    if (!eph) return
    const note = (update: AvatarUpdate): void => {
      avatarsRef.current.set(update.agentId, update.snapshot)
      mailRef.current.set(update.agentId, update.pendingMail)
    }
    // Both read paths set the mail count, not just this one: the M5b close-out's
    // standing lesson is that a fact supplied on the listing path and not on the
    // push (or the reverse) is a seam no unit test sees.
    void eph.avatars.list().then((updates: readonly AvatarUpdate[]) => {
      for (const update of updates) note(update)
      refresh()
    })
    return eph.avatars.onChange((update) => {
      note(update)
      refresh()
    })
  }, [refresh])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let cancelled = false
    let cleanup: (() => void) | null = null

    const app = new Application()
    // The sheet is loaded alongside the app so the room is painted once, from
    // whatever is actually available. A sheet that fails to load leaves the
    // floor procedural and says so, rather than blitting from a null texture.
    //
    // Decoded through the DOM rather than through Pixi's asset resolver: the
    // resolver picks a parser from the URL's *extension*, and the bundler
    // inlines a small sheet as a `data:` URL, which has none. Observed live —
    // an installed pack fell back to procedural with a loader error. Nothing
    // about a tileset should depend on the shape of the URL it arrived on.
    const loadSheet = async (): Promise<Texture | null> => {
      if (!tileset.sheetUrl) return null
      try {
        const image = new Image()
        image.src = tileset.sheetUrl
        await image.decode()
        return new Texture({
          // `nearest` is not a preference: §1.1 is pixel-snapped everywhere, and
          // the §7 integer upscale is only integer if nothing interpolates it.
          source: new ImageSource({ resource: image, scaleMode: 'nearest' })
        })
      } catch (err: unknown) {
        setSheetError(err instanceof Error ? err.message : String(err))
        return null
      }
    }
    void Promise.all([
      app.init({
        width: ROOM_COLS * TILE_PX,
        height: ROOM_ROWS * TILE_PX,
        background: tokens.marble200,
        antialias: false // pixel-snapped everything (§1.1)
      }),
      loadSheet()
    ])
      .then(([, sheet]) => {
        const map = sheet ? tileset.map : null
        if (cancelled) {
          app.destroy(true)
          return
        }
        host.appendChild(app.canvas)

        const ops = paintPlan(floorPlan(), map)
        const room = new Graphics()
        const sheetTiles = new Container()
        // Fills under blits: a partially-mapped pack paints its own tiles over
        // the procedural floor rather than punching holes in it.
        app.stage.addChild(room)
        app.stage.addChild(sheetTiles)
        drawRoom(ops, room, sheet, sheetTiles)

        // §5.7 furnishings sit over the floor and under everything that moves:
        // place identity, static, and only ever from the pack's own map.
        drawRoom(paintFurnishings(map), room, sheet, sheetTiles)

        // The §5.4 station layer, redrawn each tick because its states are
        // projections of facts that change. It sits under the citizens so a
        // brazier never paints over the guard standing at it.
        const stationLayer = new Graphics()
        app.stage.addChild(stationLayer)

        const citizens = new Container()
        app.stage.addChild(citizens)
        const sprites = new Map<string, Graphics>()
        const drawStates = new Map<string, DrawState>()

        app.ticker.add(() => {
          const now = Date.now()
          const live = avatarsRef.current
          drawStations(stationLayer, floorFacts(), now)
          drawTrays(stationLayer, live, mailRef.current, seatsRef.current)
          let index = 0
          for (const [agentId, snapshot] of live) {
            let sprite = sprites.get(agentId)
            if (!sprite) {
              sprite = new Graphics()
              sprites.set(agentId, sprite)
              citizens.addChild(sprite)
            }
            const previous = drawStates.get(agentId)
            const card = seatsRef.current.get(agentId)
            // A citizen with no card yet is seated on the terraces until one
            // arrives — never in the temple, which is Artemis's alone.
            const seat = card?.seat ?? terraceSeat(1)
            const accent =
              seat === TEMPLE_SEAT
                ? tokens.terracotta
                : (ACCENTS[index % ACCENTS.length] ?? tokens.aegean)
            const pose = positionFor(snapshot, seat, now, previous)
            drawStates.set(agentId, pose)
            drawCitizen(sprite, {
              dx: pose.x - (previous?.x ?? pose.x),
              dy: pose.y - (previous?.y ?? pose.y),
              frame: pose.frame,
              walking: snapshot.walking,
              silhouette: silhouetteFor(card?.role ?? ''),
              // §5.1's five slots. The outline is always ink-900; `primary` is
              // the agent's §2.3 accent (terracotta only in the temple seat);
              // `secondary` is the trim every silhouette prop is cut from.
              palette: {
                outline: tokens.ink900,
                hair: tokens.ink700,
                skin: tokens.sand,
                primary: accent,
                secondary: tokens.marble50
              },
              phase: snapshot.phase,
              // The overlay's whole clock: main stamped `sinceMs` when the
              // phase began, so the frame on screen is a fact about the event
              // plane, not about when this ticker happened to run.
              phaseElapsedMs: now - snapshot.sinceMs
            })
            sprite.x = Math.round(pose.x)
            sprite.y = Math.round(pose.y) - 16
            // §5.2 gives the fade to the overlay table, so `ghost` at 50 % and
            // `archived` at 0 are read from there rather than from a literal.
            sprite.alpha = overlayFor(snapshot.phase).opacity
            sprite.visible = snapshot.phase !== 'archived'
            index += 1
          }
          for (const [agentId, sprite] of sprites) {
            if (!live.has(agentId)) {
              sprite.destroy()
              sprites.delete(agentId)
              drawStates.delete(agentId)
            }
          }
        })

        // NFR-1: no animation while the window is hidden.
        const onVisibility = (): void => {
          if (document.hidden) app.ticker.stop()
          else app.ticker.start()
        }
        document.addEventListener('visibilitychange', onVisibility)
        onVisibility()

        cleanup = (): void => {
          document.removeEventListener('visibilitychange', onVisibility)
          app.destroy(true)
        }
      })
      .catch((err: unknown) => {
        // Degradations are visible, never silent (invariant §7).
        setInitError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [tileset])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div ref={hostRef} role="img" aria-label={census} />
      <span
        style={{
          fontFamily: 'var(--eph-face-data)',
          fontSize: '12px',
          color: initError ? 'var(--eph-status-blocked)' : 'var(--eph-ink-700)'
        }}
      >
        {initError
          ? `floor unavailable: ${initError}`
          : [
              `floor: ${population} on the terraces`,
              sheetError
                ? `tileset: procedural (sheet failed to load — ${sheetError})`
                : tileset.note,
              // More hires than the block has desks: citizens share a seat, and
              // that is said out loud rather than left to be noticed (§7).
              overflow > 0 ? `${overflow} sharing a desk` : null
            ]
              .filter(Boolean)
              .join(' · ')}
      </span>
    </div>
  )
}

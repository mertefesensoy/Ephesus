import { useEffect, useRef, useState, type ReactElement } from 'react'
// CSP forbids eval (ENGINEERING-STANDARDS §5); this swaps Pixi's codegen for eval-free paths.
import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics } from 'pixi.js'
import type { AvatarSnapshot } from '../../../shared/avatar'
import {
  MS_PER_TILE,
  ROOM_COLS,
  ROOM_ROWS,
  STATION_TILES,
  TILE_PX,
  deskTileFor,
  walkDurationMs
} from '../../../shared/floor'
import type { AvatarUpdate } from '../../../shared/ipc'
import { tokens } from '../tokens'
import { steppedProgress, STEPS_PER_TILE } from './walk'

/**
 * The Terraces floor (UI-DESIGN §5). It is a **projection**: every avatar's
 * phase, station and walk come from main's snapshots (SDD §6), and this module
 * only interpolates between the two ends of a walk main already decided. When
 * the snapshots stop arriving, the floor stops — it has nothing of its own to
 * animate from, which is what "never invents motion" (SDD §10) means in code.
 */
const WALL_PX = 3

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

function drawRoom(g: Graphics): void {
  for (let cx = 0; cx < ROOM_COLS; cx++) {
    for (let cy = 0; cy < ROOM_ROWS; cy++) {
      const color = (cx + cy) % 2 === 0 ? tokens.worldTerraceA : tokens.worldTerraceB
      g.rect(cx * TILE_PX, cy * TILE_PX, TILE_PX, TILE_PX).fill(color)
    }
  }
  // Stone paths along the station rows (§2.5).
  for (const row of [2, 7]) {
    for (let cx = 0; cx < ROOM_COLS; cx++) {
      g.rect(cx * TILE_PX, row * TILE_PX + 4, TILE_PX, TILE_PX - 8).fill(tokens.worldPath)
    }
  }
  // Stations: 8-color tiles until the M1.5b tileset lands (UI-DESIGN §7).
  for (const [station, tile] of Object.entries(STATION_TILES)) {
    if (station === 'desk') continue
    g.rect(tile.col * TILE_PX + 2, tile.row * TILE_PX + 2, TILE_PX - 4, TILE_PX - 4).fill(
      tokens.worldWall
    )
    g.rect(tile.col * TILE_PX + 6, tile.row * TILE_PX + 6, TILE_PX - 12, TILE_PX - 12).fill(
      tokens.gold
    )
  }
  const w = ROOM_COLS * TILE_PX
  const h = ROOM_ROWS * TILE_PX
  g.rect(0, 0, w, WALL_PX).fill(tokens.worldWall)
  g.rect(0, h - WALL_PX, w, WALL_PX).fill(tokens.worldWall)
  g.rect(0, 0, WALL_PX, h).fill(tokens.worldWall)
  g.rect(w - WALL_PX, 0, WALL_PX, h).fill(tokens.worldWall)
}

/** 32×48 pixel citizen: ≤5 colors per sprite (§1.3), ink-900 outline (§7). */
function drawCitizen(g: Graphics, frame: 0 | 1, accent: number, phase: string): void {
  g.clear()
  g.rect(8, 0, 16, 4).fill(tokens.ink700)
  g.rect(8, 4, 16, 10).fill(tokens.sand)
  g.rect(6, 14, 20, 20).fill(accent)
  if (frame === 0) {
    g.rect(9, 34, 5, 12).fill(tokens.ink700)
    g.rect(18, 34, 5, 12).fill(tokens.ink700)
  } else {
    g.rect(6, 34, 5, 12).fill(tokens.ink700)
    g.rect(21, 34, 5, 12).fill(tokens.ink700)
  }
  g.rect(6, 14, 20, 1).fill(tokens.ink900)
  // Status is double-encoded: a badge over the head, never color alone (§8).
  g.rect(10, -8, 12, 6).fill(PHASE_COLOR[phase] ?? tokens.statusIdle)
  g.rect(10, -8, 12, 1).fill(tokens.ink900)
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
  deskIndex: number,
  nowMs: number,
  drawn: DrawState | undefined
): DrawState & { frame: 0 | 1 } {
  const tileOf = (station: string): { col: number; row: number } =>
    station === 'desk'
      ? deskTileFor(deskIndex)
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
    frame: (stepIndex % 2) as 0 | 1
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

  // The floor's only input: snapshots from main (ADR-0002).
  useEffect(() => {
    const eph = window.eph
    if (!eph) return
    void eph.avatars.list().then((updates: readonly AvatarUpdate[]) => {
      for (const update of updates) avatarsRef.current.set(update.agentId, update.snapshot)
      setPopulation(avatarsRef.current.size)
    })
    return eph.avatars.onChange((update) => {
      avatarsRef.current.set(update.agentId, update.snapshot)
      setPopulation(avatarsRef.current.size)
    })
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let cancelled = false
    let cleanup: (() => void) | null = null

    const app = new Application()
    void app
      .init({
        width: ROOM_COLS * TILE_PX,
        height: ROOM_ROWS * TILE_PX,
        background: tokens.marble200,
        antialias: false // pixel-snapped everything (§1.1)
      })
      .then(() => {
        if (cancelled) {
          app.destroy(true)
          return
        }
        host.appendChild(app.canvas)

        const room = new Graphics()
        drawRoom(room)
        app.stage.addChild(room)

        const citizens = new Container()
        app.stage.addChild(citizens)
        const sprites = new Map<string, Graphics>()
        const drawStates = new Map<string, DrawState>()

        app.ticker.add(() => {
          const now = Date.now()
          const live = avatarsRef.current
          let index = 0
          for (const [agentId, snapshot] of live) {
            let sprite = sprites.get(agentId)
            if (!sprite) {
              sprite = new Graphics()
              sprites.set(agentId, sprite)
              citizens.addChild(sprite)
            }
            const accent = ACCENTS[index % ACCENTS.length] ?? tokens.aegean
            const pose = positionFor(snapshot, index, now, drawStates.get(agentId))
            drawStates.set(agentId, pose)
            drawCitizen(sprite, pose.frame, accent, snapshot.phase)
            sprite.x = Math.round(pose.x)
            sprite.y = Math.round(pose.y) - 16
            sprite.alpha = snapshot.phase === 'ghost' ? 0.45 : 1
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
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div ref={hostRef} aria-label="Terraces floor" />
      <span
        style={{
          fontFamily: 'var(--eph-face-data)',
          fontSize: '12px',
          color: initError ? 'var(--eph-status-blocked)' : 'var(--eph-ink-700)'
        }}
      >
        {initError ? `floor unavailable: ${initError}` : `floor: ${population} on the terraces`}
      </span>
    </div>
  )
}

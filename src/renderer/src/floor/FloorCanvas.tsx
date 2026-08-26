import { useEffect, useRef, type ReactElement } from 'react'
// CSP forbids eval (ENGINEERING-STANDARDS §5); this swaps Pixi's codegen for eval-free paths.
import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics } from 'pixi.js'
import { tokens } from '../tokens'
import { patrolPose, TILE_PX } from './walk'

// One terrace room (UI-DESIGN §5): checkered terrace floor, 3px walls, a stone
// path row; one procedurally drawn 32×48 citizen patrolling two waypoints.
const ROOM_COLS = 14
const ROOM_ROWS = 8
const WALL_PX = 3

const WAYPOINT_A = { x: 2 * TILE_PX, y: 4 * TILE_PX }
const WAYPOINT_B = { x: 11 * TILE_PX, y: 4 * TILE_PX }

function drawRoom(g: Graphics): void {
  // Terrace floor checker (§2.5)
  for (let cx = 0; cx < ROOM_COLS; cx++) {
    for (let cy = 0; cy < ROOM_ROWS; cy++) {
      const color = (cx + cy) % 2 === 0 ? tokens.worldTerraceA : tokens.worldTerraceB
      g.rect(cx * TILE_PX, cy * TILE_PX, TILE_PX, TILE_PX).fill(color)
    }
  }
  // Stone path along the patrol row
  for (let cx = 0; cx < ROOM_COLS; cx++) {
    g.rect(cx * TILE_PX, 4 * TILE_PX + 4, TILE_PX, TILE_PX - 8).fill(tokens.worldPath)
  }
  // Walls: 3px frame (§2.5)
  const w = ROOM_COLS * TILE_PX
  const h = ROOM_ROWS * TILE_PX
  g.rect(0, 0, w, WALL_PX).fill(tokens.worldWall)
  g.rect(0, h - WALL_PX, w, WALL_PX).fill(tokens.worldWall)
  g.rect(0, 0, WALL_PX, h).fill(tokens.worldWall)
  g.rect(w - WALL_PX, 0, WALL_PX, h).fill(tokens.worldWall)
}

/** 32×48 pixel citizen: ≤5 colors per sprite (§1.3), ink-900 outline (§7). */
function drawCitizen(g: Graphics, frame: 0 | 1): void {
  g.clear()
  g.rect(8, 0, 16, 4).fill(tokens.ink700) // hair
  g.rect(8, 4, 16, 10).fill(tokens.sand) // face
  g.rect(6, 14, 20, 20).fill(tokens.aegean) // tunic
  if (frame === 0) {
    g.rect(9, 34, 5, 12).fill(tokens.ink700) // legs together
    g.rect(18, 34, 5, 12).fill(tokens.ink700)
  } else {
    g.rect(6, 34, 5, 12).fill(tokens.ink700) // legs apart (gait)
    g.rect(21, 34, 5, 12).fill(tokens.ink700)
  }
  g.rect(6, 14, 20, 1).fill(tokens.ink900) // outline hint at collar
}

export function FloorCanvas(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)

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

        const citizen = new Container()
        const body = new Graphics()
        drawCitizen(body, 0)
        citizen.addChild(body)
        // Avatar anchor: feet on the path tile; sprite is 32×48 (§5).
        app.stage.addChild(citizen)

        let elapsed = 0
        let lastFrame: 0 | 1 = 0
        const tick = (): void => {
          elapsed += app.ticker.deltaMS
          const pose = patrolPose(WAYPOINT_A, WAYPOINT_B, elapsed)
          // Pixel-snap positions (§1.1); feet sit on the walk row.
          citizen.x = Math.round(pose.x)
          citizen.y = Math.round(pose.y - 16)
          body.scale.x = pose.facing
          body.x = pose.facing === -1 ? 32 : 0
          if (pose.frame !== lastFrame) {
            lastFrame = pose.frame
            drawCitizen(body, pose.frame)
          }
        }
        app.ticker.add(tick)

        // The floor pauses all animation when the window is hidden (§6, NFR-1).
        const onVisibility = (): void => {
          if (document.hidden) app.ticker.stop()
          else app.ticker.start()
        }
        document.addEventListener('visibilitychange', onVisibility)

        cleanup = () => {
          document.removeEventListener('visibilitychange', onVisibility)
          app.ticker.remove(tick)
          app.destroy(true)
        }
      })

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [])

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        border: '2px solid var(--eph-ink-900)',
        outline: '1px solid var(--eph-ink-700)',
        boxShadow: '2px 2px 0 var(--eph-ink-900)',
        background: 'var(--eph-marble-100)'
      }}
    >
      <header style={{ padding: '4px 8px', borderBottom: '1px solid var(--eph-ink-700)' }}>
        <span style={{ fontFamily: 'var(--eph-face-display)', fontSize: '8px' }}>THE TERRACES</span>
      </header>
      <div ref={hostRef} style={{ padding: '8px', imageRendering: 'pixelated' }} />
    </section>
  )
}

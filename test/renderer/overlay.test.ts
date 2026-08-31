import { describe, expect, it } from 'vitest'
import { AVATAR_STATES, AVATAR_TERMINALS, SUCCESS_IDLE_MS } from '../../src/shared/avatar'
import {
  OVERLAID_PHASES,
  OVERLAY_FRAMES,
  OVERLAY_KINDS,
  OVERLAY_PX,
  OVERLAY_TOKEN_COLOR,
  OVERLAYS,
  overlayFor,
  overlayFrame,
  overlayPixels,
  type OverlayKind
} from '../../src/renderer/src/floor/overlay'
import { HEADROOM_ROWS } from '../../src/renderer/src/floor/citizen'

/**
 * UI-DESIGN §5.2 — the overlays as *projections*.
 *
 * The property that matters most here is not what the marks look like, it is
 * that nothing about them is invented: the table is total over the SDD §6
 * states, the frame is a pure function of how long the phase has been current,
 * and no overlay owns a timer. A renderer-side animation with its own clock
 * would keep playing after the events stopped — motion projecting no fact,
 * which §1.2 cuts and which NFR-13's spirit forbids (replay the log, get the
 * same floor).
 */

describe('the §5.2 overlay table', () => {
  it('covers every avatar phase — the ten §6 states and both terminals', () => {
    expect(OVERLAID_PHASES).toEqual([...AVATAR_STATES, ...AVATAR_TERMINALS])
    for (const phase of OVERLAID_PHASES) {
      expect(OVERLAYS[phase], `no overlay row for ${phase}`).toBeDefined()
      expect(OVERLAY_KINDS).toContain(OVERLAYS[phase].kind)
    }
    // Total, not just complete: nothing extra has been smuggled into the table.
    expect(Object.keys(OVERLAYS).sort()).toEqual([...OVERLAID_PHASES].sort())
  })

  it('transcribes the table §5.2 prints', () => {
    expect(OVERLAYS.thinking).toMatchObject({ kind: 'dots', frames: 3, frameMs: 200 })
    expect(OVERLAYS.working).toMatchObject({ kind: 'token', frames: 2 })
    expect(OVERLAYS.waiting).toMatchObject({ kind: 'sandglass', frames: 2, frameMs: 400 })
    expect(OVERLAYS.blocked).toMatchObject({ kind: 'bang', frames: 2, frameMs: 300 })
    expect(OVERLAYS.looping).toMatchObject({ kind: 'spiral', frames: 2, frameMs: 200 })
    expect(OVERLAYS.compacting).toMatchObject({ kind: 'box', frames: 3, frameMs: 300 })
    // "star burst in gold, then gone" — one pass, ~250 ms total.
    expect(OVERLAYS.success).toMatchObject({ kind: 'starburst', frames: 4, once: true })
    expect(OVERLAYS.success.frames * OVERLAYS.success.frameMs).toBeLessThanOrEqual(SUCCESS_IDLE_MS)
    // "none" rows.
    for (const phase of ['idle', 'alert', 'ghost'] as const) {
      expect(OVERLAYS[phase].kind, phase).toBe('none')
    }
    // "ghost — none, sprite at 50 % opacity".
    expect(OVERLAYS.ghost.opacity).toBe(0.5)
    expect(OVERLAYS.idle.opacity).toBe(1)
    // An archived avatar has left the floor entirely.
    expect(OVERLAYS.archived.opacity).toBe(0)
  })

  it('reads an unknown phase as no overlay rather than throwing', () => {
    expect(overlayFor('not-a-phase').kind).toBe('none')
    expect(overlayFor('').frames).toBe(0)
    for (const phase of OVERLAID_PHASES) expect(overlayFor(phase)).toBe(OVERLAYS[phase])
  })
})

describe('overlay frames are a projection of elapsed phase time', () => {
  it('advances only on frame boundaries, and loops', () => {
    const dots = OVERLAYS.thinking // 3 × 200 ms
    expect(overlayFrame(dots, 0)).toBe(0)
    expect(overlayFrame(dots, 199)).toBe(0)
    expect(overlayFrame(dots, 200)).toBe(1)
    expect(overlayFrame(dots, 400)).toBe(2)
    expect(overlayFrame(dots, 600)).toBe(0) // wraps
    expect(overlayFrame(dots, -5)).toBe(0) // clamps
  })

  it('runs the one-shot burst once and then stops drawing', () => {
    const burst = OVERLAYS.success
    expect(overlayFrame(burst, 0)).toBe(0)
    expect(overlayFrame(burst, burst.frameMs * 3)).toBe(3)
    // Past the last frame it is gone — "then gone", not held on the last pose.
    expect(overlayFrame(burst, burst.frameMs * 4)).toBeNull()
    expect(overlayFrame(burst, 10_000)).toBeNull()
  })

  it('draws nothing for the none rows, at any elapsed time', () => {
    for (const phase of ['idle', 'alert', 'ghost', 'stopped', 'archived'] as const) {
      for (const elapsed of [0, 250, 1_000, 60_000]) {
        expect(overlayFrame(OVERLAYS[phase], elapsed), `${phase}@${String(elapsed)}`).toBeNull()
      }
    }
  })

  it('is pure — the same elapsed time always gives the same frame', () => {
    // The NFR-13 property: replay the log, get the same overlay. Two calls a
    // "long time apart" in wall-clock terms return the same frame because the
    // function has no wall clock to read.
    for (const phase of OVERLAID_PHASES) {
      for (const elapsed of [0, 137, 400, 999]) {
        expect(overlayFrame(OVERLAYS[phase], elapsed)).toBe(overlayFrame(OVERLAYS[phase], elapsed))
      }
    }
  })
})

describe('overlay pixels', () => {
  it('fits every frame in the 8×8 grid, inside the sprite head-room', () => {
    expect(OVERLAY_PX).toBe(8)
    // The overlay must fit the rows §5.1 reserves for it, or it would collide
    // with the body it sits above.
    expect(OVERLAY_PX).toBeLessThanOrEqual(HEADROOM_ROWS)
    for (const kind of OVERLAY_KINDS) {
      for (const rows of OVERLAY_FRAMES[kind]) {
        expect(rows.length, kind).toBe(OVERLAY_PX)
        for (const row of rows) expect(row.length, kind).toBe(OVERLAY_PX)
      }
    }
  })

  it('supplies exactly as many pixel frames as the table declares', () => {
    for (const phase of OVERLAID_PHASES) {
      const spec = OVERLAYS[phase]
      const frames = OVERLAY_FRAMES[spec.kind]
      if (spec.kind === 'none') {
        expect(frames.length, phase).toBe(0)
        continue
      }
      if (spec.kind === 'token') {
        // §5.3's carrying tokens are M6.3's package. The row is declared here
        // and drawn there; a placeholder mark would be a shape projecting no
        // fact, which is exactly what §5.4 calls invented motion.
        expect(frames.length, 'token pixels arrive with §5.3').toBe(0)
        continue
      }
      expect(frames.length, phase).toBe(spec.frames)
    }
  })

  it('draws a distinct shape per frame, so motion carries information', () => {
    for (const kind of OVERLAY_KINDS) {
      const frames = OVERLAY_FRAMES[kind]
      const seen = new Set(frames.map((rows) => rows.join('|')))
      expect(seen.size, `${kind} repeats a frame`).toBe(frames.length)
    }
  })

  it('makes overlays distinguishable by shape alone (§8, never colour alone)', () => {
    // First frames only: what a reader sees at a glance must already separate
    // the states, without waiting out a cycle and without reading colour.
    const drawn = OVERLAY_KINDS.filter((kind) => OVERLAY_FRAMES[kind].length > 0)
    const shapes = new Set(drawn.map((kind) => JSON.stringify(overlayPixels(kind, 0))))
    expect(shapes.size).toBe(drawn.length)
  })

  it('returns nothing for an unknown kind or an out-of-range frame', () => {
    expect(overlayPixels('nope' as OverlayKind, 0)).toEqual([])
    expect(overlayPixels('dots', 99)).toEqual([])
    expect(overlayPixels('dots', -1)).toEqual([])
    expect(overlayPixels('none', 0)).toEqual([])
    expect(overlayPixels('token', 0)).toEqual([])
  })

  it('lights at least one pixel in every drawn frame', () => {
    for (const kind of OVERLAY_KINDS) {
      OVERLAY_FRAMES[kind].forEach((_rows, frame) => {
        // The `bang` blink has a deliberately empty off-frame; everything else
        // must actually show something.
        const lit = overlayPixels(kind, frame).length
        if (kind === 'bang' && frame === 1) expect(lit).toBe(0)
        else expect(lit, `${kind}#${String(frame)}`).toBeGreaterThan(0)
      })
    }
  })

  it('colours the two rows §5.2 names, and inks the rest', () => {
    // "`!` in status-blocked", "tight spiral in status-looping" — both take the
    // phase's own status colour; "star burst in gold" takes gold.
    expect(OVERLAY_TOKEN_COLOR.bang).toBe('status')
    expect(OVERLAY_TOKEN_COLOR.spiral).toBe('status')
    expect(OVERLAY_TOKEN_COLOR.starburst).toBe('gold')
    for (const kind of OVERLAY_KINDS) {
      expect(['status', 'gold', 'ink'], kind).toContain(OVERLAY_TOKEN_COLOR[kind])
    }
  })
})

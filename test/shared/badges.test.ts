import { describe, expect, it } from 'vitest'
import { AVATAR_STATES, AVATAR_TERMINALS, type AvatarPhase } from '../../src/shared/avatar'
import {
  BADGED_PHASES,
  BADGES,
  GLYPH_H,
  GLYPH_PIXELS,
  GLYPH_W,
  badgeFor,
  floorCensus,
  glyphPixels
} from '../../src/shared/badges'
import { tokens } from '../../src/renderer/src/tokens'

/**
 * UI-DESIGN §8: "All status colors double-encoded (icon shape or label — never
 * color alone)."
 *
 * The floor drew a coloured rectangle and nothing else from M1, so three pairs
 * of states were indistinguishable by shape and all ten were indistinguishable
 * to anyone not reading colour. M3 makes `waiting`, `blocked` and `looping`
 * reachable for the first time (gates, the breaker), which is what makes the
 * clause owed now rather than theoretical.
 *
 * The test is deliberately written the way a reader without colour perceives
 * the floor: the colour map is used ONLY to find which phases collide, never to
 * distinguish them.
 */

/** The floor's phase → status-colour map (UI-DESIGN §2.4), as FloorCanvas has it. */
const PHASE_COLOR: Readonly<Record<AvatarPhase, number>> = {
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

describe('every phase carries a badge', () => {
  it('covers all ten SDD §6 states and both terminals', () => {
    for (const phase of [...AVATAR_STATES, ...AVATAR_TERMINALS]) {
      expect(BADGES[phase]).toBeDefined()
      expect(BADGES[phase].label.length).toBeGreaterThan(0)
    }
    expect(BADGED_PHASES).toHaveLength(AVATAR_STATES.length + AVATAR_TERMINALS.length)
  })

  it('has a drawable glyph for each', () => {
    for (const phase of BADGED_PHASES) {
      const pixels = glyphPixels(BADGES[phase].glyph)
      expect(pixels.length).toBeGreaterThan(0)
      for (const pixel of pixels) {
        expect(pixel.x).toBeGreaterThanOrEqual(0)
        expect(pixel.x).toBeLessThan(GLYPH_W)
        expect(pixel.y).toBeGreaterThanOrEqual(0)
        expect(pixel.y).toBeLessThan(GLYPH_H)
      }
    }
  })

  it('keeps every matrix the declared size', () => {
    for (const [glyph, rows] of Object.entries(GLYPH_PIXELS)) {
      expect(rows, glyph).toHaveLength(GLYPH_H)
      for (const row of rows) expect(row, glyph).toHaveLength(GLYPH_W)
    }
  })

  it('falls back rather than throwing on a phase it does not know', () => {
    expect(badgeFor('teleporting')).toEqual(BADGES.idle)
    expect(glyphPixels('no-such-glyph')).toEqual([])
  })
})

describe('status is legible without colour (§8)', () => {
  it('gives no two phases the same shape', () => {
    const shapes = new Map<string, AvatarPhase>()
    for (const phase of BADGED_PHASES) {
      const shape = JSON.stringify(glyphPixels(BADGES[phase].glyph))
      const clash = shapes.get(shape)
      expect(clash, `${phase} and ${String(clash)} draw the same glyph`).toBeUndefined()
      shapes.set(shape, phase)
    }
  })

  it('gives no two phases the same word', () => {
    const labels = BADGED_PHASES.map((phase) => BADGES[phase].label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('separates every pair that shares a status colour', () => {
    const collisions: [AvatarPhase, AvatarPhase][] = []
    for (const a of BADGED_PHASES) {
      for (const b of BADGED_PHASES) {
        if (a >= b) continue
        if (PHASE_COLOR[a] === PHASE_COLOR[b]) collisions.push([a, b])
      }
    }
    collisions.sort((x, y) => x.join().localeCompare(y.join()))
    // The three the palette actually collides on. Named so that adding a
    // fourth collision without a distinct glyph fails here rather than
    // silently passing the loop below.
    expect(collisions).toEqual([
      ['alert', 'thinking'],
      ['archived', 'ghost'],
      ['blocked', 'stopped']
    ])
    for (const [a, b] of collisions) {
      expect(glyphPixels(BADGES[a].glyph), `${a} vs ${b}`).not.toEqual(glyphPixels(BADGES[b].glyph))
      expect(BADGES[a].label).not.toBe(BADGES[b].label)
    }
  })

  it('separates the two pairs the floor asks about most', () => {
    // `idle` vs `waiting` (at desk vs stalled on someone) and `alert` vs
    // `thinking` are the readings the Architect makes at a glance.
    expect(BADGES.idle.glyph).not.toBe(BADGES.waiting.glyph)
    expect(BADGES.alert.glyph).not.toBe(BADGES.thinking.glyph)
  })
})

describe('the census puts the floor into words (NFR-15)', () => {
  it('says so when the floor is empty', () => {
    expect(floorCensus([])).toMatch(/nobody/)
  })

  it('counts by phase, in words', () => {
    const line = floorCensus(['working', 'working', 'blocked'])
    expect(line).toContain('3 on the terraces')
    expect(line).toContain('2 working')
    expect(line).toContain('1 blocked at a gate')
  })

  it('reads the same for the same company, whatever order it arrives in', () => {
    expect(floorCensus(['blocked', 'working', 'idle'])).toBe(
      floorCensus(['idle', 'blocked', 'working'])
    )
  })

  it('orders by the §6 state list rather than by count', () => {
    const line = floorCensus(['blocked', 'idle', 'idle'])
    expect(line.indexOf('idle')).toBeLessThan(line.indexOf('blocked at a gate'))
  })

  it('does not invent a state for a phase it cannot read', () => {
    expect(floorCensus(['teleporting'])).toContain('1 idle')
  })
})

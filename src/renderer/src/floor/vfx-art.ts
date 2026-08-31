import {
  ENVELOPE_H,
  ENVELOPE_W,
  PARTICLES,
  type ParticleSystem,
  type TokenKind
} from '../../../shared/vfx'
import { tokens } from '../tokens'

/**
 * The pixels for UI-DESIGN §5.3, §5.5 and §5.6 — the shapes only.
 *
 * `shared/vfx.ts` decides whether an effect exists and what it means; this
 * module decides what it looks like, and it is the only place a colour token
 * becomes a number. Keeping the two apart is what lets the shared model stay
 * free of hex values (invariant §12) while the floor still paints in the §2
 * palette.
 */

export interface VfxRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly color: number
}

/**
 * Contract: a §2 token name to its numeric value. Unknown names resolve to
 * `ink-900` rather than throwing — a missing colour must not take the floor
 * down, and ink is the one value that reads against every tile.
 */
export function colorOf(token: string): number {
  const value = (tokens as Readonly<Record<string, number>>)[token]
  return typeof value === 'number' ? value : tokens.ink900
}

/**
 * §5.3's tokens, drawn. Each is 6–8 px and carried at hand height; the shapes
 * are the ones the table names — a folded scroll, a wax tablet, an amphora, an
 * integration diamond, a tally with three ticks.
 */
export function tokenSprite(kind: TokenKind): readonly VfxRect[] {
  switch (kind) {
    case 'scroll':
      // Folded papyrus: marble body, ink-700 furl.
      return [
        { x: 0, y: 0, w: 6, h: 8, color: tokens.marble50 },
        { x: 0, y: 0, w: 6, h: 2, color: tokens.ink700 },
        { x: 0, y: 6, w: 6, h: 2, color: tokens.ink700 }
      ]
    case 'tablet':
      // Wax tablet with a prompt mark.
      return [
        { x: 0, y: 0, w: 8, h: 6, color: tokens.ink900 },
        { x: 1, y: 2, w: 2, h: 1, color: tokens.marble50 },
        { x: 4, y: 4, w: 3, h: 1, color: tokens.marble50 }
      ]
    case 'amphora':
      return [
        { x: 2, y: 0, w: 2, h: 2, color: tokens.aegeanLight },
        { x: 1, y: 2, w: 4, h: 4, color: tokens.aegean },
        { x: 2, y: 6, w: 2, h: 2, color: tokens.aegeanLight }
      ]
    case 'diamond':
      return [
        { x: 2, y: 0, w: 2, h: 2, color: tokens.iris },
        { x: 0, y: 2, w: 6, h: 2, color: tokens.iris },
        { x: 2, y: 4, w: 2, h: 2, color: tokens.iris }
      ]
    case 'tally':
      // Three tick marks — the §5.3 table's own detail.
      return [
        { x: 0, y: 0, w: 8, h: 6, color: tokens.olive },
        { x: 2, y: 1, w: 1, h: 4, color: tokens.ink900 },
        { x: 4, y: 1, w: 1, h: 4, color: tokens.ink900 },
        { x: 6, y: 1, w: 1, h: 4, color: tokens.ink900 }
      ]
  }
}

/**
 * §5.5's 8×6 envelope, in the act's colour. The flap is drawn in ink so the
 * envelope reads as an envelope against a same-coloured tile — the same
 * silhouette lesson the citizens taught in M6.1.
 */
export function envelopeSprite(color: number, wobble: boolean, step: number): readonly VfxRect[] {
  // A refusal or bounce wobbles on landing: one pixel of tilt, alternating.
  const tilt = wobble && step % 2 === 1 ? 1 : 0
  return [
    { x: 0, y: tilt, w: ENVELOPE_W, h: ENVELOPE_H, color },
    { x: 0, y: tilt, w: ENVELOPE_W, h: 1, color: tokens.ink900 },
    { x: 3, y: tilt + 1, w: 2, h: 2, color: tokens.ink900 }
  ]
}

/**
 * §5.6's three systems, drawn. Each takes the frame it is on, which came from
 * elapsed time since the logged event that fired it — so a particle cannot
 * outlive its fact.
 */
export function particleSprite(system: ParticleSystem, frame: number): readonly VfxRect[] {
  const spec = PARTICLES[system]
  switch (system) {
    case 'sparkle': {
      // Four pixel stars rising from the desk over 250 ms.
      const rise = frame
      return Array.from({ length: spec.count }, (_, i) => ({
        x: i * 3 - 4,
        y: -rise - i,
        w: 1,
        h: 1,
        color: tokens.gold
      }))
    }
    case 'dust': {
      // Three arcing dots at the feet on arrival.
      return Array.from({ length: spec.count }, (_, i) => ({
        x: i * 4 - 4,
        y: -Math.min(frame, 2) + (i % 2),
        w: 1,
        h: 1,
        color: tokens.marble300
      }))
    }
    case 'tray-pulse':
      // "the tray flag scales +1 px, one frame" — the flag itself is drawn by
      // the station art; this is the one extra pixel, and only on the pulse.
      return frame === 0 ? [{ x: 0, y: -1, w: 1, h: 1, color: tokens.gold }] : []
  }
}

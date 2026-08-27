import { AVATAR_STATES, AVATAR_TERMINALS, type AvatarPhase } from './avatar'

/**
 * Status badges — the double encoding UI-DESIGN §8 requires:
 * "All status colors double-encoded (icon shape or label — never color alone)."
 *
 * From M1 the floor drew a coloured rectangle above each citizen and nothing
 * else, so `alert` and `thinking` (both `status-thinking`), `ghost` and
 * `archived` (both `status-ghost`), and `blocked` and `stopped` (both
 * `status-blocked`) were indistinguishable to anyone reading by shape — and all
 * ten states were indistinguishable to anyone not reading colour at all. M3
 * makes `waiting`, `blocked` and `looping` reachable for the first time
 * (gates, the breaker), which is what makes this owed now.
 *
 * The glyphs are 3×5 pixel matrices rather than text because the floor is Pixi
 * and a font there would be a second type system for one character. They are
 * pure data, so the §8 property — distinguishable without colour — is a unit
 * test rather than an eyeball.
 */

export interface Badge {
  /** A 3×5 pixel matrix key, drawn beside the colour on the floor. */
  readonly glyph: string
  /** The same fact in words, for the census line and any screen reader. */
  readonly label: string
}

/**
 * One badge per SDD §6 phase, including the two terminals. Glyphs are chosen so
 * that phases sharing a status colour never share a shape — see the test.
 */
export const BADGES: Readonly<Record<AvatarPhase, Badge>> = {
  idle: { glyph: 'dot', label: 'idle' },
  alert: { glyph: 'bang', label: 'alert' },
  thinking: { glyph: 'query', label: 'thinking' },
  working: { glyph: 'cross', label: 'working' },
  waiting: { glyph: 'ellipsis', label: 'waiting' },
  blocked: { glyph: 'ex', label: 'blocked at a gate' },
  success: { glyph: 'check', label: 'done' },
  ghost: { glyph: 'wave', label: 'ghost' },
  compacting: { glyph: 'box', label: 'compacting' },
  looping: { glyph: 'ring', label: 'breaker tripped' },
  stopped: { glyph: 'block', label: 'stopped' },
  archived: { glyph: 'slash', label: 'archived' }
}

/** Contract: the badge for a phase; an unknown phase reads as `idle`. */
export function badgeFor(phase: string): Badge {
  return BADGES[phase as AvatarPhase] ?? BADGES.idle
}

/**
 * 3×5 matrices, top row first. `#` is ink, `.` is transparent — small enough to
 * sit beside a 12px badge and still be a shape rather than a smudge.
 */
export const GLYPH_PIXELS: Readonly<Record<string, readonly string[]>> = {
  dot: ['...', '...', '.#.', '...', '...'],
  bang: ['.#.', '.#.', '.#.', '...', '.#.'],
  query: ['##.', '..#', '.#.', '...', '.#.'],
  cross: ['...', '.#.', '###', '.#.', '...'],
  ellipsis: ['...', '...', '...', '...', '#.#'],
  ex: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  check: ['...', '..#', '..#', '#.#', '.#.'],
  wave: ['...', '##.', '.##', '...', '...'],
  box: ['###', '#.#', '###', '...', '...'],
  ring: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  block: ['###', '###', '###', '###', '###'],
  slash: ['..#', '..#', '.#.', '#..', '#..']
}

export const GLYPH_W = 3
export const GLYPH_H = 5

export interface GlyphPixel {
  readonly x: number
  readonly y: number
}

/**
 * Contract: the lit pixels of a glyph, as offsets from its top-left. An unknown
 * glyph draws nothing rather than throwing — a missing badge must not take the
 * floor down with it.
 */
export function glyphPixels(glyph: string): readonly GlyphPixel[] {
  const rows = GLYPH_PIXELS[glyph]
  if (!rows) return []
  const pixels: GlyphPixel[] = []
  rows.forEach((line, y) => {
    for (let x = 0; x < line.length; x += 1) {
      if (line[x] === '#') pixels.push({ x, y })
    }
  })
  return pixels
}

/** Every phase the floor can be asked to draw. */
export const BADGED_PHASES: readonly AvatarPhase[] = [...AVATAR_STATES, ...AVATAR_TERMINALS]

/**
 * Contract: one line naming who is on the floor and in what state, in words.
 *
 * This is the `aria-label` the canvas carries: a `<canvas>` is opaque to a
 * screen reader, so without it the floor's whole information content is
 * unavailable to anyone not looking at pixels — which is the same §8 failure as
 * colour-only status, one layer up. Ordered by the §6 state list so the same
 * company always reads the same way.
 */
export function floorCensus(phases: Iterable<string>): string {
  const counts = new Map<string, number>()
  let total = 0
  for (const phase of phases) {
    const key = phase in BADGES ? phase : 'idle'
    counts.set(key, (counts.get(key) ?? 0) + 1)
    total += 1
  }
  if (total === 0) return 'Terraces floor: nobody on the floor'
  const parts = BADGED_PHASES.filter((phase) => counts.has(phase)).map(
    (phase) => `${String(counts.get(phase))} ${BADGES[phase].label}`
  )
  return `Terraces floor: ${total} on the terraces — ${parts.join(', ')}`
}

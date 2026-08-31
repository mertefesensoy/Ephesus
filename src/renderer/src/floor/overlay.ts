import { AVATAR_STATES, AVATAR_TERMINALS, type AvatarPhase } from '../../../shared/avatar'

/**
 * Status overlays — UI-DESIGN §5.2, the 8×8 px marks that sit in the citizen's
 * head-room (rows 0–7, which §5.1 keeps clear of body pixels).
 *
 * The governing rule, and the reason this module has no state of its own:
 * **an overlay is a projection of an avatar state, never an animation with its
 * own opinion.** §5.2 says the overlays are "driven ONLY by the SDD §6 avatar
 * machine", so:
 *
 * - the *which* comes from `AvatarPhase` alone (`overlayFor`), and
 * - the *when* comes from how long that phase has been current
 *   (`overlayFrame(spec, nowMs - snapshot.sinceMs)`) — an event-plane fact,
 *   since `sinceMs` is stamped by main when the phase began.
 *
 * Nothing here holds a timer, a counter or a previous frame. That is NFR-13's
 * spirit in the vfx layer: replay `log.jsonl`, get the same avatar snapshots,
 * and the same overlay is on screen at the same moment. A renderer-owned
 * `setInterval` would break that, and would also keep animating after the
 * events stopped — motion that means nothing, which §1.2 cuts.
 *
 * Pure: 8×8 pixel matrices, so §8's "never colour alone" and the frame counts
 * are unit tests rather than eyeballs.
 */

/** §5.2: the overlay grid is 8×8, one overlay at a time. */
export const OVERLAY_PX = 8

/**
 * The overlay kinds §5.2 names. `token` is the `working` row — the citizen
 * holds the §5.3 carrying token for the tool class in use — and `none` is the
 * three rows that say "none" out loud (`idle`, `alert`, `ghost`).
 */
export const OVERLAY_KINDS = [
  'none',
  'dots',
  'token',
  'sandglass',
  'bang',
  'starburst',
  'spiral',
  'box'
] as const

export type OverlayKind = (typeof OVERLAY_KINDS)[number]

export interface OverlaySpec {
  readonly kind: OverlayKind
  /** Frames in the cycle; 0 for `none`. */
  readonly frames: number
  /** Milliseconds per frame; 0 for `none`. */
  readonly frameMs: number
  /**
   * True when the cycle runs once and stops rather than looping — §5.2's
   * `success` row ("star burst in gold, then gone").
   */
  readonly once: boolean
  /**
   * Sprite opacity while in this phase. §5.2 gives `ghost` "none — sprite at
   * 50 % opacity": the ghost's overlay *is* the fade, so it belongs here rather
   * than as a magic number in the canvas.
   */
  readonly opacity: number
}

const LOOP = (kind: OverlayKind, frames: number, frameMs: number): OverlaySpec => ({
  kind,
  frames,
  frameMs,
  once: false,
  opacity: 1
})

const NONE: OverlaySpec = { kind: 'none', frames: 0, frameMs: 0, once: false, opacity: 1 }

/**
 * §5.2's table, transcribed. Total over every `AvatarPhase` — the ten SDD §6
 * states plus the two terminals, which the table does not list because an
 * avatar in either has left the floor: `stopped` shows nothing (the citizen is
 * still drawn, still badged) and `archived` is not drawn at all.
 *
 * `working`'s pixels come from §5.3's tool-class token, which M6.3 supplies;
 * `overlayPixels` returns nothing for `token` until then rather than inventing
 * a placeholder mark. The status badge (`shared/badges.ts`) still names the
 * phase in shape and in the census either way, so no information is lost.
 */
export const OVERLAYS: Readonly<Record<AvatarPhase, OverlaySpec>> = {
  idle: NONE,
  alert: NONE,
  thinking: LOOP('dots', 3, 200),
  working: LOOP('token', 2, 400),
  waiting: LOOP('sandglass', 2, 400),
  blocked: LOOP('bang', 2, 300),
  // "star burst in gold, then gone" — 4 frames, 250 ms total, so ~62 ms each,
  // which is also exactly SUCCESS_IDLE_MS: the burst ends as the state does.
  success: { kind: 'starburst', frames: 4, frameMs: 62, once: true, opacity: 1 },
  looping: LOOP('spiral', 2, 200),
  compacting: LOOP('box', 3, 300),
  ghost: { ...NONE, opacity: 0.5 },
  stopped: NONE,
  archived: { ...NONE, opacity: 0 }
}

/** Contract: the overlay for a phase; an unknown phase shows none. */
export function overlayFor(phase: string): OverlaySpec {
  return OVERLAYS[phase as AvatarPhase] ?? NONE
}

/**
 * Contract: which frame of `spec` is showing after `elapsedMs` in the phase, or
 * `null` when nothing is drawn — a `none` overlay, a negative elapsed, or a
 * one-shot cycle that has finished.
 *
 * Pure in elapsed time, so the same log replayed gives the same frame.
 */
export function overlayFrame(spec: OverlaySpec, elapsedMs: number): number | null {
  if (spec.frames <= 0 || spec.frameMs <= 0) return null
  const step = Math.floor(Math.max(elapsedMs, 0) / spec.frameMs)
  if (spec.once) return step >= spec.frames ? null : step
  return step % spec.frames
}

/**
 * §5.2 status colours (UI-DESIGN §2.4) for the overlays that name one. The rest
 * inherit ink so they read against any tile; `null` means "use the phase's
 * status colour", which the canvas already has.
 */
export const OVERLAY_TOKEN_COLOR: Readonly<Record<OverlayKind, 'status' | 'gold' | 'ink'>> = {
  none: 'ink',
  dots: 'ink',
  token: 'ink',
  sandglass: 'ink',
  // "`!` in status-blocked" and "tight spiral in status-looping" — both are the
  // phase's own status colour, which is what `status` selects.
  bang: 'status',
  starburst: 'gold',
  spiral: 'status',
  box: 'ink'
}

/**
 * 8×8 matrices, top row first: `#` is lit, `.` is transparent. One entry per
 * frame of the cycle, so `overlayPixels(kind)[frame]` is the whole animation.
 *
 * `token` is empty by design — §5.3's carrying tokens are M6.3's package, and a
 * placeholder mark here would be exactly the "invented motion" §5.4 forbids one
 * layer up: a shape that projects no fact.
 */
export const OVERLAY_FRAMES: Readonly<Record<OverlayKind, readonly (readonly string[])[]>> = {
  none: [],
  token: [],
  // Three dots cycling · ·· ···
  dots: [
    [
      '........',
      '........',
      '........',
      '........',
      '..#.....',
      '........',
      '........',
      '........'
    ],
    [
      '........',
      '........',
      '........',
      '........',
      '..#.#...',
      '........',
      '........',
      '........'
    ],
    ['........', '........', '........', '........', '..#.#.#.', '........', '........', '........']
  ],
  // Sand-glass, slow turn: full above, then run through.
  sandglass: [
    [
      '.######.',
      '.#....#.',
      '..####..',
      '...##...',
      '..#..#..',
      '.#....#.',
      '.######.',
      '........'
    ],
    ['.######.', '.#....#.', '..#..#..', '...##...', '..####..', '.#.##.#.', '.######.', '........']
  ],
  // `!` blinking.
  bang: [
    [
      '...##...',
      '...##...',
      '...##...',
      '...##...',
      '...##...',
      '........',
      '...##...',
      '........'
    ],
    ['........', '........', '........', '........', '........', '........', '........', '........']
  ],
  // Star burst: a point that opens and thins away.
  starburst: [
    [
      '........',
      '........',
      '...##...',
      '...##...',
      '........',
      '........',
      '........',
      '........'
    ],
    [
      '........',
      '...##...',
      '..####..',
      '..####..',
      '...##...',
      '........',
      '........',
      '........'
    ],
    [
      '...##...',
      '.#.##.#.',
      '..####..',
      '.######.',
      '..####..',
      '.#.##.#.',
      '...##...',
      '........'
    ],
    ['#..#..#.', '........', '#......#', '........', '#......#', '........', '#..#..#.', '........']
  ],
  // Tight spiral, two phases.
  spiral: [
    [
      '..####..',
      '.#....#.',
      '#..##..#',
      '#.#..#.#',
      '#.#..#.#',
      '#..##..#',
      '.#....#.',
      '..####..'
    ],
    ['..####..', '.######.', '##....##', '#..##..#', '#..##..#', '##....##', '.######.', '..####..']
  ],
  // Box lid closing.
  box: [
    [
      '##....##',
      '........',
      '........',
      '..####..',
      '.#....#.',
      '.#....#.',
      '.######.',
      '........'
    ],
    [
      '.##..##.',
      '........',
      '..####..',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '.######.',
      '........'
    ],
    ['..####..', '.######.', '.#....#.', '.#....#.', '.#....#.', '.#....#.', '.######.', '........']
  ]
}

export interface OverlayPixel {
  readonly x: number
  readonly y: number
}

/**
 * Contract: the lit pixels of one overlay frame, as offsets from the overlay's
 * top-left. An unknown kind or an out-of-range frame draws nothing rather than
 * throwing — a missing overlay must not take the floor down with it.
 */
export function overlayPixels(kind: OverlayKind, frame: number): readonly OverlayPixel[] {
  const rows = OVERLAY_FRAMES[kind]?.[frame]
  if (!rows) return []
  const pixels: OverlayPixel[] = []
  rows.forEach((line, y) => {
    for (let x = 0; x < line.length; x += 1) {
      if (line[x] === '#') pixels.push({ x, y })
    }
  })
  return pixels
}

/** Every phase the floor can be asked to overlay — the §6 states plus terminals. */
export const OVERLAID_PHASES: readonly AvatarPhase[] = [...AVATAR_STATES, ...AVATAR_TERMINALS]

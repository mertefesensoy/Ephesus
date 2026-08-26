/**
 * Procedural citizens (UI-DESIGN §7). Avatars are drawn, not licensed: no
 * likeness of a real person and no other IP's character can appear on this
 * floor, so every citizen is composed here from tunic/hair/skin recipes.
 *
 * The quality bar §7 sets is a real 8-direction walk cycle at 4 frames per
 * direction, distinct silhouettes per role, and at most five palette colors per
 * sprite. This module is pure — it returns rectangles, no canvas — so all three
 * of those are unit-testable instead of eyeballed.
 *
 * Eight directions from five authored views: front, back, side, front-side and
 * back-side, with the four westward directions mirrored. That is the standard
 * pixel-art construction, and it keeps each view hand-shaped rather than
 * interpolated into mush.
 */

export const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'] as const

export type Direction = (typeof DIRECTIONS)[number]

/** Four frames per direction: contact · down · pass · up. */
export const WALK_FRAMES = 4

export type WalkFrame = 0 | 1 | 2 | 3

/** Sprite footprint, UI-DESIGN §5: 32×48, drawn at 2× integer scale. */
export const CITIZEN_W = 32
export const CITIZEN_H = 48

/**
 * Role silhouettes. `orchestrator` is Artemis's alone — the docs single her out
 * with the temple seat and the reserved terracotta accent — and the rest are
 * assigned deterministically from the role string, so two agents with the same
 * role always look alike and different roles usually do not.
 */
export const SILHOUETTES = ['orchestrator', 'worker', 'scribe', 'runner', 'guard'] as const

export type Silhouette = (typeof SILHOUETTES)[number]

const ASSIGNABLE: readonly Silhouette[] = ['worker', 'scribe', 'runner', 'guard']

/** Contract: same role string → same silhouette, always. */
export function silhouetteFor(role: string): Silhouette {
  if (role === 'orchestrator') return 'orchestrator'
  let hash = 0
  for (let i = 0; i < role.length; i += 1) hash = (hash * 31 + role.charCodeAt(i)) >>> 0
  return ASSIGNABLE[hash % ASSIGNABLE.length] ?? 'worker'
}

/** Contract: the compass direction of a walk; `s` when standing still. */
export function directionFor(dx: number, dy: number): Direction {
  if (dx === 0 && dy === 0) return 's'
  const angle = Math.atan2(dy, dx) // screen coords: +y is down, i.e. south
  const octant = Math.round(angle / (Math.PI / 4))
  const byOctant: readonly Direction[] = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne']
  return byOctant[((octant % 8) + 8) % 8] ?? 's'
}

/** Contract: the walk frame for a stepped-easing step index. */
export function walkFrame(stepIndex: number): WalkFrame {
  return (((stepIndex % WALK_FRAMES) + WALK_FRAMES) % WALK_FRAMES) as WalkFrame
}

/** Exactly five slots — the §7 colour budget, all drawn from the §2 palette. */
export interface CitizenPalette {
  readonly outline: number
  readonly hair: number
  readonly skin: number
  readonly accent: number
  readonly detail: number
}

export interface SpriteRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly color: number
}

type View = 'front' | 'back' | 'side' | 'front-side' | 'back-side'

interface Facing {
  readonly view: View
  readonly mirror: boolean
}

const FACING: Readonly<Record<Direction, Facing>> = {
  s: { view: 'front', mirror: false },
  se: { view: 'front-side', mirror: false },
  e: { view: 'side', mirror: false },
  ne: { view: 'back-side', mirror: false },
  n: { view: 'back', mirror: false },
  nw: { view: 'back-side', mirror: true },
  w: { view: 'side', mirror: true },
  sw: { view: 'front-side', mirror: true }
}

/** Vertical leg offsets per frame: contact · down · pass · up. */
const LEG_SWING: readonly [number, number][] = [
  [0, 0],
  [2, -1],
  [0, 0],
  [-1, 2]
]

/** Body bob, one pixel, on the down and up frames only. */
const BODY_BOB: readonly number[] = [0, 1, 0, 1]

function silhouetteExtras(
  silhouette: Silhouette,
  view: View,
  palette: CitizenPalette,
  bob: number
): SpriteRect[] {
  const detail = palette.detail
  switch (silhouette) {
    case 'orchestrator':
      return [
        // Laurel band and a long robe that flares below the tunic.
        { x: 7, y: 2 + bob, w: 18, h: 2, color: detail },
        { x: 5, y: 32 + bob, w: 22, h: 8, color: palette.accent },
        { x: 5, y: 39 + bob, w: 22, h: 2, color: detail }
      ]
    case 'worker':
      return [
        // Tool belt, and a satchel on the hip when seen from the side.
        { x: 6, y: 28 + bob, w: 20, h: 3, color: detail },
        ...(view === 'side' || view === 'front-side'
          ? [{ x: 22, y: 26 + bob, w: 6, h: 8, color: detail }]
          : [])
      ]
    case 'scribe':
      return [
        // A scroll carried under the arm; longer tunic hem.
        { x: view === 'back' ? 4 : 22, y: 22 + bob, w: 7, h: 4, color: detail },
        { x: 6, y: 32 + bob, w: 20, h: 3, color: detail }
      ]
    case 'runner':
      return [
        // Headband, bare arms, short hem.
        { x: 7, y: 4 + bob, w: 18, h: 2, color: detail },
        { x: 8, y: 30 + bob, w: 16, h: 2, color: detail }
      ]
    case 'guard':
      return [
        // Crested helm and shoulder guards — the broadest silhouette.
        { x: 6, y: -2 + bob, w: 20, h: 6, color: detail },
        { x: 14, y: -6 + bob, w: 4, h: 5, color: palette.accent },
        { x: 3, y: 14 + bob, w: 26, h: 4, color: detail }
      ]
  }
}

function head(view: View, palette: CitizenPalette, bob: number): SpriteRect[] {
  const rects: SpriteRect[] = [{ x: 8, y: 4 + bob, w: 16, h: 12, color: palette.skin }]
  if (view === 'back' || view === 'back-side') {
    // Seen from behind, the head is all hair — a three-quarter back view also
    // shows the near ear, which is what separates it from a straight back.
    rects[0] = { x: 8, y: 4 + bob, w: 16, h: 12, color: palette.hair }
    if (view === 'back-side') rects.push({ x: 21, y: 9 + bob, w: 3, h: 3, color: palette.skin })
  } else {
    rects.push({ x: 8, y: 2 + bob, w: 16, h: 4, color: palette.hair })
    // Eyes, in outline ink — dropped on the side view, where only one would show.
    if (view === 'front') {
      rects.push({ x: 12, y: 9 + bob, w: 2, h: 2, color: palette.outline })
      rects.push({ x: 18, y: 9 + bob, w: 2, h: 2, color: palette.outline })
    } else {
      rects.push({ x: 18, y: 9 + bob, w: 2, h: 2, color: palette.outline })
    }
  }
  return rects
}

function torso(view: View, palette: CitizenPalette, bob: number): SpriteRect[] {
  // A body turned away from the camera is narrower: full width face-on, three
  // quarters on the diagonals, narrowest in profile.
  const narrow = view === 'side'
  const threeQuarter = view === 'front-side' || view === 'back-side'
  const x = narrow ? 9 : threeQuarter ? 8 : 6
  const w = narrow ? 14 : threeQuarter ? 17 : 20
  return [
    { x, y: 16 + bob, w, h: 16, color: palette.accent },
    { x, y: 16 + bob, w, h: 1, color: palette.outline }
  ]
}

function arms(view: View, palette: CitizenPalette, frame: WalkFrame, bob: number): SpriteRect[] {
  const swing = LEG_SWING[frame] ?? [0, 0]
  if (view === 'side') {
    // One arm visible, counter-swinging the near leg.
    return [{ x: 18, y: 18 + bob - (swing[0] ?? 0), w: 5, h: 12, color: palette.skin }]
  }
  return [
    { x: 3, y: 18 + bob + (swing[1] ?? 0), w: 4, h: 12, color: palette.skin },
    { x: 25, y: 18 + bob + (swing[0] ?? 0), w: 4, h: 12, color: palette.skin }
  ]
}

function legs(view: View, palette: CitizenPalette, frame: WalkFrame, bob: number): SpriteRect[] {
  const swing = LEG_SWING[frame] ?? [0, 0]
  const [left, right] = [swing[0] ?? 0, swing[1] ?? 0]
  if (view === 'side') {
    return [
      { x: 10, y: 32 + bob, w: 5, h: 14 - left, color: palette.outline },
      { x: 17, y: 32 + bob, w: 5, h: 14 - right, color: palette.hair }
    ]
  }
  return [
    { x: 9, y: 32 + bob, w: 5, h: 14 - left, color: palette.outline },
    { x: 18, y: 32 + bob, w: 5, h: 14 - right, color: palette.outline }
  ]
}

/**
 * Contract: the rectangles for one citizen frame, in draw order, all inside the
 * 32×48 footprint. Pure — same arguments, same rectangles — and never more than
 * the five palette colors (§7).
 */
export function citizenSprite(opts: {
  readonly direction: Direction
  readonly frame: WalkFrame
  readonly silhouette: Silhouette
  readonly palette: CitizenPalette
  /** Standing citizens use the contact frame and do not bob. */
  readonly walking: boolean
}): readonly SpriteRect[] {
  const facing = FACING[opts.direction]
  const frame = opts.walking ? opts.frame : 0
  const bob = opts.walking ? (BODY_BOB[frame] ?? 0) : 0

  const rects: SpriteRect[] = [
    ...legs(facing.view, opts.palette, frame, bob),
    ...torso(facing.view, opts.palette, bob),
    ...arms(facing.view, opts.palette, frame, bob),
    ...head(facing.view, opts.palette, bob),
    ...silhouetteExtras(opts.silhouette, facing.view, opts.palette, bob)
  ]

  if (!facing.mirror) return rects
  return rects.map((rect) => ({ ...rect, x: CITIZEN_W - rect.x - rect.w }))
}

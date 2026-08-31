/**
 * Procedural citizens — UI-DESIGN §5.1, the normative sprite specification.
 *
 * Characters are DRAWN, never licensed: the purchased packs' character sets and
 * the Character Generator are deliberately unused (Architect decision
 * 2026-08-29; ATTRIBUTION rule 3), so no likeness of a real person and no other
 * IP's character can appear on this floor. Every citizen is composed here from
 * tunic/hair/skin recipes.
 *
 * §5.1 makes the §7 quality bar exact, and three of its clauses are the reason
 * this module looks the way it does:
 *
 * 1. **Eight DRAWN directions.** The diagonals are frames, not runtime flips. A
 *    flip breaks asymmetric silhouettes — a satchel worn on one shoulder, a
 *    scroll case slung across one side — by teleporting the prop to the other
 *    side of the body whenever the citizen turns. So there is no mirror table
 *    here: each direction owns a row in VIEWS, and props attach to a *drawn*
 *    side that the view names.
 * 2. **Rows 0–7 are head-room**, reserved for the §5.2 overlays. No body
 *    rectangle may enter them, at any bob phase — asserted in the tests.
 * 3. **The feet own the bottom 4 rows** (44–47) and stay planted. The ±1 px bob
 *    lifts the *body* against planted feet, which is both what a walk actually
 *    looks like and what keeps the sprite inside its 48 px cell.
 *
 * Pure on purpose — it returns rectangles, not draw calls — so the frame count,
 * the colour budget, the head-room reservation and the anti-flip property are
 * unit tests instead of eyeballs.
 */

export const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'] as const

export type Direction = (typeof DIRECTIONS)[number]

/** §5.1: four frames per direction — idle · step-A · idle · step-B. */
export const WALK_FRAMES = 4

export type WalkFrame = 0 | 1 | 2 | 3

/**
 * §5.1: 125 ms per frame, stepped. Against §6's 250 ms tile walk that is
 * exactly two frames per tile, so a citizen never slides between poses.
 */
export const FRAME_MS = 125
/** Two frames per 250 ms tile — the §5.1 clause, as a number the floor uses. */
export const FRAMES_PER_TILE = 2

/** §5.1 cell: 32×48 on the 32×32 tile grid. */
export const CITIZEN_W = 32
export const CITIZEN_H = 48

/** Rows 0–7 belong to the §5.2 overlays; the body starts at row 8. */
export const HEADROOM_ROWS = 8
/** The feet own the bottom four rows and stay planted through the bob. */
export const FOOT_ROWS = 4
export const FOOT_TOP = CITIZEN_H - FOOT_ROWS

/**
 * Role silhouettes — §5.1's table. Identity is shape first, colour second,
 * which is what keeps characters procedural without making them anonymous.
 * `orchestrator` is Artemis's alone (the reserved terracotta accent goes with
 * it); the other five are the roles the company actually staffs.
 */
export const SILHOUETTES = [
  'orchestrator',
  'scribe',
  'builder',
  'researcher',
  'watch',
  'herald'
] as const

export type Silhouette = (typeof SILHOUETTES)[number]

/** The five a role string may be assigned to; the sixth is Artemis's alone. */
const ASSIGNABLE: readonly Silhouette[] = ['scribe', 'builder', 'researcher', 'watch', 'herald']

/**
 * Exact role vocabulary → silhouette, drawn from §5.1's own cell names ("Scribe
 * / docs", "Builder / code", "Researcher (Stoa)", "Watch / safety", "Herald /
 * voice") plus the two role strings the company already uses in code.
 *
 * Exact equality, never a substring test: a hire named "process-improver-docs"
 * matching on "docs" is the same defect class the M5b close-out audit found in
 * isImprovementRole, one domain over. An unlisted role falls to the hash below,
 * which is deterministic and total — an unknown role gets a stable silhouette
 * rather than a guess dressed up as a match.
 */
export const ROLE_SILHOUETTES: Readonly<Record<string, Silhouette>> = {
  orchestrator: 'orchestrator',
  artemis: 'orchestrator',
  scribe: 'scribe',
  docs: 'scribe',
  builder: 'builder',
  code: 'builder',
  engineer: 'builder',
  researcher: 'researcher',
  stoa: 'researcher',
  watch: 'watch',
  safety: 'watch',
  herald: 'herald',
  voice: 'herald'
}

/** Contract: same role string → same silhouette, always. Total over any string. */
export function silhouetteFor(role: string): Silhouette {
  const known = ROLE_SILHOUETTES[role.trim().toLowerCase()]
  if (known) return known
  let hash = 0
  for (let i = 0; i < role.length; i += 1) hash = (hash * 31 + role.charCodeAt(i)) >>> 0
  return ASSIGNABLE[hash % ASSIGNABLE.length] ?? 'builder'
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

/**
 * Contract: the frame a walk is on after `elapsedMs`, sampled at 125 ms
 * boundaries. §5.1 requires the bob be sampled at frame boundaries *only* —
 * never a render-time sine — so this is the single clock the sprite reads, and
 * it is a pure function of elapsed time rather than of when a frame happened to
 * be drawn.
 */
export function frameAt(elapsedMs: number): WalkFrame {
  return walkFrame(Math.floor(Math.max(elapsedMs, 0) / FRAME_MS))
}

/** §5.1: five slots — skin, hair, primary (the agent's §2.3 accent), secondary, outline. */
export interface CitizenPalette {
  /** Always ink-900 (§5.1). The outline is part of the five, not extra. */
  readonly outline: number
  readonly hair: number
  readonly skin: number
  /** The agent's §2.3 citizen accent; terracotta is Artemis's alone. */
  readonly primary: number
  /** Tunic trim, and the material every silhouette prop is cut from. */
  readonly secondary: number
}

export interface SpriteRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly color: number
}

/**
 * One drawn direction. There is no `mirror` field on purpose: §5.1 forbids
 * runtime flips, so every direction states its own geometry, including which
 * side of the body faces the viewer (`propSide`) so an asymmetric prop stays on
 * the shoulder it is actually worn on.
 */
interface View {
  /** Torso left edge and width — narrowest in profile, widest face-on. */
  readonly torsoX: number
  readonly torsoW: number
  readonly headX: number
  readonly headW: number
  /** True when the citizen is seen from behind: the head reads as hair. */
  readonly back: boolean
  /** Eye columns, empty from behind and single in profile. */
  readonly eyes: readonly number[]
  /** Visible arms, as left edges. Profile shows one. */
  readonly arms: readonly number[]
  /** Left edges of the two legs/feet. */
  readonly legs: readonly [number, number]
  /**
   * Which side of the body faces the viewer, so an asymmetric prop lands where
   * it is actually worn: `-1` = screen-left, `+1` = screen-right, `0` = centred
   * (the face-on and straight-back views).
   */
  readonly propSide: -1 | 0 | 1
  /**
   * Which side of the head carries the extra hair mass — the back of the
   * skull. `-1` when the citizen faces east (the skull is screen-left), `+1`
   * facing west, `0` face-on. It is the strongest directional cue at 32 px:
   * without it a profile reads as a slightly narrow front view.
   */
  readonly hairSide: -1 | 0 | 1
  /** True when props worn on the back are visible (n, ne, nw). */
  readonly backProps: boolean
  /** True when props worn on the chest are visible (s, se, sw). */
  readonly frontProps: boolean
}

/**
 * Eight authored views. Read down the columns and the flip is visibly absent:
 * `e` and `w` differ in head offset, torso width, arm placement and leg
 * spacing, and `se`/`sw` and `ne`/`nw` likewise — none is the arithmetic
 * negation of another, which is the property the anti-flip test checks.
 *
 * Every x is inset at least 1 px from the cell edge, because the silhouette
 * outline is a 1 px ink backing behind each part (see `backing`).
 */
const VIEWS: Readonly<Record<Direction, View>> = {
  s: {
    headX: 10,
    headW: 12,
    torsoX: 8,
    torsoW: 16,
    back: false,
    eyes: [13, 18],
    arms: [5, 24],
    legs: [10, 17],
    propSide: 0,
    hairSide: 0,
    backProps: false,
    frontProps: true
  },
  se: {
    headX: 11,
    headW: 11,
    torsoX: 9,
    torsoW: 14,
    back: false,
    eyes: [17],
    arms: [6, 23],
    legs: [11, 17],
    propSide: 1,
    hairSide: -1,
    backProps: false,
    frontProps: true
  },
  e: {
    headX: 12,
    headW: 10,
    torsoX: 11,
    torsoW: 11,
    back: false,
    eyes: [19],
    arms: [17],
    legs: [12, 16],
    propSide: 1,
    hairSide: -1,
    backProps: false,
    frontProps: false
  },
  ne: {
    headX: 11,
    headW: 11,
    torsoX: 9,
    torsoW: 14,
    back: true,
    eyes: [],
    arms: [7, 22],
    legs: [11, 17],
    propSide: 1,
    hairSide: -1,
    backProps: true,
    frontProps: false
  },
  n: {
    headX: 10,
    headW: 12,
    torsoX: 8,
    torsoW: 16,
    back: true,
    eyes: [],
    arms: [5, 24],
    legs: [10, 17],
    propSide: 0,
    hairSide: 0,
    backProps: true,
    frontProps: false
  },
  nw: {
    headX: 9,
    headW: 11,
    torsoX: 8,
    torsoW: 14,
    back: true,
    eyes: [],
    arms: [4, 20],
    legs: [9, 15],
    propSide: -1,
    hairSide: 1,
    backProps: true,
    frontProps: false
  },
  w: {
    headX: 9,
    headW: 10,
    torsoX: 9,
    torsoW: 11,
    back: false,
    eyes: [11],
    arms: [13],
    legs: [11, 15],
    propSide: -1,
    hairSide: 1,
    backProps: false,
    frontProps: false
  },
  sw: {
    headX: 9,
    headW: 11,
    torsoX: 8,
    torsoW: 14,
    back: false,
    eyes: [12],
    arms: [6, 21],
    legs: [9, 15],
    propSide: -1,
    hairSide: 1,
    backProps: false,
    frontProps: true
  }
}

/**
 * Vertical band layout — §5.1's anatomy, once, so nothing drifts. The head
 * starts at row 10 rather than at the head-room boundary because a -1 px bob
 * AND the 1 px outline backing must both still land inside the body band:
 * 10 - 1 - 1 = 8, exactly the first row §5.1 allows a body pixel.
 */
const HEAD_Y = 10
const HEAD_H = 11
/** The hair cap: the top rows of the head, which is what gives it a hairline. */
const HAIR_H = 4
const NECK_Y = 21
const NECK_H = 2
const NECK_W = 4
const TORSO_Y = 23
const TORSO_H = 13
/** The tunic hem, in trim — it is what makes the torso read as cloth. */
const HEM_H = 2
const ARM_Y = 24
const ARM_H = 10
/** The hand: the bottom rows of the arm, in skin, below the sleeve. */
const HAND_H = 4
const ARM_W = 3
const LEG_Y = 36
const LEG_H = FOOT_TOP - LEG_Y
const LEG_W = 5

/**
 * ±1 px, phased with the foot cycle: level on the two idle frames, up on
 * step-A, down on step-B. Sampled at frame boundaries only (§5.1) because it is
 * indexed by the frame, not by a clock.
 */
const BODY_BOB: readonly number[] = [0, -1, 0, 1]

/** Foot separation per frame: together · left forward · together · right forward. */
const FOOT_STEP: readonly [number, number][] = [
  [0, 0],
  [-2, 1],
  [0, 0],
  [1, -2]
]

/**
 * The 1 px ink silhouette.
 *
 * Pixel art reads by its outline, and the first M6.1 render proved the point
 * the hard way: `skin` is `sand`, which is exactly the terrace fill, so an
 * un-outlined citizen dissolved into the floor it stood on. A backing
 * rectangle one pixel larger on every side fixes it in the general case — any
 * tile, any pack — rather than by re-picking one colour.
 *
 * All backings are drawn before all fills, so the outline comes out continuous
 * around the whole figure instead of appearing as seams between parts.
 */
function backing(rect: SpriteRect, outline: number): SpriteRect {
  return {
    x: rect.x - 1,
    y: rect.y - 1,
    w: rect.w + 2,
    h: rect.h + 2,
    color: outline
  }
}

function head(view: View, palette: CitizenPalette, bob: number): SpriteRect[] {
  const y = HEAD_Y + bob
  if (view.back) {
    // From behind the head is all hair; a three-quarter back also shows the
    // near ear, which is what separates `ne`/`nw` from a straight `n`.
    const rects: SpriteRect[] = [
      { x: view.headX, y, w: view.headW, h: HEAD_H, color: palette.hair }
    ]
    if (view.propSide !== 0) {
      const earX = view.propSide === 1 ? view.headX + view.headW - 2 : view.headX
      rects.push({ x: earX, y: y + 4, w: 2, h: 3, color: palette.skin })
    }
    return rects
  }
  return [
    // Face, then the hair cap over it, then the eyes: a hairline rather than a
    // slab sitting on top of a box.
    { x: view.headX, y, w: view.headW, h: HEAD_H, color: palette.skin },
    { x: view.headX, y, w: view.headW, h: HAIR_H, color: palette.hair },
    // The skull's hair mass, on the side turned away from the viewer, and a
    // 1 px sideburn on the face side. This asymmetry is what makes a profile
    // read as a profile at 32 px — and it is a second reason a runtime flip
    // would be wrong: a flip would carry the back of the head round to the
    // front.
    {
      x: view.hairSide === 1 ? view.headX + view.headW - 3 : view.headX,
      y,
      w: view.hairSide === 0 ? 1 : 3,
      h: view.hairSide === 0 ? HAIR_H + 2 : HEAD_H,
      color: palette.hair
    },
    {
      x: view.hairSide === 1 ? view.headX : view.headX + view.headW - 1,
      y,
      w: 1,
      h: HAIR_H + 2,
      color: palette.hair
    },
    ...view.eyes.map((eye) => ({
      x: eye,
      y: y + 6,
      w: 1,
      h: 2,
      color: palette.outline
    }))
  ]
}

function neck(view: View, palette: CitizenPalette, bob: number): SpriteRect[] {
  return [
    {
      x: view.headX + Math.floor((view.headW - NECK_W) / 2),
      y: NECK_Y + bob,
      w: NECK_W,
      h: NECK_H,
      color: palette.skin
    }
  ]
}

function torso(view: View, palette: CitizenPalette, bob: number): SpriteRect[] {
  const y = TORSO_Y + bob
  return [
    { x: view.torsoX, y, w: view.torsoW, h: TORSO_H, color: palette.primary },
    // The hem, in trim — a tunic, not a filled rectangle.
    {
      x: view.torsoX,
      y: y + TORSO_H - HEM_H,
      w: view.torsoW,
      h: HEM_H,
      color: palette.secondary
    }
  ]
}

function arms(view: View, palette: CitizenPalette, frame: WalkFrame, bob: number): SpriteRect[] {
  const swing = FOOT_STEP[frame] ?? [0, 0]
  // Arms counter-swing the legs: the near arm follows the far foot.
  return view.arms.flatMap((x, index) => {
    const y = ARM_Y + bob - (index === 0 ? (swing[1] ?? 0) : (swing[0] ?? 0))
    return [
      // Sleeve in the tunic colour, hand in skin below it.
      { x, y, w: ARM_W, h: ARM_H - HAND_H, color: palette.primary },
      { x, y: y + ARM_H - HAND_H, w: ARM_W, h: HAND_H, color: palette.skin }
    ]
  })
}

/**
 * Legs. They absorb the bob by changing height, which is why a ±1 px body bob
 * never pushes a pixel out of the 48 px cell: the feet below them never move.
 */
function legs(view: View, palette: CitizenPalette, bob: number): SpriteRect[] {
  const [leftX, rightX] = view.legs
  return [
    { x: leftX, y: LEG_Y + bob, w: LEG_W, h: LEG_H - bob, color: palette.skin },
    {
      x: rightX,
      y: LEG_Y + bob,
      w: LEG_W,
      h: LEG_H - bob,
      color: palette.skin
    }
  ]
}

/**
 * The planted feet — §5.1's bottom four rows. Drawn in the outline colour, so
 * they are their own silhouette and take no backing.
 */
function feet(view: View, palette: CitizenPalette, frame: WalkFrame): SpriteRect[] {
  const step = FOOT_STEP[frame] ?? [0, 0]
  const [near, far] = [step[0] ?? 0, step[1] ?? 0]
  const [leftX, rightX] = view.legs
  return [
    {
      x: leftX + near,
      y: FOOT_TOP,
      w: LEG_W,
      h: FOOT_ROWS,
      color: palette.outline
    },
    {
      x: rightX + far,
      y: FOOT_TOP,
      w: LEG_W,
      h: FOOT_ROWS,
      color: palette.outline
    }
  ]
}

/**
 * §5.1's signature elements, at the sizes the table prints. Each is cut from
 * `secondary` (or `primary` for the circlet, which is Artemis's own colour
 * showing) so the five-colour budget holds however a prop is placed. Props are
 * details drawn on top of an already-outlined body, so they take no backing —
 * which also keeps them the tail of the rectangle list.
 *
 * Placement reads `propSide` rather than mirroring: a satchel worn on the
 * body's near shoulder appears on screen-left when the citizen faces west and
 * screen-right when it faces east, and a back-slung case is hidden when the
 * back is turned away — which is exactly what a runtime flip gets wrong.
 */
function silhouetteProp(
  silhouette: Silhouette,
  view: View,
  palette: CitizenPalette,
  bob: number
): SpriteRect[] {
  const near = (w: number): number =>
    view.propSide === 1
      ? view.torsoX + view.torsoW - w
      : view.propSide === -1
        ? view.torsoX
        : view.torsoX + Math.floor((view.torsoW - w) / 2)

  switch (silhouette) {
    case 'orchestrator':
      // Laurel circlet, 2 px — worn on the head, so visible from every side.
      return [
        {
          x: view.headX,
          y: HEAD_Y + 1 + bob,
          w: view.headW,
          h: 2,
          color: palette.primary
        }
      ]
    case 'scribe':
      // Scroll case slung on the BACK, 3×8 — hidden when the back is turned away.
      return view.backProps
        ? [
            {
              x: near(3),
              y: TORSO_Y + 2 + bob,
              w: 3,
              h: 8,
              color: palette.secondary
            }
          ]
        : []
    case 'builder':
      // Tool belt, 2 px waist band — wraps the body, so always visible.
      return [
        {
          x: view.torsoX,
          y: TORSO_Y + TORSO_H - HEM_H - 3 + bob,
          w: view.torsoW,
          h: 2,
          color: palette.secondary
        }
      ]
    case 'researcher':
      // Shoulder satchel + tablet, 4×5 — worn on one shoulder, so it rides the
      // near side and is out of sight only from dead astern.
      return view.propSide === 0 && view.back
        ? []
        : [
            {
              x: near(4),
              y: TORSO_Y + 4 + bob,
              w: 4,
              h: 5,
              color: palette.secondary
            }
          ]
    case 'watch':
      // Cloak clasp, 2×2 at the collar — a front detail.
      return view.frontProps
        ? [
            {
              x: view.torsoX + Math.floor(view.torsoW / 2) - 1,
              y: TORSO_Y + 1 + bob,
              w: 2,
              h: 2,
              color: palette.secondary
            }
          ]
        : []
    case 'herald':
      // Lyre pin, 3×3 at the chest — a front detail.
      return view.frontProps
        ? [
            {
              x: view.torsoX + Math.floor(view.torsoW / 2) - 1,
              y: TORSO_Y + 4 + bob,
              w: 3,
              h: 3,
              color: palette.secondary
            }
          ]
        : []
  }
}

/**
 * Contract: the rectangles for one citizen frame, in draw order, all inside the
 * 32×48 cell and none of them above row 8 (the §5.2 overlay head-room). Pure —
 * same arguments, same rectangles — and never more than the five palette
 * colours.
 *
 * Draw order is: every outline backing, then every fill, then the feet, then
 * the silhouette prop. The two-pass outline is what makes the figure read
 * against any tile a pack might put under it.
 *
 * Standing citizens use the idle frame and do not bob: §6 forbids ambient idle
 * motion, so a citizen at rest is a still image, not a breathing one.
 */
export function citizenSprite(opts: {
  readonly direction: Direction
  readonly frame: WalkFrame
  readonly silhouette: Silhouette
  readonly palette: CitizenPalette
  readonly walking: boolean
}): readonly SpriteRect[] {
  const view = VIEWS[opts.direction]
  const frame = opts.walking ? opts.frame : 0
  const bob = opts.walking ? (BODY_BOB[frame] ?? 0) : 0

  const body = [
    ...legs(view, opts.palette, bob),
    ...torso(view, opts.palette, bob),
    ...arms(view, opts.palette, frame, bob),
    ...neck(view, opts.palette, bob),
    ...head(view, opts.palette, bob)
  ]

  return [
    ...body.map((rect) => backing(rect, opts.palette.outline)),
    ...body,
    ...feet(view, opts.palette, frame),
    ...silhouetteProp(opts.silhouette, view, opts.palette, bob)
  ]
}

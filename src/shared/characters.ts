import { z } from 'zod'

/**
 * Character art for the citizens (UI-DESIGN §7, ATTRIBUTION rule 3).
 *
 * Same shape as the tileset intake, for the same reasons: the sheets are
 * licensed and stay out of the repository, the manifest that says how to read
 * them is our own work and is committed, and an Ephesus with no pack installed
 * paints the procedural citizens and says so.
 *
 * Rule 3 permits this since 2026-09-01. It permits it narrowly: the pack
 * author's own generic characters, licensed like any other asset. No likeness
 * of a real person and no other IP's character reaches the floor, which is what
 * the rule always meant and now says directly.
 */

export const CHARACTERS_SCHEMA_VERSION = 1

/**
 * The floor's eight walk directions.
 *
 * Declared here rather than imported: `src/shared/` may not reach into the
 * renderer. `citizen.ts` asserts at compile time that its own `Direction` is
 * exactly this union, so the two cannot drift apart silently.
 */
export const CHARACTER_DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'] as const
export type CharacterDirection = (typeof CHARACTER_DIRECTIONS)[number]

/**
 * The four ways a sheet draws a person, in the order the pack lays them out.
 *
 * Measured, not assumed: the skin-pixel centroid of `Premade_Character_01` is
 * +1.82 px at column 0 (face right of centre), 0 with four skin pixels at
 * column 1 (the back of a head), -1.82 at column 2, and 0 with thirty-two at
 * column 3 (a face turned to the viewer). A first reading by eye had column 12
 * wrong; the measurement corrected it.
 */
export const SHEET_FACINGS = ['east', 'north', 'west', 'south'] as const
export type SheetFacing = (typeof SHEET_FACINGS)[number]

export const charactersManifestSchema = z
  .object({
    schemaVersion: z.literal(CHARACTERS_SCHEMA_VERSION),
    name: z.string().min(1).max(80),
    credit: z.string().min(1).max(200).optional(),
    /** Sheet file names, in the order a citizen is assigned one. */
    sheets: z.array(z.string().min(1).max(120)).min(1).max(128),
    frameW: z.number().int().positive().max(128),
    frameH: z.number().int().positive().max(128),
    /** Row holding one idle frame per facing, and the column each facing sits at. */
    idleRow: z.number().int().nonnegative().max(64),
    /** Row holding the walk cycles, one block of `walkFrames` per facing. */
    walkRow: z.number().int().nonnegative().max(64),
    walkFrames: z.number().int().positive().max(16)
  })
  .strict()

export type CharactersManifest = z.infer<typeof charactersManifestSchema>

/** Where one frame sits on a sheet, in pixels. */
export interface CharacterFrame {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Contract: pure. Which of the sheet's four facings to draw for one of the
 * floor's eight directions.
 *
 * Diagonals take the HORIZONTAL facing rather than the vertical one. A profile
 * shows a face and the back of a head shows nothing, so `ne` drawn as north
 * would turn a citizen away from the room for a walk that is mostly sideways —
 * and the floor's walks are mostly sideways.
 */
export function facingFor(direction: CharacterDirection): SheetFacing {
  if (direction.includes('e')) return 'east'
  if (direction.includes('w')) return 'west'
  return direction === 'n' ? 'north' : 'south'
}

/**
 * Contract: pure. The source rectangle for one citizen frame.
 *
 * A standing citizen takes the idle frame; a walking one takes a frame of that
 * facing's cycle, wrapped, so a floor with more walk frames than the pack ships
 * repeats rather than reading past the block into the next facing.
 */
export function characterFrame(
  manifest: CharactersManifest,
  opts: {
    readonly direction: CharacterDirection
    readonly frame: number
    readonly walking: boolean
  }
): CharacterFrame {
  const facing = facingFor(opts.direction)
  const lane = SHEET_FACINGS.indexOf(facing)
  const col = opts.walking
    ? lane * manifest.walkFrames +
      (((opts.frame % manifest.walkFrames) + manifest.walkFrames) % manifest.walkFrames)
    : lane
  const row = opts.walking ? manifest.walkRow : manifest.idleRow
  return {
    x: col * manifest.frameW,
    y: row * manifest.frameH,
    w: manifest.frameW,
    h: manifest.frameH
  }
}

/**
 * Contract: pure and stable. Which sheet a given agent wears.
 *
 * Stable across restarts because it is a function of the id alone: a citizen
 * that changed face every boot would make the floor unreadable for the one
 * thing it is for — recognising who is where.
 */
export function sheetForAgent(agentId: string, sheetCount: number): number {
  if (sheetCount <= 0) return 0
  let hash = 0
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0
  }
  return hash % sheetCount
}

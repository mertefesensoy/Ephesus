import { z } from 'zod'
import { STATIONS } from './avatar'
import { PLAN_KINDS, TILE_PX } from './floor'

/**
 * The tile map that turns an installed sheet into a painted floor
 * (UI-DESIGN §7).
 *
 * §7 permits "a professional 16×16 tileset … rendered at 2× onto the 32×32
 * world grid — integer scaling only". What it cannot do is say *which* tile of
 * *which* pack is a wall: every pack lays its sheet out differently, and the
 * sheets themselves stay out of the repository (licence terms, §7). So the
 * layout is data that ships **with the sheet**, in the gitignored drop, and is
 * validated here like any other file the harness reads.
 *
 * Hard-coding frame indices for a pack that is not in the tree would be
 * fiction: it would compile, it would look deliberate, and it would paint
 * whatever tiles happened to sit at those offsets. A missing or invalid map
 * therefore leaves the floor procedural and *says so* (invariant §7).
 */

export const TILESET_SCHEMA_VERSION = 1

/**
 * What a frame may be keyed by: a plan kind, or one specific station. The
 * allowlist is the point — a typo'd key is a tile that silently never paints,
 * so it is a parse failure instead.
 */
export const FRAME_KEYS: readonly string[] = [
  ...PLAN_KINDS,
  ...STATIONS.map((station) => `station:${station}`)
]

// zod reports a bad record key as `frames.<key>: Invalid key in record`, which
// already names the offending key; a custom message here would not surface.
const frameKeySchema = z.string().refine((key) => FRAME_KEYS.includes(key))

export const tilesetMapSchema = z
  .object({
    schemaVersion: z.literal(TILESET_SCHEMA_VERSION),
    /** Human credit, echoed into the UI so an installed pack names itself. */
    name: z.string().min(1).max(120),
    /** Sheet file name inside the drop, e.g. `kenney-roguelike-indoors.png`. */
    sheet: z.string().min(1).max(160),
    /** Source tile size. §7's integer-scale rule is enforced below. */
    tilePx: z.number().int().positive().max(TILE_PX),
    /** Sheet width in tiles, for index → (x, y). */
    columns: z.number().int().positive().max(4096),
    /** Gap between tiles, as some packs ship a 1px grid. */
    spacing: z.number().int().nonnegative().max(16).optional(),
    frames: z.record(frameKeySchema, z.number().int().nonnegative().max(1_048_576))
  })
  .strict()
  .refine((map) => TILE_PX % map.tilePx === 0, {
    // §7: "integer scaling only, pixel-snap preserved".
    message: `tilePx must divide the ${TILE_PX}px world tile exactly`,
    path: ['tilePx']
  })

export type TilesetMap = z.infer<typeof tilesetMapSchema>

export type TilesetMapParse =
  { readonly ok: true; readonly map: TilesetMap } | { readonly ok: false; readonly reason: string }

/** Contract: parses a tile map, naming the reason on failure so the UI can show it. */
export function parseTilesetMap(raw: unknown): TilesetMapParse {
  const parsed = tilesetMapSchema.safeParse(raw)
  if (parsed.success) return { ok: true, map: parsed.data }
  const first = parsed.error.issues[0]
  return {
    ok: false,
    reason: first ? `${first.path.join('.') || 'map'}: ${first.message}` : 'invalid tile map'
  }
}

/** Contract: the integer factor a sheet is drawn at (§7). Always ≥ 1. */
export function atlasScale(map: Pick<TilesetMap, 'tilePx'>): number {
  return TILE_PX / map.tilePx
}

export interface TilesetState {
  /** True only when a sheet AND a valid map for it are installed. */
  readonly installed: boolean
  /** URLs of the installed sheets, in path order. */
  readonly sheets: readonly string[]
  /** The sheet the map names, resolved to a URL — what the painter blits from. */
  readonly sheetUrl: string | null
  /** The validated map, or null when the floor stays procedural. */
  readonly map: TilesetMap | null
  /** What the UI should say about the floor's art source. */
  readonly note: string
}

const PROCEDURAL = 'tileset: procedural'

/**
 * Contract: what the floor should draw from, given what the build discovered.
 *
 * Every path that is not "a sheet and a valid map for it" returns the
 * procedural floor **and a note saying which step failed** — no sheet, no map,
 * an invalid map, or a map naming a sheet that is not there. A tileset that
 * quietly does not load would look exactly like one the designer had not
 * installed yet (invariant §7: every degradation is visible).
 *
 * Pure over its two inputs so the rules are testable without a build that has
 * art in it; `src/renderer/src/floor/tileset.ts` supplies them from
 * `import.meta.glob`.
 */
export function resolveTileset(
  sheetPaths: Readonly<Record<string, string>>,
  mapEntries: Readonly<Record<string, unknown>>
): TilesetState {
  const paths = Object.keys(sheetPaths).sort()
  const urls = paths.map((path) => sheetPaths[path]).filter((url): url is string => Boolean(url))
  const base = { sheets: urls, sheetUrl: null, map: null, installed: false } as const

  if (urls.length === 0) return { ...base, note: `${PROCEDURAL} (no sheet installed)` }

  const mapPaths = Object.keys(mapEntries).sort()
  const firstMap = mapPaths[0]
  if (firstMap === undefined) {
    return { ...base, note: `${PROCEDURAL} (${urls.length} sheet(s), no tile map)` }
  }

  const parsed = parseTilesetMap(mapEntries[firstMap])
  if (!parsed.ok) {
    return { ...base, note: `${PROCEDURAL} (tile map invalid — ${parsed.reason})` }
  }

  // The map names its sheet; matching by file name keeps a two-pack drop from
  // painting one pack's frames out of the other's sheet.
  const wanted = paths.find((path) => path.endsWith(`/${parsed.map.sheet}`))
  const sheetUrl = wanted ? sheetPaths[wanted] : undefined
  if (!sheetUrl) {
    return { ...base, note: `${PROCEDURAL} (tile map names a missing sheet: ${parsed.map.sheet})` }
  }

  return {
    installed: true,
    sheets: urls,
    sheetUrl,
    map: parsed.map,
    note: `tileset: ${parsed.map.name}`
  }
}

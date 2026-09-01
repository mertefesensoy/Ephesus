import { z } from 'zod'
import { STATIONS, type Station } from './avatar'
import { PLAN_KINDS, ROOM_COLS, ROOM_ROWS, stationTiles, TILE_PX } from './floor'

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
/**
 * Wall variants, by which edge of the room the cell sits on.
 *
 * A room whose every wall is one repeated tile reads as a band, not a room:
 * there is no cornice along the top, no return down the sides, no corner. A
 * pack that ships a wall SET can name these; one that ships a single wall still
 * works, because every variant falls back to plain `wall`.
 */
export const WALL_VARIANTS: readonly string[] = [
  'wall-n',
  'wall-s',
  'wall-e',
  'wall-w',
  'wall-ne',
  'wall-nw',
  'wall-se',
  'wall-sw'
]

/**
 * Seat halves. A desk is two tiles wide (§5.4), and mapping the whole seat to
 * one frame painted a computer on BOTH of them — twice the monitors and nowhere
 * to sit. `seat-a` is the left tile, `seat-b` the right, so a workstation can be
 * a desk and a chair instead of two of the same thing.
 */
export const SEAT_VARIANTS: readonly string[] = ['seat-a', 'seat-b']

export const FRAME_KEYS: readonly string[] = [
  ...PLAN_KINDS,
  ...WALL_VARIANTS,
  ...SEAT_VARIANTS,
  ...STATIONS.map((station) => `station:${station}`)
]

// zod reports a bad record key as `frames.<key>: Invalid key in record`, which
// already names the offending key; a custom message here would not surface.
const frameKeySchema = z.string().refine((key) => FRAME_KEYS.includes(key))

/** Composition keys are station keys only: `station:<name>`. */
const compositionKeySchema = z
  .string()
  .refine((key) => STATIONS.some((station) => key === `station:${station}`))

const compositionSchema = z
  .object({
    cols: z.number().int().positive().max(8),
    rows: z.number().int().positive().max(8),
    /** Row-major frame indices; length is checked against cols x rows. */
    frames: z.array(z.number().int().nonnegative().max(1_048_576)).min(1).max(64)
  })
  .strict()

const furnishingSchema = z
  .object({
    col: z
      .number()
      .int()
      .nonnegative()
      .max(ROOM_COLS - 1),
    row: z
      .number()
      .int()
      .nonnegative()
      .max(ROOM_ROWS - 1),
    frame: z.number().int().nonnegative().max(1_048_576)
  })
  .strict()

export const tilesetMapSchema = z
  .object({
    schemaVersion: z.literal(TILESET_SCHEMA_VERSION),
    /** Human credit, echoed into the UI so an installed pack names itself. */
    name: z.string().min(1).max(120),
    /**
     * The credit the pack's licence REQUIRES, shown in the floor's status strip
     * (UI-DESIGN §7: "license terms and credits are mandatory").
     *
     * It ships with the pack for the same reason the layout does: the credit is
     * a term of *that* licence, and a credit hard-coded in the app would be
     * wrong the moment somebody swapped the pack. Optional — a CC0 pack owes
     * none — and when present the floor prints it beside the pack name.
     */
    credit: z.string().min(1).max(200).optional(),
    /** Sheet file name inside the drop, e.g. `limezu-interiors-room-builder.png`. */
    sheet: z.string().min(1).max(160),
    /** Source tile size. §7's integer-scale rule is enforced below. */
    tilePx: z.number().int().positive().max(TILE_PX),
    /** Sheet width in tiles, for index → (x, y). */
    columns: z.number().int().positive().max(4096),
    /** Gap between tiles, as some packs ship a 1px grid. */
    spacing: z.number().int().nonnegative().max(16).optional(),
    frames: z.record(frameKeySchema, z.number().int().nonnegative().max(1_048_576)),
    /**
     * Multi-tile station structures (UI-DESIGN §5.4). A station is not one
     * tile: the Odeon is 96x64, the temple seat 64x64. Which frames compose
     * one is a property of the PACK, so it ships with the pack like the rest
     * of the layout — a station drawn from hard-coded indices would paint
     * whatever happened to sit at those offsets in the next pack.
     *
     * `frames` is row-major and must be exactly `cols * rows` long; the
     * footprint must match the §5.4 catalog. Both are checked in
     * `validateCompositions`, because a composition that is silently the wrong
     * size is a station that paints over its neighbour.
     */
    compositions: z.record(compositionKeySchema, compositionSchema).optional(),
    /**
     * Furnishings (UI-DESIGN §5.7) — place identity, not ambience. Furniture
     * says what happens in a room (shelves say library, benches say odeon,
     * crates say harbor), and it is STATIC: §1.2 bans decorative motion, so
     * these are placements and nothing else. The list rides the map so a pack
     * swap re-furnishes the floor without touching code.
     */
    furnishings: z.array(furnishingSchema).max(512).optional()
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

/**
 * One installed pack: its map, and the sheet that map names.
 *
 * A layer rather than a merged map, because a pack's frame indices are only
 * meaningful against its OWN sheet. Flattening two packs into one frame table
 * would be the exact failure the map's `sheet` field was added to prevent —
 * painting one pack's frames out of the other's image.
 */
export interface TilesetLayer {
  readonly map: TilesetMap
  /** The sheet's file name, as the map names it — the painter's texture key. */
  readonly sheet: string
  readonly sheetUrl: string
}

export interface TilesetState {
  /** True only when a sheet AND a valid map for it are installed. */
  readonly installed: boolean
  /** URLs of the installed sheets, in path order. */
  readonly sheets: readonly string[]
  /**
   * Every pack that resolved, in map-file order. Earlier layers win a contested
   * frame key: a drop is a stack, and the first pack is the base.
   */
  readonly layers: readonly TilesetLayer[]
  /** The first layer's sheet URL, or null. Kept for callers that want the base. */
  readonly sheetUrl: string | null
  /** The first layer's map, or null when the floor stays procedural. */
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
  const base = { sheets: urls, layers: [], sheetUrl: null, map: null, installed: false } as const

  if (urls.length === 0) return { ...base, note: `${PROCEDURAL} (no sheet installed)` }

  const mapPaths = Object.keys(mapEntries).sort()
  if (mapPaths.length === 0) {
    return { ...base, note: `${PROCEDURAL} (${urls.length} sheet(s), no tile map)` }
  }

  // Every pack that resolves becomes a layer, in map-file order. Before this,
  // only `mapPaths[0]` was read, so a second installed pack sat inert — and a
  // pack of office furniture could never reach a floor whose walls came from
  // the interiors pack, because the two live on different sheets.
  const layers: TilesetLayer[] = []
  const refused: string[] = []
  for (const mapPath of mapPaths) {
    const parsed = parseTilesetMap(mapEntries[mapPath])
    if (!parsed.ok) {
      refused.push(`${mapPath.split('/').pop() ?? mapPath} invalid — ${parsed.reason}`)
      continue
    }
    // The map names its sheet; matching by file name keeps a two-pack drop from
    // painting one pack's frames out of the other's sheet.
    const wanted = paths.find((path) => path.endsWith(`/${parsed.map.sheet}`))
    const sheetUrl = wanted ? sheetPaths[wanted] : undefined
    if (!sheetUrl) {
      refused.push(`${parsed.map.name} names a missing sheet: ${parsed.map.sheet}`)
      continue
    }
    layers.push({ map: parsed.map, sheet: parsed.map.sheet, sheetUrl })
  }

  const first = layers[0]
  if (first === undefined) {
    return { ...base, note: `${PROCEDURAL} (${refused.join('; ')})` }
  }

  const problems = layers.flatMap((layer) => validateCompositions(layer.map))
  // A key two packs both define is resolved, not guessed at silently: the
  // earlier layer wins and the note says which keys were contested, so a floor
  // that looks wrong can be explained without reading two JSON files.
  const seen = new Set<string>()
  const contested: string[] = []
  for (const layer of layers) {
    for (const key of Object.keys(layer.map.frames)) {
      if (seen.has(key)) contested.push(key)
      else seen.add(key)
    }
  }

  return {
    installed: true,
    sheets: urls,
    layers,
    sheetUrl: first.sheetUrl,
    map: first.map,
    // The credit rides the same line as the name: a licence term nobody can
    // see is a licence term nobody is honouring.
    note:
      `tileset: ${layers.map((layer) => `${layer.map.name}${layer.map.credit === undefined ? '' : ` — ${layer.map.credit}`}`).join(' + ')}` +
      (contested.length === 0
        ? ''
        : ` — ${String(contested.length)} key(s) taken from the first pack: ${contested.join(', ')}`) +
      (refused.length === 0 ? '' : ` — ${refused.length} pack(s) refused: ${refused.join('; ')}`) +
      (problems.length === 0
        ? ''
        : ` — ${String(problems.length)} procedural: ${problems.join('; ')}`)
  }
}
/** One station's composition, as a pack ships it (UI-DESIGN §5.4). */
export type StationComposition = NonNullable<TilesetMap['compositions']>[string]

/** One furnishing placement, as a pack ships it (UI-DESIGN §5.7). */
export type Furnishing = NonNullable<TilesetMap['furnishings']>[number]

/**
 * Contract: what is wrong with a map's §5.4 compositions, one line each, or an
 * empty list when they are sound.
 *
 * Two rules, and both exist because the failure is silent otherwise:
 *
 * 1. **`frames.length === cols * rows`.** A short list leaves holes; a long
 *    one paints tiles the station does not own — over its neighbour.
 * 2. **The footprint matches the §5.4 catalog.** The catalog is the design;
 *    a pack that ships a 2x2 Odeon has misread it, and a floor that accepted
 *    it would be a floor whose stations are whatever size the art happened to
 *    be. `stationTiles()` is the single source for both sides.
 *
 * Returned rather than thrown: a bad composition degrades that station to the
 * procedural painter and says so (invariant §7), and one wrong entry must not
 * cost the whole pack.
 */
export function validateCompositions(map: TilesetMap): readonly string[] {
  const problems: string[] = []
  for (const [key, composition] of Object.entries(map.compositions ?? {})) {
    const station = key.slice('station:'.length) as Station
    const expected = composition.cols * composition.rows
    if (composition.frames.length !== expected) {
      problems.push(
        `${key}: ${String(composition.frames.length)} frames for a ` +
          `${String(composition.cols)}x${String(composition.rows)} composition (expected ${String(expected)})`
      )
    }
    const owed = stationTiles(station)
    if (composition.cols !== owed.cols || composition.rows !== owed.rows) {
      problems.push(
        `${key}: footprint ${String(composition.cols)}x${String(composition.rows)} ` +
          `does not match the §5.4 catalog (${String(owed.cols)}x${String(owed.rows)})`
      )
    }
  }
  return problems
}

/**
 * Contract: the composition for a station, or null when the pack does not ship
 * one or ships a broken one. A station with no composition falls back to the
 * single `station:<name>` frame and then to the procedural painter — the same
 * partial-pack behaviour the rest of the painter already has.
 */
export function compositionFor(map: TilesetMap, station: Station): StationComposition | null {
  const composition = map.compositions?.[`station:${station}`]
  if (!composition) return null
  const owed = stationTiles(station)
  if (composition.frames.length !== composition.cols * composition.rows) return null
  if (composition.cols !== owed.cols || composition.rows !== owed.rows) return null
  return composition
}

/**
 * Contract: the furnishings a pack places, with out-of-room entries dropped.
 * The schema already bounds col/row to the room, so this is the belt to that
 * braces: a map hand-edited past the validator still cannot paint outside the
 * floor.
 */
export function furnishingsOf(map: TilesetMap): readonly Furnishing[] {
  return (map.furnishings ?? []).filter(
    (item) => item.col >= 0 && item.col < ROOM_COLS && item.row >= 0 && item.row < ROOM_ROWS
  )
}

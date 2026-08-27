import { resolveTileset, type TilesetState } from '../../../shared/tileset'

/**
 * Licensed tileset intake (UI-DESIGN §7).
 *
 * §7 permits a professional 16×16 tileset rendered at 2× onto the 32×32 world
 * grid, under two conditions: the licence must allow redistribution inside a
 * shipped app, and files that may not be redistributed in source form stay out
 * of the public repository. Both are handled by making the tileset *optional
 * and discovered*, never imported:
 *
 *  - drop the sheets into `src/renderer/src/assets/tileset/` (gitignored)
 *    together with a `*.tiles.json` map (`src/shared/tileset.ts`) and record
 *    them in `src/renderer/src/assets/ATTRIBUTION.md`;
 *  - the floor picks them up on the next build with no code change;
 *  - anything short of a sheet *and* a valid map for it leaves the floor
 *    drawing its own tiles, and *says which* of those was missing — a visible
 *    degraded state, not a silent one (invariant §7).
 *
 * `import.meta.glob` is what makes that possible: a missing directory yields an
 * empty record instead of a build error, which a static `import` could not do.
 */

const sheets = import.meta.glob('../assets/tileset/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

const maps = import.meta.glob('../assets/tileset/*.tiles.json', {
  eager: true,
  import: 'default'
}) as Record<string, unknown>

/**
 * The resolution rules live in `src/shared/tileset.ts` so they can be tested
 * without a build: this file is the only one that may name `import.meta.glob`,
 * which does not exist under the Node test runner (the same split the pixel
 * faces needed in M3.5).
 */
export function tilesetState(): TilesetState {
  return resolveTileset(sheets, maps)
}

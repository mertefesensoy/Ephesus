/**
 * Licensed tileset intake (UI-DESIGN §7).
 *
 * §7 permits a professional 16×16 tileset rendered at 2× onto the 32×32 world
 * grid, under two conditions: the licence must allow redistribution inside a
 * shipped app, and files that may not be redistributed in source form stay out
 * of the public repository. Both are handled by making the tileset *optional
 * and discovered*, never imported:
 *
 *  - drop the sheets into `src/renderer/src/assets/tileset/` (gitignored) and
 *    record them in `src/renderer/src/assets/ATTRIBUTION.md`;
 *  - the floor picks them up on the next build with no code change;
 *  - with no sheets present the floor draws its own tiles and *says so* — a
 *    visible degraded state, not a silent one (invariant §7).
 *
 * `import.meta.glob` is what makes that possible: a missing directory yields an
 * empty record instead of a build error, which a static `import` could not do.
 */

const sheets = import.meta.glob('../assets/tileset/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

export interface TilesetState {
  /** True when at least one licensed sheet is installed. */
  readonly installed: boolean
  /** URLs of the installed sheets, in path order. */
  readonly sheets: readonly string[]
  /** What the UI should say about the floor's art source. */
  readonly note: string
}

export function tilesetState(): TilesetState {
  const paths = Object.keys(sheets).sort()
  const urls = paths.map((path) => sheets[path]).filter((url): url is string => Boolean(url))
  return {
    installed: urls.length > 0,
    sheets: urls,
    note:
      urls.length > 0 ? `tileset: ${urls.length} sheet(s)` : 'tileset: procedural (none installed)'
  }
}

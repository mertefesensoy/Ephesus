/**
 * The bundled pixel faces (UI-DESIGN §3). Data only — no DOM, so the paths can
 * be asserted from a plain test without dragging the renderer's font loader
 * (which needs `FontFace` and `document`) into the node project.
 */

export interface PixelFace {
  /** CSS family name, matching the stacks in tokens.css. */
  readonly family: string
  /**
   * File fetched relative to the renderer document.
   *
   * RELATIVE, not absolute. A packaged app loads its renderer from
   * `file://…/out/renderer/index.html`, where `/fonts/x.woff2` resolves to the
   * filesystem root and `fetch` fails outright — so the built app never loaded
   * a single bundled face and showed "3 of 3 pixel faces missing" permanently,
   * while the dev server (an http origin, where the absolute path works) looked
   * fine. A degradation warning that is always on is worse than none: it trains
   * the Architect to ignore the surface every other degradation shares. Found
   * by reading an M3 evidence screenshot.
   *
   * `./` resolves correctly under both, because `index.html` sits at the root
   * of the served tree in the dev server and beside `fonts/` in the build.
   */
  readonly file: string
}

export const PIXEL_FACES: readonly PixelFace[] = [
  { family: 'Press Start 2P', file: './fonts/PressStart2P-Regular.woff2' },
  { family: 'Pixelify Sans', file: './fonts/PixelifySans-Regular.woff2' },
  { family: 'IBM Plex Mono', file: './fonts/IBMPlexMono-Regular.woff2' }
]

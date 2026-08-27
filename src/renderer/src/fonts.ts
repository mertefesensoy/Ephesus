/**
 * Pixel font loading (UI-DESIGN §3).
 *
 * §3 names three faces and requires them bundled — "the app must not depend on
 * a font CDN". They are loaded here at runtime rather than imported, so a build
 * never breaks over a missing font file and, more importantly, a *missing* face
 * becomes a visible state instead of the app quietly rendering in Courier and
 * looking broken for reasons nobody can name (invariant §7).
 *
 * Files go in `src/renderer/public/fonts/` — see the README there for names and
 * licences, and `assets/ATTRIBUTION.md` for the attribution rules.
 */

export interface PixelFace {
  /** CSS family name, matching the stacks in tokens.css. */
  readonly family: string
  /** File served from the renderer's public root. */
  readonly file: string
}

/**
 * Paths are RELATIVE, not absolute.
 *
 * A packaged app loads its renderer from `file://…/out/renderer/index.html`,
 * where `/fonts/x.woff2` resolves to the filesystem root and `fetch` fails
 * outright — so the built app never loaded a single bundled face and showed
 * "3 of 3 pixel faces missing" permanently, while the dev server (an http
 * origin, where the absolute path works) looked fine. A degradation warning
 * that is always on is worse than none: it trains the Architect to ignore the
 * surface every other degradation shares. Found by an M3 evidence screenshot.
 *
 * `./` resolves correctly under both, because `index.html` sits at the root of
 * the served tree in the dev server and beside `fonts/` in the build.
 */
export const PIXEL_FACES: readonly PixelFace[] = [
  { family: 'Press Start 2P', file: './fonts/PressStart2P-Regular.woff2' },
  { family: 'Pixelify Sans', file: './fonts/PixelifySans-Regular.woff2' },
  { family: 'IBM Plex Mono', file: './fonts/IBMPlexMono-Regular.woff2' }
]

export interface FontStatus {
  readonly loaded: readonly string[]
  readonly missing: readonly string[]
}

/** WOFF2 files start with the ASCII signature `wOF2`. */
const WOFF2_MAGIC = [0x77, 0x4f, 0x46, 0x32]

/**
 * Contract: never throws and never rejects. Loads whatever is installed and
 * reports the rest as missing, so the caller can show the degradation rather
 * than the app pretending its typography is correct.
 *
 * The bytes are fetched and checked before a `FontFace` is built, because a dev
 * server answers a missing file with the SPA's index.html — handing that to the
 * font parser produces a confusing "invalid sfntVersion" error instead of the
 * plain fact that the file is not installed.
 */
export async function loadPixelFonts(): Promise<FontStatus> {
  const loaded: string[] = []
  const missing: string[] = []

  await Promise.all(
    PIXEL_FACES.map(async (face) => {
      try {
        const response = await fetch(face.file)
        if (!response.ok) throw new Error(`${response.status}`)
        const bytes = await response.arrayBuffer()
        const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength))
        if (!WOFF2_MAGIC.every((byte, i) => head[i] === byte)) throw new Error('not a woff2 file')

        const font = new FontFace(face.family, bytes)
        await font.load()
        document.fonts.add(font)
        loaded.push(face.family)
      } catch {
        missing.push(face.family)
      }
    })
  )

  return { loaded, missing }
}

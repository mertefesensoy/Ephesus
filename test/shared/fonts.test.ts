import { describe, expect, it } from 'vitest'
import { PIXEL_FACES } from '../../src/shared/fonts'

/**
 * Regression test for the always-missing-fonts bug.
 *
 * A packaged app loads its renderer over `file://`, where an absolute
 * `/fonts/x.woff2` resolves to the filesystem root and `fetch` fails — so the
 * built app never loaded a bundled face and showed "3 of 3 pixel faces
 * missing" permanently, while the dev server's http origin made it look fine.
 * A warning that is always on trains the Architect to ignore the surface every
 * other degradation shares (invariant §7), which is the real damage.
 */
describe('bundled font paths resolve under file:// as well as http://', () => {
  it.each(PIXEL_FACES.map((face) => [face.family, face.file]))(
    '%s is fetched by a relative path',
    (_family, file) => {
      expect(file.startsWith('/')).toBe(false)
      expect(file.startsWith('./fonts/')).toBe(true)
    }
  )

  it('resolves against a packaged file:// renderer', () => {
    const base = 'file:///opt/app/out/renderer/index.html'
    for (const face of PIXEL_FACES) {
      // The whole bug in one assertion: the absolute form lands at the
      // filesystem root, the relative one beside index.html.
      expect(new URL(face.file, base).pathname).toBe(
        `/opt/app/out/renderer/${face.file.slice('./'.length)}`
      )
    }
  })

  it('resolves against a dev-server http:// renderer too', () => {
    for (const face of PIXEL_FACES) {
      expect(new URL(face.file, 'http://localhost:5173/').pathname).toBe(
        `/${face.file.slice('./'.length)}`
      )
    }
  })

  it('names the three faces UI-DESIGN §3 requires', () => {
    expect(PIXEL_FACES.map((face) => face.family)).toEqual([
      'Press Start 2P',
      'Pixelify Sans',
      'IBM Plex Mono'
    ])
  })
})

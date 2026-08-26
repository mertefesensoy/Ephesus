/**
 * Copies the three UI-DESIGN §3 pixel faces from their @fontsource packages
 * into the renderer's font drop (src/renderer/public/fonts/), under the exact
 * names src/renderer/src/fonts.ts probes for.
 *
 * Runs from postinstall. The woff2 files are gitignored — npm is their source
 * of truth (Architect-approved @fontsource route, 2026-08-26) — and a missing
 * package is NOT an error here: fonts.ts already reports missing faces
 * visibly, and this script must never break `npm install`.
 */
const fs = require('node:fs')
const path = require('node:path')

const FACES = [
  [
    '@fontsource/press-start-2p',
    'press-start-2p-latin-400-normal.woff2',
    'PressStart2P-Regular.woff2'
  ],
  [
    '@fontsource/pixelify-sans',
    'pixelify-sans-latin-400-normal.woff2',
    'PixelifySans-Regular.woff2'
  ],
  ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2', 'IBMPlexMono-Regular.woff2']
]

const dropDir = path.join(__dirname, '..', 'src', 'renderer', 'public', 'fonts')
fs.mkdirSync(dropDir, { recursive: true })

for (const [pkg, sourceFile, targetFile] of FACES) {
  const source = path.join(__dirname, '..', 'node_modules', pkg, 'files', sourceFile)
  if (!fs.existsSync(source)) {
    console.log(
      `sync-fonts: ${pkg} not installed — ${targetFile} stays missing (visible in the app)`
    )
    continue
  }
  fs.copyFileSync(source, path.join(dropDir, targetFile))
  console.log(`sync-fonts: ${targetFile} <- ${pkg}`)
}

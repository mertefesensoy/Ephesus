import { resolveCharacters, type CharactersState } from '../../../shared/characters'

/**
 * Licensed character intake, mirroring `./tileset.ts`.
 *
 * Sheets are dropped into `src/renderer/src/assets/characters/` (gitignored)
 * beside a `*.chars.json` manifest (committed), and recorded in
 * `ATTRIBUTION.md`. With no pack installed the floor paints the procedural
 * citizens and says so — that is not a fallback nobody exercises, it is what an
 * Ephesus without the paid pack looks like.
 */

const sheets = import.meta.glob('../assets/characters/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

const manifests = import.meta.glob('../assets/characters/*.chars.json', {
  eager: true,
  import: 'default'
}) as Record<string, unknown>

export function charactersState(): CharactersState {
  return resolveCharacters(sheets, manifests)
}

import { resolveEmotes, type EmotesState } from '../../shared/emotes'

/**
 * Licensed emote intake, mirroring the tileset's and the character pack's:
 * the sheet is gitignored, the manifest is committed, and a missing pack costs
 * the dock its icons and nothing else.
 */

const sheets = import.meta.glob('./assets/tileset/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

const manifests = import.meta.glob('./assets/tileset/*.emotes.json', {
  eager: true,
  import: 'default'
}) as Record<string, unknown>

export function emotesState(): EmotesState {
  return resolveEmotes(sheets, manifests)
}

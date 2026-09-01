import { z } from 'zod'

/**
 * Status emotes for the dock (UI-DESIGN §8).
 *
 * The Architect asked for the emote BESIDE the status word, not replacing it,
 * and that is the whole design. §8 requires status to be double-encoded rather
 * than carried by one channel: an icon alone is the 3×5 glyph problem again —
 * a reader had to ask what a ring meant — and a word alone is what we have.
 * Together the picture is recognised and the word is unambiguous.
 *
 * Optional like every licensed pack: with no sheet installed the dock shows the
 * word by itself, which is exactly what it showed yesterday.
 */

export const EMOTES_SCHEMA_VERSION = 1

export const emotesManifestSchema = z
  .object({
    schemaVersion: z.literal(EMOTES_SCHEMA_VERSION),
    name: z.string().min(1).max(80),
    credit: z.string().min(1).max(200).optional(),
    sheet: z.string().min(1).max(120),
    tilePx: z.number().int().positive().max(64),
    columns: z.number().int().positive().max(64),
    /**
     * Phase → frame index. Every phase must be present: a partial table would
     * give some agents an icon and others none, and the reader could not tell
     * whether the missing one meant "no emote for this" or "nothing is
     * happening".
     */
    phases: z.record(z.string().min(1).max(32), z.number().int().nonnegative().max(65_535))
  })
  .strict()

export type EmotesManifest = z.infer<typeof emotesManifestSchema>

export interface EmotesState {
  readonly installed: boolean
  readonly manifest: EmotesManifest | null
  readonly url: string | null
}

/** Contract: pure. Where one phase's emote sits on the sheet, or null. */
export function emoteFrame(
  manifest: EmotesManifest,
  phase: string
): { readonly x: number; readonly y: number; readonly size: number } | null {
  const index = manifest.phases[phase]
  if (index === undefined) return null
  const col = index % manifest.columns
  const row = Math.floor(index / manifest.columns)
  return { x: col * manifest.tilePx, y: row * manifest.tilePx, size: manifest.tilePx }
}

/**
 * Contract: pure over its inputs. A pack is usable only when the manifest
 * parses AND names a sheet that is installed; anything else is no pack, and the
 * dock falls back to the word alone.
 */
export function resolveEmotes(
  sheetPaths: Readonly<Record<string, string>>,
  manifestEntries: Readonly<Record<string, unknown>>
): EmotesState {
  const none = { installed: false, manifest: null, url: null } as const
  const first = Object.keys(manifestEntries).sort()[0]
  if (first === undefined) return none
  const parsed = emotesManifestSchema.safeParse(manifestEntries[first])
  if (!parsed.success) return none
  const wanted = Object.keys(sheetPaths).find((path) => path.endsWith(`/${parsed.data.sheet}`))
  const url = wanted ? sheetPaths[wanted] : undefined
  if (url === undefined) return none
  return { installed: true, manifest: parsed.data, url }
}

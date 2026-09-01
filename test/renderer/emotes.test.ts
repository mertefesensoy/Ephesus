import { describe, expect, it } from 'vitest'
import {
  EMOTES_SCHEMA_VERSION,
  emoteFrame,
  emotesManifestSchema,
  resolveEmotes,
  type EmotesManifest
} from '../../src/shared/emotes'
import { BADGES } from '../../src/shared/badges'

const MANIFEST: EmotesManifest = {
  schemaVersion: EMOTES_SCHEMA_VERSION,
  name: 'test emotes',
  sheet: 'e.png',
  tilePx: 16,
  columns: 10,
  phases: { idle: 56, working: 44 }
}

/**
 * The Architect asked for the emote BESIDE the status word, not replacing it,
 * and §8 wants the same thing for a different reason: status must be
 * double-encoded. An icon alone is the 3x5 glyph again — somebody had to ask
 * what a ring meant — and the word alone is what the dock already had.
 */
describe('where a phase’s emote sits on the sheet', () => {
  it('reads an index as a row and a column', () => {
    expect(emoteFrame(MANIFEST, 'idle')).toEqual({ x: 6 * 16, y: 5 * 16, size: 16 })
    expect(emoteFrame(MANIFEST, 'working')).toEqual({ x: 4 * 16, y: 4 * 16, size: 16 })
  })

  it('answers null for a phase the pack does not map', () => {
    expect(emoteFrame(MANIFEST, 'looping')).toBeNull()
  })
})

/**
 * A partial table would give some agents an icon and others none, and a reader
 * could not tell "this phase has no emote" from "nothing is happening". The
 * shipped manifest therefore covers every phase the badges declare.
 */
describe('the shipped emote table', () => {
  it('covers every phase the floor can be in', async () => {
    const shipped = (await import('../../src/renderer/src/assets/tileset/limezu.emotes.json')) as {
      default: { phases: Record<string, number> }
    }
    for (const phase of Object.keys(BADGES)) {
      expect(shipped.default.phases[phase], `no emote for "${phase}"`).toBeTypeOf('number')
    }
  })
})

describe('deciding whether an emote pack is usable', () => {
  it('is not installed when there is no manifest', () => {
    expect(resolveEmotes({}, {}).installed).toBe(false)
  })

  it('is not installed when the manifest names a sheet that is absent', () => {
    expect(resolveEmotes({}, { '/a/x.emotes.json': MANIFEST }).installed).toBe(false)
  })

  it('is installed when the sheet is there', () => {
    const state = resolveEmotes({ '/a/e.png': 'blob:e' }, { '/a/x.emotes.json': MANIFEST })
    expect(state.installed).toBe(true)
    expect(state.url).toBe('blob:e')
  })

  it('refuses a manifest it cannot parse rather than half-using it', () => {
    expect(resolveEmotes({ '/a/e.png': 'u' }, { '/a/x.emotes.json': { nope: 1 } }).installed).toBe(
      false
    )
  })

  it('refuses an unknown field', () => {
    expect(emotesManifestSchema.safeParse({ ...MANIFEST, extra: 1 }).success).toBe(false)
  })
})

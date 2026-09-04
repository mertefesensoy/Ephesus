import { describe, expect, it } from 'vitest'
import { CHARACTERS_SCHEMA_VERSION, type CharactersManifest } from '../../src/shared/characters'
import { resolveCharacters } from '../../src/shared/characters'

const MANIFEST: CharactersManifest = {
  schemaVersion: CHARACTERS_SCHEMA_VERSION,
  name: 'test pack',
  sheets: ['a.png', 'b.png', 'c.png'],
  frameW: 16,
  frameH: 32,
  idleRow: 0,
  walkRow: 1,
  walkFrames: 6
}

/**
 * Intake, mirroring the tileset's: with no pack the floor paints procedural
 * citizens AND says so, because invariant §7 will not have a silent
 * degradation. A pack that is half-installed is refused rather than half-used —
 * `sheetForAgent` indexes into the manifest's own list, so a hole would give
 * some citizens a face and others nothing, with no way to tell which from the
 * floor.
 */
describe('deciding whether a character pack is usable', () => {
  const manifestFor = (sheets: string[]) => ({ ...MANIFEST, sheets })

  it('says procedural, and why, with no manifest at all', () => {
    const state = resolveCharacters({}, {})
    expect(state.installed).toBe(false)
    expect(state.note).toContain('no character pack')
  })

  it('refuses a manifest naming a sheet that is not installed, and names it', () => {
    const state = resolveCharacters(
      { '/a/a.png': 'blob:a' },
      { '/a/p.chars.json': manifestFor(['a.png', 'b.png']) }
    )
    expect(state.installed).toBe(false)
    expect(state.note).toContain('b.png')
  })

  it('accepts a pack whose sheets are all present', () => {
    const state = resolveCharacters(
      { '/a/a.png': 'blob:a', '/a/b.png': 'blob:b' },
      { '/a/p.chars.json': manifestFor(['a.png', 'b.png']) }
    )
    expect(state.installed).toBe(true)
    expect(state.urls.get('b.png')).toBe('blob:b')
    expect(state.note).toContain('test pack')
  })

  it('puts the pack’s CREDIT on the note, which is a licence term', () => {
    // UI-DESIGN §7: "license terms and credits are mandatory". Every fixture in
    // this file omits `credit`, so the suite only ever took the no-credit side;
    // the shipped `limezu.chars.json` carries one, so the credit side ran only
    // on a machine holding the licensed pack — never in CI. An arm-level diff of
    // two full runs, pack on and pack off, named this arm and `tileset.ts:284`
    // as the only two in `terraces` that differed between the two conditions.
    const state = resolveCharacters(
      { '/a/a.png': 'blob:a', '/a/b.png': 'blob:b' },
      { '/a/p.chars.json': { ...manifestFor(['a.png', 'b.png']), credit: 'LimeZu — example' } }
    )
    expect(state.installed).toBe(true)
    expect(state.note).toBe('citizens: test pack — LimeZu — example')
  })

  it('says procedural, and why, for a manifest it cannot parse', () => {
    const state = resolveCharacters({ '/a/a.png': 'blob:a' }, { '/a/p.chars.json': { nope: 1 } })
    expect(state.installed).toBe(false)
    expect(state.note).toContain('invalid')
  })
})

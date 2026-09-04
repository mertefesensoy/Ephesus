// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { tilesetState } from '../../src/renderer/src/floor/tileset'
import { charactersState } from '../../src/renderer/src/floor/characters'

/**
 * The two modules that read the licensed art drop off the build (M8.5 follow-up).
 *
 * ## Why they need a file of their own
 *
 * `floor/tileset.ts` and `floor/characters.ts` are three lines each: an
 * `import.meta.glob` over `../assets/{tileset,characters}/*`, and a call into
 * the real resolution rules in `src/shared/`. They exist as a pair *because*
 * `import.meta.glob` does not exist under the Node test runner, so the rules had
 * to live somewhere a test could reach without a build — the same split the
 * pixel faces needed in M3.5.
 *
 * Their only caller is `FloorCanvas`, and `floor-canvas.test.tsx` now stubs both
 * of them so the loader loops run a fixed count whether or not the machine holds
 * the licensed pack. That stub is right, and it left these two modules entered by
 * nothing at all — the coverage gate said so by name, which is the seam rule
 * (ENGINEERING-STANDARDS §6.7) catching the fix for one defect creating another.
 *
 * ## What can honestly be asserted here
 *
 * Not what the state SAYS: that depends on whether this machine bought the pack
 * (`assets/ATTRIBUTION.md` rule 2 keeps it out of the repository, so CI never
 * has it). Asserting `installed` either way would put the pack back into the
 * gate through a different door.
 *
 * What is the same on every machine is that the glob is read, the resolver is
 * called, and a state comes back that a caller can branch on — including the
 * `note` that invariant §7 requires, which is the whole reason a missing pack is
 * a *described* degradation rather than an empty floor. The values differ; the
 * contract does not.
 *
 * ## Why `.tsx` for a file with no JSX in it
 *
 * `tsconfig.web-test.json` includes `test/renderer/**\/*.tsx` and is the only
 * test project carrying `types: ["vite/client"]`. `import.meta.glob` exists
 * only under those types, so a renderer test that reaches a module using it
 * belongs in that project — and the extension is how a file gets into it. The
 * sibling `.ts` tests in this directory reach the *rules* in `src/shared/`,
 * which need no build and no vite types; these two modules are the halves that
 * do.
 */

describe('the modules that read the art drop off the build', () => {
  it('resolves a tileset state whichever way the drop went', () => {
    const state = tilesetState()
    expect(typeof state.installed).toBe('boolean')
    expect(Array.isArray(state.layers)).toBe(true)
    expect(Array.isArray(state.sheets)).toBe(true)
    // Invariant §7: a floor with no art says which art it is drawing, and a
    // floor with art says that too. Silence is the one answer neither may give.
    expect(state.note.length).toBeGreaterThan(0)
    // `installed` and `map` cannot disagree: the note exists so a caller never
    // has to infer one from the other.
    expect(state.installed).toBe(state.map !== null)
  })

  it('resolves a characters state whichever way the drop went', () => {
    const state = charactersState()
    expect(typeof state.installed).toBe('boolean')
    expect(state.urls instanceof Map).toBe(true)
    expect(state.note.length).toBeGreaterThan(0)
    expect(state.installed).toBe(state.manifest !== null)
  })

  it('says the same thing twice, so a caller may ask more than once', () => {
    // Both read module-level globs and re-resolve on every call; a caller that
    // asked twice and got two answers would be a floor that repainted itself
    // differently for no reason.
    expect(tilesetState().note).toBe(tilesetState().note)
    expect(charactersState().note).toBe(charactersState().note)
  })
})

import type { ProfileBundle } from './profile'

/**
 * What the renderer is told about mission profiles (SDD §5 `profiles:`).
 *
 * Type-only, and deliberately so: `src/shared/ipc.ts` must stay free of runtime
 * dependencies (the sandboxed preload cannot `require` zod), so the shapes that
 * cross the bridge live here and the schemas that validate them stay in
 * `profile.ts`, imported only by main.
 */

/**
 * One row on the profiles list.
 *
 * A bundle that fails validation still gets a row. It is the whole point of
 * refusing BY NAME (ADR-0012, M7.1): a profile that vanished from the list when
 * its JSON broke would look uninstalled, and the Architect would go looking for
 * a missing directory instead of a missing comma.
 */
export interface ProfileSummary {
  readonly name: string
  /** Where the bundle was read from — the harness home, or the app's built-ins. */
  readonly source: 'home' | 'builtin'
  /** False when the bundle failed validation; `load()` carries the reasons. */
  readonly valid: boolean
  /** `profile.json`'s version, or null when the document could not be read. */
  readonly version: number | null
}

/**
 * The result of loading one bundle: the profile, or every reason it was
 * refused. There is no third state — no partial bundle, no defaults filled in —
 * because ADR-0012's safety story is that the Architect can read what a profile
 * may do before activating it, and a half-loaded profile is a document that
 * says one thing on disk and another in memory.
 */
export type ProfileLoad =
  | { readonly ok: true; readonly bundle: ProfileBundle; readonly source: 'home' | 'builtin' }
  | { readonly ok: false; readonly name: string; readonly reasons: readonly string[] }

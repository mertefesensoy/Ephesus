import type { ProfileBundle } from './profile'
import type { ActivationPlan } from './profile-activation'

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
  /**
   * Targets this profile has been activated against before, most recent first,
   * so the panel can offer one instead of asking for a long absolute path to be
   * retyped at every restart. Empty for a profile never activated.
   *
   * A remembered target is a convenience, never an authorisation: choosing one
   * fills the form and still goes through preview and activate like anything
   * typed by hand.
   */
  readonly knownTargets: readonly RememberedTarget[]
}

/** One remembered activation target, as the panel shows it on a chip. */
export interface RememberedTarget {
  readonly kind: string
  readonly id: string
  readonly path: string
  /** ISO-8601 of the activation that last used it. */
  readonly lastUsedAt: string
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

/**
 * One live instance, as the floor and the profiles panel see it.
 *
 * Carries the PLAN it was activated under, not a freshly computed one: the
 * bundle on disk may have changed since, and what the Architect approved is
 * what these agents are actually running under.
 */
export interface ProfileInstanceView {
  readonly instanceId: string
  readonly plan: ActivationPlan
  readonly agentIds: readonly string[]
  readonly armed: readonly string[]
  /**
   * Event bindings declared but NOT armed — nothing publishes `webhook`, `ci`
   * or `health` yet (the Harbor is M7.3). Shown rather than hidden, so the gap
   * is a listed fact instead of a watcher the Architect believes is on duty.
   */
  readonly pendingEvents: readonly { readonly id: string; readonly event: string }[]
  readonly activatedAt: string
}

export type ActivationResult =
  | { readonly ok: true; readonly instance: ProfileInstanceView }
  | { readonly ok: false; readonly reasons: readonly string[] }

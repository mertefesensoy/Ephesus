import type { ShareManifest } from './share'

/**
 * What the renderer is told about sharing (SDD §5 `harbor:`, FR-10.4 — M7.6).
 *
 * Type-only, like the other `-view` modules: `src/shared/ipc.ts` must stay free
 * of runtime dependencies (the sandboxed preload cannot `require` zod), so the
 * shapes that cross the bridge live here and the schemas that validate them
 * stay in `share.ts`, imported only by main.
 */

export type ShareExport =
  | { readonly ok: true; readonly blob: string; readonly filename: string }
  | { readonly ok: false; readonly reason: string }

/**
 * The pre-filled form FR-10.4 requires — what importing this blob WOULD do.
 *
 * `manifest` is the RECOMPUTED disclosure, never the one the envelope carried.
 * That distinction is the point of the whole package: a human confirming
 * against an author-supplied summary is confirming a claim, and a human
 * confirming against a derived one is confirming a fact.
 */
export type ShareInspection =
  | {
      readonly ok: true
      readonly kind: 'hire' | 'profile'
      readonly manifest: ShareManifest
      /** True when something of this name is already installed here. */
      readonly replaces: boolean
    }
  | { readonly ok: false; readonly reasons: readonly string[] }

export type ShareInstall =
  | { readonly ok: true; readonly name: string; readonly replaced: boolean }
  | { readonly ok: false; readonly reasons: readonly string[] }

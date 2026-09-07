import { z } from 'zod'

/**
 * Engine identity and hook-fidelity vocabulary (ADR-0009). These live in
 * src/shared/ because both planes need them: main keys its adapter registry by
 * `EngineId`, and the renderer's agent card displays the declared `HookSupport`
 * grade. Renderer code imports these as types only — the zod schemas here are
 * for main-side validation of untrusted input (BUILD-PROMPT §3.9).
 */

/** The engine roster fixed by ADR-0009. New engines are added here + an adapter. */
export const ENGINE_IDS = ['claude', 'codex', 'gemini', 'grok', 'opencode', 'custom'] as const

export const engineIdSchema = z.enum(ENGINE_IDS)

export type EngineId = z.infer<typeof engineIdSchema>

/**
 * Hook fidelity grade (ADR-0009): `native` > `wrapper` > `none`.
 * The grade is displayed on the agent card and scales down floor detail and
 * breaker sensitivity (SDD §3) — a degraded engine is honest about it (FR-2.3).
 *
 * The bottom grade was called `pty-heuristic` until M8.11. It named a mechanism
 * that was never built — every occurrence was a declaration, a breaker
 * downgrade or a comment, and no adapter ever inferred an event from a PTY
 * stream. ADR-0024 §3 renamed it to what it is: an engine at this grade reports
 * NO hook events at all, so the floor has nothing to animate from and the
 * breaker's span-derived signals see nothing. A roster written before the
 * rename still reads — see `storedHookSupportSchema`.
 */
export const HOOK_SUPPORTS = ['native', 'wrapper', 'none'] as const

export const hookSupportSchema = z.enum(HOOK_SUPPORTS)

export type HookSupport = z.infer<typeof hookSupportSchema>

/**
 * Grade names this build no longer writes, mapped to what they became.
 *
 * A hook grade is not only a value in memory: it is cached on every roster
 * entry (`registry.json`'s `hookFidelity`), and the roster is a durable
 * schema'd file the Agora refuses to overwrite when it cannot parse it. So
 * dropping the old spelling from the enum without accepting it on READ would
 * make a roster written by an older build fail validation, and the company
 * would come up with an empty roster and a warning — losing every agent's seat
 * to a rename. Accepted here; normalized on the next write.
 */
export const LEGACY_HOOK_SUPPORTS: Readonly<Record<string, HookSupport>> = {
  'pty-heuristic': 'none'
}

/**
 * The hook grade as it may appear in a file this build did not write.
 *
 * Deliberately separate from `hookSupportSchema`: the vocabulary the code
 * SPEAKS is the enum above, and only the vocabulary it READS is widened. One
 * schema doing both would put `pty-heuristic` back into `HookSupport` and hand
 * every consumer a fourth case to handle forever.
 */
export const storedHookSupportSchema = z.preprocess(
  (raw) => (typeof raw === 'string' ? (LEGACY_HOOK_SUPPORTS[raw] ?? raw) : raw),
  hookSupportSchema
)

/**
 * Numeric encoding of the ADR-0009 ordering, so "declared grade matches
 * demonstrated events" (TEST-STRATEGY §5 hook-grade honesty) is a comparison
 * rather than a hand-rolled switch in every caller. Higher = more faithful.
 */
export const HOOK_SUPPORT_RANK: Readonly<Record<HookSupport, number>> = {
  native: 2,
  wrapper: 1,
  none: 0
}

/**
 * Whether an engine integration can enforce the autonomy the harness composed
 * (ADR-0031). Declared beside `HookSupport` and for the same reason: an
 * integration that cannot deliver something says so, and the harness acts on
 * the declaration rather than on an assumption.
 *
 * - `enforced` — every level reaches the engine as a flag or setting, so what
 *   the Watch composed is what the process runs at.
 * - `none` — the adapter has no way to say "ask me less" to this engine, so
 *   the engine's own configuration decides, and that configuration belongs to
 *   the operator rather than to the harness.
 *
 * There is deliberately no middle grade. A partial mapping is the dangerous
 * shape — it looks enforced and holds for some levels — so an integration that
 * cannot map ALL THREE declares `none` until it can.
 */
export const AUTONOMY_SUPPORTS = ['enforced', 'none'] as const

export const autonomySupportSchema = z.enum(AUTONOMY_SUPPORTS)

export type AutonomySupport = z.infer<typeof autonomySupportSchema>

/**
 * Contract: returns the `EngineId` for a well-known id, or null for anything
 * else. Never throws — callers decide whether an unknown id is a validation
 * error (IPC boundary) or a "no adapter installed" state (registry lookup).
 */
export function parseEngineId(raw: unknown): EngineId | null {
  const result = engineIdSchema.safeParse(raw)
  return result.success ? result.data : null
}

/**
 * The engine the MVP ships, and the only one a hire may declare (ADR-0024).
 *
 * ADR-0009 already made Claude Code the reference adapter and the only one that
 * may gate a release; SRS FR-1.2 requires only the seam. The normative
 * documents held this position all along — the shipping surface disagreed with
 * them, advertising five engines, two of which have no adapter in the tree at
 * all. This constant is where the disagreement is settled, and it is
 * deliberately ONE name rather than a list: an allowlist invites an entry, and
 * the bar for a second entry is ADR-0024's Revisiting section (the conformance
 * suite passing for that engine on autonomy, notification and trust), not a
 * commit.
 *
 * It is NOT the registry's question. `EngineRegistry.get` asks "does this build
 * carry an adapter"; this asks "may a hire run on it". Folding the second into
 * the first would make the conformance suite — which constructs the
 * unregistered adapters directly, on purpose — pass by special-casing Claude,
 * which is the one reading ADR-0024 forbids.
 */
export const REFERENCE_ENGINE: EngineId = 'claude'

/**
 * Contract: whether `engine` is the engine this build ships (ADR-0024). Pure,
 * total, and takes a plain string because a hire TEMPLATE may name anything —
 * `grok` and `opencode` are in `ENGINE_IDS` for ADR-0009's seam and have never
 * had an adapter, and an unknown string must get the same refusal rather than a
 * different one.
 */
export function isReferenceEngine(engine: string): boolean {
  return engine === REFERENCE_ENGINE
}

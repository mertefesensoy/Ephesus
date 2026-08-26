import { z } from 'zod'

/**
 * The hook wire format (FR-2.1, SDD §1 event plane). Engine hook shims POST one
 * of these envelopes per lifecycle event to the harness endpoint — a Unix domain
 * socket, or a named pipe on Windows.
 *
 * Two layers, on purpose:
 *
 *  - The **envelope** is ours and is `.strict()`. It is the shim contract, so an
 *    unexpected top-level key means a shim/harness version mismatch, which is a
 *    real error rather than engine drift.
 *  - The **event name** is a free string here, deliberately. Engines grow new
 *    lifecycle hooks; FR-2.3 requires that drift be *accepted with a visible
 *    warning*, never silently dropped, so an unknown name has to survive parsing
 *    long enough to be classified by `classifyHookEvent()`.
 *  - The **payload** is opaque at this layer (per-event validation lands with the
 *    hook server in M1.3), for the same drift reason.
 *
 * Event names are harness-normalized, not engine-native: `pre-tool`, not
 * `PreToolUse`. Mapping engine vocabulary onto this one is the adapter's job, so
 * that core (`hooks.ts`, the avatar machine, the floor) never learns a Claude-ism
 * (NFR-12, ADR-0009).
 */
export const HOOK_ENVELOPE_SCHEMA_VERSION = 1

/**
 * The normalized lifecycle vocabulary the harness understands today. Derived
 * from the SDD §6 transition triggers that arrive over the socket
 * (`prompt-submitted`, `pre-tool`, `post-tool`, `stop`, compaction), plus the
 * session bracket that binds a spawn to an engine session id — which is what
 * resume (FR-1.4) and the transcript reader (FR-11.2) key off.
 *
 * Anything outside this list is drift, not an error: see `classifyHookEvent()`.
 */
export const HOOK_EVENTS = [
  'session-start',
  'prompt-submitted',
  'pre-tool',
  'post-tool',
  'stop',
  'compact-start',
  'compact-end',
  'session-end'
] as const

export const hookEventSchema = z.enum(HOOK_EVENTS)

export type HookEvent = z.infer<typeof hookEventSchema>

/**
 * One hook post. `token` is the per-spawn hook token (ADR-0009 `EPH_HOOK_TOKEN`)
 * and is validated by the server on every payload; it is never logged and never
 * crosses the IPC boundary to the renderer.
 */
export const hookEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(HOOK_ENVELOPE_SCHEMA_VERSION),
    token: z.string().min(1).max(256),
    agentId: z.string().min(1).max(128),
    /** Free-form on purpose — unknown names are drift, handled visibly (FR-2.3). */
    event: z.string().min(1).max(64),
    /** Engine session id when the engine exposes one; null otherwise. */
    sessionId: z.string().min(1).max(256).nullable(),
    /** Epoch milliseconds as recorded by the shim. */
    ts: z.number().int().nonnegative(),
    /** Engine-specific detail; validated per event by the hook server (M1.3). */
    payload: z.unknown()
  })
  .strict()

export type HookEnvelope = z.infer<typeof hookEnvelopeSchema>

/** The HTTP path the shim POSTs to on the socket / named pipe. */
export const HOOK_ENDPOINT_PATH = '/hook'

export type HookEventClassification =
  | { readonly known: true; readonly event: HookEvent }
  | { readonly known: false; readonly event: string }

/**
 * Contract: never throws, never drops. A name in `HOOK_EVENTS` comes back
 * `known`; anything else comes back `known: false` carrying the raw name, so the
 * caller can raise the visible schema-drift warning FR-2.3 demands instead of
 * pretending the event did not happen.
 */
export function classifyHookEvent(event: string): HookEventClassification {
  const parsed = hookEventSchema.safeParse(event)
  return parsed.success ? { known: true, event: parsed.data } : { known: false, event }
}

/**
 * Contract: parses an envelope from untrusted bytes. Returns the envelope or a
 * one-line reason; never throws, because the hook server must answer a malformed
 * post with a logged rejection rather than a crashed listener.
 */
export function parseHookEnvelope(
  raw: unknown
):
  | { readonly ok: true; readonly envelope: HookEnvelope }
  | { readonly ok: false; readonly reason: string } {
  const parsed = hookEnvelopeSchema.safeParse(raw)
  if (parsed.success) return { ok: true, envelope: parsed.data }
  const first = parsed.error.issues[0]
  const where = first && first.path.length > 0 ? first.path.join('.') : 'envelope'
  return { ok: false, reason: `${where}: ${first?.message ?? 'invalid hook envelope'}` }
}

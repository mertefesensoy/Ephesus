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
  /**
   * The engine wants something from a human — a tool-permission dialog, a
   * folder-trust prompt. Unmapped through M1 and M2, which is exactly why an
   * agent could sit stalled behind a dialog with no harness-visible signal (the
   * M1 carried item). It is the first of SDD §9's three gate choke points.
   */
  'notification',
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
 * Contract: pure. Whether this event is the engine's own evidence that a TURN
 * is running — which is what tells the command queue its submit key landed and
 * more keys would not help (`commands.ts`, 2026-09-06).
 *
 * Three events, and the exclusions carry as much weight as the inclusions:
 *
 * - `prompt-submitted` is the direct answer: the prompt became a turn.
 * - `pre-tool`/`post-tool` are the indirect one. The wake path deliberately
 *   sends to an agent it believes idle and tolerates being wrong (`isIdle`,
 *   `index.ts`); when it is wrong the engine QUEUES the text behind the running
 *   turn and `prompt-submitted` does not arrive for minutes. Without these, a
 *   perfectly healthy mid-turn nudge would spend the whole key budget and be
 *   reported as unaccepted.
 * - `session-start` is excluded. A session exists long before its prompt
 *   accepts anything — that gap IS the defect the budget was added for, and
 *   counting it as evidence would restore it exactly.
 * - `stop` is excluded. A turn ending says nothing about whether OUR text was
 *   the one that ran, and text sent as a turn ends still needs its key.
 * - `notification` is excluded, and pointedly: it is the engine saying a dialog
 *   is up, which is the very thing that eats submit keys.
 *
 * Takes the RAW name, because that is what an envelope carries (FR-2.3 keeps
 * drift addressable rather than dropping it). A name this build does not know
 * answers `false`: an unrecognised event is not evidence of anything, and the
 * cost of being wrong that way is one spare keystroke.
 */
export function provesTurnRunning(event: string): boolean {
  const classified = classifyHookEvent(event)
  if (!classified.known) return false
  // Narrowed first so these literals are checked against `HookEvent` — a typo
  // here would otherwise compile to a branch that is simply never taken.
  const known: HookEvent = classified.event
  return known === 'prompt-submitted' || known === 'pre-tool' || known === 'post-tool'
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

/**
 * Per-event payload shapes. Deliberately *loose*: an engine that adds a field to
 * a payload has not broken anything, and rejecting it would violate FR-2.3's
 * "never silent failure, never brittle failure" stance. Only the fields the
 * harness actually reads are required.
 *
 * `pre-tool`/`post-tool` require `tool` because the station map (SDD §6) routes
 * an avatar by tool class — without a tool name there is no station to walk to,
 * which is real drift worth a visible warning.
 */
const anyPayload = z.looseObject({})

export const HOOK_PAYLOAD_SCHEMAS: Readonly<Record<HookEvent, z.ZodType>> = {
  'session-start': anyPayload,
  'prompt-submitted': anyPayload,
  'pre-tool': z.looseObject({ tool: z.string().min(1) }),
  'post-tool': z.looseObject({ tool: z.string().min(1) }),
  // Loose like the rest: engines word their prompts differently, and the
  // harness reads only `message` when the engine offers one. A notification
  // with no message still opens a gate — "the engine is waiting on you" is the
  // fact that matters, and losing it to a missing field is the stall this
  // event exists to end.
  notification: anyPayload,
  stop: anyPayload,
  'compact-start': anyPayload,
  'compact-end': anyPayload,
  'session-end': anyPayload
}

/**
 * The outcome of validating one hook post's payload. Every branch is *accepted*
 * — FR-2.3 allows exactly one response to drift, and it is "accept, warn
 * visibly, degrade". A non-null `warning` is what the UI must surface.
 */
export interface HookPayloadCheck {
  /** True when the event name is in `HOOK_EVENTS`. */
  readonly known: boolean
  /** The normalized event when known; the raw name otherwise. */
  readonly event: string
  /** Human-readable drift description, or null when the post matched the spec. */
  readonly warning: string | null
}

/**
 * Contract: never rejects. Returns `warning: null` for a known event with a
 * conforming payload; a one-line warning for an unknown event name or a payload
 * missing a field the harness reads. The caller stores the event either way and
 * shows the warning (FR-2.3, ENGINEERING-STANDARDS §4 "fail loud, degrade
 * visible").
 */
export function checkHookPayload(event: string, payload: unknown): HookPayloadCheck {
  const classification = classifyHookEvent(event)
  if (!classification.known) {
    return {
      known: false,
      event: classification.event,
      warning: `unknown hook event "${classification.event}" — engine schema drift; event recorded, avatar detail degraded`
    }
  }
  const schema = HOOK_PAYLOAD_SCHEMAS[classification.event]
  const parsed = schema.safeParse(payload)
  if (parsed.success) return { known: true, event: classification.event, warning: null }
  const first = parsed.error.issues[0]
  const where = first && first.path.length > 0 ? first.path.join('.') : 'payload'
  const reason = first?.message ?? 'payload did not match'
  return {
    known: true,
    event: classification.event,
    warning: `hook payload drift on "${classification.event}": ${where}: ${reason}`
  }
}

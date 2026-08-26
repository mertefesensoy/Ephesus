import { z } from 'zod'
import { agentIdSchema } from './agents'

/**
 * The Hermes message (SDD §4.4, FR-3.1) — a FIPA-lite speech act in a single
 * JSON file. The indirection *is* the design (ADR-0003): agents write only in
 * their own outbox, the router delivers, and nothing is ever written by two
 * processes.
 *
 * The anti-livelock rules are transport rules, not etiquette — which is why
 * `requires_reply` is *derived from the act* here rather than trusted from the
 * sender. An agent cannot opt out of owing a reply by clearing a flag.
 */
export const MESSAGE_SCHEMA_VERSION = 1

/** ADR-0003 speech acts. */
export const SPEECH_ACTS = [
  'request',
  'inform',
  'propose',
  'query',
  'agree',
  'refuse',
  'done'
] as const

export const speechActSchema = z.enum(SPEECH_ACTS)

export type SpeechAct = z.infer<typeof speechActSchema>

/** Only these obligate a reply (ADR-0003, FR-3.3). */
export const REPLY_OBLIGING_ACTS: readonly SpeechAct[] = ['request', 'query', 'propose']

/** Contract: pure. The single source of truth for the obligation table. */
export function requiresReply(act: SpeechAct): boolean {
  return REPLY_OBLIGING_ACTS.includes(act)
}

/** Special addresses (ADR-0003, FR-3.7). */
export const BROADCAST = 'broadcast'
export const HUMAN = 'human'

export const recipientSchema = z.union([agentIdSchema, z.literal(BROADCAST), z.literal(HUMAN)])

/**
 * Time-sortable unique id: `<ISO with : and . replaced by ->-<random>`, e.g.
 * `2026-08-26T14-03-11-123Z-a1b2`. Sortable ids let a consumer reason about
 * order without a clock of its own, and make the inbox listing chronological.
 */
export const messageIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{4,16}$/,
    'message id: <time-sortable timestamp>-<suffix>'
  )

export const messageSchema = z
  .object({
    id: messageIdSchema,
    conversation: z.string().min(1).max(64),
    in_reply_to: messageIdSchema.nullable(),
    from: agentIdSchema,
    to: recipientSchema,
    act: speechActSchema,
    subject: z.string().min(1).max(200),
    body: z.string().max(200_000),
    hops: z.number().int().min(0).max(100),
    requires_reply: z.boolean(),
    needs_human: z.boolean(),
    created_at: z.string().min(1).max(64)
  })
  .strict()

export type Message = z.infer<typeof messageSchema>

export type MessageParse =
  { readonly ok: true; readonly message: Message } | { readonly ok: false; readonly reason: string }

/**
 * Contract: validates a message an *agent* wrote, so it never throws and never
 * trusts. Two checks beyond the schema:
 *
 *  - `requires_reply` must match what the act implies. A sender that disagrees
 *    is either buggy or trying to dodge the obligation table; either way the
 *    router will not carry it.
 *  - a message cannot be `in_reply_to` itself.
 */
export function parseMessage(raw: unknown): MessageParse {
  const parsed = messageSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'message'
    return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid message'}` }
  }

  const message = parsed.data
  if (message.requires_reply !== requiresReply(message.act)) {
    return {
      ok: false,
      reason: `requires_reply must be ${requiresReply(message.act)} for act "${message.act}" (ADR-0003 obligation table)`
    }
  }
  if (message.in_reply_to === message.id) {
    return { ok: false, reason: 'in_reply_to: a message cannot reply to itself' }
  }

  return { ok: true, message }
}

/** Contract: a time-sortable id for `at`, with a random suffix for uniqueness. */
export function makeMessageId(at: Date, suffix: string): string {
  const stamp = at.toISOString().replace(/:/g, '-').replace(/\./g, '-')
  return `${stamp}-${suffix}`
}

/**
 * Contract: builds a well-formed message, deriving `requires_reply` rather than
 * accepting it. Used by the harness (bounces, broadcasts) and by tests; agents
 * write their own files and are validated on pickup.
 */
export function composeMessage(fields: {
  readonly id: string
  readonly conversation: string
  readonly in_reply_to?: string | null
  readonly from: string
  readonly to: string
  readonly act: SpeechAct
  readonly subject: string
  readonly body: string
  readonly hops?: number
  readonly needs_human?: boolean
  readonly created_at: string
}): Message {
  return messageSchema.parse({
    id: fields.id,
    conversation: fields.conversation,
    in_reply_to: fields.in_reply_to ?? null,
    from: fields.from,
    to: fields.to,
    act: fields.act,
    subject: fields.subject,
    body: fields.body,
    hops: fields.hops ?? 0,
    requires_reply: requiresReply(fields.act),
    needs_human: fields.needs_human ?? false,
    created_at: fields.created_at
  })
}

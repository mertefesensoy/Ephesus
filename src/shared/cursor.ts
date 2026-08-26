import { z } from 'zod'
import { messageIdSchema } from './message'

/**
 * The per-agent consumption cursor (`agora/agents/<id>/cursor.json`, SDD §2).
 *
 * ADR-0003 makes consumption idempotent: "a re-seen `id` is a no-op (per-agent
 * cursor); processed mail moves to `inbox/.done/`". The cursor is the
 * high-water mark; `.done/` is the authority on what has actually been
 * consumed. Both exist because they answer different questions — the cursor
 * says how far we got, `.done/` says whether *this* message was handled, and
 * only the second survives out-of-order delivery.
 */
export const CURSOR_SCHEMA_VERSION = 1

export const cursorSchema = z
  .object({
    schemaVersion: z.literal(CURSOR_SCHEMA_VERSION),
    /** Highest message id consumed so far, or null before the first. */
    lastProcessed: messageIdSchema.nullable()
  })
  .strict()

export type Cursor = z.infer<typeof cursorSchema>

export const emptyCursor: Cursor = { schemaVersion: CURSOR_SCHEMA_VERSION, lastProcessed: null }

/**
 * Contract: never throws. An unreadable cursor reads as empty — the worst case
 * is re-offering mail that `.done/` will then filter out, which is exactly the
 * failure mode idempotency exists to absorb.
 */
export function parseCursor(raw: unknown): Cursor {
  const parsed = cursorSchema.safeParse(raw)
  return parsed.success ? parsed.data : emptyCursor
}

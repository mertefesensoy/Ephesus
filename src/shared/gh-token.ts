import { z } from 'zod'

/**
 * The agent-facing GitHub credential refresh (ADR-0022).
 *
 * An installation token lives one hour. An agent receives one in its
 * environment at spawn and holds that copy for as long as it runs, so a crew
 * member alive past the hour pushes with a dead credential and gets a 401 that
 * looks exactly like a permissions mistake. The harness refreshes its own copy
 * at fifty minutes; this is how a running agent asks for that fresher one.
 *
 * It rides the socket `eph-recall` already uses (ADR-0006 layer 2): one 0600
 * socket, one per-spawn token. A second channel for a second purpose would be a
 * second thing to secure.
 */
export const GH_TOKEN_SCHEMA_VERSION = 1

/** The HTTP path the harness answers on, beside `/hook` and `/recall`. */
export const GH_TOKEN_ENDPOINT_PATH = '/gh-token'

export const ghTokenRequestSchema = z
  .object({
    schemaVersion: z.literal(GH_TOKEN_SCHEMA_VERSION),
    /** The per-spawn hook token; the same credential `/recall` is gated on. */
    token: z.string().min(1).max(256),
    agentId: z.string().min(1).max(128)
  })
  .strict()

export type GhTokenRequest = z.infer<typeof ghTokenRequestSchema>

/**
 * The answer. A refusal carries a reason and never a token, and the reason is
 * written for the agent that has to act on it rather than for a log reader:
 * "your role does not declare GH_TOKEN" is something an agent can stop doing,
 * where "forbidden" is not.
 */
export type GhTokenResponse =
  | {
      readonly schemaVersion: typeof GH_TOKEN_SCHEMA_VERSION
      readonly ok: true
      readonly token: string
      /** ISO-8601, so an agent can decide whether to refresh before a long push. */
      readonly expiresAt: string | null
    }
  | {
      readonly schemaVersion: typeof GH_TOKEN_SCHEMA_VERSION
      readonly ok: false
      readonly because: string
    }

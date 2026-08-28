/**
 * Identities the harness reserves for itself.
 *
 * Three things in this system write mail without being agents: the router, when
 * it refuses an undeliverable message; the ledger endpoint, when it accepts or
 * refuses a proposal; and the Library, when it asks an agent to condense its
 * memory and answers the result (ADR-0006 layer 3). Until M3 the router-authored refusal claimed
 * `from: <the original sender>` — a message the sender never wrote, attributed
 * to them — because SDD §4.4 gave the harness no legal `from`. That was
 * recorded at the M2 close-out as a gap for M3 to consider "alongside Artemis's
 * proxy role", and this module is the answer: reserved *agent ids*, which §4.4's
 * `from`/`to` domain already permits, so nothing about the schema changes.
 *
 * Reserved means reserved: `spawnRequestSchema` refuses these ids, so no hire
 * can ever take one and forge a refusal in the harness's name.
 *
 * Deliberately imports nothing — `agents.ts` validates spawn ids against it,
 * and a cycle in a module zod initializes at import time is a crash, not a
 * style problem.
 */

/** Author of router-written refusals (ADR-0003's bounce). */
export const HERMES_SENDER = 'agent.hermes'

/** The harness's ledger endpoint (SDD §7.1). Never spawned, never a mailbox. */
export const LEDGER_ENDPOINT = 'agent.ledger'

/**
 * The Library's reflection endpoint (ADR-0006 layer 3).
 *
 * Reflection asks an agent to condense its own memory and takes the answer
 * back through the mail plane, because ADR-0005 rejects the alternative
 * outright: the harness does not call a model. It asks a correspondent, and
 * this is the correspondent's address — the standing rule the Architect
 * ratified at the M3 close for harness-owned endpoints.
 */
export const LIBRARY_ENDPOINT = 'agent.library'

/**
 * The closing-time endpoint (GYM-003). At an orderly quit the harness mails
 * every live agent a `request` from this address — park WIP, append state to
 * `memory.md`, acknowledge — and the workers' replies route back here as an
 * endpoint hand-off, exactly the standing rule the Architect ratified at the
 * M3 close for harness-owned correspondents. Never spawned, never a mailbox.
 */
export const CLOSING_ENDPOINT = 'agent.closing'

/**
 * The Odeon's filing endpoint (ADR-0008, FR-7.2).
 *
 * SDD §2 gives `odeon/` to the harness alone, so an agent files an accountability
 * artifact the only way it can say anything — a message from its own outbox to
 * this address. That single rule is what makes the archive trustworthy: a deck
 * cannot be back-dated, edited in place, or written for a task its author was
 * never given.
 */
export const ODEON_ENDPOINT = 'agent.odeon'

export const RESERVED_AGENT_IDS: readonly string[] = [
  HERMES_SENDER,
  LEDGER_ENDPOINT,
  LIBRARY_ENDPOINT,
  CLOSING_ENDPOINT,
  ODEON_ENDPOINT
]

/** Contract: whether this id belongs to the harness rather than to a hire. */
export function isReservedAgentId(agentId: string): boolean {
  return RESERVED_AGENT_IDS.includes(agentId)
}

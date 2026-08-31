import { IMPROVEMENT_ROLES, isImprovementRole } from './mode'

/**
 * Whose spend belongs to which slice — the carried item from the M5 and M5b
 * close-outs (FR-12.5, R3, ADR-0017).
 *
 * Until now `Gymnasium.slice()` returned `spentTokens: null` and the standup
 * brief said "not yet attributed", which was the honest answer while nothing
 * attributed anything: reporting zero would have claimed a measurement nobody
 * had taken (invariant §7). This module is the measurement.
 *
 * Two rules shape it:
 *
 * 1. **The figure comes from the durable ledger** (invariant §11, ADR-0011).
 *    Never an in-memory counter, so a restart cannot reset it — the exact bug
 *    class §11 exists to forbid.
 * 2. **Attribution is by ROLE, exactly.** `isImprovementRole` already refuses
 *    substring matching (the M5b audit's `includes('improv')` finding), and the
 *    same discipline applies here: a hire named "process-improver-docs" is not
 *    improvement work because its name contains a word.
 */

/** The slices a spend figure can be attributed to. */
export const SPEND_SCOPES = ['gymnasium', 'stoa'] as const

export type SpendScope = (typeof SPEND_SCOPES)[number]

/** One roster row, as much of it as attribution needs. */
export interface AttributableAgent {
  readonly agentId: string
  readonly role: string
}

/**
 * Contract: the agents whose spend belongs to a scope.
 *
 * - `gymnasium` is the whole improvement slice — ADR-0019's improvement roles,
 *   which is what FR-12.5's weekly budget is a budget *for*.
 * - `stoa` is the researcher alone: the Stoa's reading is a subset of
 *   improvement work, so a company running both sees the Stoa's spend inside
 *   the gym slice AND named separately. That is deliberate, and the source
 *   line says so, because a reader who saw two numbers and assumed they added
 *   up would be wrong.
 */
export function agentsInScope(
  roster: readonly AttributableAgent[],
  scope: SpendScope
): readonly string[] {
  return roster
    .filter((agent) =>
      scope === 'gymnasium'
        ? isImprovementRole(agent.role)
        : agent.role.trim().toLowerCase() === 'researcher'
    )
    .map((agent) => agent.agentId)
}

/**
 * How many tokens the durable ledger has recorded for one agent.
 *
 * Taken as a function rather than a row list so production and the tests reach
 * the SAME number by the same route: main passes the `CostLedger`'s own
 * `spendFor(...).cumulativeTotals`, and a test passes a table. Two paths to one
 * figure is exactly how a total drifts from the ledger it claims to come from.
 */
export type TokensFor = (agentId: string) => number

/**
 * Contract: tokens attributed to these agents. Zero when the scope has no
 * agents — a measurement ("nobody is doing this work"), not the absence of one.
 */
export function attributedTokens(agents: readonly string[], tokensFor: TokensFor): number {
  return agents.reduce((total, agentId) => total + Math.max(0, tokensFor(agentId)), 0)
}

/**
 * Contract: where the figure came from, in words, for the brief to print.
 *
 * The M5 close-out asked for the number back "with its source named", and the
 * naming is the point: a bare token count invites the reader to trust a total
 * whose scope they cannot see. This says which agents it covers.
 */
export function attributionSource(scope: SpendScope, agents: readonly string[]): string {
  if (agents.length === 0) {
    return `cost ledger — no ${scope === 'stoa' ? 'researcher' : 'improvement'} agents hired`
  }
  const who = agents.length === 1 ? '1 agent' : `${String(agents.length)} agents`
  return `cost ledger — ${who} (${agents.join(', ')})`
}

export interface AttributedSpend {
  readonly scope: SpendScope
  readonly tokens: number
  readonly agents: readonly string[]
  readonly source: string
}

/** Contract: a scope's spend, its agents, and the sentence naming its source. */
export function attributeSpend(
  roster: readonly AttributableAgent[],
  scope: SpendScope,
  tokensFor: TokensFor
): AttributedSpend {
  const agents = agentsInScope(roster, scope)
  return {
    scope,
    tokens: attributedTokens(agents, tokensFor),
    agents,
    source: attributionSource(scope, agents)
  }
}

/** Re-exported so a caller can show the vocabulary attribution actually uses. */
export { IMPROVEMENT_ROLES }

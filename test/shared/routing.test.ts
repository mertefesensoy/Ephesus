import { describe, expect, it } from 'vitest'
import { LEDGER_ENDPOINT, LIBRARY_ENDPOINT } from '../../src/shared/reserved'
import {
  BROADCAST,
  HUMAN,
  composeMessage,
  makeMessageId,
  type Message
} from '../../src/shared/message'
import {
  DEFAULT_HOP_CAP,
  HUMAN_QUEUE,
  replyHops,
  routeMessage,
  type RoutingContext
} from '../../src/shared/routing'

/**
 * The transport rules of ADR-0003, asserted as pure functions. S-LIVELOCK and
 * S-BOUNCE assert the same rules end-to-end in M2.7; this file is where the
 * boundary cases live, because a rule you can only test through two spawned
 * agents is a rule nobody will test.
 */

function message(over: Partial<Parameters<typeof composeMessage>[0]> = {}): Message {
  return composeMessage({
    id: '2026-08-26T14-03-11-123Z-a1b2',
    conversation: 'conv-7f3',
    from: 'agent.a',
    to: 'agent.b',
    act: 'request',
    subject: 'need the numbers',
    body: 'please',
    created_at: '2026-08-26T14:03:11.123Z',
    ...over
  })
}

const roster: RoutingContext = {
  knownAgents: ['agent.a', 'agent.b', 'agent.c'],
  orchestratorId: null
}

describe('ordinary delivery', () => {
  it('delivers to a known recipient', () => {
    expect(routeMessage(message(), roster)).toEqual({ kind: 'deliver', to: ['agent.b'] })
  })

  it('does not care about the act — the obligation table is a separate rule', () => {
    for (const act of ['request', 'inform', 'agree', 'done'] as const) {
      expect(routeMessage(message({ act }), roster).kind).toBe('deliver')
    }
  })
})

describe('the hop cap fires at exactly the cap (FR-3.3, S-LIVELOCK)', () => {
  it('delivers one hop below the cap', () => {
    const route = routeMessage(message({ hops: DEFAULT_HOP_CAP - 1 }), roster)
    expect(route.kind).toBe('deliver')
  })

  it('diverts AT the cap, not after it', () => {
    const route = routeMessage(message({ hops: DEFAULT_HOP_CAP }), roster)
    expect(route.kind).toBe('divert')
    if (route.kind === 'divert') {
      expect(route.to).toBe(HUMAN_QUEUE)
      expect(route.reason).toContain(`hop cap ${DEFAULT_HOP_CAP}`)
    }
  })

  it('keeps diverting above the cap', () => {
    expect(routeMessage(message({ hops: DEFAULT_HOP_CAP + 5 }), roster).kind).toBe('divert')
  })

  it('diverts to Artemis once an orchestrator exists', () => {
    const route = routeMessage(message({ hops: DEFAULT_HOP_CAP }), {
      ...roster,
      orchestratorId: 'agent.artemis'
    })
    expect(route).toMatchObject({ kind: 'divert', to: 'agent.artemis' })
  })

  it('checks the cap BEFORE the address — a livelock is caught even to a dead agent', () => {
    // Stopping the loop matters more than adjudicating the address.
    const route = routeMessage(message({ to: 'agent.gone', hops: DEFAULT_HOP_CAP }), roster)
    expect(route.kind).toBe('divert')
  })

  it('honours a custom cap', () => {
    expect(routeMessage(message({ hops: 2 }), { ...roster, hopCap: 3 }).kind).toBe('deliver')
    expect(routeMessage(message({ hops: 3 }), { ...roster, hopCap: 3 }).kind).toBe('divert')
  })

  it('increments hops on every reply, which is what makes the cap reachable', () => {
    expect(replyHops(message({ hops: 0 }))).toBe(1)
    expect(replyHops(message({ hops: 7 }))).toBe(8)
  })

  it('reaches the cap in exactly cap ping-pongs', () => {
    // The S-LIVELOCK arithmetic, stated once here so the scenario suite can
    // assert behaviour rather than re-derive the boundary.
    let hops = 0
    let bounces = 0
    while (routeMessage(message({ hops }), roster).kind === 'deliver') {
      hops = replyHops(message({ hops }))
      bounces += 1
      if (bounces > 100) break
    }
    expect(hops).toBe(DEFAULT_HOP_CAP)
    expect(bounces).toBe(DEFAULT_HOP_CAP)
  })
})

describe('undeliverable mail bounces (FR-3.4, S-BOUNCE)', () => {
  it('bounces to a recipient with no mailbox', () => {
    const route = routeMessage(message({ to: 'agent.gone' }), roster)
    expect(route.kind).toBe('bounce')
    if (route.kind === 'bounce') expect(route.reason).toContain('agent.gone')
  })

  it('bounces rather than dropping, for every act', () => {
    for (const act of ['request', 'inform', 'refuse', 'done'] as const) {
      expect(routeMessage(message({ to: 'agent.gone', act }), roster).kind).toBe('bounce')
    }
  })

  it('never returns nothing — every message is delivered, diverted or bounced', () => {
    const cases: Message[] = [
      message(),
      message({ to: 'agent.gone' }),
      message({ to: BROADCAST }),
      message({ to: HUMAN }),
      message({ hops: 99 })
    ]
    for (const m of cases) {
      expect(['deliver', 'divert', 'bounce']).toContain(routeMessage(m, roster).kind)
    }
  })
})

describe('special addresses (FR-3.7)', () => {
  it('fans a broadcast out to everyone but the sender', () => {
    const route = routeMessage(message({ to: BROADCAST }), roster)
    expect(route).toEqual({ kind: 'deliver', to: ['agent.b', 'agent.c'] })
  })

  it('bounces a broadcast with nobody to hear it', () => {
    const route = routeMessage(message({ to: BROADCAST }), {
      knownAgents: ['agent.a'],
      orchestratorId: null
    })
    expect(route.kind).toBe('bounce')
  })

  it('routes to:human to Artemis when the orchestrator exists', () => {
    expect(
      routeMessage(message({ to: HUMAN }), { ...roster, orchestratorId: 'agent.artemis' })
    ).toEqual({ kind: 'deliver', to: ['agent.artemis'] })
  })

  it('never delivers the proxy her own to:human mail — it queues for the Architect', () => {
    // Artemis is the human's proxy (FR-3.7); if SHE mails the human, routing
    // back to her own inbox would swallow the escalation (M3 audit, N4).
    expect(
      routeMessage(message({ from: 'agent.artemis', to: HUMAN }), {
        ...roster,
        orchestratorId: 'agent.artemis'
      })
    ).toEqual({ kind: 'deliver', to: [HUMAN_QUEUE] })
  })

  it('queues to:human for the Architect when there is no proxy yet', () => {
    // Losing a message addressed to the human would be the worst outcome
    // available, so it queues rather than bouncing.
    expect(routeMessage(message({ to: HUMAN }), roster)).toEqual({
      kind: 'deliver',
      to: [HUMAN_QUEUE]
    })
  })
})

describe('the ledger endpoint is addressable, and guarded (SDD §7.1)', () => {
  const LEDGER = LEDGER_ENDPOINT
  const ctx = {
    knownAgents: ['agent.artemis', 'agent.mason'],
    orchestratorId: 'agent.artemis'
  }

  function proposal(over: Partial<Message> = {}): Message {
    return composeMessage({
      id: makeMessageId(new Date(), 'aa11'),
      conversation: 'conv-1',
      from: 'agent.artemis',
      to: LEDGER,
      act: 'propose',
      subject: 'decompose the directive',
      body: '{}',
      created_at: new Date().toISOString(),
      ...over
    })
  }

  it('hands the orchestrator’s proposal to the endpoint, not to a mailbox', () => {
    expect(routeMessage(proposal(), ctx)).toEqual({ kind: 'endpoint', endpoint: LEDGER })
  })

  it('refuses a writer who is not the orchestrator', () => {
    // "Agents never touch tasks.json" — enforced at the transport layer, where
    // ADR-0003 puts the addressing rules.
    const route = routeMessage(proposal({ from: 'agent.mason' }), ctx)
    expect(route.kind).toBe('bounce')
    expect(route.kind === 'bounce' ? route.reason : '').toMatch(/only the orchestrator/)
  })

  it('refuses an act that is not a proposal', () => {
    for (const act of ['request', 'inform', 'done'] as const) {
      const route = routeMessage(proposal({ act }), ctx)
      expect(route.kind, act).toBe('bounce')
    }
  })

  it('refuses when no orchestrator is hired', () => {
    const route = routeMessage(proposal(), { ...ctx, orchestratorId: null })
    expect(route.kind).toBe('bounce')
    expect(route.kind === 'bounce' ? route.reason : '').toMatch(/no orchestrator/)
  })

  it('still catches a livelocked proposal at the hop cap first', () => {
    // The cap exists to stop loops, whatever the address.
    const route = routeMessage(proposal({ hops: DEFAULT_HOP_CAP }), ctx)
    expect(route.kind).toBe('divert')
  })

  it('does not need a mailbox to exist for the endpoint', () => {
    expect(ctx.knownAgents).not.toContain(LEDGER)
    expect(routeMessage(proposal(), ctx).kind).toBe('endpoint')
  })
})

describe('mail for the Architect reaches Artemis (FR-3.7, ADR-0005)', () => {
  function toHuman(): Message {
    return composeMessage({
      id: makeMessageId(new Date(), 'bb22'),
      conversation: 'conv-2',
      from: 'agent.mason',
      to: 'human',
      act: 'query',
      subject: 'which staging database?',
      body: 'both look current',
      created_at: new Date().toISOString()
    })
  }

  it('routes to the orchestrator when one is hired', () => {
    const route = routeMessage(toHuman(), {
      knownAgents: ['agent.mason'],
      orchestratorId: 'agent.artemis'
    })
    expect(route).toEqual({ kind: 'deliver', to: ['agent.artemis'] })
  })

  it('queues for the Architect when there is no proxy', () => {
    // Losing a message addressed to the human would be the worst outcome
    // available, so with no orchestrator it queues rather than bouncing.
    const route = routeMessage(toHuman(), { knownAgents: ['agent.mason'], orchestratorId: null })
    expect(route).toEqual({ kind: 'deliver', to: [HUMAN_QUEUE] })
  })
})

describe('the library endpoint (ADR-0006 layer 3)', () => {
  it('takes a propose from any agent — it can only act on the sender', () => {
    const route = routeMessage(
      message({ from: 'agent.mason', to: LIBRARY_ENDPOINT, act: 'propose' }),
      { knownAgents: ['agent.mason'], orchestratorId: null }
    )
    expect(route).toEqual({ kind: 'endpoint', endpoint: LIBRARY_ENDPOINT })
  })

  it('needs no orchestrator, unlike the ledger', () => {
    const route = routeMessage(
      message({ from: 'agent.iris', to: LIBRARY_ENDPOINT, act: 'propose' }),
      { knownAgents: ['agent.iris'], orchestratorId: null }
    )
    expect(route.kind).toBe('endpoint')
  })

  it('bounces anything that is not a propose', () => {
    const route = routeMessage(
      message({ from: 'agent.mason', to: LIBRARY_ENDPOINT, act: 'inform' }),
      { knownAgents: ['agent.mason'], orchestratorId: null }
    )
    expect(route.kind).toBe('bounce')
    if (route.kind === 'bounce') expect(route.reason).toContain('library endpoint takes')
  })
})

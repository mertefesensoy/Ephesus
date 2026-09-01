import { describe, expect, it } from 'vitest'
import { RESERVED_AGENT_IDS } from '../../src/shared/reserved'
import {
  ENDPOINT_CONTRACTS,
  TERMINAL_ACTS,
  endpointContract,
  obligesReply,
  type EndpointContract
} from '../../src/shared/endpoints'
import { SPEECH_ACTS, composeMessage, type Message, type SpeechAct } from '../../src/shared/message'
import { routeMessage, type RoutingContext } from '../../src/shared/routing'

/**
 * The guard that closes the half-wired-endpoint bug class.
 *
 * It has been found twice. `agent.profiles` shipped sending every scheduled
 * trigger wake with no branch in `routeMessage` at all, so the crew swept all
 * evening on the 2026-09-01 live run and every report bounced with `no mailbox
 * for "agent.profiles"`. `agent.harbor` shipped sending the triage request
 * while its handler could read only a triage report, so any other honest answer
 * came back as a parse error. Both were found by a human reading a live run.
 *
 * A convention would not have caught either, and neither would a rule that
 * merely reports. This file FAILS, and it fails from the source of truth: it
 * iterates `RESERVED_AGENT_IDS`, so an eighth endpoint is covered the moment it
 * is declared, without anyone remembering to add a case here.
 *
 * Why a test and not a `scripts/check-invariants.cjs` rule: that script greps
 * source text for patterns a reviewer cannot hold in their head (a `git` call
 * outside `src/main/git.ts`, a truncating write to `log.jsonl`). The property
 * here is not textual — it is what a pure function RETURNS for a given message.
 * A grep could assert that every reserved id appears somewhere in `routing.ts`
 * and would have caught the first instance, but it would have passed the second
 * happily: `agent.harbor` was named in a branch that refused the acts its own
 * requests obliged. Executing `routeMessage` is the only check that sees both,
 * and it cannot go stale against a refactor the way a pattern can.
 */

const ROSTER: RoutingContext = {
  knownAgents: ['agent.mason'],
  // The ledger's extra rules read the context, so the sender must BE the
  // orchestrator for its contract to be exercised rather than short-circuited.
  orchestratorId: 'agent.mason'
}

function replyTo(endpoint: string, act: SpeechAct): Message {
  return composeMessage({
    id: '2026-09-01T18-30-00-000Z-a1b2',
    conversation: 'conv-endpoint',
    in_reply_to: null,
    from: 'agent.mason',
    to: endpoint,
    act,
    subject: 'answering what you asked me',
    body: 'the answer',
    hops: 1,
    created_at: '2026-09-01T18:30:00.000Z'
  })
}

describe('the reserved endpoints are declared, in full', () => {
  it('gives every reserved id a contract — a new endpoint fails here first', () => {
    // The fail-closed hinge of the whole file. Add a const to
    // `RESERVED_AGENT_IDS` and ship it with no contract, and this is the test
    // that stops it — which is exactly what nobody was there to do for
    // `agent.profiles`.
    const declared = ENDPOINT_CONTRACTS.map((contract) => contract.id).sort()
    expect(declared).toEqual([...RESERVED_AGENT_IDS].sort())
  })

  it('declares no contract for an id that is not reserved', () => {
    for (const contract of ENDPOINT_CONTRACTS) {
      expect(RESERVED_AGENT_IDS).toContain(contract.id)
    }
  })

  it('names the four terminal acts, derived from the obligation table', () => {
    // Not hard-coded in `endpoints.ts` — derived — so this pins the derivation
    // rather than restating it. An act joins this set exactly when replying to
    // it obliges nothing further.
    expect([...TERMINAL_ACTS].sort()).toEqual(['agree', 'done', 'inform', 'refuse'])
  })

  it('handles only what it accepts', () => {
    for (const contract of ENDPOINT_CONTRACTS) {
      for (const act of contract.handles) {
        expect(contract.accepts, `${contract.id} handles "${act}" without accepting it`).toContain(
          act
        )
      }
    }
  })
})

/**
 * THE invariant. An endpoint that asks an agent a question has to be able to
 * hear every answer the agent is allowed to give — and PROTOCOL.md tells every
 * agent to "`refuse` and say why" when it cannot do what was asked, and to say
 * so "when you finish". Those answers were bouncing off five of the six
 * endpoints that had a branch at all.
 */
describe('an endpoint that asks a question can hear the answer', () => {
  const askers = ENDPOINT_CONTRACTS.filter(obligesReply)

  it('there is at least one such endpoint, or this suite proves nothing', () => {
    expect(askers.length).toBeGreaterThan(0)
  })

  it.each(askers.map((contract) => [contract.id, contract] as const))(
    '%s accepts every terminal act',
    (_id, contract: EndpointContract) => {
      for (const act of TERMINAL_ACTS) {
        expect(
          contract.accepts,
          `${contract.id} sends ${contract.sends.join('/')} — which obliges a reply — but refuses "${act}"`
        ).toContain(act)
      }
    }
  )

  it('a deaf endpoint never asks a question it cannot hear answered', () => {
    for (const contract of ENDPOINT_CONTRACTS) {
      if (contract.accepts.length > 0) continue
      expect(obligesReply(contract), `${contract.id} obliges a reply it cannot receive`).toBe(false)
      // Deafness is a decision, and it has to be written down: the reason is
      // what the sender is told instead of the false `no mailbox` claim.
      expect(contract.deaf, `${contract.id} is deaf with no reason given`).toBeTruthy()
    }
  })
})

/**
 * The table is not allowed to be decoration. Everything above asserts what the
 * contracts SAY; this asserts that `routeMessage` does it — which is what makes
 * the declaration binding rather than a second place to be wrong.
 */
describe('routeMessage obeys the contracts', () => {
  it.each(RESERVED_AGENT_IDS.map((id) => [id] as const))(
    '%s routes exactly the acts it accepts, and refuses the rest by name',
    (id: string) => {
      const contract = endpointContract(id)
      expect(contract).toBeDefined()
      if (contract === undefined) return

      for (const act of SPEECH_ACTS) {
        const route = routeMessage(replyTo(id, act), ROSTER)
        if (contract.accepts.includes(act)) {
          expect(route, `${id} declares it accepts "${act}" but the router does not`).toEqual({
            kind: 'endpoint',
            endpoint: id
          })
        } else {
          expect(route.kind, `${id} routed "${act}" it does not accept`).toBe('bounce')
        }
      }
    }
  )

  it('never tells a sender that a reserved address has no mailbox', () => {
    // The exact lie the first instance told. `agent.profiles` was not a missing
    // mailbox — it was the harness's own address, with nothing behind it. Any
    // reserved id that falls through to the mailbox lookup lands here.
    for (const id of RESERVED_AGENT_IDS) {
      for (const act of SPEECH_ACTS) {
        const route = routeMessage(replyTo(id, act), ROSTER)
        if (route.kind !== 'bounce') continue
        expect(route.reason, `${id} fell through to the mailbox lookup on "${act}"`).not.toContain(
          'no mailbox'
        )
      }
    }
  })

  it('names the endpoint in every refusal, so the sender can correct itself', () => {
    for (const contract of ENDPOINT_CONTRACTS) {
      for (const act of SPEECH_ACTS) {
        if (contract.accepts.includes(act)) continue
        const route = routeMessage(replyTo(contract.id, act), ROSTER)
        if (route.kind !== 'bounce') continue
        expect(route.reason.toLowerCase()).toContain(contract.name)
      }
    }
  })
})

/**
 * The two live regressions, pinned as themselves rather than only as instances
 * of the rule — a rule can be rewritten, and these two must never come back.
 */
describe('the two instances that were actually observed', () => {
  it('takes a sweep report from a crew member it woke (instance one)', () => {
    const route = routeMessage(replyTo('agent.profiles', 'inform'), ROSTER)
    expect(route).toEqual({ kind: 'endpoint', endpoint: 'agent.profiles' })
  })

  it('takes a sweep REFUSAL too — the most useful thing a sweep can say', () => {
    const route = routeMessage(replyTo('agent.profiles', 'refuse'), ROSTER)
    expect(route).toEqual({ kind: 'endpoint', endpoint: 'agent.profiles' })
  })

  it('takes a triage refusal from the on-call agent (instance two)', () => {
    const route = routeMessage(replyTo('agent.harbor', 'refuse'), ROSTER)
    expect(route).toEqual({ kind: 'endpoint', endpoint: 'agent.harbor' })
  })

  it('still refuses the acts that ASK a harness endpoint for a decision', () => {
    // "Can receive" is not "accepts anything". A sweep report never asks the
    // harness for anything, and an endpoint that quietly took a `propose` would
    // owe a verdict nothing is there to give.
    for (const act of ['request', 'query', 'propose'] as const) {
      expect(routeMessage(replyTo('agent.profiles', act), ROSTER).kind).toBe('bounce')
    }
  })
})

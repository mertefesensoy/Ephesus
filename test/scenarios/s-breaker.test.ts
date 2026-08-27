import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS } from '../../src/shared/breaker'
import { cleanupHomes, scenarioMessage, startCompany, type Company } from './company'

/**
 * S-BREAKER (TEST-STRATEGY §3): "scripted repetition/error-storm/burn-rate
 * fixtures walk the ladder steer→constrain→stop; assert work preserved, ledger
 * `stalled`, brief mentions trip."
 *
 * Real spawned `fake-engine` processes emitting real hook events over a real
 * socket — the breaker sees exactly what it sees in the app, through the same
 * wiring. Two of the spec's clauses land here in full; the ledger-`stalled`
 * clause needs Artemis's reassignment (M3.8), and the brief needs the Odeon
 * (M5), so both are named as owed rather than faked.
 */

const companies: Company[] = []
afterAll(async () => {
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
})

async function company(): Promise<Company> {
  const started = await startCompany()
  companies.push(started)
  return started
}

/** One tool call, as a real engine reports it. */
function toolCall(tool: string, payload: Record<string, unknown>, failed = false): unknown[] {
  return [
    { kind: 'hook', event: 'pre-tool', payload: { tool, ...payload } },
    {
      kind: 'hook',
      event: 'post-tool',
      payload: { tool, ...payload, ...(failed ? { error: 'it failed' } : {}) }
    }
  ]
}

describe('S-BREAKER — repetition walks the ladder', () => {
  it('a real agent looping on one call reaches rung 1, and nothing more', async () => {
    const eph = await company()
    eph.hire('agent.mason')

    // A REAL fake-engine process making the same call over and over.
    await eph.runTurn('agent.mason', [
      ...Array.from({ length: DEFAULT_THRESHOLDS.repeatCount }, () =>
        toolCall('Read', { path: 'same.ts' })
      ).flat(),
      { kind: 'exit', code: 0 }
    ])

    expect(eph.breaker.stateFor('agent.mason').rung).toBe(1)
    // Rung 1 is one injected sentence. Nothing was interrupted, nothing
    // stopped, no mail held — work is preserved (ADR-0011's whole bargain).
    expect(eph.breakerActs.filter((act) => act.startsWith('steer:'))).toHaveLength(1)
    expect(eph.breakerActs.filter((act) => act.startsWith('interrupt:'))).toEqual([])
    expect(eph.breakerActs.filter((act) => act.startsWith('stop:'))).toEqual([])
    expect(eph.breakerActs).toContain('avatar:agent.mason:rung1')
  })

  it('the steer is a real sentence rendered from prompts/, carrying the facts', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    await eph.runTurn('agent.mason', [
      ...Array.from({ length: DEFAULT_THRESHOLDS.repeatCount }, () =>
        toolCall('Bash', { command: 'npm test' })
      ).flat(),
      { kind: 'exit', code: 0 }
    ])
    const steer = eph.breakerActs.find((act) => act.startsWith('steer:'))
    expect(steer).toBeDefined()
    // The words come from prompts/watch/steer-repetition.md; the breaker
    // supplies only the facts (invariant §8).
    expect(steer).toContain('looping')
  })

  it('a busy agent doing DIFFERENT work never trips', async () => {
    const eph = await company()
    eph.hire('agent.scribe')
    await eph.runTurn('agent.scribe', [
      ...Array.from({ length: 20 }, (_unused, i) =>
        toolCall('Read', { path: `file-${String(i)}.ts` })
      ).flat(),
      { kind: 'exit', code: 0 }
    ])
    // Twenty reads of twenty files is work. A breaker that fires on this is one
    // the Architect turns off, and then it protects nothing at all.
    expect(eph.breaker.stateFor('agent.scribe').rung).toBe(0)
    expect(eph.breakerActs).toEqual([])
  })
})

describe('S-BREAKER — an error storm walks the ladder', () => {
  it('trips on a real agent whose calls keep failing', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    await eph.runTurn('agent.mason', [
      ...Array.from({ length: 8 }, (_unused, i) =>
        toolCall('Bash', { command: `attempt-${String(i)}` }, true)
      ).flat(),
      { kind: 'exit', code: 0 }
    ])
    const state = eph.breaker.stateFor('agent.mason')
    expect(state.rung).toBeGreaterThanOrEqual(1)
    expect(state.firing.map((hit) => hit.signal)).toContain('error-rate')
  })

  it('climbs to constrain and HOLDS mail rather than losing it', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    eph.hire('agent.scribe')

    await eph.runTurn('agent.mason', [
      ...Array.from({ length: 8 }, (_unused, i) =>
        toolCall('Bash', { command: `attempt-${String(i)}` }, true)
      ).flat(),
      { kind: 'exit', code: 0 }
    ])
    expect(eph.breaker.stateFor('agent.mason').rung).toBe(1)
    // The storm is still firing and the dwell has passed: rung 2.
    eph.breaker.forceEvaluate('agent.mason')
    expect(eph.breaker.stateFor('agent.mason').rung).toBe(2)
    expect(eph.breakerActs).toContain('pause:agent.mason:true')
    expect(eph.hermes.isPaused('agent.mason')).toBe(true)

    // Mail sent to a constrained agent is HELD, not delivered and not dropped.
    await eph.runTurn('agent.scribe', [
      {
        kind: 'write-outbox',
        message: scenarioMessage({ from: 'agent.scribe', to: 'agent.mason', subject: 'status?' })
      },
      { kind: 'exit', code: 0 }
    ])
    await eph.hermes.sweep()
    expect(eph.inbox('agent.mason')).toEqual([])

    // …and it arrives once the constraint lifts. Constraining an agent is not
    // the same as losing its mail.
    eph.hermes.setPaused('agent.mason', false)
    await eph.hermes.sweep()
    expect(eph.inbox('agent.mason')).toHaveLength(1)
  })

  it('only the third step stops, interrupting gracefully first', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    await eph.runTurn('agent.mason', [
      ...Array.from({ length: 8 }, (_unused, i) =>
        toolCall('Bash', { command: `attempt-${String(i)}` }, true)
      ).flat(),
      { kind: 'exit', code: 0 }
    ])
    eph.breaker.forceEvaluate('agent.mason')
    expect(eph.breakerActs.filter((a) => a.startsWith('stop:'))).toEqual([])
    eph.breaker.forceEvaluate('agent.mason')

    expect(eph.breaker.stateFor('agent.mason').rung).toBe(3)
    // Graceful interrupt BEFORE the process stop (ADR-0011).
    const acts = eph.breakerActs.filter((a) => a.startsWith('interrupt:') || a.startsWith('stop:'))
    expect(acts).toEqual(['interrupt:agent.mason', 'stop:agent.mason'])
  })
})

describe('S-BREAKER — the whole ladder is in the book of record (NFR-13)', () => {
  it('every rung transition is a `breaker` entry carrying its numbers', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    await eph.runTurn('agent.mason', [
      ...Array.from({ length: DEFAULT_THRESHOLDS.repeatCount }, () =>
        toolCall('Read', { path: 'same.ts' })
      ).flat(),
      { kind: 'exit', code: 0 }
    ])
    eph.breaker.forceEvaluate('agent.mason')
    eph.breaker.forceEvaluate('agent.mason')

    const trips = eph.agora.readLog(0, 500).filter((entry) => entry.kind === 'breaker')
    expect(trips.map((entry) => entry['action'])).toEqual(['steer', 'constrain', 'stop'])
    expect(trips[0]).toMatchObject({ agentId: 'agent.mason', from: 0, rung: 1 })
    // The numbers that caused it, so a trip is explicable rather than a mood.
    expect(JSON.stringify(trips[0]?.['detail'])).toContain('repeats')
  })
})

describe('S-BREAKER — the M2 pathology signal is finally consumed', () => {
  it('a Stop-hook loop enters the ladder instead of only being logged', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    // From M2 this was emitted and logged with nothing reading it.
    eph.breaker.notePathology('agent.mason', 7)
    expect(eph.breaker.stateFor('agent.mason').rung).toBe(1)
    expect(eph.breakerActs.filter((act) => act.startsWith('steer:'))).toHaveLength(1)
  })
})

describe('S-BREAKER — reduced protection is surfaced, not hidden', () => {
  it('a native engine reports full protection and its span count', async () => {
    const eph = await company()
    eph.hire('agent.mason')
    await eph.runTurn('agent.mason', [
      ...toolCall('Read', { path: 'a.ts' }),
      { kind: 'exit', code: 0 }
    ])
    const state = eph.breaker.stateFor('agent.mason')
    expect(state.reducedProtection).toBe(false)
    expect(state.spanCount).toBe(1)
  })
})

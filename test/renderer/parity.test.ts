import { describe, expect, it } from 'vitest'
import {
  PARITY_MAX,
  PARITY_WINDOW_MS,
  noteParity,
  parityLine,
  type ParityNotice
} from '../../src/renderer/src/floor/parity'
import { reduceEnvelope, reduceWalk, envelopeFor, type EnvelopeFlight } from '../../src/shared/vfx'

/**
 * §8's reduced-motion parity, on the surface it actually reaches.
 *
 * The M6 close-out audit found this clause asserted three ways that could not
 * fail: `expect(reduceEnvelope(f).info).toEqual(envelopeInfo(f))` is a
 * tautology, since `reduceEnvelope` returns exactly that; the walk half was
 * never implemented in the renderer at all; and the tray flash computed its
 * label and dropped it. So parity is asserted HERE against an independent
 * statement of what the moving form conveys — who, to whom, and what — rather
 * than against the function under test.
 */

const flight = (over: Partial<EnvelopeFlight> = {}): EnvelopeFlight =>
  ({
    id: 'm-1',
    from: 'mason',
    to: 'artemis',
    act: 'request',
    kind: 'deliver',
    color: 'aegean',
    startedMs: 7_000,
    wobble: false,
    towardTemple: false,
    fan: 1,
    ...over
  }) as EnvelopeFlight

describe('§8 parity — the reduced form says what the moving form said', () => {
  // Independent statement of the information a flight carries. If parity ever
  // regresses, THIS is what disagrees — not a restatement of the implementation.
  const partiesAndAct = (f: EnvelopeFlight): readonly string[] => [f.from, f.to, f.act]

  it('names both parties and the act, for every kind of flight', () => {
    for (const kind of ['deliver', 'bounce', 'divert', 'broadcast'] as const) {
      const f = flight({ kind })
      const said = reduceEnvelope(f).info.text
      for (const fact of partiesAndAct(f)) {
        // A tray flash the reader cannot attribute is a colour, not information.
        expect(said, `${kind} / ${fact}`).toContain(fact)
      }
      // And it must name both trays, or a screen reader cannot tell who flashed.
      expect(reduceEnvelope(f).info.at).toEqual([f.from, f.to])
    }
  })

  it('distinguishes a bounce and a divert from a plain delivery, in words', () => {
    // §5.5 gives bounce and refusal the same COLOUR. Under reduced motion there
    // is no colour to read, so the distinction has to survive in the sentence.
    const delivered = reduceEnvelope(flight({ kind: 'deliver' })).info.text
    const bounced = reduceEnvelope(flight({ kind: 'bounce' })).info.text
    const diverted = reduceEnvelope(flight({ kind: 'divert' })).info.text
    expect(new Set([delivered, bounced, diverted]).size).toBe(3)
  })

  it('a walk says who went where', () => {
    const info = reduceWalk('iris', 'shelf').info
    expect(info.text).toContain('iris')
    expect(info.text).toContain('shelf')
    expect(info.at).toEqual(['iris', 'shelf'])
  })

  it('parity survives a REAL log entry, not just a hand-built flight', () => {
    // The seam the unit suite cannot see: `envelopeFor` reads the record, and
    // the reduced form has to carry that record's parties through.
    const built = envelopeFor({
      seq: 1,
      ts: 7_000,
      kind: 'delivery',
      msgId: 'm-9',
      from: 'pallas',
      to: 'iris',
      act: 'propose'
    } as never)
    expect(built).not.toBeNull()
    if (!built) return
    const said = reduceEnvelope(built).info.text
    expect(said).toContain('pallas')
    expect(said).toContain('iris')
    expect(said).toContain('propose')
  })
})

describe('the census carries the parity lines (UI-DESIGN §8, NFR-15)', () => {
  it('says nothing when nothing recent happened', () => {
    // A label that always renders a segment would add a permanent
    // "nothing happened" to a string that is read aloud.
    expect(parityLine([], 1_000)).toBe('')
  })

  it('carries a notice, then drops it once it is no longer recent', () => {
    const notices = noteParity([], reduceWalk('iris', 'shelf').info, 1_000)
    expect(parityLine(notices, 1_000)).toContain('iris')
    expect(parityLine(notices, 1_000 + PARITY_WINDOW_MS - 1)).toContain('iris')
    expect(parityLine(notices, 1_000 + PARITY_WINDOW_MS)).toBe('')
  })

  it('does not repeat one event, and keeps the repeat FRESH', () => {
    // A broadcast flashes several trays and a walking citizen re-notifies on
    // every snapshot; four copies of one line is noise, and an event still
    // happening must not age out mid-repeat.
    const info = reduceWalk('iris', 'shelf').info
    let notices: readonly ParityNotice[] = []
    notices = noteParity(notices, info, 1_000)
    notices = noteParity(notices, info, 5_000)
    expect(notices).toHaveLength(1)
    expect(parityLine(notices, 5_000 + PARITY_WINDOW_MS - 1)).toContain('iris')
  })

  it('keeps the newest few, so the label describes now rather than the session', () => {
    let notices: readonly ParityNotice[] = []
    for (let i = 0; i < PARITY_MAX + 3; i += 1) {
      notices = noteParity(notices, reduceWalk(`agent-${String(i)}`, 'shelf').info, 1_000)
    }
    expect(notices).toHaveLength(PARITY_MAX)
    // The oldest are the ones dropped.
    expect(parityLine(notices, 1_000)).not.toContain('agent-0')
    expect(parityLine(notices, 1_000)).toContain(`agent-${String(PARITY_MAX + 2)}`)
  })
})

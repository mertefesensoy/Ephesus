import { describe, expect, it } from 'vitest'
import { degradationLine } from '../../src/shared/degradation'
import type { AgoraHealth } from '../../src/shared/ipc'

/**
 * What the Architect actually reads (M8.2).
 *
 * The channel is only as good as its last inch: a degradation that reaches the
 * book of record and then renders as an undated one-liner still cannot answer
 * the two questions worth asking — is this happening constantly, and was it
 * observed just now or before the last restart. Invariant §7 is about the
 * VISIBLE state, so the visible state is asserted rather than assumed from the
 * model behind it.
 *
 * Typed against the IPC shape the renderer really receives, so a field renamed
 * in `AgoraHealth` breaks this file rather than silently changing the line.
 */

type RuntimeEntry = AgoraHealth['runtime'][number]

const entry = (over: Partial<RuntimeEntry> = {}): RuntimeEntry => ({
  at: 5_000,
  source: 'library',
  detail: 'no index — recall is on the grep rung',
  cause: 'library/fts',
  count: 1,
  since: 5_000,
  freshness: 'live',
  ...over
})

describe('the degradation line', () => {
  it('shows a single occurrence plainly', () => {
    expect(degradationLine(entry())).toBe('library: no index — recall is on the grep rung')
  })

  it('shows how often a condition is being reported', () => {
    // A pacing warning seen 3,000 times is a different fact from one seen once,
    // and the old line could not tell them apart.
    expect(degradationLine(entry({ source: 'usage', detail: 'pacing slow', count: 3_000 }))).toBe(
      'usage: pacing slow (×3000)'
    )
  })

  it('marks a condition carried over from before this session', () => {
    // Never presented as though it were observed now — and never hidden, which
    // is what an empty list every morning did (register item B2).
    expect(degradationLine(entry({ freshness: 'carried' }))).toBe(
      'library: no index — recall is on the grep rung — last seen before this session'
    )
  })

  it('says both when a carried condition was also frequent', () => {
    expect(degradationLine(entry({ count: 42, freshness: 'carried' }))).toBe(
      'library: no index — recall is on the grep rung (×42) — last seen before this session'
    )
  })
})

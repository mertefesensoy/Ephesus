import { describe, expect, it } from 'vitest'
import {
  VOICE_FAULTS,
  isConversational,
  type VoiceAdapter,
  type VoiceFault
} from '../../src/main/herald/seam'
import {
  BARGE_IN_MS,
  FAILOVER_BUDGET_MS,
  initialFailover,
  reduceFailover
} from '../../src/main/herald/policy'

/**
 * The voice-adapter conformance suite (TEST-STRATEGY §5, NFR-12).
 *
 * > **Voice adapters:** contract tests over recorded fixtures — stream start
 * > latency, cancel latency (barge-in ≤ 250 ms simulated), error taxonomy
 * > mapping (auth vs transient vs latency-breach → correct failover state
 * > machine transitions).
 *
 * It runs against **recorded fixtures**, never a live provider: a suite that
 * needed a key would not run in CI, and a voice adapter that only proves itself
 * when someone is watching proves nothing. Live smoke tests are opt-in with
 * keys (ADR-0007's consequence) and are not run from here.
 *
 * Written against the SURFACE, never a mechanism — the engine-adapter suite's
 * rule, one seam over. "Cancel is fast" does not care whether an adapter aborts
 * a socket or drops a buffer, only that playback stops inside the budget.
 */

export interface VoiceConformanceSubject {
  readonly name: string
  /** Built fresh per case, so no case can leak state into another. */
  make(): VoiceAdapter
  /**
   * Drives the subject's fixture for one fault class, returning what the
   * adapter classified it as. This is the taxonomy half of TEST-STRATEGY §5:
   * the adapter must map its provider's real error shapes onto the three the
   * seam defines.
   */
  classify(fault: VoiceFault): Promise<VoiceFault>
  /** Milliseconds from `speak()` to the first audio frame, from the fixture. */
  streamStartMs(): Promise<number>
  /** Milliseconds from `cancel()` to playback actually stopping. */
  cancelMs(): Promise<number>
}

/** ADR-0007 §NFR-3: a voice that takes longer than this to start is not a voice. */
export const STREAM_START_BUDGET_MS = 1_200

export function runVoiceConformance(subject: VoiceConformanceSubject): void {
  describe(`voice conformance — ${subject.name}`, () => {
    it('declares a provider id and at least one usable capability', () => {
      const adapter = subject.make()
      expect(adapter.provider).toBeTruthy()
      // ADR-0007 allows STT+TTS or duplex; an adapter offering neither
      // combination cannot carry a conversation and must not claim to.
      expect(isConversational(adapter)).toBe(true)
    })

    it('reports health rather than deciding anything', async () => {
      const adapter = subject.make()
      const health = await adapter.health()
      expect(typeof health.ok).toBe('boolean')
      if (!health.ok) expect(VOICE_FAULTS).toContain(health.fault)
      else expect(health.fault).toBeNull()
      // The seam gives an adapter no way to act on its own health. If one ever
      // grows a `failover()` or a `retry()`, this is the line that notices.
      const surface = Object.keys(adapter)
      for (const forbidden of ['failover', 'retry', 'switchProvider', 'preferOver']) {
        expect(surface, forbidden).not.toContain(forbidden)
      }
    })

    it('starts streaming inside the budget', async () => {
      const ms = await subject.streamStartMs()
      expect(ms).toBeGreaterThanOrEqual(0)
      expect(ms).toBeLessThanOrEqual(STREAM_START_BUDGET_MS)
    })

    it('cancels playback within the barge-in budget (NFR-3)', async () => {
      // VOICE-DESIGN §2: "Barge-in is absolute … within 250 ms … regardless of
      // provider". This is the case that keeps that promise true of a NEW
      // adapter, which is the only place it can be broken.
      const ms = await subject.cancelMs()
      expect(ms).toBeLessThanOrEqual(BARGE_IN_MS)
    })

    it.each(VOICE_FAULTS)('maps a %s failure onto the seam taxonomy', async (fault) => {
      await expect(subject.classify(fault)).resolves.toBe(fault)
    })

    it('drives the failover machine the way each fault should', async () => {
      const adapter = subject.make()
      for (const fault of VOICE_FAULTS) {
        const classified = await subject.classify(fault)
        const start = initialFailover(0, [adapter.provider])
        const after = reduceFailover(
          start,
          { kind: 'fault', provider: adapter.provider, fault: classified },
          10,
          [adapter.provider]
        )
        // With this adapter as the only provider, ANY of the three faults ends
        // the session's voice — which is FR-8.6's text-only degradation, and it
        // must be reached identically whatever the fault was called.
        expect(after.state, fault).toBe('cooldown')
        expect(after.provider, fault).toBeNull()
        expect(after.notice, fault).toBe('voice-unavailable')
        // NFR-3: the transition itself is immediate; the 3 s budget is for the
        // adapter swap, not for deciding to swap.
        expect(after.sinceMs - start.sinceMs).toBeLessThanOrEqual(FAILOVER_BUDGET_MS)
      }
    })
  })
}

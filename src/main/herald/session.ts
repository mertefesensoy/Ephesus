import type { Phrasebook } from './phrasebook'
import {
  FAILOVER_BUDGET_MS,
  initialFailover,
  reduceFailover,
  voiceAvailable,
  type FailoverSnapshot
} from './policy'
import { VoiceError, type VoiceAdapter, type VoiceProviderId } from './seam'

/**
 * The Herald's session — where the policy layer and the adapters meet
 * (SDD §8, FR-8.2, FR-8.6).
 *
 * Three obligations, all of them ADR-0007's:
 *
 * 1. **The policy decides.** An adapter throws a classified `VoiceError`; this
 *    session hands it to `reduceFailover` and does whatever the reducer says.
 *    It never inspects a provider to pick a favourite.
 * 2. **Failover is mid-utterance and continuous.** When ElevenLabs fails
 *    halfway through a sentence, the fallback speaks the REMAINDER — not the
 *    whole line again, and not nothing. `spokenSoFar()` is what makes that
 *    possible, which is why it had to be a measurement.
 * 3. **Zero non-audio loss.** Every line reaches the transcript whether or not
 *    any provider spoke it. FR-8.6's "the entire system SHALL function fully in
 *    text" is not a banner — it is the guarantee that turning the voice off
 *    costs exactly the audio and nothing else.
 *
 * ADR-0007 also maps the conversation contract onto whatever the provider
 * offers: a `TextToSpeech` adapter is spoken through directly, a duplex-only
 * adapter is driven through its session. That mapping is here, in the policy
 * layer, because ADR-0007 puts it here — not inside the Realtime adapter, which
 * would have to fake two interfaces to host it.
 */

/** One line as it reached the Architect. */
export interface TranscriptEntry {
  readonly text: string
  /** Who spoke it, or null when nothing did (text-only). */
  readonly provider: VoiceProviderId | null
  /** VOICE-DESIGN §2's "unspoken from here": what audio never carried. */
  readonly unspoken: string
}

export interface SpeakResult {
  /** True when some provider carried at least part of the line. */
  readonly spoken: boolean
  /** The providers that tried, in order — the failover's own record. */
  readonly attempted: readonly VoiceProviderId[]
  /** Phrase-book keys announced during this utterance (FR-8.2). */
  readonly notices: readonly string[]
  readonly entry: TranscriptEntry
  /** Wall-clock ms from the fault to the fallback speaking (NFR-3 ≤ 3 s). */
  readonly failoverMs: number | null
}

export interface HeraldSessionOptions {
  readonly adapters: readonly VoiceAdapter[]
  readonly phrasebook: Phrasebook
  now(): number
  /** The one-line notice, spoken or shown (FR-8.2). */
  onNotice?(key: string, line: string): void
  onTranscript?(entry: TranscriptEntry): void
}

export class HeraldSession {
  private snapshot: FailoverSnapshot
  private readonly transcript: TranscriptEntry[] = []

  constructor(private readonly options: HeraldSessionOptions) {
    this.snapshot = initialFailover(
      options.now(),
      options.adapters.map((a) => a.provider)
    )
  }

  state(): FailoverSnapshot {
    return this.snapshot
  }

  /** FR-8.6: false means text-only — everything still works, minus the audio. */
  available(): boolean {
    return voiceAvailable(this.snapshot)
  }

  entries(): readonly TranscriptEntry[] {
    return this.transcript
  }

  /** The Architect asserting the outage is over. Failback is manual (ADR-0007). */
  failback(): void {
    this.snapshot = reduceFailover(
      this.snapshot,
      { kind: 'failback' },
      this.options.now(),
      this.options.adapters.map((a) => a.provider)
    )
    if (this.snapshot.notice) this.announce(this.snapshot.notice)
  }

  /**
   * Contract: says a line, switching providers mid-utterance if one fails.
   *
   * The loop is the whole design: try the provider the POLICY currently names,
   * and on a classified fault hand it to the reducer and continue from what was
   * left unspoken. It ends when the line is spoken or the reducer reaches
   * cooldown — never after a fixed number of tries, because "how many providers
   * are left" is the reducer's knowledge, not this method's.
   */
  async speak(text: string): Promise<SpeakResult> {
    const attempted: VoiceProviderId[] = []
    const notices: string[] = []
    let remaining = text
    let spokenTotal = ''
    let faultAt: number | null = null
    let failoverMs: number | null = null

    while (voiceAvailable(this.snapshot) && remaining.length > 0) {
      const provider = this.snapshot.provider
      const adapter = this.options.adapters.find((a) => a.provider === provider)
      if (!adapter) break
      attempted.push(adapter.provider)

      // What this provider managed before it failed. It is credited whether
      // the attempt succeeded or threw: a provider that got half the sentence
      // out DID say half the sentence, and the fallback must pick up from
      // there rather than repeat it.
      let partial = ''
      try {
        const spoken = await this.speakWith(adapter, remaining, (said) => {
          partial = said
        })
        // The fallback got its first words out: NFR-3's budget is measured to
        // here, not to the moment the decision was taken.
        if (faultAt !== null && failoverMs === null) failoverMs = this.options.now() - faultAt
        spokenTotal += spoken
        remaining = remaining.slice(spoken.length)
        if (spoken.length === 0) break
      } catch (err) {
        const fault = err instanceof VoiceError ? err.fault : 'transient'
        spokenTotal += partial
        remaining = remaining.slice(partial.length)
        faultAt = this.options.now()
        const before = this.snapshot
        this.snapshot = reduceFailover(
          this.snapshot,
          { kind: 'fault', provider: adapter.provider, fault },
          faultAt,
          this.options.adapters.map((a) => a.provider)
        )
        if (this.snapshot === before) break
        if (this.snapshot.notice) {
          notices.push(this.snapshot.notice)
          this.announce(this.snapshot.notice)
        }
      }
    }

    const entry: TranscriptEntry = {
      text,
      provider: spokenTotal.length > 0 ? (attempted.at(-1) ?? null) : null,
      // Zero non-audio loss: the line is recorded in full either way, and what
      // audio never carried is marked rather than dropped.
      unspoken: text.slice(spokenTotal.length)
    }
    this.transcript.push(entry)
    this.options.onTranscript?.(entry)

    return { spoken: spokenTotal.length > 0, attempted, notices, entry, failoverMs }
  }

  /**
   * ADR-0007's "the policy layer maps the common conversation contract onto
   * it". A `TextToSpeech` adapter is spoken through; a duplex-only adapter is
   * driven through its session, and what it says back is what counts as spoken.
   */
  private async speakWith(
    adapter: VoiceAdapter,
    text: string,
    onPartial: (spoken: string) => void
  ): Promise<string> {
    // Only a prefix ever counts. A provider whose alignment disagrees with the
    // text is treated as having said nothing, which is the safe direction:
    // claiming the Architect heard something they did not is the worse error.
    const prefix = (said: string): string => (text.startsWith(said) ? said : '')

    if (adapter.tts) {
      const handle = await adapter.tts.speak(text)
      try {
        await handle.done()
      } catch (err) {
        // The utterance died part-way. What it managed is still true, and
        // reporting it is what lets the fallback finish the sentence instead
        // of starting it again.
        onPartial(prefix(handle.spokenSoFar()))
        throw err
      }
      return prefix(handle.spokenSoFar())
    }
    if (adapter.duplex) {
      const session = await adapter.duplex.open({ onTranscript: () => {}, onSpoken: () => {} })
      try {
        // ADR-0007's mapping: a duplex provider is asked to say the line, and
        // what it reports back is what counts as spoken.
        return prefix(await session.say(text))
      } finally {
        await session.close()
      }
    }
    throw new VoiceError('transient', adapter.provider, 'adapter offers no way to speak')
  }

  private announce(key: string): void {
    // The KEY is the policy's; the SENTENCE is the phrase book's (invariant §8).
    // A missing entry throws there rather than being spoken as a key.
    this.options.onNotice?.(key, this.options.phrasebook.line(key))
  }
}

/** Re-exported so a caller can assert the NFR-3 budget without importing policy. */
export { FAILOVER_BUDGET_MS }

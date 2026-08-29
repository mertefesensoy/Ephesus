/**
 * The Herald's provider-agnostic voice seam — ADR-0007, transcribed.
 *
 * ADR-0007 names exactly three capability interfaces and nothing else:
 *
 * > `SpeechToText` (streaming transcription + endpointing), `TextToSpeech`
 * > (streamed audio with cancel), and optional `DuplexVoice` (speech-to-speech
 * > session), plus a conversation policy layer above them owning wake word,
 * > push-to-talk, barge-in, repeat-back confirmation, and provider selection.
 *
 * This file is that surface and no more. The M1.1 lesson stands: an adapter
 * interface that grows a convenience method becomes a contract every future
 * adapter owes, and the ADR is the place that decision gets made — not here.
 *
 * **Adapters report health; they never decide.** There is deliberately no
 * `shouldFailover()`, no retry, no provider preference on any interface below.
 * An adapter's whole obligation on failure is to classify the fault
 * (`VoiceFault`) and hand it up; `policy.ts` owns what happens next (ADR-0007:
 * "provider adapters stay dumb pipes"). An adapter that switched providers
 * would be making a safety decision in a layer with no view of the session.
 */

/** Every provider the seam can carry, by id. Adapters register under one. */
export const VOICE_PROVIDERS = ['elevenlabs', 'openai-realtime'] as const

export type VoiceProviderId = (typeof VOICE_PROVIDERS)[number]

/**
 * The error taxonomy TEST-STRATEGY §5 requires an adapter to map its provider's
 * failures onto: "auth vs transient vs latency-breach → correct failover state
 * machine transitions".
 *
 * Three, because the policy layer treats them differently and nothing else
 * about a provider's error matters to it:
 *
 * - `auth` — the key is missing, wrong or revoked. Retrying cannot help, so
 *   this provider is done for the session.
 * - `transient` — a network blip, a 5xx, a dropped socket. Worth another
 *   provider, and worth a manual failback later.
 * - `latency-breach` — the provider answered, but too slowly to be a voice
 *   (ADR-0007's "sustained latency breach").
 */
export const VOICE_FAULTS = ['auth', 'transient', 'latency-breach'] as const

export type VoiceFault = (typeof VOICE_FAULTS)[number]

export class VoiceError extends Error {
  constructor(
    readonly fault: VoiceFault,
    readonly provider: VoiceProviderId,
    message: string
  ) {
    super(message)
    this.name = 'VoiceError'
  }
}

/** One transcription result. `final` marks the endpointed utterance. */
export interface Transcript {
  readonly text: string
  /** True once endpointing decided the utterance is over. */
  readonly final: boolean
  /** 0–1, or null when the provider does not report one. */
  readonly confidence: number | null
}

/** A live transcription session. Closing it is the caller's job. */
export interface TranscriptionSession {
  /** Feeds captured audio. Frames are raw PCM; the adapter owns the encoding. */
  write(frame: Uint8Array): void
  /** Ends input and resolves once the final transcript has been emitted. */
  end(): Promise<void>
  /** Abandons the session immediately — used when barge-in supersedes it. */
  cancel(): void
}

/**
 * ADR-0007: "streaming transcription + endpointing".
 *
 * `start` returns as soon as the session is open, not when speech ends; the
 * caller streams frames in and reads transcripts from the callback. Endpointing
 * is the ADAPTER's (providers differ wildly in how they decide an utterance is
 * over, and re-implementing it above the seam would make every adapter fight
 * the policy layer).
 */
export interface SpeechToText {
  readonly provider: VoiceProviderId
  start(onTranscript: (t: Transcript) => void): Promise<TranscriptionSession>
}

/** A speaking turn in progress. */
export interface SpeechHandle {
  /**
   * Stops playback. ADR-0007 and VOICE-DESIGN §2 make this the sacred one:
   * Architect audio stops TTS within 250 ms regardless of provider, and the
   * interrupted text stays in the transcript. Adapters must make cancel cheap.
   */
  cancel(): void
  /** Resolves when the utterance finished playing, or after a cancel. */
  done(): Promise<void>
  /**
   * What was actually spoken before a cancel — VOICE-DESIGN §2's "the
   * interrupted text remains in the transcript marked 'unspoken from here'".
   */
  spokenSoFar(): string
}

export interface SpeakOptions {
  readonly voiceId?: string
  /**
   * Where the streamed audio goes. SDD §8 puts audio I/O in main with "a thin
   * renderer visualizer", so the adapter produces bytes and something else
   * plays them.
   *
   * Added at M6.5, when the first real adapter met this interface: ADR-0007
   * says "streamed audio with cancel", and the M6.4 transcription had the
   * cancel and no way for the audio to leave. Completing the sentence the ADR
   * wrote — not extending it.
   */
  readonly onAudio?: (chunk: Uint8Array) => void
}

/** ADR-0007: "streamed audio with cancel". */
export interface TextToSpeech {
  readonly provider: VoiceProviderId
  /** Begins speaking; resolves once audio has STARTED, not when it finishes. */
  speak(text: string, opts?: SpeakOptions): Promise<SpeechHandle>
}

/** A duplex speech-to-speech session (ADR-0007's optional third interface). */
export interface DuplexSession {
  write(frame: Uint8Array): void
  /**
   * Asks the session to speak a composed line, and resolves with what the
   * provider reports having said.
   *
   * Added at M6.5/M6.6 for the same reason `onAudio` was: ADR-0007 says "the
   * policy layer maps the common conversation contract onto it", and reading a
   * brief aloud is part of that contract. A duplex session that could only
   * carry captured audio could not be a TTS fallback at all — which is the one
   * job ADR-0007 gives this provider.
   *
   * Both additions come from sentences already in the ADR; neither is a
   * convenience the seam grew on its own.
   */
  say(text: string): Promise<string>
  /** The provider's own interrupt primitive — what barge-in maps onto. */
  interrupt(): void
  close(): Promise<void>
}

/**
 * ADR-0007: "optional `DuplexVoice` (speech-to-speech session)". Optional means
 * optional: a provider that offers only STT and TTS is a complete adapter.
 */
export interface DuplexVoice {
  readonly provider: VoiceProviderId
  open(handlers: {
    onTranscript: (t: Transcript) => void
    onSpoken: (text: string) => void
  }): Promise<DuplexSession>
}

/**
 * What an adapter offers. Every field optional except the id: this is how the
 * policy layer discovers that ElevenLabs brings STT+TTS while OpenAI Realtime
 * brings duplex, without either knowing about the other.
 */
export interface VoiceAdapter {
  readonly provider: VoiceProviderId
  readonly stt?: SpeechToText
  readonly tts?: TextToSpeech
  readonly duplex?: DuplexVoice
  /**
   * Whether this provider is usable at all right now — a key present, an
   * endpoint reachable. It REPORTS; it does not decide. A `false` here is a
   * fact the policy layer weighs, not an instruction to switch.
   */
  health(): Promise<{ readonly ok: boolean; readonly fault: VoiceFault | null }>
}

/**
 * Contract: whether an adapter can carry a full conversation on its own.
 *
 * Either both halves (STT + TTS) or a duplex session. This is the only
 * capability judgement the seam makes, and it is arithmetic over the interfaces
 * ADR-0007 named, not a preference between providers.
 */
export function isConversational(adapter: VoiceAdapter): boolean {
  return Boolean(adapter.duplex) || Boolean(adapter.stt && adapter.tts)
}

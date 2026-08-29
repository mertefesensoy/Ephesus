import { ElevenLabsClient, ElevenLabsError } from '@elevenlabs/elevenlabs-js'
import {
  VoiceError,
  type SpeakOptions,
  type SpeechHandle,
  type Transcript,
  type TranscriptionSession,
  type VoiceAdapter,
  type VoiceFault
} from './seam'

/**
 * The ElevenLabs adapter — ADR-0007's reference implementation, "chosen for
 * voice quality and latency".
 *
 * It is a dumb pipe, deliberately. It streams audio out, streams transcripts
 * in, and classifies its own failures into the seam's three faults. It has no
 * opinion about whether to keep going: `policy.ts` owns that (ADR-0007's
 * "provider adapters stay dumb pipes"), and there is no method here it could
 * express one through.
 *
 * **The key never comes from `process.env`.** It arrives through the injected
 * `apiKey()`, which main supplies from the write-only broker (ADR-0010,
 * invariant §6). An absent key is not an error state to hide: `health()` reports
 * it, the policy layer degrades to text, and FR-8.6 keeps everything else
 * working.
 *
 * **The voice id and model ids are config**, loaded from `prompts/herald/` by
 * the caller and passed in — FR-8.5 and invariant §8 put persona out of code,
 * and a voice id hard-coded here would be the persona in code by another name.
 */

/** The SDK surface this adapter uses, narrowed so tests can supply a double. */
export interface ElevenLabsLike {
  readonly textToSpeech: {
    streamWithTimestamps(
      voiceId: string,
      request: { text: string; modelId?: string }
    ): Promise<AsyncIterable<TimestampedChunk>>
  }
  readonly speechToText: {
    readonly realtime: {
      connect(options: {
        modelId: string
        audioFormat?: string
        sampleRate?: number
      }): Promise<RealtimeLike>
    }
  }
}

/** One streamed chunk: audio plus the characters it covers. */
export interface TimestampedChunk {
  readonly audioBase64?: string
  readonly alignment?: { readonly characters?: readonly string[] }
}

export interface RealtimeLike {
  on(event: string, listener: (data: unknown) => void): void
  send(data: { audio: Uint8Array }): void
  commit(): void
  close(): void
}

export interface ElevenLabsDeps {
  /** The key, from the broker. `null` when none is configured (FR-8.6). */
  apiKey(): string | null
  /** Voice id from `prompts/herald/voice-id.md`. */
  voiceId(): string
  /** TTS model id from `prompts/herald/model-id.md`. */
  modelId(): string
  /** Streaming-STT model id from `prompts/herald/stt-model-id.md`. */
  sttModelId(): string
  /** Injectable for tests; production builds the real client from the key. */
  client?(apiKey: string): ElevenLabsLike
}

/**
 * Contract: maps an ElevenLabs failure onto the seam's three faults.
 *
 * This is the taxonomy half of TEST-STRATEGY §5. The distinction that matters
 * is `auth` versus the rest: a 401 will fail identically forever, so the policy
 * layer must burn the provider rather than retry it, while a 5xx or a dropped
 * socket is worth another provider and a later manual failback.
 */
export function classifyElevenLabsError(err: unknown): VoiceFault {
  if (err instanceof VoiceError) return err.fault
  const status =
    err instanceof ElevenLabsError
      ? err.statusCode
      : typeof (err as { statusCode?: unknown })?.statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : undefined
  if (status === 401 || status === 403) return 'auth'
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  // The SDK raises its own timeout error; a timeout is the provider answering
  // too slowly to be a voice, which is a latency breach and not a transient.
  if (name.includes('Timeout') || message.includes('timeout') || message.includes('timed out')) {
    return 'latency-breach'
  }
  if (typeof status === 'number' && status >= 500) return 'transient'
  if (message.includes('invalid_api_key') || message.includes('unauthorized')) return 'auth'
  return 'transient'
}

const MISSING_KEY = 'no ElevenLabs key configured'

export function createElevenLabsAdapter(deps: ElevenLabsDeps): VoiceAdapter {
  const provider = 'elevenlabs' as const

  const connect = (): ElevenLabsLike => {
    const key = deps.apiKey()
    if (!key) throw new VoiceError('auth', provider, MISSING_KEY)
    return deps.client
      ? deps.client(key)
      : (new ElevenLabsClient({ apiKey: key }) as unknown as ElevenLabsLike)
  }

  return {
    provider,

    tts: {
      provider,
      async speak(text: string, opts: SpeakOptions = {}): Promise<SpeechHandle> {
        const client = connect()
        let cancelled = false
        // The characters the provider says it has actually produced audio for.
        // This is a MEASUREMENT, not an estimate: `streamWithTimestamps` returns
        // the alignment, so the "unspoken from here" mark in the transcript is
        // a fact rather than a guess at 150 words per minute.
        let spoken = ''

        let stream: AsyncIterable<TimestampedChunk>
        try {
          stream = await client.textToSpeech.streamWithTimestamps(opts.voiceId ?? deps.voiceId(), {
            text,
            modelId: deps.modelId()
          })
        } catch (err) {
          throw new VoiceError(
            classifyElevenLabsError(err),
            provider,
            err instanceof Error ? err.message : String(err)
          )
        }

        const pump = (async (): Promise<void> => {
          try {
            for await (const chunk of stream) {
              // Cancel is checked between chunks, which is what keeps barge-in
              // inside 250 ms: chunks are short, and nothing here awaits a
              // whole utterance.
              if (cancelled) return
              if (chunk.audioBase64 && opts.onAudio) {
                opts.onAudio(Uint8Array.from(Buffer.from(chunk.audioBase64, 'base64')))
              }
              for (const character of chunk.alignment?.characters ?? []) spoken += character
            }
          } catch (err) {
            if (cancelled) return
            throw new VoiceError(
              classifyElevenLabsError(err),
              provider,
              err instanceof Error ? err.message : String(err)
            )
          }
        })()

        return {
          cancel: () => {
            cancelled = true
          },
          done: () => pump,
          // Only ever a prefix of what was asked for: if the provider's
          // alignment drifts from the text, the policy layer's `bargeIn` treats
          // a non-prefix as "nothing was heard", which is the safe direction.
          spokenSoFar: () => spoken
        }
      }
    },

    stt: {
      provider,
      async start(onTranscript: (t: Transcript) => void): Promise<TranscriptionSession> {
        const client = connect()
        let connection: RealtimeLike
        try {
          connection = await client.speechToText.realtime.connect({
            modelId: deps.sttModelId(),
            audioFormat: 'pcm_16000',
            sampleRate: 16_000
          })
        } catch (err) {
          throw new VoiceError(
            classifyElevenLabsError(err),
            provider,
            err instanceof Error ? err.message : String(err)
          )
        }

        // Endpointing is the provider's: it decides when an utterance is over
        // and emits a committed transcript. Re-deciding that above the seam
        // would make every adapter fight the policy layer (ADR-0007).
        connection.on('partial_transcript', (data) => {
          const text = readText(data)
          if (text !== null) onTranscript({ text, final: false, confidence: null })
        })
        connection.on('committed_transcript', (data) => {
          const text = readText(data)
          if (text !== null) onTranscript({ text, final: true, confidence: null })
        })

        let open = true
        return {
          write: (frame) => {
            if (open) connection.send({ audio: frame })
          },
          end: async () => {
            if (!open) return
            open = false
            connection.commit()
            connection.close()
            await Promise.resolve()
          },
          cancel: () => {
            open = false
            connection.close()
          }
        }
      }
    },

    // ADR-0007 gives `DuplexVoice` to OpenAI Realtime; this adapter offers
    // STT + TTS, which `isConversational` accepts as a complete pair. Claiming
    // duplex it does not have would make the policy layer prefer it wrongly.

    async health() {
      if (!deps.apiKey()) {
        // FR-8.6: a missing key is a VISIBLE degradation, reported as the fault
        // it is. It is never silently swallowed into "provider unavailable".
        return { ok: false as const, fault: 'auth' as const }
      }
      return Promise.resolve({ ok: true as const, fault: null })
    }
  }
}

/** Pulls the transcript text out of a realtime event, whatever it is called. */
function readText(data: unknown): string | null {
  const record = (data ?? {}) as Record<string, unknown>
  for (const key of ['text', 'transcript']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return null
}

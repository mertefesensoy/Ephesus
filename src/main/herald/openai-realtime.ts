import { APIError } from 'openai'
import {
  VoiceError,
  type DuplexSession,
  type Transcript,
  type VoiceAdapter,
  type VoiceFault
} from './seam'

/**
 * The OpenAI Realtime adapter — ADR-0007's automatic fallback.
 *
 * > **OpenAI Realtime adapter** implements `DuplexVoice`; the policy layer maps
 * > the common conversation contract onto it.
 *
 * So this file implements `DuplexVoice` and *only* `DuplexVoice`. It does not
 * synthesise a `TextToSpeech` out of the duplex session to look like a complete
 * adapter: the mapping is the policy layer's job, ADR-0007 says so, and an
 * adapter that faked the other two interfaces would make the policy layer
 * choose it for capabilities it does not have.
 *
 * Like the ElevenLabs adapter it is a dumb pipe: it classifies its failures and
 * hands them up, and there is no method here through which it could decide to
 * keep going, retry, or hand over.
 */

/** The Realtime connection surface this adapter uses, narrowed for testing. */
export interface RealtimeConnectionLike {
  on(event: string, listener: (data: unknown) => void): void
  send(event: Record<string, unknown>): void
  close(): void
}

export interface OpenAIRealtimeDeps {
  /** The key, from the broker. `null` when none is configured (FR-8.6). */
  apiKey(): string | null
  /** Realtime model id, from `prompts/herald/realtime-model-id.md`. */
  modelId(): string
  /**
   * Opens the socket. Production supplies the SDK's `OpenAIRealtimeWebSocket`,
   * which needs the runtime's native `WebSocket` — present in Electron's Node,
   * absent under vitest, which is why every test injects this.
   */
  connect?(apiKey: string, modelId: string): Promise<RealtimeConnectionLike>
}

/**
 * Contract: maps an OpenAI failure onto the seam's three faults.
 *
 * Same shape of judgement as the ElevenLabs classifier and the same reason for
 * it: `auth` must burn the provider (retrying a revoked key fails identically
 * forever), while a 5xx or a dropped socket is worth the other provider.
 */
export function classifyOpenAIError(err: unknown): VoiceFault {
  if (err instanceof VoiceError) return err.fault
  const status =
    err instanceof APIError
      ? err.status
      : typeof (err as { status?: unknown })?.status === 'number'
        ? (err as { status: number }).status
        : undefined
  if (status === 401 || status === 403) return 'auth'
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  if (name.includes('Timeout') || message.includes('timeout') || message.includes('timed out')) {
    return 'latency-breach'
  }
  if (typeof status === 'number' && status >= 500) return 'transient'
  if (message.includes('invalid_api_key') || message.includes('unauthorized')) return 'auth'
  return 'transient'
}

const MISSING_KEY = 'no OpenAI key configured'

export function createOpenAIRealtimeAdapter(deps: OpenAIRealtimeDeps): VoiceAdapter {
  const provider = 'openai-realtime' as const

  return {
    provider,

    duplex: {
      provider,
      async open(handlers): Promise<DuplexSession> {
        const key = deps.apiKey()
        if (!key) throw new VoiceError('auth', provider, MISSING_KEY)
        if (!deps.connect) {
          // Honest refusal rather than a crash inside the SDK: without a
          // transport there is no session, and the policy layer needs a fault
          // it can act on (invariant §7 — the degradation is visible).
          throw new VoiceError('transient', provider, 'no Realtime transport available')
        }

        let connection: RealtimeConnectionLike
        try {
          connection = await deps.connect(key, deps.modelId())
        } catch (err) {
          throw new VoiceError(
            classifyOpenAIError(err),
            provider,
            err instanceof Error ? err.message : String(err)
          )
        }

        connection.on('conversation.item.input_audio_transcription.delta', (data) => {
          const text = readString(data, 'delta')
          if (text !== null) handlers.onTranscript(partial(text))
        })
        connection.on('conversation.item.input_audio_transcription.completed', (data) => {
          const text = readString(data, 'transcript')
          if (text !== null) handlers.onTranscript({ text, final: true, confidence: null })
        })
        // What the model said back — the duplex half the policy layer maps
        // `speak` onto.
        connection.on('response.output_audio_transcript.done', (data) => {
          const text = readString(data, 'transcript')
          if (text !== null) handlers.onSpoken(text)
        })

        let open = true
        // The line the model reports having spoken, resolved by `say()`.
        let pendingSay: ((spoken: string) => void) | null = null
        connection.on('response.output_audio_transcript.done', (data) => {
          const text = readString(data, 'transcript')
          if (text !== null && pendingSay) {
            const resolve = pendingSay
            pendingSay = null
            resolve(text)
          }
        })

        return {
          write: (frame) => {
            if (!open) return
            connection.send({
              type: 'input_audio_buffer.append',
              audio: Buffer.from(frame).toString('base64')
            })
          },
          say: (text) =>
            new Promise<string>((resolve) => {
              if (!open) {
                resolve('')
                return
              }
              pendingSay = resolve
              // Realtime speaks by being asked to respond. Passing the line as
              // the response's instructions is what makes this provider a TTS
              // fallback, which is the job ADR-0007 gives it.
              connection.send({
                type: 'response.create',
                response: { modalities: ['audio', 'text'], instructions: text }
              })
            }),
          interrupt: () => {
            if (!open) return
            // ADR-0007: barge-in maps onto "the provider's interrupt
            // primitive". For Realtime that is cancelling the in-flight
            // response, which stops playback at the source.
            connection.send({ type: 'response.cancel' })
          },
          close: () => {
            open = false
            connection.close()
            return Promise.resolve()
          }
        }
      }
    },

    async health() {
      if (!deps.apiKey()) return { ok: false as const, fault: 'auth' as const }
      if (!deps.connect) return { ok: false as const, fault: 'transient' as const }
      return Promise.resolve({ ok: true as const, fault: null })
    }
  }
}

const partial = (text: string): Transcript => ({ text, final: false, confidence: null })

function readString(data: unknown, key: string): string | null {
  const value = (data as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : null
}

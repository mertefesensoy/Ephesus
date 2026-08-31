import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VoiceError,
  type DuplexSession,
  type SpeechHandle,
  type Transcript,
  type TranscriptionSession,
  type VoiceAdapter,
  type VoiceFault,
  type VoiceProviderId
} from '../../src/main/herald/seam'

/**
 * A voice adapter driven entirely by **recorded fixtures** — TEST-STRATEGY §5's
 * "contract tests over recorded fixtures".
 *
 * It exists for the same reason the fake engine does (BUILD-PROMPT M1.2): the
 * conformance harness must be proven against something before the real adapters
 * are written, or the first real adapter and the suite that judges it are
 * authored together and agree by construction.
 *
 * It touches no network and reads no key. Every latency it reports and every
 * error shape it classifies comes from `test/fixtures/voice/*.json`, which are
 * recorded provider responses trimmed to the fields an adapter actually reads.
 */

/** What a recorded response must beat to count as a voice (ADR-0007/NFR-3). */
export const DEFAULT_LATENCY_BUDGET_MS = 2_000

const FIXTURES = fileURLToPath(new URL('../fixtures/voice/', import.meta.url))

interface VoiceFixture {
  readonly provider: VoiceProviderId
  readonly streamStartMs: number
  readonly cancelMs: number
  readonly transcript: readonly Transcript[]
  readonly errors: Readonly<Record<VoiceFault, unknown>>
}

export function loadVoiceFixture(provider: VoiceProviderId): VoiceFixture {
  const file = path.join(FIXTURES, `${provider}.json`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as VoiceFixture
}

/**
 * Classifies a recorded provider payload the way a real adapter must.
 *
 * This is the taxonomy under test: a 401 or an `invalid_api_key` is `auth`
 * (retrying cannot help); a 5xx or a `server_error` is `transient`; anything
 * that answered but took longer than the budget is `latency-breach`. An adapter
 * that lumped all three into "error" would give the policy layer nothing to
 * decide with.
 */
export function classifyPayload(payload: unknown, budgetMs: number): VoiceFault {
  const record = (payload ?? {}) as Record<string, unknown>
  const elapsed = typeof record['elapsedMs'] === 'number' ? record['elapsedMs'] : 0
  if (elapsed > budgetMs) return 'latency-breach'

  const status = typeof record['status'] === 'number' ? record['status'] : 0
  const nested = (record['error'] ?? record['detail'] ?? {}) as Record<string, unknown>
  const code = String(nested['code'] ?? nested['status'] ?? '')
  if (status === 401 || status === 403 || code.includes('invalid_api_key')) return 'auth'
  if (status >= 500 || code.includes('server_error') || code.includes('service_unavailable')) {
    return 'transient'
  }
  return 'transient'
}

export interface FakeVoiceOptions {
  readonly provider: VoiceProviderId
  /** Force `health()` to report a fault, for the degradation cases. */
  readonly unhealthy?: VoiceFault
}

/** A voice adapter that replays one recorded fixture. */
export function fakeVoiceAdapter(options: FakeVoiceOptions): VoiceAdapter {
  const fixture = loadVoiceFixture(options.provider)

  const speak = async (text: string): Promise<SpeechHandle> => {
    let cancelled = false
    let spoken = ''
    // "Playback" is deterministic: the fixture says how far in the cancel
    // lands, so the barge-in case is a fact about the recording rather than a
    // race with a real clock.
    const cut = Math.floor(text.length / 2)
    return Promise.resolve({
      cancel: () => {
        cancelled = true
        spoken = text.slice(0, cut)
      },
      done: () => Promise.resolve(),
      spokenSoFar: () => (cancelled ? spoken : text)
    })
  }

  return {
    provider: options.provider,
    stt: {
      provider: options.provider,
      start: (onTranscript): Promise<TranscriptionSession> => {
        let open = true
        return Promise.resolve({
          write: () => {
            if (!open) return
            const partial = fixture.transcript[0]
            if (partial) onTranscript(partial)
          },
          end: () => {
            open = false
            const final = fixture.transcript.at(-1)
            if (final) onTranscript(final)
            return Promise.resolve()
          },
          cancel: () => {
            open = false
          }
        })
      }
    },
    tts: { provider: options.provider, speak },
    duplex:
      options.provider === 'openai-realtime'
        ? {
            provider: options.provider,
            open: (handlers): Promise<DuplexSession> =>
              Promise.resolve({
                write: () => {
                  const partial = fixture.transcript[0]
                  if (partial) handlers.onTranscript(partial)
                },
                say: (text: string) => {
                  handlers.onSpoken(text)
                  return Promise.resolve(text)
                },
                interrupt: () => handlers.onSpoken(''),
                close: () => Promise.resolve()
              })
          }
        : undefined,
    health: () =>
      Promise.resolve(
        options.unhealthy
          ? { ok: false as const, fault: options.unhealthy }
          : { ok: true as const, fault: null }
      )
  }
}

/** Contract: replays one recorded failure and returns the classified fault. */
export function replayFault(
  provider: VoiceProviderId,
  fault: VoiceFault,
  latencyBudgetMs = DEFAULT_LATENCY_BUDGET_MS
): VoiceFault {
  const fixture = loadVoiceFixture(provider)
  const classified = classifyPayload(fixture.errors[fault], latencyBudgetMs)
  // A real adapter throws a `VoiceError`; constructing one here keeps the fake
  // honest about the shape the policy layer will actually see.
  const error = new VoiceError(classified, provider, `recorded ${fault}`)
  return error.fault
}

import { describe, expect, it } from 'vitest'
import { VOICE_PROVIDERS } from '../../src/main/herald/seam'
import { fakeVoiceAdapter, loadVoiceFixture, replayFault } from '../fakes/fake-voice'
import {
  classifyElevenLabsError,
  createElevenLabsAdapter,
  type ElevenLabsLike
} from '../../src/main/herald/elevenlabs'
import { runVoiceConformance } from './voice-conformance'

/**
 * The voice conformance suite, run against every subject that claims to be a
 * voice adapter.
 *
 * The fixture-driven fake for both providers proves the harness; the shipped
 * ElevenLabs adapter (M6.5) proves the code that will actually run. When M6.6
 * lands the OpenAI Realtime adapter it joins this list and nothing else about
 * the suite changes — which is the extensibility guarantee NFR-12 is asking
 * for, and the reason the harness existed before the first adapter rather than
 * beside it.
 */

for (const provider of VOICE_PROVIDERS) {
  runVoiceConformance({
    name: `fixture:${provider}`,
    make: () => fakeVoiceAdapter({ provider }),
    classify: (fault) => Promise.resolve(replayFault(provider, fault)),
    streamStartMs: () => Promise.resolve(loadVoiceFixture(provider).streamStartMs),
    cancelMs: () => Promise.resolve(loadVoiceFixture(provider).cancelMs)
  })
}

/**
 * The SHIPPED ElevenLabs adapter, under the same suite.
 *
 * This is the half that matters: the fixture-driven fake proves the harness,
 * and this proves the adapter that will actually run. Its client is a double
 * (there is no key here, and a suite that needed one would not run in CI), but
 * the code under test is `createElevenLabsAdapter` itself — its cancel path,
 * its capability advertisement, its error taxonomy.
 */
runVoiceConformance({
  name: 'shipped:elevenlabs',
  make: () =>
    createElevenLabsAdapter({
      apiKey: () => 'conformance-key',
      voiceId: () => 'voice',
      modelId: () => 'model',
      sttModelId: () => 'stt',
      client: () => conformanceClient()
    }),
  // The fixture records the WIRE response; the SDK surfaces it as an error with
  // `statusCode`, which is what the adapter classifies on. Translating here
  // keeps the recording faithful to the provider rather than to our types.
  classify: (fault) => {
    const recorded = loadVoiceFixture('elevenlabs').errors[fault] as {
      status?: number
      elapsedMs?: number
    }
    if ((recorded.elapsedMs ?? 0) > 2_000) {
      return Promise.resolve(
        classifyElevenLabsError(
          Object.assign(new Error('request timed out'), { name: 'TimeoutError' })
        )
      )
    }
    return Promise.resolve(classifyElevenLabsError({ statusCode: recorded.status }))
  },
  streamStartMs: async () => {
    const started = Date.now()
    const adapter = createElevenLabsAdapter({
      apiKey: () => 'k',
      voiceId: () => 'v',
      modelId: () => 'm',
      sttModelId: () => 's',
      client: () => conformanceClient()
    })
    await adapter.tts?.speak('hello')
    // Measured on the shipped path: `speak()` must resolve once audio has
    // STARTED, not when the utterance finishes.
    return Date.now() - started
  },
  cancelMs: async () => {
    const adapter = createElevenLabsAdapter({
      apiKey: () => 'k',
      voiceId: () => 'v',
      modelId: () => 'm',
      sttModelId: () => 's',
      // A stream that never ends on its own: the only thing that can stop it
      // is the adapter's own cancel, so what is timed is the shipped path.
      client: () => conformanceClient({ endless: true })
    })
    const handle = await adapter.tts?.speak('a long sentence the Architect interrupts')
    const started = Date.now()
    handle?.cancel()
    await handle?.done()
    return Date.now() - started
  }
})

/** A client double that streams a couple of chunks, or forever. */
function conformanceClient(opts: { endless?: boolean } = {}): ElevenLabsLike {
  return {
    textToSpeech: {
      streamWithTimestamps: () =>
        Promise.resolve({
          async *[Symbol.asyncIterator]() {
            for (let i = 0; opts.endless ? true : i < 2; i += 1) {
              yield await Promise.resolve({
                audioBase64: Buffer.from('audio').toString('base64'),
                alignment: { characters: ['a'] }
              })
            }
          }
        })
    },
    speechToText: {
      realtime: {
        connect: () =>
          Promise.resolve({
            on: () => {},
            send: () => {},
            commit: () => {},
            close: () => {}
          })
      }
    }
  }
}

describe('the fixtures are recordings, not stand-ins', () => {
  it('carries no key, no token and no audio', () => {
    for (const provider of VOICE_PROVIDERS) {
      const raw = JSON.stringify(loadVoiceFixture(provider))
      // Invariant §6: no secret-shaped string in a fixture. A recorded session
      // is exactly where one would end up by accident.
      expect(raw).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
      expect(raw).not.toMatch(/[A-Za-z0-9_-]{40,}/)
      expect(raw.toLowerCase()).not.toContain('bearer ')
    }
  })

  it('records both providers, with the shapes each actually returns', () => {
    // ElevenLabs errors are HTTP-shaped; Realtime's arrive as session events.
    // An adapter that classified only one shape would pass a suite written
    // against the other, which is why both are recorded rather than normalised.
    const eleven = loadVoiceFixture('elevenlabs')
    const realtime = loadVoiceFixture('openai-realtime')
    expect(JSON.stringify(eleven.errors.auth)).toContain('401')
    expect(JSON.stringify(realtime.errors.auth)).toContain('invalid_api_key')
  })

  it('offers duplex only where the provider has it (ADR-0007)', () => {
    // ADR-0007 gives `DuplexVoice` to OpenAI Realtime and leaves it optional;
    // an adapter must not claim a capability to look complete.
    expect(fakeVoiceAdapter({ provider: 'openai-realtime' }).duplex).toBeDefined()
    expect(fakeVoiceAdapter({ provider: 'elevenlabs' }).duplex).toBeUndefined()
  })

  it('reports an unhealthy provider with a fault the seam names', () => {
    const adapter = fakeVoiceAdapter({ provider: 'elevenlabs', unhealthy: 'auth' })
    return expect(adapter.health()).resolves.toEqual({ ok: false, fault: 'auth' })
  })
})

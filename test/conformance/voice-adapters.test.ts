import { describe, expect, it } from 'vitest'
import { VOICE_PROVIDERS } from '../../src/main/herald/seam'
import { fakeVoiceAdapter, loadVoiceFixture, replayFault } from '../fakes/fake-voice'
import { runVoiceConformance } from './voice-conformance'

/**
 * The voice conformance suite, run against every subject that claims to be a
 * voice adapter.
 *
 * Today that is the fixture-driven fake for both providers. When M6.5 and M6.6
 * land the real ElevenLabs and OpenAI Realtime adapters, they join this list
 * and nothing else about the suite changes — which is the extensibility
 * guarantee NFR-12 is asking for, and the reason the harness exists before the
 * adapters rather than beside them.
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

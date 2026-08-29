import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PromptStore } from '../../src/main/prompts'
import { Phrasebook } from '../../src/main/herald/phrasebook'
import { createElevenLabsAdapter } from '../../src/main/herald/elevenlabs'
import { createOpenAIRealtimeAdapter } from '../../src/main/herald/openai-realtime'
import { HeraldSession, FAILOVER_BUDGET_MS } from '../../src/main/herald/session'
import { VOICE_FAULTS, type VoiceAdapter } from '../../src/main/herald/seam'

/**
 * **S-FAILOVER** (TEST-STRATEGY §3, SRS 6.5):
 *
 * > scripted ElevenLabs adapter failure mid-utterance → OpenAI Realtime
 * > continues ≤ 3 s; both down → text-only banner, briefs still generated.
 *
 * Scripted, not live: the failure is injected into the SHIPPED adapters through
 * their injected clients, so what runs is `createElevenLabsAdapter`,
 * `createOpenAIRealtimeAdapter`, `reduceFailover` and `HeraldSession` — the
 * production bodies, not a rig's copy of them. The M5b lesson applies here as
 * anywhere: if a scenario rebuilds the wiring inline, the wiring is tested by
 * nothing.
 *
 * The clock is a fixture clock, so "≤ 3 s" is asserted rather than raced.
 */

const BUNDLED = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function phrasebook(): Phrasebook {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-failover-'))
  temps.push(home)
  return new Phrasebook(new PromptStore(path.join(home, 'prompts'), BUNDLED))
}

/** A fixture clock: every advance is deliberate, so a budget is a fact. */
function clock(startMs = 0): { now(): number; advance(ms: number): void } {
  let t = startMs
  return { now: () => t, advance: (ms) => (t += ms) }
}

/**
 * The shipped ElevenLabs adapter, scripted to stream `upTo` characters and then
 * fail the way a real provider does.
 */
function elevenlabs(opts: {
  upTo?: number
  failWith?: { statusCode: number } | null
  key?: string | null
}): VoiceAdapter {
  return createElevenLabsAdapter({
    apiKey: () => (opts.key === undefined ? 'el-key' : opts.key),
    voiceId: () => 'voice',
    modelId: () => 'model',
    sttModelId: () => 'stt',
    client: () => ({
      textToSpeech: {
        streamWithTimestamps: (_voiceId, request) =>
          Promise.resolve({
            async *[Symbol.asyncIterator]() {
              const said = request.text.slice(0, opts.upTo ?? request.text.length)
              if (said.length > 0) {
                yield await Promise.resolve({
                  audioBase64: Buffer.from('audio').toString('base64'),
                  alignment: { characters: [...said] }
                })
              }
              if (opts.failWith) throw opts.failWith
            }
          })
      },
      speechToText: {
        realtime: {
          connect: () =>
            Promise.resolve({ on: () => {}, send: () => {}, commit: () => {}, close: () => {} })
        }
      }
    })
  })
}

/** The shipped Realtime adapter, scripted to answer or to fail. */
function realtime(
  opts: { fail?: boolean; key?: string | null; onSay?: (text: string) => void } = {}
): VoiceAdapter {
  return createOpenAIRealtimeAdapter({
    apiKey: () => (opts.key === undefined ? 'oa-key' : opts.key),
    modelId: () => 'gpt-realtime',
    connect: () => {
      if (opts.fail) return Promise.reject({ status: 503 })
      const listeners = new Map<string, (data: unknown) => void>()
      return Promise.resolve({
        on: (event: string, listener: (data: unknown) => void) => listeners.set(event, listener),
        // A real Realtime session answers a response.create with the
        // transcript of what it spoke; the fake does the same.
        send: (event: Record<string, unknown>) => {
          if (event['type'] !== 'response.create') return
          const response = event['response'] as { instructions?: string } | undefined
          opts.onSay?.(response?.instructions ?? '')
          listeners.get('response.output_audio_transcript.done')?.({
            transcript: response?.instructions ?? ''
          })
        },
        close: () => listeners.clear()
      })
    }
  })
}

const LINE = 'Mason wants to force-push to main; the release is still building.'

describe('S-FAILOVER — a provider fails mid-utterance', () => {
  it('continues on the fallback, within the NFR-3 budget, and says so once', async () => {
    const c = clock()
    const notices: string[] = []
    const session = new HeraldSession({
      adapters: [elevenlabs({ upTo: 11, failWith: { statusCode: 503 } }), realtime()],
      phrasebook: phrasebook(),
      now: c.now,
      onNotice: (_key, line) => {
        // The switch costs real time; the budget is asserted against it.
        c.advance(400)
        notices.push(line)
      }
    })

    const result = await session.speak(LINE)

    expect(result.attempted).toEqual(['elevenlabs', 'openai-realtime'])
    expect(session.state().state).toBe('degraded')
    expect(session.state().provider).toBe('openai-realtime')
    // FR-8.2: automatic, mid-session, with a ONE-line notice.
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('Switching voice provider')
    // NFR-3 / SRS 6.5: the fallback is speaking within 3 s.
    expect(result.failoverMs).not.toBeNull()
    expect(result.failoverMs ?? Infinity).toBeLessThanOrEqual(FAILOVER_BUDGET_MS)
  })

  it('keeps the transcript continuous — the fallback finishes the sentence', async () => {
    const c = clock()
    const saidByFallback: string[] = []
    const session = new HeraldSession({
      adapters: [
        elevenlabs({ upTo: 11, failWith: { statusCode: 503 } }),
        realtime({ onSay: (text) => saidByFallback.push(text) })
      ],
      phrasebook: phrasebook(),
      now: c.now
    })

    const result = await session.speak(LINE)

    // ADR-0007: the switch "keeps the transcript continuous". The whole line is
    // in the record, and none of it was said twice.
    expect(result.entry.text).toBe(LINE)
    expect(result.spoken).toBe(true)
    expect(result.entry.unspoken).toBe('')
    expect(session.entries()).toHaveLength(1)
    // And CONTINUOUS means the fallback picked up where the first provider
    // died — it was asked for the REMAINDER, not for the whole line again.
    // Without this the suite passes on a session that repeats the sentence.
    expect(saidByFallback).toEqual([LINE.slice(11)])
  })

  it.each(VOICE_FAULTS)('fails over on a %s fault, whichever it was', async (fault) => {
    const c = clock()
    const status = fault === 'auth' ? 401 : 503
    const failWith =
      fault === 'latency-breach'
        ? (Object.assign(new Error('request timed out'), { name: 'TimeoutError' }) as never)
        : { statusCode: status }
    const session = new HeraldSession({
      adapters: [elevenlabs({ upTo: 5, failWith }), realtime()],
      phrasebook: phrasebook(),
      now: c.now
    })
    await session.speak(LINE)
    expect(session.state().provider).toBe('openai-realtime')
    expect(session.state().reason).toBe(fault)
  })

  it('does not fail back on its own (ADR-0007)', async () => {
    const c = clock()
    const session = new HeraldSession({
      adapters: [elevenlabs({ upTo: 3, failWith: { statusCode: 503 } }), realtime()],
      phrasebook: phrasebook(),
      now: c.now
    })
    await session.speak(LINE)
    c.advance(60 * 60 * 1000)
    await session.speak('And again.')
    // An hour later it is still on the fallback: a provider that failed will
    // fail again, and flapping mid-conversation is worse than staying put.
    expect(session.state().provider).toBe('openai-realtime')

    session.failback()
    expect(session.state().provider).toBe('elevenlabs')
    expect(session.state().state).toBe('healthy')
  })
})

describe('S-FAILOVER — both providers down (FR-8.6)', () => {
  it('goes text-only, and says which state it is in', async () => {
    const c = clock()
    const notices: string[] = []
    const session = new HeraldSession({
      adapters: [elevenlabs({ upTo: 0, failWith: { statusCode: 401 } }), realtime({ fail: true })],
      phrasebook: phrasebook(),
      now: c.now,
      onNotice: (_key, line) => notices.push(line)
    })

    const result = await session.speak(LINE)

    expect(session.state().state).toBe('cooldown')
    expect(session.available()).toBe(false)
    expect(result.spoken).toBe(false)
    // The banner is a real sentence from the phrase book, not a key.
    expect(notices.at(-1)).toContain('lost both voices')
    expect(notices.at(-1)).not.toContain('voice-unavailable')
  })

  it('loses NOTHING but the audio — the line is in the transcript in full', async () => {
    const c = clock()
    const session = new HeraldSession({
      adapters: [elevenlabs({ upTo: 0, failWith: { statusCode: 401 } }), realtime({ fail: true })],
      phrasebook: phrasebook(),
      now: c.now
    })

    await session.speak(LINE)
    await session.speak('The brief is on the card.')

    // FR-8.6: "Without configured voice keys the entire system SHALL function
    // fully in text." Every line is recorded, marked entirely unspoken, and
    // nothing about the company's records depends on a provider being up.
    const entries = session.entries()
    expect(entries.map((e) => e.text)).toEqual([LINE, 'The brief is on the card.'])
    for (const entry of entries) {
      expect(entry.provider).toBeNull()
      expect(entry.unspoken).toBe(entry.text)
    }
  })

  it('is text-only from the start when no keys are configured at all', async () => {
    const c = clock()
    const session = new HeraldSession({
      adapters: [elevenlabs({ key: null }), realtime({ key: null })],
      phrasebook: phrasebook(),
      now: c.now
    })
    const result = await session.speak(LINE)
    // A company with no voice keys is not a broken company; it is a quiet one.
    expect(result.spoken).toBe(false)
    expect(result.entry.text).toBe(LINE)
    expect(session.state().state).toBe('cooldown')
  })

  it('reports both adapters unhealthy rather than looking fine', async () => {
    await expect(elevenlabs({ key: null }).health()).resolves.toEqual({ ok: false, fault: 'auth' })
    await expect(realtime({ key: null }).health()).resolves.toEqual({ ok: false, fault: 'auth' })
  })
})

describe('S-FAILOVER — the decision is the policy’s', () => {
  it('switches on the POLICY’s reducer, never on an adapter’s say-so', async () => {
    const c = clock()
    const session = new HeraldSession({
      adapters: [elevenlabs({ upTo: 4, failWith: { statusCode: 503 } }), realtime()],
      phrasebook: phrasebook(),
      now: c.now
    })
    await session.speak(LINE)
    // Neither shipped adapter exposes anything it could have decided WITH —
    // this is the structural half of ADR-0007's "adapters stay dumb pipes".
    for (const adapter of [elevenlabs({}), realtime()]) {
      for (const forbidden of ['failover', 'retry', 'switchProvider', 'select']) {
        expect(Object.keys(adapter), `${adapter.provider}.${forbidden}`).not.toContain(forbidden)
      }
    }
    expect(session.state().state).toBe('degraded')
  })
})

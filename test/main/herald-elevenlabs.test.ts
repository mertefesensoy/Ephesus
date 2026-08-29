import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PromptStore } from '../../src/main/prompts'
import {
  Phrasebook,
  PHRASEBOOK_PATH,
  STT_MODEL_PATH,
  TTS_MODEL_PATH,
  VOICE_ID_PATH,
  parsePhrasebook
} from '../../src/main/herald/phrasebook'
import {
  classifyElevenLabsError,
  createElevenLabsAdapter,
  type ElevenLabsLike,
  type RealtimeLike,
  type TimestampedChunk
} from '../../src/main/herald/elevenlabs'
import { VoiceError, isConversational, type Transcript } from '../../src/main/herald/seam'
import { bargeIn } from '../../src/main/herald/policy'

/**
 * The ElevenLabs adapter (ADR-0007's reference implementation) and the phrase
 * book that keeps its words out of code.
 *
 * No network and no key: the SDK client is injected, so what is tested is the
 * adapter's own behaviour — how it classifies a failure, what it does with a
 * missing key, and whether the "unspoken from here" mark is a measurement or a
 * guess. The provider's wire protocol is the SDK's problem, which is why the
 * SDK is a dependency (Architect approval, 2026-08-29).
 */

const BUNDLED = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** The adapter's source with comments stripped — for the "in code" assertions. */
function adapterCode(): string {
  const source = fs.readFileSync(
    fileURLToPath(new URL('../../src/main/herald/elevenlabs.ts', import.meta.url)),
    'utf8'
  )
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function prompts(): PromptStore {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-herald-'))
  temps.push(home)
  return new PromptStore(path.join(home, 'prompts'), BUNDLED)
}

/** A client double that replays chunks the test names. */
function fakeClient(opts: {
  chunks?: readonly TimestampedChunk[]
  ttsError?: unknown
  sttError?: unknown
  onConnect?: (c: RealtimeLike) => void
}): ElevenLabsLike {
  return {
    textToSpeech: {
      streamWithTimestamps: async () => {
        if (opts.ttsError) throw opts.ttsError
        const chunks = opts.chunks ?? []
        return Promise.resolve({
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield await Promise.resolve(chunk)
          }
        })
      }
    },
    speechToText: {
      realtime: {
        connect: async () => {
          if (opts.sttError) throw opts.sttError
          const listeners = new Map<string, (data: unknown) => void>()
          const connection: RealtimeLike = {
            on: (event, listener) => listeners.set(event, listener),
            send: () => listeners.get('partial_transcript')?.({ text: 'show me' }),
            commit: () => listeners.get('committed_transcript')?.({ text: 'show me the ledger' }),
            close: () => listeners.clear()
          }
          opts.onConnect?.(connection)
          return Promise.resolve(connection)
        }
      }
    }
  }
}

const chunk = (audio: string, chars: string): TimestampedChunk => ({
  audioBase64: Buffer.from(audio).toString('base64'),
  alignment: { characters: [...chars] }
})

function adapter(client: ElevenLabsLike, key: string | null = 'test-key') {
  return createElevenLabsAdapter({
    apiKey: () => key,
    voiceId: () => 'voice-1',
    modelId: () => 'model-1',
    sttModelId: () => 'stt-1',
    client: () => client
  })
}

describe('the adapter is a dumb pipe (ADR-0007)', () => {
  it('offers STT and TTS, and does not claim duplex it lacks', () => {
    const a = adapter(fakeClient({}))
    expect(a.provider).toBe('elevenlabs')
    expect(a.tts).toBeDefined()
    expect(a.stt).toBeDefined()
    // ADR-0007 gives DuplexVoice to OpenAI Realtime. Claiming it here would
    // make the policy layer prefer this provider for the wrong reason.
    expect(a.duplex).toBeUndefined()
    expect(isConversational(a)).toBe(true)
  })

  it('exposes no way to decide anything about failover', () => {
    const surface = Object.keys(adapter(fakeClient({})))
    for (const forbidden of ['failover', 'retry', 'switchProvider', 'select', 'preferOver']) {
      expect(surface, forbidden).not.toContain(forbidden)
    }
  })
})

describe('a missing key is a visible degradation (FR-8.6, invariant §6)', () => {
  it('reports the fault rather than pretending to be healthy', async () => {
    await expect(adapter(fakeClient({}), null).health()).resolves.toEqual({
      ok: false,
      fault: 'auth'
    })
  })

  it('refuses to speak, naming the reason', async () => {
    const a = adapter(fakeClient({}), null)
    await expect(a.tts?.speak('hello')).rejects.toBeInstanceOf(VoiceError)
    await expect(a.tts?.speak('hello')).rejects.toThrow(/no ElevenLabs key/)
  })

  it('never reads the key from the environment', () => {
    // Invariant §6 / ADR-0010: the key arrives through the injected getter,
    // which main fills from the write-only broker. `check-invariants.cjs`
    // permits `process.env` under herald/, so this is the check that the
    // permission is not being used.
    // Comments stripped: the ban is on the CODE reading the environment, and
    // the module documents the rule it follows.
    expect(adapterCode()).not.toContain('process.env')
  })
})

describe('speaking, and the mark the barge-in leaves', () => {
  it('streams audio out through the sink', async () => {
    const audio: Uint8Array[] = []
    const handle = await adapter(
      fakeClient({ chunks: [chunk('one', 'Mason '), chunk('two', 'is done.')] })
    ).tts?.speak('Mason is done.', { onAudio: (c) => audio.push(c) })
    await handle?.done()
    expect(audio).toHaveLength(2)
    expect(Buffer.from(audio[0] as Uint8Array).toString()).toBe('one')
  })

  it('reports what was spoken as a MEASUREMENT, not an estimate', async () => {
    const line = 'Mason is done.'
    const handle = await adapter(
      fakeClient({ chunks: [chunk('a', 'Mason '), chunk('b', 'is done.')] })
    ).tts?.speak(line)
    await handle?.done()
    // The provider's own character alignment, accumulated — not a guess at
    // 150 words per minute.
    expect(handle?.spokenSoFar()).toBe(line)
  })

  it('leaves the transcript honest when a cancel lands mid-utterance', async () => {
    const line = 'Mason wants to force-push to main.'
    let released = (): void => {}
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })
    const client: ElevenLabsLike = {
      ...fakeClient({}),
      textToSpeech: {
        streamWithTimestamps: () =>
          Promise.resolve({
            async *[Symbol.asyncIterator]() {
              yield chunk('a', 'Mason wants')
              await gate
              yield chunk('b', ' to force-push to main.')
            }
          })
      }
    }
    const handle = await adapter(client).tts?.speak(line)
    // Let the first chunk land, then interrupt.
    await new Promise((r) => setImmediate(r))
    handle?.cancel()
    released()
    await handle?.done()

    const spoken = handle?.spokenSoFar() ?? ''
    const split = bargeIn(line, spoken)
    // VOICE-DESIGN §2: the interrupted text remains, split at what was heard.
    expect(split.spoken).toBe('Mason wants')
    expect(split.spoken + split.unspoken).toBe(line)
  })
})

describe('streaming transcription', () => {
  it('emits partials and a final, and lets the provider do the endpointing', async () => {
    const heard: Transcript[] = []
    const session = await adapter(fakeClient({})).stt?.start((t) => heard.push(t))
    session?.write(new Uint8Array([1, 2, 3]))
    await session?.end()
    expect(heard).toEqual([
      { text: 'show me', final: false, confidence: null },
      { text: 'show me the ledger', final: true, confidence: null }
    ])
  })

  it('stops feeding a cancelled session', async () => {
    let sends = 0
    const client = fakeClient({
      onConnect: (c) => {
        const original = c.send.bind(c)
        c.send = (data) => {
          sends += 1
          original(data)
        }
      }
    })
    const session = await adapter(client).stt?.start(() => {})
    session?.write(new Uint8Array([1]))
    session?.cancel()
    session?.write(new Uint8Array([2]))
    // Barge-in supersedes the session; writing on afterwards would keep the
    // microphone open past the moment the Architect stopped talking.
    expect(sends).toBe(1)
  })
})

describe('the error taxonomy (TEST-STRATEGY §5)', () => {
  it.each([
    ['a 401', { statusCode: 401 }, 'auth'],
    ['a 403', { statusCode: 403 }, 'auth'],
    ['a 500', { statusCode: 500 }, 'transient'],
    ['a 503', { statusCode: 503 }, 'transient'],
    [
      'a timeout',
      Object.assign(new Error('request timed out'), { name: 'TimeoutError' }),
      'latency-breach'
    ],
    ['an unauthorized message', new Error('unauthorized'), 'auth'],
    ['anything else', new Error('socket hang up'), 'transient']
  ])('maps %s', (_label, err, expected) => {
    expect(classifyElevenLabsError(err)).toBe(expected)
  })

  it('wraps a failure as a VoiceError carrying the fault', async () => {
    const a = adapter(fakeClient({ ttsError: { statusCode: 401 } }))
    await expect(a.tts?.speak('hi')).rejects.toMatchObject({
      fault: 'auth',
      provider: 'elevenlabs'
    })
    const b = adapter(fakeClient({ sttError: { statusCode: 503 } }))
    await expect(b.stt?.start(() => {})).rejects.toMatchObject({ fault: 'transient' })
  })
})

describe('the Herald’s words and voice are config (invariant §8, FR-8.5)', () => {
  it('parses the phrase book by heading', () => {
    const entries = parsePhrasebook('## a\nfirst\n\n## b\nsecond line\nand more\n')
    expect(entries).toEqual({ a: 'first', b: 'second line\nand more' })
  })

  it('reads a line and fills its placeholders', () => {
    const book = new Phrasebook(prompts())
    expect(book.line('switching-provider')).toContain('Switching voice provider')
    expect(book.line('repeat-back', { what: 'Delete branch', token: 'confirm delete' })).toContain(
      'confirm delete'
    )
  })

  it('throws on an unknown key rather than speaking the key aloud', () => {
    const book = new Phrasebook(prompts())
    // Saying "switching-provider" out loud is worse than crashing: it looks
    // like working software.
    expect(() => book.line('no-such-line')).toThrow(/no entry/)
    expect(() => book.line('repeat-back', {})).toThrow(/needs a value/)
  })

  it('loads voice and model ids from prompts, not from code', () => {
    const book = new Phrasebook(prompts())
    for (const p of [VOICE_ID_PATH, TTS_MODEL_PATH, STT_MODEL_PATH]) {
      expect(book.value(p).length, p).toBeGreaterThan(0)
    }
    // A voice id in code would be the persona in code by another name.
    const code = adapterCode()
    expect(code).not.toContain(book.value(VOICE_ID_PATH))
    expect(code).not.toContain(book.value(TTS_MODEL_PATH))
  })

  it('seeds the editable copy so the Architect can change any of it', () => {
    const store = prompts()
    const book = new Phrasebook(store)
    book.line('switching-provider')
    // PromptStore seeds home from the bundled copy on first read; that is what
    // makes "config, not code" true in practice rather than in principle.
    expect(fs.existsSync(store.pathOf(PHRASEBOOK_PATH))).toBe(true)
  })
})

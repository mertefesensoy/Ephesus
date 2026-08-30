import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { Agora } from '../../src/main/agora'
import { Hermes } from '../../src/main/hermes'
import { PromptStore } from '../../src/main/prompts'
import { DEFAULT_HOP_CAP } from '../../src/shared/routing'
import { envelopeFor, envelopeInfo, reduceEnvelope } from '../../src/shared/vfx'

/**
 * The seam between Hermes and the floor's envelopes (UI-DESIGN §5.5).
 *
 * `test/shared/vfx.test.ts` proves the model against log entries it writes
 * itself, which is exactly the blindness every milestone audit here has found:
 * two correct halves that have never met. So this file delivers REAL messages
 * through the REAL router into a REAL `log.jsonl` on real fs, and then asks
 * `envelopeFor` what flies — because if Hermes ever renames a field, the model
 * silently stops producing envelopes and every unit test stays green.
 *
 * Nothing is mocked, and no log entry is hand-written.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []
const routers: Hermes[] = []
const agoras: Agora[] = []

afterEach(async () => {
  for (const hermes of routers.splice(0)) hermes.stop()
  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

async function rig(): Promise<{
  agora: Agora
  hermes: Hermes
  send(from: string, m: Message): void
}> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-vfx-'))
  temps.push(home)
  const agora = new Agora({
    root: path.join(home, 'agora'),
    prompts: new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS),
    backoffMs: 1
  })
  await agora.ensureRepo()
  agoras.push(agora)
  const hermes = new Hermes({ agora })
  routers.push(hermes)
  hermes.ensureMailbox('agent.a')
  hermes.ensureMailbox('agent.b')
  return {
    agora,
    hermes,
    send(from, m) {
      fs.writeFileSync(
        path.join(agora.agentDir(from), 'outbox', `${m.id}.json`),
        JSON.stringify(m, null, 2),
        'utf8'
      )
    }
  }
}

let counter = 0
function message(over: Partial<Parameters<typeof composeMessage>[0]> = {}): Message {
  counter += 1
  return composeMessage({
    id: makeMessageId(
      new Date(Date.UTC(2026, 7, 29, 12, 0, 0, counter % 1000)),
      `v${String(counter).padStart(4, '0')}`
    ),
    conversation: 'conv-vfx',
    from: 'agent.a',
    to: 'agent.b',
    act: 'request',
    subject: 'the numbers',
    body: 'please send them',
    created_at: '2026-08-29T12:00:00.000Z',
    ...over
  })
}

describe('an envelope flies because the real router logged a real delivery', () => {
  it('turns Hermes’s own delivery entry into a flight', async () => {
    const r = await rig()
    const sent = message({ act: 'propose' })
    r.send('agent.a', sent)
    await r.hermes.sweep()

    const entry = r.agora.readLog().find((e) => e['kind'] === 'delivery')
    expect(entry, 'the router logged no delivery').toBeDefined()

    // The whole point: the SHIPPED log entry, not one this test invented.
    const flight = envelopeFor(entry as never)
    expect(flight).not.toBeNull()
    expect(flight?.id).toBe(sent.id)
    expect(flight?.from).toBe('agent.a')
    expect(flight?.to).toBe('agent.b')
    expect(flight?.act).toBe('propose')
    // §5.5: `propose` needs a verdict, so it is gold.
    expect(flight?.color).toBe('gold')
    expect(flight?.kind).toBe('deliver')
  })

  it('flies nothing for the entries that are not deliveries', async () => {
    const r = await rig()
    r.send('agent.a', message())
    await r.hermes.sweep()
    const flown = r.agora
      .readLog()
      .filter((e) => envelopeFor(e as never) !== null)
      .map((e) => e['kind'])
    // Every entry that produces an envelope is a delivery or a bounce, and
    // nothing else on the log does — spawns and hooks are not mail.
    for (const kind of flown) expect(['delivery', 'bounce']).toContain(kind)
  })

  it('wobbles a real bounce, in wine', async () => {
    const r = await rig()
    r.send('agent.a', message({ to: 'agent.nobody' }))
    await r.hermes.sweep()

    const entry = r.agora.readLog().find((e) => e['kind'] === 'bounce')
    expect(entry, 'the router logged no bounce').toBeDefined()
    const flight = envelopeFor(entry as never)
    expect(flight?.kind).toBe('bounce')
    expect(flight?.wobble).toBe(true)
    expect(flight?.color).toBe('wine')
    // It does not turn toward the temple — that is the hop cap's behaviour,
    // and confusing the two would tell the reader the wrong story.
    expect(flight?.towardTemple).toBe(false)
  })

  it('turns a real hop-cap divert toward the temple', async () => {
    const r = await rig()
    // The router diverts at the cap (ADR-0003); the hop count rides the message.
    r.send('agent.a', message({ hops: DEFAULT_HOP_CAP }))
    await r.hermes.sweep()

    const entry = r.agora
      .readLog()
      .find((e) => e['kind'] === 'bounce' && String(e['reason']).includes('hop cap'))
    expect(entry, 'the router logged no hop-cap divert').toBeDefined()
    const flight = envelopeFor(entry as never)
    expect(flight?.kind).toBe('divert')
    expect(flight?.towardTemple).toBe(true)
  })

  it('keeps information parity on a real delivery (§8)', async () => {
    const r = await rig()
    const sent = message({ act: 'done' })
    r.send('agent.a', sent)
    await r.hermes.sweep()

    const entry = r.agora.readLog().find((e) => e['kind'] === 'delivery')
    const flight = envelopeFor(entry as never)
    expect(flight).not.toBeNull()
    // Reduced motion drops the flight, never the fact.
    const reduced = reduceEnvelope(flight as never)
    expect(reduced.info).toEqual(envelopeInfo(flight as never))
    expect(reduced.info.text).toContain('agent.a')
    expect(reduced.info.text).toContain('agent.b')
  })

  it('takes its clock from the record, so a replay flies the same envelopes', async () => {
    const r = await rig()
    r.send('agent.a', message())
    await r.hermes.sweep()

    const entries = r.agora.readLog().filter((e) => e['kind'] === 'delivery')
    // Reading the same log twice must give identical flights — the model holds
    // no state of its own, which is what makes the floor reconstructible
    // (NFR-13's spirit).
    const first = entries.map((e) => envelopeFor(e as never))
    const second = entries.map((e) => envelopeFor(e as never))
    expect(first).toEqual(second)
    for (const flight of first) expect(flight?.startedMs).toBeGreaterThan(0)
  })
})

describe('the OTHER delivery path also flies (M6.10)', () => {
  it('turns a harness-authored delivery into a flight', async () => {
    // The M6 close-out audit found this seam drove only `Hermes.deliver`. But
    // `deliverFromHarness` writes a `delivery` entry too — it is how every
    // endpoint's answer and every reflection request reaches an agent — and
    // renaming `msgId` on THAT path broke nothing, because nothing looked.
    // NFR-13 is not "the router's mail is reconstructible"; it is all of it.
    const r = await rig()
    const sent = message({ act: 'agree' })
    r.hermes.deliverFromHarness(sent)

    const entry = r.agora.readLog().find((e) => e['kind'] === 'delivery')
    expect(entry, 'deliverFromHarness logged no delivery').toBeDefined()

    const flight = envelopeFor(entry as never)
    expect(flight).not.toBeNull()
    expect(flight?.id).toBe(sent.id)
    expect(flight?.from).toBe(sent.from)
    expect(flight?.to).toBe(sent.to)
    expect(flight?.act).toBe('agree')
    // §5.5: `agree` is laurel — a verdict granted.
    expect(flight?.color).toBe('laurel')
    expect(flight?.kind).toBe('deliver')
  })

  it('carries §8 parity on the harness path too', async () => {
    const r = await rig()
    const sent = message({ act: 'inform' })
    r.hermes.deliverFromHarness(sent)
    const entry = r.agora.readLog().find((e) => e['kind'] === 'delivery')
    const flight = envelopeFor(entry as never)
    expect(flight).not.toBeNull()
    if (!flight) return
    const said = reduceEnvelope(flight).info.text
    expect(said).toContain(sent.from)
    expect(said).toContain(sent.to)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { Agora } from '../../src/main/agora'
import { Hermes } from '../../src/main/hermes'
import { PromptStore } from '../../src/main/prompts'
import { removeTempDir } from '../tmpdir'

/**
 * D5 (M8.10) — mail written to an agent that has no session to read it.
 *
 * **Verified open by execution before anything was built for it**, because the
 * register was written before `f6c9262` and the merged
 * `fix/mail-lost-when-a-woken-agent-dies` landed and either might have closed
 * it. They did not: those fix the agent that COMES BACK — a respawned session
 * being told again, and in-flight mail returning to the inbox on exit. A probe
 * against the real router showed a message delivered into a dead agent's
 * inbox, sitting there across three wake ticks, nobody nudged, and one row in
 * the book of record: `delivery`. Nothing said the mail was unread.
 *
 * ## What the fix is, and what it deliberately is not
 *
 * The mail is NOT bounced and NOT dropped. An agent can come back — the respawn
 * ladders exist for exactly that — and its inbox is where its mail belongs
 * until it does. Bouncing would break the case the ladder was built for. What
 * was missing is not delivery, it is DISCLOSURE (invariant §7).
 *
 * The question the watchdog could not previously ask is "is there a process at
 * all". `isIdle` is false for a busy agent AND for a gone one, so "ask later"
 * and "nobody is ever going to read this" arrived as the same silence.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []
const routers: Hermes[] = []
const agoras: Agora[] = []

afterEach(async () => {
  for (const hermes of routers.splice(0)) {
    hermes.stop()
    await hermes.settled()
  }
  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

interface Rig {
  readonly agora: Agora
  readonly hermes: Hermes
  readonly nudged: string[]
  readonly stranded: { agentId: string; pendingMail: number }[]
  send(from: string, message: Message): void
  pending(agentId: string): readonly string[]
}

/** `live` is the set of agents that still have a process. */
async function rig(live: ReadonlySet<string>, options: { wired?: boolean } = {}): Promise<Rig> {
  const wired = options.wired ?? true
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-stranded-'))
  temps.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const agora = new Agora({ root: path.join(home, 'agora'), prompts, backoffMs: 1 })
  await agora.ensureRepo()
  agoras.push(agora)

  const nudged: string[] = []
  const stranded: { agentId: string; pendingMail: number }[] = []
  const hermes = new Hermes({
    agora,
    isIdle: (id) => live.has(id),
    ...(wired ? { hasSession: (id: string) => live.has(id) } : {}),
    onMailStranded: (agentId, detail) => stranded.push({ agentId, ...detail }),
    nudge: (id) => nudged.push(id)
  })
  routers.push(hermes)
  hermes.ensureMailbox('agent.a')
  hermes.ensureMailbox('agent.b')

  return {
    agora,
    hermes,
    nudged,
    stranded,
    send(from, message) {
      fs.writeFileSync(
        path.join(agora.agentDir(from), 'outbox', `${message.id}.json`),
        JSON.stringify(message, null, 2),
        'utf8'
      )
    },
    pending(agentId) {
      const dir = path.join(agora.agentDir(agentId), 'inbox')
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : []
    }
  }
}

let counter = 0
function message(over: Partial<Parameters<typeof composeMessage>[0]> = {}): Message {
  counter += 1
  return composeMessage({
    id: makeMessageId(
      new Date(Date.UTC(2026, 8, 7, 9, 0, 0, counter % 1000)),
      `s${String(counter).padStart(4, '0')}`
    ),
    conversation: 'conv-stranded',
    from: 'agent.a',
    to: 'agent.b',
    act: 'request',
    subject: 'are you there',
    body: 'please confirm',
    created_at: '2026-09-07T09:00:00.000Z',
    ...over
  })
}

describe('D5 — mail waiting for an agent with no session', () => {
  it('is reported, in the book of record and to the Architect', async () => {
    const r = await rig(new Set(['agent.a']))
    r.send('agent.a', message())
    await r.hermes.sweep()
    await r.hermes.wakeCheck()

    expect(r.stranded).toEqual([{ agentId: 'agent.b', pendingMail: 1 }])
    const rows = r.agora.readLogAll().filter((row) => row['event'] === 'mail-stranded')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['agentId']).toBe('agent.b')
    expect(rows[0]?.['pendingMail']).toBe(1)
    // The row says WHY, so a forensic reader does not have to infer it.
    expect(String(rows[0]?.['because'])).toContain('no session')
  })

  it('leaves the mail exactly where it is', async () => {
    const r = await rig(new Set(['agent.a']))
    const sent = message()
    r.send('agent.a', sent)
    await r.hermes.sweep()
    await r.hermes.wakeCheck()

    // Not bounced, not archived, not consumed: an agent that comes back must
    // find its mail. Reporting is the whole of the change.
    expect(r.pending('agent.b')).toEqual([`${sent.id}.json`])
    expect(r.nudged).toEqual([])
  })

  it('reports once, not once per tick', async () => {
    const r = await rig(new Set(['agent.a']))
    r.send('agent.a', message())
    await r.hermes.sweep()
    await r.hermes.wakeCheck()
    await r.hermes.wakeCheck()
    await r.hermes.wakeCheck()

    // The sweep runs every second. A condition that re-reports every second is
    // a condition nobody reads.
    expect(r.stranded).toHaveLength(1)
    expect(r.agora.readLogAll().filter((row) => row['event'] === 'mail-stranded')).toHaveLength(1)
  })

  it('reports again when NEW mail arrives for the same silent agent', async () => {
    const r = await rig(new Set(['agent.a']))
    r.send('agent.a', message())
    await r.hermes.sweep()
    await r.hermes.wakeCheck()
    expect(r.stranded).toHaveLength(1)

    r.send('agent.a', message())
    await r.hermes.sweep()
    await r.hermes.wakeCheck()

    // A second correspondent writing to the same silence is a new fact.
    expect(r.stranded).toHaveLength(2)
    expect(r.stranded[1]?.pendingMail).toBe(2)
  })

  it('says nothing about an agent that is merely busy', async () => {
    // Both live — `isIdle` is what gates the nudge, and a busy agent will be
    // nudged later. Confusing this with a dead one is the defect in reverse.
    const r = await rig(new Set(['agent.a', 'agent.b']))
    r.send('agent.a', message())
    await r.hermes.sweep()
    await r.hermes.wakeCheck()
    expect(r.stranded).toEqual([])
  })

  it('reports again when a nudged agent dies still holding the mail', async () => {
    // The case a weaker version of this test missed, and a mutation found:
    // clearing the record on the nudge is what makes a SECOND stranding of the
    // SAME message audible.
    //
    // `consumeInbox` hands mail to a session by renaming it into `.inflight/`,
    // and `forgetSession` on exit returns it to the inbox under the SAME
    // filename (the mechanism `f6c9262` added). So the second stranding has a
    // byte-identical signature to the first, and a record that was never
    // cleared would swallow it — mail handed to a session that died holding it,
    // going quiet exactly when it matters most.
    const live = new Set(['agent.a'])
    const r = await rig(live)
    const sent = message()
    r.send('agent.a', sent)
    await r.hermes.sweep()
    await r.hermes.wakeCheck()
    expect(r.stranded).toHaveLength(1)

    // It comes back and is handed the mail.
    live.add('agent.b')
    await r.hermes.wakeCheck()
    expect(r.nudged).toEqual(['agent.b'])
    expect(r.pending('agent.b')).toEqual([])

    // It dies mid-turn. The exit seam returns the in-flight mail to the inbox,
    // under the name it already had.
    live.delete('agent.b')
    expect(r.hermes.forgetSession('agent.b')).toBe(1)
    expect(r.pending('agent.b')).toEqual([`${sent.id}.json`])

    await r.hermes.wakeCheck()
    expect(r.stranded).toHaveLength(2)
    expect(r.stranded[1]).toEqual({ agentId: 'agent.b', pendingMail: 1 })
  })

  it('goes quiet once the inbox is empty, then speaks again for new mail', async () => {
    const live = new Set(['agent.a'])
    const r = await rig(live)
    r.send('agent.a', message())
    await r.hermes.sweep()
    await r.hermes.wakeCheck()
    expect(r.stranded).toHaveLength(1)

    live.add('agent.b')
    await r.hermes.wakeCheck()
    expect(r.nudged).toEqual(['agent.b'])

    live.delete('agent.b')
    r.send('agent.a', message())
    await r.hermes.sweep()
    await r.hermes.wakeCheck()
    expect(r.stranded).toHaveLength(2)
  })

  it('says nothing when the harness cannot tell whether a session exists', async () => {
    // `hasSession` absent means unknown, and an unknown must not manufacture a
    // degradation. This is also the assertion that the behaviour above comes
    // from the guard rather than from something else in the sweep.
    const r = await rig(new Set(['agent.a']), { wired: false })
    r.send('agent.a', message())
    await r.hermes.sweep()
    await r.hermes.wakeCheck()
    expect(r.stranded).toEqual([])
    expect(r.agora.readLogAll().filter((row) => row['event'] === 'mail-stranded')).toEqual([])
  })
})

/**
 * The guard above is opt-in, so a harness that never passes `hasSession` keeps
 * the defect with every unit test in this file still green. That is the
 * "green suite is not a wired feature" shape this repository keeps
 * rediscovering, so the production wiring is asserted rather than assumed.
 *
 * The check strips comments FIRST. A checker written as a bare
 * `source.includes('hasSession')` would be satisfied by the word appearing in
 * a comment — which is precisely how a guard written for a real defect
 * survived being fed that defect on 2026-09-07 — so the last case here feeds
 * this checker the case it must fail.
 */
describe('D5 — the production harness wires it', () => {
  const INDEX = path.join(__dirname, '..', '..', 'src', 'main', 'index.ts')

  /** Source with block and line comments removed. */
  function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  /** The argument object of `new Hermes({ … })`, comments stripped. */
  function hermesOptions(source: string): string {
    const stripped = code(source)
    const start = stripped.indexOf('new Hermes({')
    expect(start).toBeGreaterThan(-1)
    let depth = 0
    for (let i = stripped.indexOf('{', start); i < stripped.length; i += 1) {
      if (stripped[i] === '{') depth += 1
      if (stripped[i] === '}') {
        depth -= 1
        if (depth === 0) return stripped.slice(start, i + 1)
      }
    }
    throw new Error('unbalanced braces in the Hermes construction')
  }

  it('passes hasSession from the process table, not from idleness', () => {
    const options = hermesOptions(fs.readFileSync(INDEX, 'utf8'))
    expect(options).toContain('hasSession:')
    // The VALUE matters as much as the key: wiring it to `isIdle` would
    // reintroduce the exact confusion the seam exists to end.
    expect(/hasSession:\s*\(\s*\w+\s*\)\s*=>\s*ptyManager\.has\(/.test(options)).toBe(true)
  })

  it('routes the report to the degradation surface', () => {
    const options = hermesOptions(fs.readFileSync(INDEX, 'utf8'))
    expect(options).toContain('onMailStranded:')
    expect(options).toContain('reportDegradation(')
  })

  it('is not satisfied by a mention in a comment', () => {
    // Feed the checker the case it must fail. Without the comment strip, this
    // source would pass both assertions above while wiring nothing.
    const decoy = `
      hermes = new Hermes({
        agora,
        // hasSession: (agentId) => ptyManager.has(agentId),
        /* onMailStranded: (a, d) => reportDegradation(a, String(d.pendingMail)) */
        isIdle: (agentId) => true
      })
    `
    const options = hermesOptions(decoy)
    expect(options).not.toContain('hasSession:')
    expect(options).not.toContain('onMailStranded:')
  })
})

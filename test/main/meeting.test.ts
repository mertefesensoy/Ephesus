import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../../src/shared/message'
import { ODEON_ENDPOINT } from '../../src/shared/reserved'
import { MeetingDriver } from '../../src/main/meeting'
import { PromptStore } from '../../src/main/prompts'
import { removeTempDir } from '../tmpdir'

/**
 * The meeting driver (FR-7.4, UC-07).
 *
 * What the driver owes, and what these assert: the floor is handed to exactly
 * one attendee at a time, a question goes only to whoever holds it, attendees
 * gather in the Odeon room and leave when it closes, and the minutes land
 * immutably while the ACTION ITEMS go to the orchestrator rather than to
 * `tasks.json` — FR-4.2 gives the ledger one scribe.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    removeTempDir(home)
  }
})

interface Rig {
  readonly driver: MeetingDriver
  readonly sent: Message[]
  readonly logs: Record<string, unknown>[]
  readonly attendance: string[]
  readonly changes: number[]
  minutes(id: string): string | null
}

function rig(over: { orchestrator?: string | null } = {}): Rig {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-meeting-'))
  homes.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const agoraRoot = path.join(home, 'agora')

  const sent: Message[] = []
  const logs: Record<string, unknown>[] = []
  const attendance: string[] = []
  const changes: number[] = []
  const driver = new MeetingDriver({
    agoraRoot,
    prompts,
    deliver: (message) => sent.push(message),
    orchestrator: () => (over.orchestrator === undefined ? 'agent.artemis' : over.orchestrator),
    onAttendance: (agentId, present) => attendance.push(`${agentId}:${String(present)}`),
    onLogEvent: (draft) => logs.push(draft),
    onChange: () => changes.push(1)
  })

  return {
    driver,
    sent,
    logs,
    attendance,
    changes,
    minutes: (id) => {
      const file = path.join(agoraRoot, 'odeon', 'minutes', `${id}.md`)
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    }
  }
}

const AGENDA = { attendees: ['agent.mason', 'agent.scribe'], agenda: 'What is blocking us?' }

describe('the floor is handed to one attendee at a time', () => {
  it('asks only the floor-holder, with a `query` that obligates a reply', () => {
    const r = rig()
    r.driver.convene(AGENDA)

    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatchObject({ from: ODEON_ENDPOINT, to: 'agent.mason', act: 'query' })
  })

  it('renders the question from prompts/, never from code (invariant §8)', () => {
    const r = rig()
    r.driver.convene(AGENDA)
    expect(r.sent[0]?.body).toContain('You have the floor')
    expect(r.sent[0]?.body).toContain('What is blocking us?')
  })

  it('passes the floor on when the holder answers', () => {
    const r = rig()
    r.driver.convene(AGENDA)
    expect(r.driver.say('agent.mason', 'The fixture is stale.')).toEqual({ kind: 'accepted' })
    expect(r.sent).toHaveLength(2)
    expect(r.sent[1]?.to).toBe('agent.scribe')
  })

  it('asks NOBODY when a reply is held', () => {
    // Holding must not look like a turn: a second question would put two
    // agents on the floor at once.
    const r = rig()
    r.driver.convene(AGENDA)
    expect(r.driver.say('agent.scribe', 'me first')).toEqual({ kind: 'held' })
    expect(r.sent).toHaveLength(1)
  })

  it('asks the released speaker exactly once when the floor reaches them', () => {
    const r = rig()
    r.driver.convene(AGENDA)
    r.driver.say('agent.scribe', 'me first')
    r.driver.say('agent.mason', 'the fixture')
    // mason answered, scribe's held reply was released, and the floor wrapped
    // back to mason — who is asked again. Scribe already spoke, so scribe is
    // never asked a second time.
    expect(r.sent.map((message) => message.to)).toEqual(['agent.mason', 'agent.mason'])
    expect(r.driver.current()?.transcript.map((t) => t.from)).toContain('agent.scribe')
  })

  it('refuses a second meeting while one is open', () => {
    const r = rig()
    r.driver.convene(AGENDA)
    const second = r.driver.convene(AGENDA)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain('still open')
  })

  it('refuses anything said when no meeting is open', () => {
    const r = rig()
    expect(r.driver.say('agent.mason', 'hello').kind).toBe('refused')
    expect(r.driver.interject('hello').kind).toBe('refused')
    expect(r.driver.close().ok).toBe(false)
  })
})

describe('attendees gather in the Odeon room and leave when it closes (SDD §6)', () => {
  it('marks every attendee present on convene', () => {
    const r = rig()
    r.driver.convene(AGENDA)
    expect(r.attendance).toEqual(['agent.mason:true', 'agent.scribe:true'])
  })

  it('marks them absent again on close', () => {
    const r = rig()
    const opened = r.driver.convene(AGENDA)
    if (!opened.ok) throw new Error('convene failed')
    r.driver.close()
    expect(r.attendance.slice(2)).toEqual(['agent.mason:false', 'agent.scribe:false'])
  })
})

describe('closing files minutes, and sends the actions to the scribe', () => {
  it('archives the minutes at the meeting id', () => {
    const r = rig()
    const opened = r.driver.convene(AGENDA)
    if (!opened.ok) throw new Error('convene failed')
    r.driver.say('agent.mason', 'The fixture is stale.')

    const closed = r.driver.close()
    expect(closed.ok).toBe(true)
    if (closed.ok) expect(closed.ref).toContain('odeon/minutes/')
    expect(r.minutes(opened.id)).toContain('The fixture is stale.')
  })

  it('does NOT write the ledger itself — it asks the orchestrator (FR-4.2)', () => {
    const r = rig()
    const opened = r.driver.convene(AGENDA)
    if (!opened.ok) throw new Error('convene failed')
    r.driver.close([{ title: 'Rebuild the fixture', assignee: 'agent.mason', spec: 'do it' }])

    const ask = r.sent.at(-1)
    expect(ask).toMatchObject({ from: ODEON_ENDPOINT, to: 'agent.artemis', act: 'request' })
    expect(ask?.body).toContain('Rebuild the fixture')
    expect(ask?.body).toContain('ledger endpoint')
  })

  it('still archives the minutes when nobody can be asked to file the actions', () => {
    const r = rig({ orchestrator: null })
    const opened = r.driver.convene(AGENDA)
    if (!opened.ok) throw new Error('convene failed')
    const closed = r.driver.close([
      { title: 'Rebuild the fixture', assignee: 'agent.mason', spec: 'do it' }
    ])
    expect(closed.ok).toBe(true)
    expect(r.minutes(opened.id)).toContain('Rebuild the fixture')
  })

  it('records the close with what was said and what was not (NFR-13)', () => {
    const r = rig()
    r.driver.convene(AGENDA)
    r.driver.say('agent.scribe', 'never heard')
    r.driver.close()

    expect(r.logs.find((log) => log['event'] === 'closed')).toMatchObject({
      kind: 'meeting',
      unheard: 1
    })
  })

  it('refuses to close twice', () => {
    const r = rig()
    r.driver.convene(AGENDA)
    expect(r.driver.close().ok).toBe(true)
    expect(r.driver.close().ok).toBe(false)
  })
})

describe('the panel is a projection of the driver', () => {
  it('has nothing to show before a meeting is convened', () => {
    expect(rig().driver.current()).toBeNull()
  })

  it('exposes the live state, and pushes a change on every move', () => {
    const r = rig()
    r.driver.convene(AGENDA)
    r.driver.say('agent.mason', 'one')
    r.driver.interject('carry on')

    expect(r.driver.current()?.status).toBe('open')
    expect(r.driver.current()?.transcript.length).toBeGreaterThan(2)
    expect(r.changes.length).toBeGreaterThanOrEqual(3)
  })
})

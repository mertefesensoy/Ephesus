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
  /** The HARNESS HOME — what a reader of the book of record actually has. */
  readonly home: string
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
    home,
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

describe('a meeting can end itself (M8b.2 — Finding 11)', () => {
  /**
   * The case `ephctl help`'s own usage line documents, and the one
   * `EXIT-M8.md` §5.4 sends a runner to create:
   *
   *     ephctl odeon:convene --attendee agent.artemis --agenda "the incident"
   *
   * On 2026-09-09 it could not terminate. `after()` wraps, so the floor came
   * straight back to the only speaker: seq 387 (convened, one attendee) → 389
   * (floor) → 393 (said) → 395 (floor, to her again) → 427 (said) → 429
   * (floor, to her again). Artemis diagnosed the loop from the log herself and
   * declined rather than speak a third time — and the decline had nowhere to
   * go. The hour ended with no minutes and nothing to read.
   */
  const DOCUMENTED = { attendees: ['agent.artemis'], agenda: 'the incident' }

  it('adjourns the documented one-attendee meeting when its only speaker yields', () => {
    const r = rig()
    const convened = r.driver.convene(DOCUMENTED)
    if (!convened.ok) throw new Error(convened.reason)

    r.driver.say('agent.artemis', 'The crew found run 34317920145 and opened a task for it.')
    const outcome = r.driver.declineFloor('agent.artemis')

    expect(outcome.kind).toBe('adjourned')
    expect(r.driver.current()?.status).toBe('closed')
    // A meeting that ends itself must leave the SAME record as one a person
    // ended: §5.4 asks a runner to read the narration against the incident,
    // and on 2026-09-09 there was nothing to read.
    const minutes = r.minutes(convened.id)
    expect(minutes).not.toBeNull()
    expect(minutes).toContain('The crew found run 34317920145')
    expect(minutes).toContain('the incident')
  })

  it('does not adjourn a two-attendee meeting until BOTH have declined', () => {
    // The half a one-attendee-only fix would have left live. Nothing could end
    // a meeting of ANY size before this, and the next runner to convene two
    // would have found it again.
    const r = rig()
    const convened = r.driver.convene({
      attendees: ['agent.artemis', 'agent.mason'],
      agenda: 'the incident'
    })
    if (!convened.ok) throw new Error(convened.reason)

    expect(r.driver.declineFloor('agent.artemis').kind).toBe('accepted')
    expect(r.driver.current()?.status).toBe('open')
    expect(r.driver.current()?.floor).toBe('agent.mason')

    expect(r.driver.declineFloor('agent.mason').kind).toBe('adjourned')
    expect(r.driver.current()?.status).toBe('closed')
  })

  it('restarts the round whenever somebody actually says something', () => {
    const r = rig()
    r.driver.convene({ attendees: ['agent.artemis', 'agent.mason'], agenda: 'the incident' })

    r.driver.declineFloor('agent.artemis')
    // Mason has something to add, so the room is not out of things to say.
    r.driver.say('agent.mason', 'The verifier disputes the root cause.')
    // Back to Artemis. One decline is now the FIRST of a new round, not the
    // second of the old one — otherwise a meeting would adjourn on a decline
    // and a contribution, which is a discussion rather than a silence.
    expect(r.driver.declineFloor('agent.artemis').kind).toBe('accepted')
    expect(r.driver.current()?.status).toBe('open')
    expect(r.driver.declineFloor('agent.mason').kind).toBe('adjourned')
  })

  it('restarts the round when the Architect asks something new', () => {
    const r = rig()
    r.driver.convene(DOCUMENTED)
    r.driver.interject('And what did it cost?')
    // The interjection IS a new question; an attendee with nothing to add to
    // the last one may well have something to say about this one.
    expect(r.driver.current()?.declinedInARow).toBe(0)
    expect(r.driver.declineFloor('agent.artemis').kind).toBe('adjourned')
  })

  it('refuses a decline from anyone but the floor-holder, and holds nothing', () => {
    const r = rig()
    r.driver.convene({ attendees: ['agent.artemis', 'agent.mason'], agenda: 'the incident' })

    // A held REPLY is a contribution that arrived early and is worth keeping.
    // A held DECLINE is worth nothing by the time it is released: the question
    // it answers has moved on.
    const early = r.driver.declineFloor('agent.mason')
    expect(early.kind).toBe('refused')
    expect(r.driver.current()?.held).toEqual([])
    expect(r.driver.current()?.declinedInARow).toBe(0)

    const stranger = r.driver.declineFloor('agent.nobody')
    expect(stranger.kind).toBe('refused')
  })

  it('refuses a decline once the meeting is closed', () => {
    const r = rig()
    r.driver.convene(DOCUMENTED)
    r.driver.declineFloor('agent.artemis')
    expect(r.driver.declineFloor('agent.artemis').kind).toBe('refused')
  })

  it('records the adjournment and its reason in the book of record', () => {
    const r = rig()
    r.driver.convene(DOCUMENTED)
    r.driver.declineFloor('agent.artemis')

    const declined = r.logs.find((row) => row.event === 'declined')
    expect(declined).toMatchObject({ kind: 'meeting', from: 'agent.artemis' })
    const adjourned = r.logs.find((row) => row.event === 'adjourned')
    // WHY it ended, not just that it did. A meeting that closes itself with no
    // reason in the log is indistinguishable from one a person closed.
    expect(adjourned?.because).toBe('every attendee declined the floor with nothing said')
    expect(r.logs.some((row) => row.event === 'closed')).toBe(true)
  })

  it('asks nobody anything after it has adjourned', () => {
    // The loop this closes was visible as repeated `floor` rows. If the driver
    // handed the floor once more on the way out, the log would show the same
    // shape and the meeting would be closed underneath it.
    const r = rig()
    r.driver.convene(DOCUMENTED)
    const before = r.sent.length
    r.driver.declineFloor('agent.artemis')
    const after = r.sent.filter((m) => m.act === 'query')
    expect(after.length).toBe(r.sent.slice(0, before).filter((m) => m.act === 'query').length)
  })
})

describe('the floor prompt tells an agent how to leave (M8b.2, adversarial)', () => {
  /**
   * The mechanism is useless if nobody is told about it, and the shipped
   * prompt used to steer agents straight past it: "If you have nothing useful
   * to add, SAY THAT in one line rather than filling the silence." Saying it
   * is a turn. A turn is a contribution. A contribution restarts the round —
   * so an agent obeying the prompt keeps the meeting alive for ever.
   *
   * That is what happened on 2026-09-09: Artemis said she had nothing further
   * at seq 393 and again at seq 427, and the floor came back both times. She
   * reached `refuse` on her third attempt by reasoning about the log, not
   * because anything told her it existed. The round rule alone would not have
   * ended that meeting.
   *
   * Asserted against the SHIPPED prompt rather than a fixture, for the reason
   * `GH_TOKEN_REFRESH_COMMAND` is one exported constant: a rule that does not
   * match the sentence the agent was given is a rule that grants nothing.
   */
  const floorPrompt = fs.readFileSync(
    path.join(BUNDLED_PROMPTS, 'odeon', 'meeting-floor.md'),
    'utf8'
  )

  it('names the act that declines the floor', () => {
    expect(floorPrompt).toContain('refuse')
  })

  it('does not tell an agent to SAY it has nothing to add', () => {
    // The exact steer that produced the loop. A prompt may not both offer the
    // decline and recommend the turn that defeats it.
    expect(floorPrompt).not.toMatch(/say that in one line/i)
  })

  it('says what a decline does, so the agent can predict the outcome', () => {
    expect(floorPrompt).toMatch(/adjourns/i)
  })
})

describe('a minutesRef resolves from the home a reader has (M8b.3)', () => {
  /**
   * `EXIT-M8.md` §5.4 asks a runner to read the narration against the
   * incident. After M8b.2 an adjourned meeting is where that narration lives —
   * so the ref it hands back has to open on the first try, from the directory
   * the runner actually has.
   *
   * A mutation run is why this exists: reverting `minutesRef` to its old
   * agora-relative shape survived every other test in the package, because the
   * only assertion on it was `toContain('odeon/minutes/')`, which is true of
   * both shapes. A substring check is not a resolution check.
   */
  it('joins to the home and opens, for a close and for an adjournment', () => {
    const closeRig = rig()
    const opened = closeRig.driver.convene(AGENDA)
    if (!opened.ok) throw new Error('convene failed')
    closeRig.driver.say('agent.mason', 'The fixture is stale.')
    const closed = closeRig.driver.close()
    if (!closed.ok) throw new Error(closed.reason)

    expect(closed.ref.startsWith('agora/')).toBe(true)
    const resolved = path.join(closeRig.home, ...closed.ref.split('/'))
    expect(fs.existsSync(resolved)).toBe(true)
    expect(fs.readFileSync(resolved, 'utf8')).toContain('The fixture is stale.')

    // And the path an ADJOURNMENT reports, which is the one §5.4's runner gets
    // from `odeon:adjourn`.
    const adjournRig = rig()
    const second = adjournRig.driver.convene({
      attendees: ['agent.artemis'],
      agenda: 'the incident'
    })
    if (!second.ok) throw new Error(second.reason)
    adjournRig.driver.say('agent.artemis', 'The crew opened a task for run 34317920145.')
    const outcome = adjournRig.driver.declineFloor('agent.artemis')
    expect(outcome.kind).toBe('adjourned')
    if (outcome.kind !== 'adjourned') return
    const adjourned = path.join(adjournRig.home, ...outcome.ref.split('/'))
    expect(fs.existsSync(adjourned)).toBe(true)
    expect(fs.readFileSync(adjourned, 'utf8')).toContain('run 34317920145')
  })

  it('is the ref the book of record carries, not only the one returned', () => {
    const r = rig()
    const opened = r.driver.convene(AGENDA)
    if (!opened.ok) throw new Error('convene failed')
    r.driver.close()

    const row = r.logs.find((entry) => entry.event === 'closed')
    const ref = String(row?.minutesRef ?? '')
    expect(ref).not.toBe('')
    // The log row is what a runner reads; the return value never reaches them.
    expect(fs.existsSync(path.join(r.home, ...ref.split('/')))).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import {
  BROADCAST,
  HUMAN,
  REPLY_OBLIGING_ACTS,
  SPEECH_ACTS,
  composeMessage,
  makeMessageId,
  messageIdSchema,
  parseMessage,
  requiresReply
} from '../../src/shared/message'
import { CURSOR_SCHEMA_VERSION, emptyCursor, parseCursor } from '../../src/shared/cursor'

/**
 * The message rules (SDD §4.4, FR-3.1/3.3, ADR-0003). These are transport
 * rules, not etiquette — so they are asserted at the module boundary, where
 * S-LIVELOCK and S-BOUNCE will assert them too.
 */

const base = {
  id: '2026-08-26T14-03-11-123Z-a1b2',
  conversation: 'conv-7f3',
  from: 'agent.mason',
  to: 'agent.artemis',
  act: 'request' as const,
  subject: 'need staging DB creds decision',
  body: 'markdown or structured payload',
  created_at: '2026-08-26T14:03:11.123Z'
}

describe('the obligation table (ADR-0003, FR-3.3)', () => {
  it('names exactly the seven speech acts', () => {
    expect([...SPEECH_ACTS]).toEqual([
      'request',
      'inform',
      'propose',
      'query',
      'agree',
      'refuse',
      'done'
    ])
  })

  it.each(REPLY_OBLIGING_ACTS)('%s obliges a reply', (act) => {
    expect(requiresReply(act)).toBe(true)
  })

  it.each(SPEECH_ACTS.filter((a) => !REPLY_OBLIGING_ACTS.includes(a)))(
    '%s does not oblige a reply',
    (act) => {
      expect(requiresReply(act)).toBe(false)
    }
  )

  it('derives requires_reply rather than trusting the sender', () => {
    // An agent cannot opt out of owing a reply by clearing a flag.
    expect(composeMessage({ ...base, act: 'request' }).requires_reply).toBe(true)
    expect(composeMessage({ ...base, act: 'inform' }).requires_reply).toBe(false)
  })

  it('refuses a message whose flag disagrees with its act', () => {
    const forged = { ...composeMessage(base), requires_reply: false }
    const result = parseMessage(forged)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('obligation table')
  })
})

describe('message schema (SDD §4.4)', () => {
  it('accepts the worked example', () => {
    expect(parseMessage(composeMessage(base)).ok).toBe(true)
  })

  it.each([BROADCAST, HUMAN, 'agent.artemis'])('accepts %s as a recipient (FR-3.7)', (to) => {
    expect(parseMessage(composeMessage({ ...base, to })).ok).toBe(true)
  })

  const rejected: readonly [string, Record<string, unknown>][] = [
    ['an unknown act', { act: 'shout' }],
    ['an unknown recipient shape', { to: 'everyone' }],
    ['a bad sender id', { from: 'Mason' }],
    ['an empty subject', { subject: '' }],
    ['negative hops', { hops: -1 }],
    ['an unknown extra key', { rogue: true }],
    ['a non-sortable id', { id: 'msg-1' }]
  ]

  it.each(rejected)('rejects %s with a reason, never a throw', (_label, patch) => {
    const raw = { ...composeMessage(base), ...patch }
    const result = parseMessage(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
  })

  it('rejects non-objects without throwing', () => {
    for (const raw of [null, undefined, 'message', 42, []]) {
      expect(parseMessage(raw).ok).toBe(false)
    }
  })

  it('refuses a message that replies to itself', () => {
    const self = composeMessage(base)
    const result = parseMessage({ ...self, in_reply_to: self.id })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('cannot reply to itself')
  })
})

describe('message ids are time-sortable (ADR-0003)', () => {
  it('sorts lexicographically in the order the messages were created', () => {
    const early = makeMessageId(new Date(Date.UTC(2026, 7, 26, 14, 3, 11, 100)), 'aaaa')
    const later = makeMessageId(new Date(Date.UTC(2026, 7, 26, 14, 3, 12, 100)), 'zzzz')
    const nextDay = makeMessageId(new Date(Date.UTC(2026, 7, 27, 0, 0, 0, 0)), 'aaaa')

    expect([nextDay, later, early].sort()).toEqual([early, later, nextDay])
  })

  it('produces ids the schema accepts', () => {
    expect(messageIdSchema.safeParse(makeMessageId(new Date(), 'a1b2')).success).toBe(true)
  })

  it('rejects an id with no timestamp to sort by', () => {
    for (const id of ['a1b2', '2026-08-26-a1b2', 'nope']) {
      expect(messageIdSchema.safeParse(id).success).toBe(false)
    }
  })
})

describe('the consumption cursor (ADR-0003 idempotency)', () => {
  it('starts empty', () => {
    expect(emptyCursor).toEqual({ schemaVersion: CURSOR_SCHEMA_VERSION, lastProcessed: null })
  })

  it('reads a valid cursor', () => {
    const cursor = { schemaVersion: 1, lastProcessed: base.id }
    expect(parseCursor(cursor)).toEqual(cursor)
  })

  it('reads anything unreadable as empty rather than throwing', () => {
    for (const raw of [null, 'cursor', {}, { schemaVersion: 2, lastProcessed: null }]) {
      expect(parseCursor(raw)).toEqual(emptyCursor)
    }
  })
})

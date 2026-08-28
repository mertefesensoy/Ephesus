import { describe, expect, it } from 'vitest'
import { CLOSING_ACK_SUBJECT, ClosingTime, type ClosingTimeOptions } from '../../src/main/closing'
import { CLOSING_ENDPOINT } from '../../src/shared/reserved'
import { composeMessage, type Message } from '../../src/shared/message'

/**
 * GYM-003 — the closing-time protocol as a pure exchange: requests out, acks
 * in, a hard deadline, and a report that names every agent that went silent.
 * The mail plane and the quit path are exercised by S-CLOSING; this file owns
 * the protocol's own rules.
 */

function rig(over: Partial<ClosingTimeOptions> = {}): {
  closing: ClosingTime
  delivered: Message[]
  logged: Record<string, unknown>[]
} {
  const delivered: Message[] = []
  const logged: Record<string, unknown>[] = []
  const closing = new ClosingTime({
    liveAgents: () => ['agent.mason', 'agent.scribe'],
    deliver: (message) => delivered.push(message),
    render: (kind, vars) =>
      kind === 'subject' ? 'Closing time' : `pack up; reply ${vars['ackSubject'] ?? ''}`,
    onLogEvent: (draft) => logged.push(draft),
    deadlineMs: 5_000,
    ...over
  })
  return { closing, delivered, logged }
}

/** An ack as a worker would write it. */
function ack(from: string, over: Partial<Parameters<typeof composeMessage>[0]> = {}): Message {
  return composeMessage({
    id: `2026-08-28T14-00-00-000Z-${from.slice(-4)}`,
    conversation: 'conv-ack',
    from,
    to: CLOSING_ENDPOINT,
    act: 'inform',
    subject: CLOSING_ACK_SUBJECT,
    body: 'parked',
    created_at: '2026-08-28T14:00:00.000Z',
    ...over
  })
}

describe('ClosingTime — the request', () => {
  it('mails every live agent one request from the closing endpoint', async () => {
    const { closing, delivered } = rig()
    const done = closing.begin()
    expect(delivered.map((m) => m.to).sort()).toEqual(['agent.mason', 'agent.scribe'])
    for (const message of delivered) {
      expect(message.from).toBe(CLOSING_ENDPOINT)
      expect(message.act).toBe('request')
      expect(message.body).toContain(CLOSING_ACK_SUBJECT)
    }
    closing.noteReply(ack('agent.mason'))
    closing.noteReply(ack('agent.scribe'))
    await done
  })

  it('with nobody live it completes immediately, on the record', async () => {
    const { closing, delivered, logged } = rig({ liveAgents: () => [] })
    const report = await closing.begin()
    expect(report).toEqual({ acked: [], missing: [], timedOut: false })
    expect(delivered).toEqual([])
    expect(logged.map((d) => d['event'])).toEqual(['closing-begin', 'closing-complete'])
  })

  it('refuses reentry while a closing is in flight', async () => {
    const { closing } = rig()
    const done = closing.begin()
    expect(closing.inProgress()).toBe(true)
    expect(() => closing.begin()).toThrow('already in progress')
    closing.noteReply(ack('agent.mason'))
    closing.noteReply(ack('agent.scribe'))
    await done
    expect(closing.inProgress()).toBe(false)
  })
})

describe('ClosingTime — the acks', () => {
  it('resolves with everyone acked, in ack order', async () => {
    const { closing, logged } = rig()
    const done = closing.begin()
    expect(closing.noteReply(ack('agent.scribe'))).toBe(true)
    expect(closing.noteReply(ack('agent.mason'))).toBe(true)
    const report = await done
    expect(report).toEqual({ acked: ['agent.scribe', 'agent.mason'], missing: [], timedOut: false })
    expect(logged.filter((d) => d['event'] === 'closing-ack')).toHaveLength(2)
  })

  it('accepts a reply to its own request even without the subject', async () => {
    const { closing, delivered } = rig({ liveAgents: () => ['agent.mason'] })
    const done = closing.begin()
    const requestId = delivered[0]?.id ?? ''
    closing.noteReply(
      ack('agent.mason', { subject: 'all parked, see memory.md', in_reply_to: requestId })
    )
    const report = await done
    expect(report.acked).toEqual(['agent.mason'])
  })

  it('consumes but does not count a reply that is neither ack shape', async () => {
    const { closing, logged } = rig({ liveAgents: () => ['agent.mason'], deadlineMs: 200 })
    const done = closing.begin()
    expect(closing.noteReply(ack('agent.mason', { subject: 'what is going on?' }))).toBe(true)
    const report = await done
    expect(report.missing).toEqual(['agent.mason'])
    expect(logged.some((d) => d['event'] === 'closing-unrecognized')).toBe(true)
  })

  it('ignores an agent that was never asked, and a second ack from the same agent', async () => {
    // Two agents, so the closing is still in flight when the noise arrives.
    const { closing } = rig({ deadlineMs: 200 })
    const done = closing.begin()
    expect(closing.noteReply(ack('agent.ghostwriter'))).toBe(true)
    expect(closing.noteReply(ack('agent.mason'))).toBe(true)
    expect(closing.noteReply(ack('agent.mason'))).toBe(true)
    const report = await done
    // Counted once, the stranger never; scribe's silence is what timed out.
    expect(report.acked).toEqual(['agent.mason'])
    expect(report.missing).toEqual(['agent.scribe'])
    expect(report.timedOut).toBe(true)
  })

  it('an ack after completion is out of season — false, so Hermes bounces it', async () => {
    const { closing } = rig({ liveAgents: () => ['agent.mason'] })
    const done = closing.begin()
    expect(closing.noteReply(ack('agent.mason'))).toBe(true)
    await done
    expect(closing.noteReply(ack('agent.mason'))).toBe(false)
  })

  it('answers false when no closing is in flight — Hermes bounces on that', () => {
    const { closing } = rig()
    expect(closing.noteReply(ack('agent.mason'))).toBe(false)
  })
})

describe('ClosingTime — the deadline is a hard promise', () => {
  it('proceeds at the deadline and names every silent agent', async () => {
    const { closing, logged } = rig({ deadlineMs: 150 })
    const done = closing.begin()
    closing.noteReply(ack('agent.mason'))
    const report = await done
    expect(report.timedOut).toBe(true)
    expect(report.acked).toEqual(['agent.mason'])
    expect(report.missing).toEqual(['agent.scribe'])
    const complete = logged.find((d) => d['event'] === 'closing-complete')
    expect(complete).toMatchObject({ missing: ['agent.scribe'], timedOut: true })
  })
})

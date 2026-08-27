import { describe, expect, it } from 'vitest'
import {
  HOOK_ENDPOINT_PATH,
  HOOK_ENVELOPE_SCHEMA_VERSION,
  HOOK_EVENTS,
  classifyHookEvent,
  hookEnvelopeSchema,
  parseHookEnvelope
} from '../../src/shared/hooks'

const valid = {
  schemaVersion: HOOK_ENVELOPE_SCHEMA_VERSION,
  token: 'spawn-token-1',
  agentId: 'agent.mason',
  event: 'pre-tool',
  sessionId: 'sess-42',
  ts: 1724668800123,
  payload: { tool: 'Read' }
}

describe('hook envelope (FR-2.1)', () => {
  it('accepts a well-formed envelope', () => {
    const result = parseHookEnvelope(valid)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.event).toBe('pre-tool')
      expect(result.envelope.payload).toEqual({ tool: 'Read' })
    }
  })

  it('accepts a null sessionId (engines without sessions)', () => {
    expect(parseHookEnvelope({ ...valid, sessionId: null }).ok).toBe(true)
  })

  const rejected: readonly [string, Record<string, unknown>][] = [
    ['a drifted schemaVersion', { ...valid, schemaVersion: 2 }],
    ['a missing token', { ...valid, token: undefined }],
    ['an empty token', { ...valid, token: '' }],
    ['a missing agentId', { ...valid, agentId: undefined }],
    ['an empty event name', { ...valid, event: '' }],
    ['a non-numeric ts', { ...valid, ts: 'now' }],
    ['a negative ts', { ...valid, ts: -1 }],
    ['an unknown top-level key (shim/harness mismatch)', { ...valid, extra: 'surprise' }]
  ]

  it.each(rejected)('rejects %s with a reason, never a throw', (_label, raw) => {
    const result = parseHookEnvelope(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
  })

  it('rejects non-objects without throwing', () => {
    for (const raw of [null, undefined, 'envelope', 42, []]) {
      expect(parseHookEnvelope(raw).ok).toBe(false)
    }
  })

  it('keeps the payload opaque so engine drift lands inside it, not on the envelope', () => {
    const result = hookEnvelopeSchema.safeParse({
      ...valid,
      payload: { tool: 'Read', brand_new_field: [1, 2, 3] }
    })
    expect(result.success).toBe(true)
  })

  it('posts to a fixed endpoint path', () => {
    expect(HOOK_ENDPOINT_PATH).toBe('/hook')
  })
})

describe('hook event classification (FR-2.3)', () => {
  it.each(HOOK_EVENTS)('classifies %s as known', (event) => {
    expect(classifyHookEvent(event)).toEqual({ known: true, event })
  })

  it('classifies an unseen event as drift, keeping the raw name', () => {
    expect(classifyHookEvent('SubagentStop')).toEqual({ known: false, event: 'SubagentStop' })
  })

  it('never drops an event on the floor', () => {
    for (const event of ['', 'pre-tool', 'PreToolUse', 'x'.repeat(200)]) {
      expect(classifyHookEvent(event).event).toBe(event)
    }
  })

  it('carries the SDD §6 socket-borne triggers, the session bracket, and the gate signal', () => {
    expect([...HOOK_EVENTS]).toEqual([
      'session-start',
      'prompt-submitted',
      'pre-tool',
      'post-tool',
      // Added in M3.3 for SDD §9's first choke point: without it an agent
      // stalled behind the engine's own permission dialog was invisible to the
      // harness — the M1 carried item.
      'notification',
      'stop',
      'compact-start',
      'compact-end',
      'session-end'
    ])
  })
})

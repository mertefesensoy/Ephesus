import { describe, expect, it } from 'vitest'
import { LOG_KINDS, logRowSummary, type LogEntry, type LogKind } from '../../src/shared/log'

/**
 * The row the Activity panel shows for one entry (M8.3).
 *
 * The old version lived in the panel with seven cases and a `default` that
 * reached for `agentId` or `subject`, so 19% of the rows on the Architect's
 * machine rendered as an empty line — an event that happened, on screen as
 * nothing. Worse, the breaker's case read `signal` where every emitter writes
 * `signals`, which blanked the reason on all 93 breaker rows while the row
 * itself still looked populated.
 *
 * So the assertions here are about WHICH text appears, never about how many
 * rows there are: a count would have passed against both defects.
 */

const entry = (kind: LogKind, fields: Record<string, unknown> = {}): LogEntry =>
  ({ ts: 1, seq: 1, kind, ...fields }) as LogEntry

/**
 * One realistic payload per kind, taken from what the emitters actually write.
 * Kinds with no emitter yet (`message`, `memory`) carry the shape SDD §4.3
 * documents for them.
 */
const REALISTIC: Record<LogKind, Record<string, unknown>> = {
  message: {
    msgId: 'm-1',
    from: 'agent.mason',
    to: 'agent.artemis',
    act: 'inform',
    subject: 'green'
  },
  delivery: {
    msgId: 'm-2',
    from: 'agent.mason',
    to: 'agent.tess',
    act: 'request',
    subject: 'review'
  },
  bounce: { msgId: 'm-3', from: 'agent.mason', to: 'agent.gone', reason: 'no such agent' },
  spawn: { agentId: 'agent.mason', engine: 'claude', engineVersion: '2.1.195', role: 'engineer' },
  exit: { agentId: 'agent.mason', engine: 'claude', exitCode: 0, settingsRestored: 1 },
  ghost: { agentId: 'agent.mason', engine: 'claude', resumable: true, tasksReturned: 2 },
  hook: { agentId: 'agent.mason', event: 'stop', decision: 'continue', because: 'mail waiting' },
  task: { event: 'assigned', taskId: 't-7', assignee: 'agent.mason', because: 'capability' },
  gate: { event: 'opened', gateKind: 'destructive', what: 'delete branch', agentId: 'agent.mason' },
  memo: { event: 'filed', under: 'new-dependency', by: 'agent.mason', because: 'policy' },
  brief: { event: 'archived', briefId: 'b-3', by: 'agent.artemis', sentences: 9 },
  deck: { event: 'archived', taskId: 't-7', deckRef: 'decks/t-7.html', by: 'agent.scribe' },
  meeting: { event: 'closed', meetingId: 'mt-1', attendees: ['agent.mason', 'agent.tess'] },
  breaker: {
    agentId: 'agent.mason',
    action: 'steer',
    rung: 1,
    signals: ['repetition', 'error-rate']
  },
  budget: { agentId: 'agent.mason', state: 'clamped', because: 'daily ceiling', spent: 120_000 },
  memory: { agentId: 'agent.mason', event: 'condensed', because: 'reflection' },
  orchestrator: { event: 'respawn', agentId: 'agent.artemis', engine: 'claude', attempt: 2 },
  remote: { event: 'ingested', repo: 'owner/app', by: 'agent.ci', because: 'ci failed' },
  'secret-rotated': { name: 'GH_TOKEN', removed: false },
  profile: { event: 'activated', profile: 'skeleton-crew', repo: 'owner/app' },
  gym: { event: 'proposed', gymId: 'GYM-007', title: 'a better ladder', by: 'agent.artemis' },
  stoa: { event: 'registered', sourceId: 'src-md', url: 'https://example.test/x', by: 'architect' },
  shutdown: { event: 'closing-complete', acked: ['agent.mason'], missing: ['agent.tess'] },
  capacity: { event: 'parked', agentId: 'agent.mason', limitKind: '5h', detail: 'retry at 18:00' },
  respawn: { event: 'scheduled', agentId: 'agent.mason', attempt: 2, waitMs: 30000 },
  error: { subsystem: 'hermes', reason: 'sweep failed' },
  degradation: { source: 'library', detail: 'no index', cause: 'library/fts', count: 12 }
}

describe('every kind the harness can emit renders something', () => {
  it('covers all of LOG_KINDS with a realistic payload', () => {
    // The map is the assertion: a kind added to the union without a payload
    // here fails the build, next to the switch that must also grow a case.
    expect(Object.keys(REALISTIC).sort()).toEqual([...LOG_KINDS].sort())
  })

  for (const kind of LOG_KINDS) {
    it(`${kind} is never a blank row`, () => {
      expect(logRowSummary(entry(kind, REALISTIC[kind])).trim()).not.toBe('')
    })
  }

  it('falls back to the entry’s own fields rather than rendering nothing', () => {
    // An entry from an older version, or an emitter that changed its fields:
    // the event still happened, so the row still says something.
    expect(logRowSummary(entry('gate', { somethingNobodyExpected: 'still true' }))).toBe(
      'somethingNobodyExpected still true'
    )
  })

  /**
   * REVERSED deliberately (M8.3 audit, 2026-09-07), with the reason here rather
   * than in a commit nobody reads.
   *
   * This case used to assert `''` — "has nothing to say only when the entry
   * itself carries nothing" — while M8.3's own evidence claimed the summary was
   * "unable to return an empty string". The register described a guarantee the
   * code never had, and this test pinned the opposite.
   *
   * A blank line in the Activity panel is B3, the defect this module exists to
   * close, and it does not become acceptable because the row that produced it
   * was thin. The row is reachable from DISK — an older format, a hand-edit, a
   * future kind whose payload is a nested object — so "the entry carries
   * nothing" is not a hypothetical, it is a file the panel will one day read.
   */
  it('names the kind rather than rendering a blank line, whatever the entry carries', () => {
    expect(logRowSummary(entry('gate'))).toBe('gate #1')
    // The shapes `otherFields` cannot render: objects, nulls, empty strings.
    expect(logRowSummary(entry('spawn', { detail: {}, meta: { a: 1 } }))).toBe('spawn #1')
    expect(logRowSummary(entry('spawn', { agentId: '', because: null }))).toBe('spawn #1')
  })

  it('never renders a label with no value behind it', () => {
    // A bare `exit ` or `rung ` is worse than a blank part: the row looks
    // populated and says nothing, which is exactly what reading `signal` for
    // `signals` did to all 93 breaker rows.
    expect(logRowSummary(entry('exit', { agentId: 'agent.mason' }))).toBe('agent.mason')
    expect(logRowSummary(entry('breaker', { agentId: 'agent.mason', signals: [] }))).toBe(
      'agent.mason'
    )
  })
})

describe('the rows that were wrong', () => {
  it('reads the breaker’s signals, plural, as the emitter writes them', () => {
    // `signal` singular blanked the reason on all 93 breaker rows while the
    // row still looked populated — the agent id and rung were there.
    const line = logRowSummary(entry('breaker', REALISTIC.breaker))
    expect(line).toBe('agent.mason · steer · repetition, error-rate · rung 1')
  })

  it('joins the other list fields too', () => {
    expect(logRowSummary(entry('shutdown', REALISTIC.shutdown))).toBe(
      'closing-complete · acked agent.mason · silent agent.tess'
    )
    expect(logRowSummary(entry('meeting', REALISTIC.meeting))).toContain('agent.mason, agent.tess')
  })

  it('shows a delivery as a flow between two agents', () => {
    expect(logRowSummary(entry('delivery', REALISTIC.delivery))).toBe(
      'agent.mason → agent.tess · request · review'
    )
  })

  it('names a secret without ever showing its value (ADR-0010)', () => {
    const line = logRowSummary(entry('secret-rotated', { name: 'GH_TOKEN', value: 'ghp_secret' }))
    expect(line).toContain('GH_TOKEN')
    expect(line).not.toContain('ghp_secret')
  })

  it('counts a repeated degradation and marks a cleared one', () => {
    expect(logRowSummary(entry('degradation', REALISTIC.degradation))).toBe(
      'library · no index · ×12'
    )
    expect(
      logRowSummary(entry('degradation', { ...REALISTIC.degradation, event: 'cleared' }))
    ).toContain('cleared')
  })

  it('does not decorate a degradation that has only happened once', () => {
    // `×1` is noise on the row that matters most — the first report of a new
    // condition. The count earns its place only when it is telling the reader
    // something the row does not already say.
    expect(logRowSummary(entry('degradation', { ...REALISTIC.degradation, count: 1 }))).toBe(
      'library · no index'
    )
    // And a missing count is not a count of one dressed up as absent.
    const noCount = { ...REALISTIC.degradation }
    delete noCount['count']
    expect(logRowSummary(entry('degradation', noCount))).toBe('library · no index')
    // Two is worth saying.
    expect(logRowSummary(entry('degradation', { ...REALISTIC.degradation, count: 2 }))).toBe(
      'library · no index · ×2'
    )
  })
})

describe('the awkward shapes', () => {
  it('shows one side of a flow when only one is recorded', () => {
    expect(logRowSummary(entry('delivery', { from: 'agent.mason', act: 'inform' }))).toBe(
      'agent.mason · inform'
    )
    expect(logRowSummary(entry('delivery', { to: 'agent.tess', act: 'inform' }))).toBe(
      'agent.tess · inform'
    )
  })

  it('reads a boolean field, and ignores one that is an object', () => {
    expect(logRowSummary(entry('ghost', { agentId: 'agent.mason', resumable: false }))).toBe(
      'agent.mason · resumable false'
    )
    expect(logRowSummary(entry('error', { subsystem: 'hermes', reason: { deep: 1 } }))).toBe(
      'hermes'
    )
  })

  it('ignores a list field that is not a list, and skips unusable items in one', () => {
    expect(logRowSummary(entry('breaker', { agentId: 'a', signals: 'repetition', rung: 1 }))).toBe(
      'a · rung 1'
    )
    expect(
      logRowSummary(entry('breaker', { agentId: 'a', signals: ['x', { y: 1 }, 2], rung: 1 }))
    ).toBe('a · x, 2 · rung 1')
  })

  it('bounds the fallback so one enormous field cannot take over the panel', () => {
    const line = logRowSummary(
      entry('gate', { a: 'x'.repeat(400), b: 'b', c: 'c', d: 'd', e: 'never shown' })
    )
    expect(line).not.toContain('never shown')
    expect(line.length).toBeLessThan(200)
  })

  it('renders an array in the fallback', () => {
    expect(logRowSummary(entry('gate', { whoever: ['agent.mason', 'agent.tess'] }))).toBe(
      'whoever agent.mason, agent.tess'
    )
  })

  it('does not throw on a kind from a newer version of the app', () => {
    // `parseLogLine` refuses an unknown kind, so this cannot arrive from the
    // file — but the panel must not be the thing that breaks if it ever does,
    // and the exhaustive switch's fallback is what guarantees that.
    const fromTheFuture = { ts: 1, seq: 1, kind: 'teleport' } as unknown as LogEntry
    expect(() => logRowSummary(fromTheFuture)).not.toThrow()
    expect(logRowSummary(fromTheFuture)).toBe('teleport')
  })
})

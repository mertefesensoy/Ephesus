import { describe, expect, it } from 'vitest'
import {
  agoPhrase,
  diagnose,
  renderDiagnosis,
  type Condition,
  type DiagnosisInput
} from '../../src/shared/diagnosis'
import type { LogEntry } from '../../src/shared/log'

/**
 * The three-state fold (M8.13).
 *
 * The direction that matters is `not-exercised`. A report calling an untouched
 * subsystem "ok" would be exactly the check-that-cannot-fail this codebase keeps
 * finding, dressed as a diagnostic — so the tests below spend most of their
 * effort proving that silence is never rendered as health.
 */

let seq = 0
const row = (kind: string, event?: string): LogEntry =>
  ({
    ts: 1_000 + seq,
    seq: (seq += 1),
    kind,
    ...(event === undefined ? {} : { event })
  }) as LogEntry

const condition = (over: Partial<Condition> = {}): Condition => ({
  source: 'harbor',
  cause: 'harbor/ingest',
  detail: 'gh is not authenticated',
  count: 1,
  since: 1_000,
  freshness: 'live',
  ...over
})

function input(over: Partial<DiagnosisInput> = {}): DiagnosisInput {
  seq = 0
  return {
    at: 5_000_000,
    home: 'C:/home/.ephesus',
    version: 'abc1234',
    conditions: [],
    events: [],
    fileWarnings: [],
    crew: [],
    consented: false,
    armed: [],
    ...over
  }
}

const find = (d: ReturnType<typeof diagnose>, area: string) => d.rows.find((r) => r.area === area)

describe('an untouched harness is NOT healthy, it is unexercised', () => {
  it('calls every area not-exercised when nothing has happened', () => {
    const d = diagnose(input())
    expect(d.rows.length).toBeGreaterThan(0)
    expect(d.rows.every((r) => r.verdict === 'not-exercised')).toBe(true)
  })

  it('never says "ok" or "working" for an area with no evidence', () => {
    // The whole point. A mutation that made the absent case `working` has to
    // fail here, and it is the mutation somebody will make while "tidying".
    const d = diagnose(input())
    expect(d.rows.some((r) => r.verdict === 'working')).toBe(false)
    expect(renderDiagnosis(d, 5_000_000)).not.toContain('| WORKING |')
  })

  it('says what WOULD exercise each one, so the reader is not left hunting', () => {
    const d = diagnose(input())
    for (const r of d.rows) {
      expect(r.because).toContain('nothing has happened either way')
      expect(r.because.length).toBeGreaterThan('nothing has happened either way — '.length)
    }
  })
})

describe('a live degradation makes an area broken, and says why', () => {
  it('reports the cause and the detail, not just a colour', () => {
    const d = diagnose(input({ conditions: [condition()] }))
    const harbor = find(d, 'watching a repository')
    expect(harbor?.verdict).toBe('broken')
    expect(harbor?.because).toContain('harbor/ingest')
    expect(harbor?.because).toContain('gh is not authenticated')
  })

  it('carries the repeat count when a condition has fired more than once', () => {
    const d = diagnose(input({ conditions: [condition({ count: 47 })] }))
    expect(find(d, 'watching a repository')?.because).toContain('47 times')
  })

  it('does not mark OTHER areas broken', () => {
    const d = diagnose(input({ conditions: [condition()] }))
    expect(d.rows.filter((r) => r.verdict === 'broken')).toHaveLength(1)
  })

  it('beats positive evidence — a working past does not excuse a broken present', () => {
    const d = diagnose(input({ conditions: [condition()], events: [row('remote'), row('remote')] }))
    expect(find(d, 'watching a repository')?.verdict).toBe('broken')
  })
})

describe('a CARRIED condition is not evidence about now', () => {
  it('does not make an area broken on its own', () => {
    // "This was wrong last week" and "this is wrong now" are different
    // sentences, and conflating them is how a stale problem reads as current.
    const d = diagnose(input({ conditions: [condition({ freshness: 'carried' })] }))
    expect(find(d, 'watching a repository')?.verdict).toBe('not-exercised')
    expect(d.carried).toHaveLength(1)
    expect(d.live).toHaveLength(0)
  })

  it('and the reverse: a LIVE condition never appears in the carried section', () => {
    // Found by a surviving mutant (`carried = conditions.slice()`), which is a
    // missing test rather than an equivalent one. If a currently-true condition
    // were listed as carried, the report would say it "was true when we stopped
    // and nothing has re-checked it since" — of a thing that is true right now.
    // That is the exact confusion the two sections exist to prevent.
    const d = diagnose(input({ conditions: [condition({ freshness: 'live' })] }))
    expect(d.carried).toHaveLength(0)
    expect(d.live).toHaveLength(1)
    const text = renderDiagnosis(d, 5_000_000)
    const carriedSection = text.slice(text.indexOf('## Conditions carried from the last run'))
    expect(carriedSection).toContain('None.')
    expect(carriedSection).not.toContain('gh is not authenticated')
  })

  it('is still reported, in its own section, marked as not current', () => {
    const d = diagnose(input({ conditions: [condition({ freshness: 'carried' })] }))
    const text = renderDiagnosis(d, 5_000_000)
    expect(text).toContain('Conditions carried from the last run')
    expect(text).toContain('not evidence about now')
    expect(text).toContain('gh is not authenticated')
  })
})

describe('a log row proves an area worked, and the report cites it', () => {
  it('matches on kind:event', () => {
    const d = diagnose(input({ events: [row('orchestrator', 'consented')] }))
    expect(find(d, 'consent')?.verdict).toBe('working')
    expect(find(d, 'consent')?.because).toContain('orchestrator/consented')
  })

  it('matches on a bare kind', () => {
    const d = diagnose(input({ events: [row('gate', 'opened')] }))
    expect(find(d, 'gates')?.verdict).toBe('working')
  })

  it('does NOT match the right kind with the wrong event', () => {
    // `orchestrator/awaiting-consent` is the refusal, not the grant. A fold
    // that matched on kind alone here would report consent as working on every
    // machine that has never been consented to — the worst possible false pass.
    const d = diagnose(input({ events: [row('orchestrator', 'awaiting-consent')] }))
    expect(find(d, 'consent')?.verdict).toBe('not-exercised')
  })

  it('cites the NEWEST proof, not the oldest', () => {
    const d = diagnose(input({ events: [row('gate'), row('message'), row('gate')] }))
    expect(find(d, 'gates')?.because).toContain('seq 3')
  })
})

describe('the rendered report', () => {
  it('leads with its own age, because a stale report read as current is the failure', () => {
    const d = diagnose(input({ at: 1_000_000 }))
    const text = renderDiagnosis(d, 1_000_000 + 3 * 60 * 60 * 1000)
    const head = text.split('\n').slice(0, 4).join('\n')
    expect(head).toContain('3 hours ago')
    expect(head).toContain('was not running when you read this')
  })

  it('says NOT EXERCISED is not a pass, in the report itself', () => {
    const text = renderDiagnosis(diagnose(input()), 5_000_000)
    expect(text).toContain('`NOT EXERCISED` is not a pass')
  })

  it('counts the broken areas in the short answer', () => {
    const text = renderDiagnosis(
      diagnose(input({ conditions: [condition(), condition({ source: 'hermes' })] })),
      5_000_000
    )
    expect(text).toContain('**2 thing(s) are broken right now:**')
  })

  it('states plainly when consent is withheld and why nothing is running', () => {
    const text = renderDiagnosis(diagnose(input({ consented: false })), 5_000_000)
    expect(text).toContain('NOT GRANTED')
    expect(text).toContain('by design')
    expect(text).toContain('no clock is running')
    expect(text).toContain('none of these are running')
  })

  it('admits it cannot see the UI', () => {
    // The M8 exit run stalled on a button. A report that implied it covered the
    // UI would send the next reader looking in the wrong place.
    expect(renderDiagnosis(diagnose(input()), 5_000_000)).toContain('Nothing here observes the UI')
  })

  it('names the log as the ground truth and itself as only a reading', () => {
    const text = renderDiagnosis(diagnose(input()), 5_000_000)
    expect(text).toContain('agora/log.jsonl')
    expect(text).toContain('only its reading')
  })

  it('surfaces files the harness could not parse', () => {
    const text = renderDiagnosis(
      diagnose(input({ fileWarnings: [{ file: 'tasks.json', reason: 'unexpected token' }] })),
      5_000_000
    )
    expect(text).toContain('tasks.json')
    expect(text).toContain('never overwritten')
  })
})

describe('agoPhrase', () => {
  it('reads in the unit a person acts on', () => {
    expect(agoPhrase(0)).toBe('just now')
    expect(agoPhrase(59_000)).toBe('just now')
    expect(agoPhrase(60_000)).toBe('1 minute ago')
    expect(agoPhrase(90 * 60_000)).toBe('1 hour ago')
    expect(agoPhrase(50 * 60 * 60_000)).toBe('2 days ago')
  })

  it('does not pretend a backwards clock is fresh', () => {
    expect(agoPhrase(-5_000)).toContain('the clock moved')
  })
})

describe('the report of a company that is actually running', () => {
  const running = () =>
    input({
      consented: true,
      crew: [
        { agentId: 'agent.artemis', lifecycle: 'running' },
        { agentId: 'agent.ci-babysitter', lifecycle: 'down' }
      ],
      armed: [{ id: 'standup', everyMs: 1_800_000 }],
      events: [row('orchestrator', 'consented'), row('spawn'), row('gate'), row('cost')]
    })

  it('says consent is granted and lists the crew with its lifecycle', () => {
    const text = renderDiagnosis(diagnose(running()), 5_000_000)
    expect(text).toContain('granted — the company may work')
    expect(text).toContain('agent.artemis — running')
    // A down agent must read as down, not be quietly omitted.
    expect(text).toContain('agent.ci-babysitter — down')
  })

  it('lists the armed schedules with their intervals', () => {
    expect(renderDiagnosis(diagnose(running()), 5_000_000)).toContain(
      'standup — every 30 minute(s)'
    )
  })

  it('says plainly when nothing is broken, rather than staying silent', () => {
    expect(renderDiagnosis(diagnose(running()), 5_000_000)).toContain(
      'Nothing is reporting itself broken.'
    )
  })

  it('cites a proving row that carries no event field', () => {
    // `spawn` and `cost` have no `event`; the citation must not render
    // "spawn/undefined".
    const text = renderDiagnosis(diagnose(running()), 5_000_000)
    expect(text).not.toContain('undefined')
  })

  it('still counts what remains unexercised, even on a live company', () => {
    const d = diagnose(running())
    expect(d.rows.some((r) => r.verdict === 'working')).toBe(true)
    expect(d.rows.some((r) => r.verdict === 'not-exercised')).toBe(true)
    expect(renderDiagnosis(d, 5_000_000)).toContain('areas are NOT EXERCISED')
  })

  it('omits the unread-files section entirely when every file parsed', () => {
    expect(renderDiagnosis(diagnose(running()), 5_000_000)).not.toContain(
      'Files the harness could not read'
    )
  })
})

/**
 * The three defects the FIRST live report exposed, pinned so they cannot return.
 *
 * All three were mine, all three were invisible to the suite, and all three were
 * obvious the moment a real boot wrote a real file. This is why `PROVE` is a
 * step of the loop and not a formality.
 */
describe('what the first live report got wrong', () => {
  const withheld = () =>
    input({
      consented: false,
      conditions: [
        condition({
          source: 'consent',
          cause: 'consent/not-granted',
          detail: 'nobody has said go on this machine yet'
        })
      ],
      armed: [
        { id: 'standup', everyMs: 1_440 * 60_000 },
        { id: 'retro', everyMs: 10_080 * 60_000 }
      ]
    })

  it('does not call withheld consent BROKEN — it is waiting for you', () => {
    // It reported "consent BROKEN" on every first launch. A reader who meets a
    // BROKEN on a perfectly healthy first boot learns to skip the column.
    const d = diagnose(withheld())
    expect(find(d, 'consent')?.verdict).toBe('waiting')
    const text = renderDiagnosis(d, 5_000_000)
    expect(text).toContain('WAITING FOR YOU')
    expect(text).toContain('**1 thing(s) are waiting on YOU:**')
    expect(text).toContain('Nothing is reporting itself broken.')
  })

  it('still calls a REAL consent failure broken', () => {
    // The distinction has to cut both ways: a grant that could not be written
    // down is genuinely broken, and shares the same degradation source.
    const d = diagnose(
      input({
        conditions: [
          condition({
            source: 'consent',
            cause: 'consent/unwritable',
            detail: 'EROFS: read-only file system'
          })
        ]
      })
    )
    expect(find(d, 'consent')?.verdict).toBe('broken')
  })

  it('does not claim schedules are running while the clock is stopped', () => {
    // It said "no schedule is armed, by design" and then listed five. `armed()`
    // reports REGISTERED triggers; the clock is behind the consent gate.
    const text = renderDiagnosis(diagnose(withheld()), 5_000_000)
    expect(text).toContain('## Schedules that would start')
    expect(text).not.toContain('## Schedules running')
    expect(text).toContain('none of these are running')
    expect(text).toContain('standup — every 1440 minute(s)')
  })

  it('calls them running once consent is granted', () => {
    const text = renderDiagnosis(
      diagnose({ ...withheld(), consented: true, conditions: [] }),
      5_000_000
    )
    expect(text).toContain('## Schedules running')
    expect(text).not.toContain('none of these are running')
  })
})

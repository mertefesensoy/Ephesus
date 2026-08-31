import { describe, expect, it } from 'vitest'
import {
  isCiFailure,
  parseIssues,
  parsePulls,
  parseRuns,
  remoteLogEntries,
  type InboundItem
} from '../../src/shared/harbor'

/**
 * Harbor ingestion parsing (FR-10.1, FR-10.3 — M7.3).
 *
 * The claim: **ingestion never invents what the API did not report.** The
 * package's risk line calls this the E-BRIEF-FAITH failure wearing a Harbor
 * hat, and it is the same defect — a queue listing an issue nobody opened and a
 * briefing narrating a bug nobody filed are one bug at two ends of the
 * building.
 *
 * So a malformed row is DROPPED AND COUNTED, never repaired; a run in flight
 * has a null conclusion rather than a guessed one; and the `remote` tag is a
 * projection of the items, so it cannot be applied to some and forgotten on
 * others.
 */

const ISSUES = JSON.stringify([
  {
    number: 12,
    title: 'Login times out',
    state: 'OPEN',
    updatedAt: '2026-08-30T09:00:00Z',
    url: 'https://github.com/octocat/myapp/issues/12',
    author: { login: 'kestrel' },
    labels: [{ name: 'bug' }, { name: 'p1' }]
  }
])

describe('parsing what gh returned, and only that', () => {
  it('reads an issue field for field', () => {
    const parsed = parseIssues('octocat/myapp', ISSUES)
    expect(parsed.dropped).toBe(0)
    expect(parsed.items).toEqual([
      {
        repo: 'octocat/myapp',
        kind: 'issue',
        ref: 12,
        title: 'Login times out',
        state: 'OPEN',
        conclusion: null,
        url: 'https://github.com/octocat/myapp/issues/12',
        at: '2026-08-30T09:00:00Z',
        author: 'kestrel',
        labels: ['bug', 'p1'],
        draft: false
      }
    ])
  })

  it('marks a draft PR rather than hiding it', () => {
    const parsed = parsePulls(
      'octocat/myapp',
      JSON.stringify([
        {
          number: 3,
          title: 'WIP: retry logic',
          state: 'OPEN',
          updatedAt: '2026-08-30T10:00:00Z',
          url: 'u',
          isDraft: true
        }
      ])
    )
    expect(parsed.items[0]).toMatchObject({ kind: 'pull-request', ref: 3, draft: true })
  })

  it('leaves a running CI job with a NULL conclusion, never a guessed one', () => {
    // Guessing `failure` here hands the CI babysitter an incident that has not
    // happened, against work somebody is still doing.
    const parsed = parseRuns(
      'octocat/myapp',
      JSON.stringify([
        {
          databaseId: 991,
          workflowName: 'ci',
          status: 'in_progress',
          conclusion: null,
          headBranch: 'main',
          createdAt: '2026-08-30T11:00:00Z',
          url: 'u'
        },
        {
          databaseId: 992,
          workflowName: 'ci',
          status: 'completed',
          conclusion: '',
          headBranch: 'main',
          createdAt: '2026-08-30T11:05:00Z',
          url: 'u'
        }
      ])
    )
    expect(parsed.items.map((item) => item.conclusion)).toEqual([null, null])
  })

  it('tolerates a field gh added, and carries none of it', () => {
    // Refusing an issue because a new field appeared would make a `gh` upgrade
    // look like an outage. Reading it would be inventing.
    const parsed = parseIssues(
      'octocat/myapp',
      JSON.stringify([
        {
          number: 1,
          title: 't',
          state: 'OPEN',
          updatedAt: 'x',
          url: 'u',
          somethingNew: { nested: true }
        }
      ])
    )
    expect(parsed.dropped).toBe(0)
    expect(Object.keys(parsed.items[0] ?? {}).sort()).toEqual([
      'at',
      'author',
      'conclusion',
      'draft',
      'kind',
      'labels',
      'ref',
      'repo',
      'state',
      'title',
      'url'
    ])
  })
})

describe('a row that does not validate is DROPPED AND COUNTED', () => {
  const table: readonly (readonly [string, unknown])[] = [
    ['no number', { title: 't', state: 'OPEN', updatedAt: 'x', url: 'u' }],
    [
      'a number that is not one',
      { number: 'twelve', title: 't', state: 'OPEN', updatedAt: 'x', url: 'u' }
    ],
    ['no title', { number: 1, state: 'OPEN', updatedAt: 'x', url: 'u' }],
    ['no state', { number: 1, title: 't', updatedAt: 'x', url: 'u' }],
    ['no url', { number: 1, title: 't', state: 'OPEN', updatedAt: 'x' }],
    ['not an object at all', 'an issue'],
    ['null', null]
  ]

  for (const [what, row] of table) {
    it(`drops an issue with ${what}, and says one was dropped`, () => {
      const parsed = parseIssues('octocat/myapp', JSON.stringify([row]))
      expect(parsed.items).toEqual([])
      expect(parsed.dropped).toBe(1)
      expect(parsed.reasons.join(' · ')).toContain('octocat/myapp issue')
    })
  }

  it('keeps the good rows beside the dropped count — never all-or-nothing', () => {
    // "12 open issues" when 3 rows were unparseable is a false statement. The
    // count travels with the items so a caller cannot report one without the
    // other.
    const parsed = parseIssues(
      'octocat/myapp',
      JSON.stringify([
        { number: 1, title: 'a', state: 'OPEN', updatedAt: 'x', url: 'u' },
        { title: 'no number' },
        { number: 3, title: 'c', state: 'OPEN', updatedAt: 'x', url: 'u' }
      ])
    )
    expect(parsed.items.map((item) => item.ref)).toEqual([1, 3])
    expect(parsed.dropped).toBe(1)
  })

  it('never repairs a row into existence', () => {
    // The defect this whole file exists to prevent: an issue with no number and
    // no title becoming `#0 ""` in the queue, which reads as a bug in the
    // company rather than in the payload.
    const parsed = parseIssues('octocat/myapp', JSON.stringify([{}]))
    expect(parsed.items).toEqual([])
  })

  it('refuses a response that is not an array, without throwing', () => {
    for (const body of ['{ "issues": [] }', 'not json', '', 'null', '42']) {
      const parsed = parseIssues('octocat/myapp', body)
      expect(parsed.items).toEqual([])
      expect(parsed.reasons.length).toBeGreaterThan(0)
    }
  })

  it('bounds the reasons it reports, but never the count', () => {
    const many = JSON.stringify(Array.from({ length: 20 }, () => ({})))
    const parsed = parseIssues('octocat/myapp', many)
    expect(parsed.dropped).toBe(20)
    expect(parsed.reasons.length).toBeLessThanOrEqual(5)
  })
})

describe('the `remote` tag is TOTAL over the inbound path (FR-10.3)', () => {
  const items: readonly InboundItem[] = [
    ...parseIssues('octocat/myapp', ISSUES).items,
    ...parsePulls(
      'octocat/myapp',
      JSON.stringify([{ number: 3, title: 'p', state: 'OPEN', updatedAt: 'x', url: 'u' }])
    ).items,
    ...parseRuns(
      'octocat/myapp',
      JSON.stringify([
        {
          databaseId: 9,
          status: 'completed',
          conclusion: 'failure',
          createdAt: 'x',
          url: 'u',
          workflowName: 'ci'
        }
      ])
    ).items
  ]

  it('tags every item, of every kind, with kind `remote`', () => {
    const entries = remoteLogEntries(items)
    expect(entries).toHaveLength(3)
    expect(entries.every((entry) => entry.kind === 'remote')).toBe(true)
    expect(entries.map((entry) => entry['inbound'])).toEqual(['issue', 'pull-request', 'ci-run'])
  })

  it('carries the refs needed to reconstruct the action (NFR-13)', () => {
    const entry = remoteLogEntries(items)[0]
    expect(entry).toMatchObject({
      source: 'github',
      repo: 'octocat/myapp',
      ref: 12,
      url: 'https://github.com/octocat/myapp/issues/12'
    })
  })

  it('gives every entry a `conclusion` key, so a reader need not know the kind', () => {
    expect(remoteLogEntries(items).every((entry) => 'conclusion' in entry)).toBe(true)
  })

  it('is a projection — no item can reach the queue without reaching the log', () => {
    expect(remoteLogEntries(items)).toHaveLength(items.length)
    expect(remoteLogEntries([])).toEqual([])
  })
})

describe('isCiFailure is narrow on purpose', () => {
  function run(over: Record<string, unknown>): InboundItem {
    return (
      parseRuns(
        'octocat/myapp',
        JSON.stringify([{ databaseId: 1, status: 'completed', createdAt: 'x', url: 'u', ...over }])
      ).items[0] ?? (undefined as never)
    )
  }

  it('counts a finished run that failed or timed out', () => {
    expect(isCiFailure(run({ conclusion: 'failure' }))).toBe(true)
    expect(isCiFailure(run({ conclusion: 'timed_out' }))).toBe(true)
  })

  it('does NOT count a run still going, a success, or a human cancellation', () => {
    // A cancelled run is somebody's decision, not a fault. A babysitter that
    // treated it as one would open a PR against work being stopped on purpose.
    expect(isCiFailure(run({ status: 'in_progress', conclusion: null }))).toBe(false)
    expect(isCiFailure(run({ conclusion: 'success' }))).toBe(false)
    expect(isCiFailure(run({ conclusion: 'cancelled' }))).toBe(false)
    expect(isCiFailure(run({ conclusion: 'skipped' }))).toBe(false)
  })

  it('never counts an issue or a PR, whatever they say', () => {
    const issue = parseIssues(
      'octocat/myapp',
      JSON.stringify([{ number: 1, title: 'failure', state: 'failure', updatedAt: 'x', url: 'u' }])
    ).items[0]
    expect(issue === undefined ? null : isCiFailure(issue)).toBe(false)
  })
})

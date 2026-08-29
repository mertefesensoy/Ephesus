import { describe, expect, it } from 'vitest'
import {
  STOA_SCHEMA_VERSION,
  checkIntake,
  checkRegistrar,
  checkStudiable,
  nextBriefId,
  parseWatchlist,
  parseWatchlistMarkdown,
  registerDraftSchema,
  sourceIdFor,
  uniqueSourceId,
  watchlistEntrySchema,
  type WatchlistEntry
} from '../../src/shared/stoa'

/**
 * The Stoa's validators (ADR-0017, FR-13, SDD §4.7).
 *
 * The entry shape IS the provenance chain — id, pin and license are what make
 * a brief's claims checkable years later — so most of these tests are about
 * what the schema refuses rather than what it accepts.
 */

function entry(over: Record<string, unknown> = {}): unknown {
  return {
    id: 'src-hermes-agent',
    url: 'https://github.com/NousResearch/hermes-agent',
    kind: 'git',
    tags: ['agent-loop'],
    license: 'unverified',
    pin: null,
    registeredBy: 'architect',
    registeredAt: '2026-08-28T09:00:00.000Z',
    notes: 'what to learn',
    ...over
  }
}

describe('the watchlist entry schema (SDD §4.7)', () => {
  it('accepts the documented shape', () => {
    expect(watchlistEntrySchema.safeParse(entry()).success).toBe(true)
  })

  it.each([
    ['an id that is not slug-shaped', { id: 'hermes agent' }],
    ['an id without the src- prefix', { id: 'hermes-agent' }],
    ['a url that is not a url', { url: 'not-a-url' }],
    ['a non-git kind while v1 studies git only', { kind: 'web' }],
    ['no tags at all — tags scope every study', { tags: [] }],
    ['an empty license rather than "unverified"', { license: '' }],
    ['an empty pin instead of null', { pin: '' }],
    ['a registrar who is not the Architect', { registeredBy: 'artemis' }],
    ['an unknown extra field', { escalate: true }]
  ])('refuses %s', (_why, over) => {
    expect(watchlistEntrySchema.safeParse(entry(over)).success).toBe(false)
  })

  it('accepts "unverified" as a license — recording "not checked" is honest', () => {
    const parsed = watchlistEntrySchema.safeParse(entry({ license: 'unverified' }))
    expect(parsed.success).toBe(true)
  })

  it('refuses a registrar smuggled in as an extra key, not just a wrong value', () => {
    // `.strict()` is what makes the authority claim un-forgeable at the
    // boundary: there is no field to set, so there is nothing to ignore.
    const parsed = registerDraftSchema.safeParse({
      url: 'https://github.com/o/r',
      tags: ['x'],
      license: 'MIT',
      pin: null,
      notes: '',
      registeredBy: 'artemis'
    })
    expect(parsed.success).toBe(false)
  })
})

describe('the watchlist file', () => {
  it('round-trips a valid file', () => {
    const body = JSON.stringify({
      schemaVersion: STOA_SCHEMA_VERSION,
      sources: [entry()],
      retired: []
    })
    const parsed = parseWatchlist(body)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.watchlist.sources[0]?.id).toBe('src-hermes-agent')
  })

  it('reports every reason at once rather than the first', () => {
    const parsed = parseWatchlist(
      JSON.stringify({
        schemaVersion: STOA_SCHEMA_VERSION,
        sources: [entry({ id: 'bad id', url: 'nope' })],
        retired: []
      })
    )
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reasons.length).toBeGreaterThan(1)
  })

  it('names the file, not a stack trace, when it is not JSON', () => {
    const parsed = parseWatchlist('{ nope')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reasons[0]).toContain('not JSON')
  })

  it('refuses a schemaVersion it does not know', () => {
    const parsed = parseWatchlist(JSON.stringify({ schemaVersion: 2, sources: [], retired: [] }))
    expect(parsed.ok).toBe(false)
  })
})

describe('curation authority (ADR-0017 R1, FR-13.1)', () => {
  it('lets the Architect curate', () => {
    expect(checkRegistrar('architect').allowed).toBe(true)
  })

  it.each(['artemis', 'agent.artemis', 'researcher', 'orchestrator', ''])(
    'refuses "%s" — the Stoa may never widen its own reading list',
    (who) => {
      const check = checkRegistrar(who)
      expect(check.allowed).toBe(false)
      expect(check.because).toContain('R1')
    }
  )
})

describe('what a source is allowed to do (FR-13.2, FR-13.5)', () => {
  const pinned = watchlistEntrySchema.parse(entry({ pin: 'b91a49f', license: 'MIT' }))
  const unpinned = watchlistEntrySchema.parse(entry())

  it('refuses to study an unpinned source — a study runs on a pinned snapshot', () => {
    const check = checkStudiable(unpinned)
    expect(check.allowed).toBe(false)
    expect(check.because).toContain('FR-13.2')
  })

  it('studies a pinned source', () => {
    expect(checkStudiable(pinned).allowed).toBe(true)
  })

  it('permits study but refuses intake on an unverified license', () => {
    // The asymmetry IS FR-13.5: "we did not check" is not a licence to copy,
    // but it is no reason to refuse to read in public.
    expect(checkStudiable(watchlistEntrySchema.parse(entry({ pin: 'abc1234' }))).allowed).toBe(true)
    expect(checkIntake(unpinned).allowed).toBe(false)
  })

  it.each(['unverified', 'UNVERIFIED', '  Unverified  '])(
    'treats %s as unverified however it is cased',
    (license) => {
      const row = watchlistEntrySchema.parse(entry({ license }))
      expect(checkIntake(row).allowed).toBe(false)
    }
  )

  it('permits intake on a verified license', () => {
    expect(checkIntake(pinned).allowed).toBe(true)
  })
})

describe('id derivation', () => {
  it.each([
    ['https://github.com/NousResearch/hermes-agent', 'src-hermes-agent'],
    ['https://github.com/chaitanyagiri/munder-difflin', 'src-munder-difflin'],
    ['https://github.com/anomalyco/opencode.git', 'src-opencode'],
    ['https://github.com/owner/Repo_Name/', 'src-repo-name']
  ])('derives %s → %s', (url, id) => {
    expect(sourceIdFor(url)).toBe(id)
  })

  it('never returns the bare prefix', () => {
    expect(sourceIdFor('https://example.com')).toBe('src-example-com')
    expect(sourceIdFor('///')).toBe('src-source')
  })

  it('mints a free id rather than colliding with a registered one', () => {
    expect(uniqueSourceId('src-opencode', ['src-opencode'])).toBe('src-opencode-2')
    expect(uniqueSourceId('src-opencode', ['src-opencode', 'src-opencode-2'])).toBe(
      'src-opencode-3'
    )
  })

  it('mints brief ids that never reuse one', () => {
    expect(nextBriefId([])).toBe('RB-001')
    expect(nextBriefId(['RB-001'])).toBe('RB-002')
    // A gap does not let the next mint fall back into it — RB-002 is cited by
    // whatever referenced it, whether or not the file still exists.
    expect(nextBriefId(['RB-001', 'RB-009'])).toBe('RB-010')
  })
})

describe('the build-phase seed reader (FR-13.7)', () => {
  const table = [
    '# Stoa watchlist',
    '',
    'Prose the table grows around, with a | pipe | in it.',
    '',
    '| ID | Source | Tags | License | Pin | Notes (what to learn) |',
    '|---|---|---|---|---|---|',
    '| src-hermes-agent | https://github.com/NousResearch/hermes-agent | `agent-loop`, `tool-use` | unverified | *(set at first study)* | How a lab-grade harness structures its loop. |',
    '| src-munder-difflin | https://github.com/chaitanyagiri/munder-difflin | `orchestration`, `hive` | MIT | `b91a49f` (2026-08-28, [RB-001](./briefs/RB-001.md)) | The project’s own inspiration. |',
    ''
  ].join('\n')

  const at = '2026-08-28T09:00:00.000Z'
  const parsed = parseWatchlistMarkdown(table, at)

  it('reads only the source rows — not the header, separator or prose', () => {
    expect(parsed.map((row) => row.id)).toEqual(['src-hermes-agent', 'src-munder-difflin'])
  })

  it('reads the pin when there is one and null when the cell is a placeholder', () => {
    expect(parsed[0]?.pin).toBeNull()
    expect(parsed[1]?.pin).toBe('b91a49f')
  })

  it('strips the backticks off tags, which scope every study', () => {
    expect(parsed[0]?.tags).toEqual(['agent-loop', 'tool-use'])
  })

  it('carries the license verbatim, unverified included', () => {
    expect(parsed[0]?.license).toBe('unverified')
    expect(parsed[1]?.license).toBe('MIT')
  })

  it('stamps the registrar and the seed time, which the table does not record', () => {
    expect(parsed.every((row) => row.registeredBy === 'architect')).toBe(true)
    expect(parsed.every((row) => row.registeredAt === at)).toBe(true)
  })

  it('produces entries the schema accepts — the seed cannot write an invalid file', () => {
    for (const row of parsed) {
      expect(watchlistEntrySchema.safeParse(row as WatchlistEntry).success).toBe(true)
    }
  })

  it('skips a row whose url cell has no url rather than inventing one', () => {
    const rows = parseWatchlistMarkdown(
      '| src-broken | *(pending)* | `x` | MIT | `abc1234` | n |',
      at
    )
    expect(rows).toEqual([])
  })
})

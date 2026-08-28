import { describe, expect, it } from 'vitest'
import {
  DECK_SECTIONS,
  ODEON_SCHEMA_VERSION,
  deckFileName,
  escapeHtml,
  parseDeckFiling,
  taskOfDeckFile
} from '../../src/shared/odeon'

/**
 * The Odeon's filing vocabulary (ADR-0008, FR-7.2).
 *
 * The parser refuses rather than repairs, for the same reason the ledger's
 * does: a refusal is the only feedback a filing agent gets, and a deck quietly
 * accepted with a blank "trade-offs" would satisfy the close gate while
 * defeating the reason FR-7.2 names six sections.
 */

function sections(): Record<string, string> {
  return Object.fromEntries(DECK_SECTIONS.map((s) => [s, `${s} content`])) as Record<string, string>
}

function filing(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: ODEON_SCHEMA_VERSION,
    kind: 'deck',
    taskId: 't-2026-08-28-01',
    title: 'Checkout flakiness',
    sections: sections(),
    ...over
  })
}

describe('parseDeckFiling', () => {
  it('accepts a complete filing', () => {
    const parsed = parseDeckFiling(filing())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.filing.sections.tradeOffs).toBe('tradeOffs content')
  })

  it('refuses a body that is not JSON, and says so', () => {
    const parsed = parseDeckFiling('not json at all')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('not JSON')
  })

  it.each(DECK_SECTIONS)('refuses a filing missing %s', (missing) => {
    const partial = { ...sections() }
    delete partial[missing]
    const parsed = parseDeckFiling(filing({ sections: partial }))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain(missing)
  })

  it.each(DECK_SECTIONS)('refuses an EMPTY %s — a blank slide is not a section', (blank) => {
    const parsed = parseDeckFiling(filing({ sections: { ...sections(), [blank]: '' } }))
    expect(parsed.ok).toBe(false)
  })

  it('refuses an unknown section, so a typo is never silently dropped', () => {
    const parsed = parseDeckFiling(filing({ sections: { ...sections(), tradeoffs: 'oops' } }))
    expect(parsed.ok).toBe(false)
  })

  it('refuses a filing with no task — a deck with no task closes nothing', () => {
    expect(parseDeckFiling(filing({ taskId: 'not-a-task-id' })).ok).toBe(false)
  })

  it('refuses a schemaVersion it does not know', () => {
    expect(parseDeckFiling(filing({ schemaVersion: 99 })).ok).toBe(false)
  })
})

describe('the archive names files so the record can only grow', () => {
  it('names a deck for its task and the moment it landed', () => {
    const name = deckFileName('t-2026-08-28-01', new Date('2026-08-28T10:11:12.500Z'))
    expect(name).toBe('t-2026-08-28-01-2026-08-28T10-11-12-500Z.html')
  })

  it('never puts a colon in a file name', () => {
    // Windows refuses them, and an archive that cannot be written on one
    // platform is not an archive.
    expect(deckFileName('t-x', new Date('2026-08-28T10:11:12.500Z'))).not.toContain(':')
  })

  it('sorts by time when sorted by name', () => {
    const early = deckFileName('t-x', new Date('2026-08-28T10:00:00.000Z'))
    const late = deckFileName('t-x', new Date('2026-08-28T11:00:00.000Z'))
    expect([late, early].sort()).toEqual([early, late])
  })

  it('gives a second deck for the same task a DIFFERENT name (invariant §5)', () => {
    const first = deckFileName('t-x', new Date('2026-08-28T10:00:00.000Z'))
    const second = deckFileName('t-x', new Date('2026-08-28T10:00:00.001Z'))
    expect(second).not.toBe(first)
  })

  it('reads the task back out of a file name', () => {
    const name = deckFileName('t-2026-08-28-01', new Date('2026-08-28T10:11:12.500Z'))
    expect(taskOfDeckFile(name)).toBe('t-2026-08-28-01')
  })

  it.each([
    'notes.html',
    '../../etc/passwd',
    't-x.html',
    'index.html',
    't-x-2026-08-28T10-00-00-000Z.html.bak'
  ])('refuses to recognise %s as a deck', (name) => {
    expect(taskOfDeckFile(name)).toBeNull()
  })
})

describe('escapeHtml — a deck is agent-authored text in a webview', () => {
  it('neutralises markup rather than rendering it', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes the ampersand first, so nothing double-decodes', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('escapes both quote characters', () => {
    expect(escapeHtml(`"x" 'y'`)).toBe('&quot;x&quot; &#39;y&#39;')
  })

  it('leaves ordinary prose alone', () => {
    expect(escapeHtml('we chose zod over ajv')).toBe('we chose zod over ajv')
  })
})

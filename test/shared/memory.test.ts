import { describe, expect, it } from 'vitest'
import {
  composeMemoryEntry,
  MEMORY_INJECTION_BUDGET_CHARS,
  memoryEntrySchema,
  parseMemorySections,
  selectMemoryForInjection
} from '../../src/shared/memory'

/**
 * Library layer 1's read-time structure (ADR-0006).
 *
 * The rule under test in most of these is the ADR's, not a style preference:
 * *no schema is imposed at write time*. So the parser's job is to find what
 * framing it can and lose nothing when there is none.
 */

describe('parseMemorySections', () => {
  it('reads the harness framing off a dated heading', () => {
    const sections = parseMemorySections(
      '## 2026-08-27 — agent.mason\n\nThe checkout suite is flaky under load.\n'
    )
    expect(sections).toHaveLength(1)
    expect(sections[0]?.date).toBe('2026-08-27')
    expect(sections[0]?.author).toBe('agent.mason')
    expect(sections[0]?.body).toBe('The checkout suite is flaky under load.')
  })

  it('keeps a section an agent headed its own way, with no date and no author', () => {
    const sections = parseMemorySections('## Things I keep forgetting\n\nThe port is 5173.\n')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.date).toBeNull()
    expect(sections[0]?.author).toBeNull()
    expect(sections[0]?.body).toBe('The port is 5173.')
  })

  it('keeps the preamble above the first heading as its own section', () => {
    const sections = parseMemorySections('# Memory\n\nSeed text.\n\n## 2026-08-27 — a\n\nbody\n')
    expect(sections).toHaveLength(2)
    expect(sections[0]?.heading).toBeNull()
    expect(sections[0]?.body).toContain('Seed text.')
    expect(sections[1]?.date).toBe('2026-08-27')
  })

  it('loses nothing: every section body survives verbatim', () => {
    const text =
      '## 2026-08-26 — agent.a\n\nfirst\nwith a second line\n\n## 2026-08-27 — agent.b\n\nsecond\n'
    const bodies = parseMemorySections(text).map((section) => section.body)
    expect(bodies).toEqual(['first\nwith a second line', 'second'])
  })

  it('returns nothing for an empty or whitespace-only memory', () => {
    expect(parseMemorySections('')).toEqual([])
    expect(parseMemorySections('   \n\n  ')).toEqual([])
  })

  it('does not mistake a deeper heading inside prose for a new section', () => {
    const sections = parseMemorySections('## 2026-08-27 — a\n\nbody\n\n### a sub-heading\n\nmore\n')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.body).toContain('### a sub-heading')
  })
})

describe('composeMemoryEntry', () => {
  it('frames one dated section and keeps the prose verbatim', () => {
    const text = composeMemoryEntry({
      at: '2026-08-27T09:15:00.000Z',
      author: 'agent.mason',
      body: 'Retries hide the real failure.'
    })
    expect(text).toBe('\n## 2026-08-27 — agent.mason\n\nRetries hide the real failure.\n')
  })

  it('always opens with a blank line, so an append cannot weld onto the last paragraph', () => {
    const previous = '## 2026-08-26 — agent.a\n\nold'
    const joined = previous + composeMemoryEntry({ at: '2026-08-27', author: 'a', body: 'new' })
    expect(parseMemorySections(joined)).toHaveLength(2)
  })

  it('validates only the harness framing — any prose is legal', () => {
    expect(
      memoryEntrySchema.safeParse({ at: '2026-08-27', author: 'agent.a', body: '{"not":"json"}' })
        .success
    ).toBe(true)
    expect(memoryEntrySchema.safeParse({ at: '2026-08-27', author: '', body: 'x' }).success).toBe(
      false
    )
    expect(memoryEntrySchema.safeParse({ at: '2026-08-27', author: 'a', body: '' }).success).toBe(
      false
    )
  })
})

describe('selectMemoryForInjection', () => {
  const section = (n: number, size: number): string =>
    `## 2026-08-${String(n).padStart(2, '0')} — agent.a\n\n${'x'.repeat(size)}\n`

  it('carries everything when the whole memory fits', () => {
    const text = section(1, 50) + section(2, 50)
    const injection = selectMemoryForInjection(text)
    expect(injection.truncated).toBe(false)
    expect(injection.includedSections).toBe(2)
    expect(injection.elidedChars).toBe(0)
    expect(injection.text).toContain('2026-08-01')
    expect(injection.text).toContain('2026-08-02')
  })

  it('keeps the NEWEST sections when the budget bites, in file order', () => {
    const text = section(1, 100) + section(2, 100) + section(3, 100)
    const injection = selectMemoryForInjection(text, 260)
    expect(injection.truncated).toBe(true)
    expect(injection.includedSections).toBe(2)
    expect(injection.totalSections).toBe(3)
    expect(injection.text).not.toContain('2026-08-01')
    expect(injection.text.indexOf('2026-08-02')).toBeLessThan(injection.text.indexOf('2026-08-03'))
    expect(injection.elidedChars).toBeGreaterThan(0)
  })

  it('never carries half a section', () => {
    const text = section(1, 100) + section(2, 100)
    const injection = selectMemoryForInjection(text, 150)
    expect(injection.includedSections).toBe(1)
    // The one section it kept is whole: heading, blank line and the full body.
    expect(injection.text).toBe(section(2, 100).trim())
  })

  it('never injects the seed preamble, and never counts it', () => {
    const text = `# Memory\n\n${'s'.repeat(200)}\n\n${section(9, 100)}`
    const injection = selectMemoryForInjection(text)
    expect(injection.text).toContain('2026-08-09')
    expect(injection.text).not.toContain('# Memory')
    expect(injection.totalSections).toBe(1)
    expect(injection.truncated).toBe(false)
  })

  it('reports nothing for a seeded memory the agent has not written to yet', () => {
    const injection = selectMemoryForInjection('# Memory — agent.new\n\nSeed text only.\n')
    expect(injection.text).toBe('')
    expect(injection.totalSections).toBe(0)
    expect(injection.truncated).toBe(false)
  })

  it('reports nothing to inject for an empty memory', () => {
    const injection = selectMemoryForInjection('')
    expect(injection.text).toBe('')
    expect(injection.truncated).toBe(false)
    expect(injection.totalSections).toBe(0)
  })

  it('has a budget large enough for a working memory', () => {
    expect(MEMORY_INJECTION_BUDGET_CHARS).toBeGreaterThanOrEqual(4_000)
  })
})

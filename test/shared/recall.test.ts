import { describe, expect, it } from 'vitest'
import {
  grepRecall,
  inScope,
  recallPassages,
  recallRequestSchema,
  recallResponseSchema,
  recallTerms,
  RECALL_SCHEMA_VERSION,
  scorePassage,
  snippetOf,
  type RecallDoc
} from '../../src/shared/recall'

/**
 * The grep rung — ADR-0006's transparency floor. Everything here is
 * deterministic on purpose: "the same known-answer query, green at every
 * available rung" is only meaningful if the bottom rung answers the same way
 * every time.
 */

const memory = (scope: string, text: string): RecallDoc => ({
  ref: `/agora/agents/${scope}/memory.md`,
  source: 'memory',
  scope,
  text
})

const CORPUS: readonly RecallDoc[] = [
  memory(
    'agent.mason',
    [
      '# Memory — agent.mason',
      '',
      'seed text',
      '',
      '## 2026-08-26 — agent.mason',
      '',
      'The checkout suite is flaky because the fixture seeds two carts.',
      '',
      '## 2026-08-27 — agent.mason',
      '',
      'Staging resets at 03:00 UTC. Do not trust data written before then.'
    ].join('\n')
  ),
  memory(
    'agent.iris',
    ['## 2026-08-26 — agent.iris', '', 'The deploy pipeline needs a staging smoke test.'].join('\n')
  ),
  {
    ref: '/agora/knowledge/release-runbook.md',
    source: 'knowledge',
    scope: 'release-runbook',
    text: '# Release runbook\n\nTag, wait for CI, then promote staging to production.'
  }
]

describe('recallTerms', () => {
  it('lowercases, de-duplicates and drops one-character noise', () => {
    expect(recallTerms('Flaky CHECKOUT a flaky')).toEqual(['flaky', 'checkout'])
  })

  it('keeps dotted and dashed identifiers whole', () => {
    expect(recallTerms('agent.mason smoke-test')).toEqual(['agent.mason', 'smoke-test'])
  })

  it('finds nothing to search for in punctuation alone', () => {
    expect(recallTerms('?! — ,')).toEqual([])
  })
})

describe('recallPassages', () => {
  it('splits at markdown headings and titles each passage', () => {
    const passages = recallPassages(CORPUS[0] as RecallDoc)
    expect(passages.map((p) => p.title)).toEqual([
      'Memory — agent.mason',
      '2026-08-26 — agent.mason',
      '2026-08-27 — agent.mason'
    ])
  })

  it('titles a document with no headings after its scope', () => {
    const passages = recallPassages(memory('agent.a', 'just prose, no headings'))
    expect(passages).toEqual([{ title: 'agent.a', text: 'just prose, no headings' }])
  })
})

describe('scorePassage', () => {
  it('ranks distinct terms above repetition', () => {
    const both = scorePassage('alpha beta', ['alpha', 'beta'])
    const oneRepeated = scorePassage('alpha alpha alpha alpha alpha', ['alpha', 'beta'])
    expect(both).toBeGreaterThan(oneRepeated)
  })

  it('is zero when nothing matches, and zero never becomes a hit', () => {
    expect(scorePassage('nothing here', ['alpha'])).toBe(0)
    expect(grepRecall(CORPUS, 'quantum')).toEqual([])
  })
})

describe('grepRecall (known-answer queries)', () => {
  it('finds the agent who wrote the fact, in their own memory', () => {
    const [top] = grepRecall(CORPUS, 'flaky checkout fixture')
    expect(top?.scope).toBe('agent.mason')
    expect(top?.source).toBe('memory')
    expect(top?.title).toBe('2026-08-26 — agent.mason')
    expect(top?.snippet).toContain('two carts')
  })

  it('reaches across agents and into the knowledge shelf', () => {
    expect(grepRecall(CORPUS, 'staging').map((hit) => hit.scope)).toContain('agent.mason')
    expect(grepRecall(CORPUS, 'runbook promote').map((hit) => hit.scope)).toContain(
      'release-runbook'
    )
  })

  it('is deterministic: the same corpus and query give the same order', () => {
    const once = grepRecall(CORPUS, 'staging test')
    const twice = grepRecall([...CORPUS].reverse(), 'staging test')
    expect(twice).toEqual(once)
  })

  it('honours the limit', () => {
    expect(grepRecall(CORPUS, 'the', 1)).toHaveLength(1)
  })
})

describe('inScope', () => {
  const doc = CORPUS[0] as RecallDoc
  it('lets everything through when no scope is asked for', () => {
    expect(inScope(doc, null)).toBe(true)
  })
  it('matches an agent id and a corpus name', () => {
    expect(inScope(doc, 'agent.mason')).toBe(true)
    expect(inScope(doc, 'memory')).toBe(true)
    expect(inScope(doc, 'agent.iris')).toBe(false)
    expect(inScope(doc, 'knowledge')).toBe(false)
  })
})

describe('snippetOf', () => {
  it('returns short passages whole', () => {
    expect(snippetOf('short', ['short'])).toBe('short')
  })

  it('windows a long passage around the match and marks the cut', () => {
    const text = `${'x '.repeat(600)}NEEDLE${' y'.repeat(600)}`
    const snippet = snippetOf(text, ['needle'])
    expect(snippet).toContain('NEEDLE')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThan(text.length)
  })

  it('opens where the most distinct terms are, not on the first stopword hit', () => {
    // `is` matches in the boilerplate; the sentence that answers is far away.
    const text = [
      'This file is your long-term memory.',
      'x'.repeat(1_200),
      'The checkout suite is flaky because the fixture seeds two carts.'
    ].join('\n')
    const snippet = snippetOf(text, ['is', 'checkout', 'flaky'])
    expect(snippet).toContain('checkout suite is flaky')
    expect(snippet).not.toContain('long-term memory')
  })
})

describe('the recall wire format', () => {
  it('accepts a well-formed request and refuses an unversioned one', () => {
    const request = {
      schemaVersion: RECALL_SCHEMA_VERSION,
      token: 'tok',
      agentId: 'agent.mason',
      query: 'staging',
      scope: null,
      limit: 5
    }
    expect(recallRequestSchema.safeParse(request).success).toBe(true)
    expect(recallRequestSchema.safeParse({ ...request, schemaVersion: 2 }).success).toBe(false)
    expect(recallRequestSchema.safeParse({ ...request, limit: 0 }).success).toBe(false)
  })

  it('requires a degraded reason to be a string or explicitly null, never absent', () => {
    const base = { schemaVersion: RECALL_SCHEMA_VERSION, query: 'q', rung: 'grep', hits: [] }
    expect(recallResponseSchema.safeParse({ ...base, degraded: null }).success).toBe(true)
    expect(recallResponseSchema.safeParse(base).success).toBe(false)
  })
})

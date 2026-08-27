import { describe, expect, it } from 'vitest'
import {
  archiveFileName,
  nothingDestroyed,
  parseCondensation,
  planReflection,
  REFLECTION_KEEP_SECTIONS,
  REFLECTION_SCHEMA_VERSION,
  REFLECTION_THRESHOLD_CHARS
} from '../../src/shared/reflection'
import { MEMORY_INJECTION_BUDGET_CHARS } from '../../src/shared/memory'

/** Reflection's mechanism (ADR-0006 layer 3, NFR-7) — pure and inspectable. */

const section = (day: number, size: number): string =>
  `## 2026-08-${String(day).padStart(2, '0')} — agent.a\n\n${'x'.repeat(size)}\n\n`

const memoryOf = (count: number, size: number, preamble = '# Memory\n\nseed\n\n'): string =>
  preamble + Array.from({ length: count }, (_, i) => section(i + 1, size)).join('')

describe('planReflection', () => {
  it('declines under the threshold, and says why', () => {
    const plan = planReflection(memoryOf(10, 100))
    expect(plan.due).toBe(false)
    expect(plan.because).toContain('under the')
    expect(plan.condensing).toEqual([])
  })

  it('fires over the threshold, keeping the newest sections', () => {
    const plan = planReflection(memoryOf(12, 3_000))
    expect(plan.due).toBe(true)
    expect(plan.keeping).toHaveLength(REFLECTION_KEEP_SECTIONS)
    expect(plan.condensing).toHaveLength(12 - REFLECTION_KEEP_SECTIONS)
    // The oldest go; the newest stay.
    expect(plan.condensing[0]?.date).toBe('2026-08-01')
    expect(plan.keeping.at(-1)?.date).toBe('2026-08-12')
  })

  it('never counts the seed preamble as something to condense', () => {
    const plan = planReflection(memoryOf(12, 3_000))
    expect(plan.preamble?.heading).toBeNull()
    expect(plan.condensing.every((s) => s.heading !== null)).toBe(true)
  })

  it('declines a long memory that is one enormous section, and says why', () => {
    const plan = planReflection(`## 2026-08-01 — agent.a\n\n${'x'.repeat(40_000)}`)
    expect(plan.due).toBe(false)
    expect(plan.because).toContain('written section')
  })

  it('fires well above the injection budget, not the moment eliding starts', () => {
    expect(REFLECTION_THRESHOLD_CHARS).toBeGreaterThan(MEMORY_INJECTION_BUDGET_CHARS * 2)
  })
})

describe('nothingDestroyed (NFR-7)', () => {
  const old = memoryOf(3, 50)

  it('passes when every old section is in the new memory or the archive', () => {
    expect(nothingDestroyed(old, '# Memory\n\nseed\n', old)).toEqual({ ok: true })
  })

  it('fails, naming what would be lost', () => {
    const result = nothingDestroyed(old, '# Memory\n\nseed\n', section(1, 50))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toHaveLength(2)
      expect(result.missing[0]).toContain('2026-08-02')
    }
  })

  it('does not accept a summary as containing what it summarizes', () => {
    // The core mentions the same dates; it is still not the sections.
    const core = '## 2026-08-01 — condensed\n\nI learned things on 2026-08-01, -02 and -03.'
    expect(nothingDestroyed(old, core, '').ok).toBe(false)
  })
})

describe('parseCondensation', () => {
  const good = JSON.stringify({ schemaVersion: REFLECTION_SCHEMA_VERSION, core: 'what I know' })

  it('reads a bare JSON body', () => {
    const parsed = parseCondensation(good)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.condensation.core).toBe('what I know')
  })

  it('reads the fenced block engines like to wrap JSON in', () => {
    expect(parseCondensation(`Sure!\n\n\`\`\`json\n${good}\n\`\`\`\n`).ok).toBe(true)
  })

  it('refuses with a reason the agent can act on', () => {
    expect(parseCondensation('')).toEqual({ ok: false, reason: 'the message body is empty' })
    expect(parseCondensation('not json')).toEqual({
      ok: false,
      reason: 'the body is not valid JSON'
    })
    const wrong = parseCondensation(JSON.stringify({ schemaVersion: 9, core: 'x' }))
    expect(wrong.ok).toBe(false)
  })

  it('refuses an empty core rather than erasing a memory into nothing', () => {
    expect(
      parseCondensation(JSON.stringify({ schemaVersion: REFLECTION_SCHEMA_VERSION, core: '' })).ok
    ).toBe(false)
  })
})

describe('archiveFileName', () => {
  it('is dated and sequenced, so a second condensation the same day is its own file', () => {
    const at = new Date('2026-08-27T10:00:00Z')
    expect(archiveFileName(at, 1)).toBe('2026-08-27-001.md')
    expect(archiveFileName(at, 2)).toBe('2026-08-27-002.md')
  })
})

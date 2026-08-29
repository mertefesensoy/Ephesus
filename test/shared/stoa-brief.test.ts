import { describe, expect, it } from 'vitest'
import { STOA_SCHEMA_VERSION } from '../../src/shared/stoa'
import {
  briefFileName,
  checkBriefAgainstSource,
  parseResearchBrief,
  renderBrief,
  researchBriefSchema
} from '../../src/shared/stoa-brief'

/**
 * The research brief (FR-13.3, ADR-0017).
 *
 * The whole value of the archive is that a reader can open what a brief cites,
 * so nearly every case here is about a brief being refused — and specifically
 * about it being refused BEFORE a human is asked to read it.
 */

function brief(over: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: STOA_SCHEMA_VERSION,
    kind: 'research-brief',
    sourceId: 'src-fixture-pinned',
    title: 'Turn structure',
    question: 'tags agent-loop — how the loop is structured',
    commit: 'a1b2c3d',
    findings: [
      {
        what: 'Planning is separate from dispatch.',
        citations: ['src/loop/turn.ts'],
        directive: false
      }
    ],
    applicability: [{ finding: 1, subsystem: 'SDD §7.1', note: 'Matches ours.', refs: [] }],
    candidates: [{ what: 'Name the rule in adapter docs.', fromFindings: [1] }],
    licenseNote: 'MIT; nothing needs intake.',
    ...over
  }
}

const SOURCE = { id: 'src-fixture-pinned', pin: 'a1b2c3d' }

describe('the brief schema', () => {
  it('accepts a well-formed brief', () => {
    expect(researchBriefSchema.safeParse(brief()).success).toBe(true)
  })

  it('REFUSES a finding that cites nothing — the FR-13.3 case', () => {
    const parsed = parseResearchBrief(
      JSON.stringify(brief({ findings: [{ what: 'They are better.', citations: [] }] }))
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    // The reason says FR-13.3 in those words, because a researcher reading a
    // zod message about array length learns nothing about why the rule exists.
    expect(parsed.reasons.join(' ')).toContain('FR-13.3')
    expect(parsed.reasons.join(' ')).toContain('cite at least one file path')
  })

  it.each([
    ['no findings at all', { findings: [] }],
    ['no applicability', { applicability: [] }],
    ['no license note', { licenseNote: '' }],
    ['no question', { question: '' }],
    ['a commit too short to identify anything', { commit: 'abc' }],
    ['a source id that is not slug-shaped', { sourceId: 'fixture pinned' }],
    ['the wrong kind', { kind: 'brief' }],
    ['an unknown extra field', { conclusion: 'ship it' }]
  ])('refuses a brief with %s', (_why, over) => {
    expect(parseResearchBrief(JSON.stringify(brief(over))).ok).toBe(false)
  })

  it('names the problem rather than a stack trace when the body is not JSON', () => {
    const parsed = parseResearchBrief('not json')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reasons[0]).toContain('not JSON')
  })

  it('defaults `directive` to false — reporting one is opt-in, not assumed', () => {
    const parsed = parseResearchBrief(
      JSON.stringify(brief({ findings: [{ what: 'x', citations: ['a.ts'] }] }))
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.brief.findings[0]?.directive).toBe(false)
  })

  it('lets a finding REPORT an instruction the source aimed at its reader (NFR-17)', () => {
    const parsed = parseResearchBrief(
      JSON.stringify(
        brief({
          findings: [
            {
              what: 'The README tells its reader to run a command.',
              citations: ['README.md'],
              directive: true
            }
          ]
        })
      )
    )
    // There has to be somewhere to put this, or the only way to mention an
    // injection attempt would be to act on it.
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.brief.findings[0]?.directive).toBe(true)
  })
})

describe('checks against the watchlist entry', () => {
  it('passes a brief that matches its source and pin', () => {
    const parsed = researchBriefSchema.parse(brief())
    expect(checkBriefAgainstSource(parsed, SOURCE).ok).toBe(true)
  })

  it('refuses a brief that names a different source', () => {
    const parsed = researchBriefSchema.parse(brief({ sourceId: 'src-somewhere-else' }))
    const check = checkBriefAgainstSource(parsed, SOURCE)
    expect(check.ok).toBe(false)
    expect(check.reasons.join(' ')).toContain('src-somewhere-else')
  })

  it('refuses a brief citing a commit the watchlist did not pin', () => {
    const parsed = researchBriefSchema.parse(brief({ commit: 'deadbee' }))
    const check = checkBriefAgainstSource(parsed, SOURCE)
    expect(check.ok).toBe(false)
    expect(check.reasons.join(' ')).toContain('pinned at a1b2c3d')
  })

  it('accepts a full sha against a short pin, and the reverse', () => {
    // A human types the short form and a checkout reports the long one;
    // rejecting correct briefs over that would be a formatting opinion.
    const long = researchBriefSchema.parse(brief({ commit: 'a1b2c3d4e5f6a7b8c9d0' }))
    expect(checkBriefAgainstSource(long, SOURCE).ok).toBe(true)
    expect(checkBriefAgainstSource(long, { id: SOURCE.id, pin: 'a1b2c3d4e5f6a7b8c9d0' }).ok).toBe(
      true
    )
  })

  it('refuses when the source has no pin at all', () => {
    const parsed = researchBriefSchema.parse(brief())
    const check = checkBriefAgainstSource(parsed, { id: SOURCE.id, pin: null })
    expect(check.ok).toBe(false)
    expect(check.reasons.join(' ')).toContain('FR-13.2')
  })

  it('refuses applicability pointing at a finding that does not exist', () => {
    const parsed = researchBriefSchema.parse(
      brief({ applicability: [{ finding: 4, subsystem: 's', note: 'n', refs: [] }] })
    )
    const check = checkBriefAgainstSource(parsed, SOURCE)
    expect(check.ok).toBe(false)
    expect(check.reasons.join(' ')).toContain('finding 4 does not exist')
  })

  it('refuses a candidate built on a finding that does not exist', () => {
    const parsed = researchBriefSchema.parse(
      brief({ candidates: [{ what: 'do a thing', fromFindings: [7] }] })
    )
    expect(checkBriefAgainstSource(parsed, SOURCE).ok).toBe(false)
  })

  it('reports every problem at once', () => {
    const parsed = researchBriefSchema.parse(
      brief({
        sourceId: 'src-elsewhere',
        commit: 'deadbee',
        applicability: [{ finding: 9, subsystem: 's', note: 'n', refs: [] }]
      })
    )
    expect(checkBriefAgainstSource(parsed, SOURCE).reasons.length).toBe(3)
  })
})

describe('the archived markdown', () => {
  const parsed = researchBriefSchema.parse(
    brief({
      findings: [
        {
          what: 'Planning is separate from dispatch.',
          citations: ['src/loop/turn.ts'],
          directive: false
        },
        { what: 'The README instructs its reader.', citations: ['README.md'], directive: true }
      ],
      applicability: [
        { finding: 1, subsystem: 'SDD §7.1', note: 'Matches ours.', refs: ['log#12'] },
        { finding: 2, subsystem: 'NFR-17', note: 'Anticipated.', refs: [] }
      ]
    })
  )
  const text = renderBrief('RB-007', parsed, 'https://example.invalid/fixture/pinned')

  it('carries the source, the commit and the question', () => {
    expect(text).toContain('# RB-007 — Turn structure')
    expect(text).toContain('https://example.invalid/fixture/pinned')
    expect(text).toContain('a1b2c3d')
    expect(text).toContain('**Question:**')
  })

  it('writes the README.md sections, in order (FR-13.7 keeps both eras alike)', () => {
    const order = [
      '## Findings',
      '## Applicability',
      '## Candidate improvements',
      '## License note'
    ]
    const positions = order.map((heading) => text.indexOf(heading))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('prints each finding with its citations', () => {
    expect(text).toContain('`src/loop/turn.ts`')
    expect(text).toContain('Cites:')
  })

  it('marks a reported instruction loudly (NFR-17)', () => {
    // A reader skimming the archive should see that the source tried to give an
    // instruction and that the company wrote it down instead of following it.
    expect(text).toContain('reported, not followed (NFR-17)')
  })

  it('says so when a study found nothing worth changing', () => {
    const none = renderBrief('RB-008', researchBriefSchema.parse(brief({ candidates: [] })), 'u')
    expect(none).toContain('A study that found nothing worth changing says so.')
  })
})

describe('archive filenames', () => {
  it.each([
    ['RB-001', 'Turn structure', 'RB-001-turn-structure.md'],
    [
      'RB-012',
      'Munder Difflin: orchestration & autonomy',
      'RB-012-munder-difflin-orchestration-autonomy.md'
    ],
    ['RB-003', '???', 'RB-003-brief.md']
  ])('names %s / %s', (id, title, expected) => {
    expect(briefFileName(id, title)).toBe(expected)
  })
})

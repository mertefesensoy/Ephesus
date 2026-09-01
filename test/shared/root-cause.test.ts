import { describe, expect, it } from 'vitest'
import {
  ROOT_CAUSE_SCHEMA_VERSION,
  ROOT_CAUSE_VERDICTS,
  checkVerdict,
  formatCitations,
  parseRootCauseVerdict,
  rootCauseSchema,
  sourceCitationSchema,
  type RootCause,
  type RootCauseVerdict
} from '../../src/shared/root-cause'

/**
 * Root-cause claims and the verdicts on them (FR-9.2, UC-09 — the second
 * reconciliation gap from the 2026-09-01 live run).
 *
 * The fixture is that run's own defect, kept deliberately: the on-call agent
 * claimed `ArcLinker.run()` had no injectable clock, and the file's line 122
 * reads `async def run(self, run_id: str, now: datetime | None = None)`. Every
 * rule here is asserted against the shape of the claim that actually got past
 * the company, not against an invented one.
 *
 * What is NOT asserted, because it cannot be: that a quote really appears in a
 * file. The harness has not read the repository and must not (ADR-0005). These
 * are DISCIPLINE rules — is the claim citeable, did the verdict bring evidence,
 * did it read what the claim rests on — and the truth is the verifier's finding.
 */

const CLAIM: RootCause = {
  claim: 'ArcLinker.run() has no injectable clock and always calls live utcnow()',
  cites: [
    {
      file: 'musahit/arcs/linker.py',
      line: 122,
      quote: 'async def run(self, run_id: str)'
    }
  ]
}

function verdict(over: Partial<RootCauseVerdict> = {}): RootCauseVerdict {
  return {
    schemaVersion: ROOT_CAUSE_SCHEMA_VERSION,
    kind: 'root-cause-verdict',
    incident: 'mertefesensoy/MUSAHIT#ci-run:33440874791',
    verdict: 'refute',
    because: 'the signature already takes `now`, and threads it into _load_arc_cache(now)',
    read: [
      {
        file: 'musahit/arcs/linker.py',
        line: 122,
        quote: 'async def run(self, run_id: str, now: datetime | None = None)'
      }
    ],
    ...over
  }
}

describe('a root cause that cannot be checked cannot be written down', () => {
  it('refuses a claim with no citations at all', () => {
    // The strongest available form of "an unciteable claim is refused": the
    // shape does not exist. A claim accepted and marked unverifiable reads
    // exactly like a verified one three weeks later.
    expect(
      rootCauseSchema.safeParse({
        claim: 'the clock is not injectable',
        cites: []
      }).success
    ).toBe(false)
  })

  it('refuses a citation with no quoted text', () => {
    // The quote is the load-bearing field. "linker.py:122 is the problem" is
    // unfalsifiable; the LINE's text is what a second reader holds against the
    // file and watches fail.
    expect(
      sourceCitationSchema.safeParse({
        file: 'musahit/arcs/linker.py',
        line: 122
      }).success
    ).toBe(false)
  })

  it('refuses a citation with no line', () => {
    expect(
      sourceCitationSchema.safeParse({
        file: 'musahit/arcs/linker.py',
        quote: 'async def run(self, run_id: str)'
      }).success
    ).toBe(false)
  })

  it('accepts the claim from the run that made this necessary', () => {
    expect(rootCauseSchema.safeParse(CLAIM).success).toBe(true)
  })
})

describe('parsing a verdict, without ever defaulting one', () => {
  it('reads a well-formed verdict', () => {
    const parsed = parseRootCauseVerdict(JSON.stringify(verdict()))
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.verdict.verdict).toBe('refute')
  })

  it('refuses a body that is not JSON, and says so', () => {
    const parsed = parseRootCauseVerdict('I read the file and it looks fine to me')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? [] : parsed.reasons.join(' ')).toContain('not JSON')
  })

  it('refuses an unreadable verdict rather than calling it "cannot-tell"', () => {
    const missing: Record<string, unknown> = { ...verdict() }
    delete missing.verdict
    const parsed = parseRootCauseVerdict(JSON.stringify(missing))
    // "The answer was unreadable" and "the verifier could not tell" are
    // different facts. Collapsing them would put a conclusion in the log that
    // nobody reached — the same silent-default failure a missing severity has.
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? [] : parsed.reasons.join(' ')).toContain('verdict')
  })

  it('refuses a verdict outside the three answers', () => {
    const parsed = parseRootCauseVerdict(JSON.stringify(verdict({ verdict: 'probably' as never })))
    expect(parsed.ok).toBe(false)
  })

  it('offers exactly three answers, one of which is an honest failure', () => {
    expect([...ROOT_CAUSE_VERDICTS].sort()).toEqual(['agree', 'cannot-tell', 'refute'])
  })
})

describe('the verifier is held to the claimant’s own rule', () => {
  it('refuses a refutation that quotes nothing', () => {
    const check = checkVerdict(verdict({ read: [] }), CLAIM)
    // An unevidenced "wrong" is worth no more than the unevidenced claim it
    // disputes, and it is more dangerous: a verdict is the answer that gets
    // believed.
    expect(check.ok).toBe(false)
    expect(check.reasons.join(' ')).toContain('must quote what it read')
  })

  it('refuses an agreement that quotes nothing', () => {
    const check = checkVerdict(verdict({ verdict: 'agree', read: [] }), CLAIM)
    expect(check.ok).toBe(false)
  })

  it('asks nothing of "cannot-tell" but the reason the schema already demands', () => {
    const check = checkVerdict(verdict({ verdict: 'cannot-tell', read: [] }), CLAIM)
    // The honest answer must stay cheap, or a verifier that could not open the
    // file will invent a reading to justify itself.
    expect(check.ok).toBe(true)
  })

  it('refuses a verdict that read somewhere else entirely', () => {
    const check = checkVerdict(
      verdict({
        read: [
          {
            file: 'musahit/api/routes.py',
            line: 8,
            quote: 'from fastapi import'
          }
        ]
      }),
      CLAIM
    )
    expect(check.ok).toBe(false)
    expect(check.reasons.join(' ')).toContain('musahit/arcs/linker.py')
  })

  it('accepts a verdict that read the cited file and more besides', () => {
    // The rule is an OVERLAP, not an equality: a refutation often lives one
    // call site over, and demanding that the verifier read nothing else would
    // forbid the most useful kind of refutation there is.
    const check = checkVerdict(
      verdict({
        read: [
          ...verdict().read,
          {
            file: 'musahit/arcs/cache.py',
            line: 40,
            quote: 'def _load_arc_cache(now)'
          }
        ]
      }),
      CLAIM
    )
    expect(check.ok).toBe(true)
  })

  it('treats a path written with the other separator or the other case as the same file', () => {
    // A transcription slip is not a different claim. Refusing it would teach
    // agents to fight the checker rather than read the source.
    const check = checkVerdict(
      verdict({
        read: [
          {
            file: 'Musahit\\arcs\\linker.py',
            line: 122,
            quote: 'now: datetime | None = None'
          }
        ]
      }),
      CLAIM
    )
    expect(check.ok).toBe(true)
  })

  it('does not judge whether the quote is really on the line', () => {
    // The harness has not read the repository. A verdict quoting text that is
    // nowhere near line 122 passes this check, because catching that is the
    // VERIFIER's job and pretending otherwise would be the confident wrongness
    // this whole path exists to catch, one level up.
    const check = checkVerdict(
      verdict({
        read: [
          {
            file: 'musahit/arcs/linker.py',
            line: 122,
            quote: 'this text is not in the file'
          }
        ]
      }),
      CLAIM
    )
    expect(check.ok).toBe(true)
  })
})

describe('citations reach a prompt as data, never as prose', () => {
  it('renders one line per citation, file, line and text', () => {
    expect(formatCitations(CLAIM.cites)).toBe(
      '- musahit/arcs/linker.py:122 — async def run(self, run_id: str)'
    )
  })

  it('says "(none)" rather than an empty string', () => {
    expect(formatCitations([])).toBe('(none)')
  })
})

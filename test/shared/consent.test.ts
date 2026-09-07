import { describe, expect, it } from 'vitest'
import {
  CONSENT_TERMS_VERSION,
  consentRecordSchema,
  consentSentences,
  decideConsent,
  everyPhrase,
  type ConsentDisclosure
} from '../../src/shared/consent'
import { configSchema, defaultConfig, parseConfig } from '../../src/shared/config'

/**
 * The consent predicate (DD-6, M8.12), driven in all four directions the
 * package names: absent, stale, granted, corrupt.
 *
 * The direction that matters is ABSENT. `ensureHarnessHome` seeds a file only
 * when it is missing, so no existing install will ever be given a consent
 * record by the harness — and a predicate that read `undefined` as "granted"
 * would be a gate that refuses only on machines nobody has.
 */

const GRANTED = { grantedAt: '2026-09-07T21:00:00.000Z', terms: CONSENT_TERMS_VERSION }

describe('decideConsent', () => {
  it('refuses when there is no record at all — absent means ASK', () => {
    const verdict = decideConsent(undefined)
    expect(verdict.mayStartWork).toBe(false)
    expect(verdict.state).toBe('never-asked')
    // A refusal must teach the rule: the reason names the two things withheld.
    expect(verdict.because).toContain('hires nobody')
    expect(verdict.because).toContain('arms no schedule')
  })

  it('allows when a grant covers the terms this build ships', () => {
    const verdict = decideConsent(GRANTED)
    expect(verdict.mayStartWork).toBe(true)
    expect(verdict.state).toBe('granted')
    expect(verdict.because).toContain(GRANTED.grantedAt)
  })

  it('refuses a grant made against an older disclosure, and says which', () => {
    const verdict = decideConsent({ grantedAt: GRANTED.grantedAt, terms: 1 }, 2)
    expect(verdict.mayStartWork).toBe(false)
    expect(verdict.state).toBe('stale-terms')
    expect(verdict.because).toContain('v1')
    expect(verdict.because).toContain('v2')
  })

  it('allows a grant made against a NEWER disclosure than this build asks about', () => {
    // A downgrade, not a widening: the Architect consented to more than this
    // build does. Refusing would ask them to re-consent to a subset, which is
    // an interrogation rather than a safeguard.
    expect(decideConsent({ grantedAt: GRANTED.grantedAt, terms: 9 }, 2).mayStartWork).toBe(true)
  })

  it('is exactly one boolean: no record shape reads as granted without a grant', () => {
    // The mutation this pins: flipping `mayStartWork` on either refusal branch,
    // or making `terms <` a `>`, all show up here.
    const outcomes = [
      decideConsent(undefined, 1),
      decideConsent({ grantedAt: GRANTED.grantedAt, terms: 1 }, 2),
      decideConsent({ grantedAt: GRANTED.grantedAt, terms: 2 }, 2)
    ].map((v) => v.mayStartWork)
    expect(outcomes).toEqual([false, false, true])
  })
})

describe('the record is durable state, so the schema refuses junk', () => {
  it('demands both fields', () => {
    expect(consentRecordSchema.safeParse({ grantedAt: 'x' }).success).toBe(false)
    expect(consentRecordSchema.safeParse({ terms: 1 }).success).toBe(false)
  })

  it('refuses an unknown field rather than dropping it', () => {
    expect(consentRecordSchema.safeParse({ ...GRANTED, coversEverything: true }).success).toBe(
      false
    )
  })

  it('refuses a fractional or zero terms version', () => {
    expect(consentRecordSchema.safeParse({ ...GRANTED, terms: 1.5 }).success).toBe(false)
    expect(consentRecordSchema.safeParse({ ...GRANTED, terms: 0 }).success).toBe(false)
  })
})

describe('a corrupt config.json cannot grant consent', () => {
  it('leaves the whole config invalid, and the default carries no consent', () => {
    // The shipped failure path: `configSchema` is strict, so a malformed
    // consent block invalidates the file; `home.ts` then runs on `defaultConfig`
    // and surfaces a warning. What must never happen is the parse succeeding
    // with a half-read record.
    expect(() => parseConfig({ schemaVersion: 1, consent: { grantedAt: 12 } })).toThrow()
    expect(() => parseConfig({ schemaVersion: 1, consent: true })).toThrow()
    expect(defaultConfig.consent).toBeUndefined()
    expect(decideConsent(defaultConfig.consent).mayStartWork).toBe(false)
  })

  it('accepts a config that predates the field, unchanged', () => {
    // The upgrade path in miniature: every home written before M8.12 looks
    // exactly like this, and it must stay VALID (so the app boots) while
    // reading as un-consented (so it does not start).
    const old = configSchema.parse({ schemaVersion: 1, mode: 'directed' })
    expect(old.consent).toBeUndefined()
    expect(decideConsent(old.consent).mayStartWork).toBe(false)
  })

  it('round-trips a grant through the real config schema', () => {
    const saved = configSchema.parse({ schemaVersion: 1, consent: GRANTED })
    expect(decideConsent(saved.consent).mayStartWork).toBe(true)
  })
})

describe('the disclosure says what actually happens', () => {
  const full: ConsentDisclosure = {
    hire: { agentId: 'artemis', engine: 'claude' },
    triggers: [
      { id: 'standup', everyMs: 30 * 60 * 1000 },
      { id: 'retro', everyMs: 24 * 60 * 60 * 1000 }
    ],
    dailyCeiling: null
  }

  it('names the agent, the engine, and whose money it is', () => {
    const said = consentSentences(full).join(' ')
    expect(said).toContain('artemis')
    expect(said).toContain('claude')
    expect(said).toContain('YOUR subscription')
  })

  it('says OUT LOUD that spending is unbudgeted when no ceiling is set', () => {
    // The direction that would be easy to get wrong: omitting the line when
    // there is no limit makes the most permissive configuration the quietest.
    expect(consentSentences(full).join(' ')).toContain('unbudgeted')
  })

  it('states the ceiling when there is one, and stops saying unbudgeted', () => {
    const said = consentSentences({ ...full, dailyCeiling: 200_000 }).join(' ')
    expect(said).toContain('200,000')
    expect(said).not.toContain('unbudgeted')
  })

  it('names every cadence and its interval', () => {
    const said = consentSentences(full).join(' ')
    expect(said).toContain('standup (every 30 minutes)')
    expect(said).toContain('retro (every 1 day)')
  })

  it('does not promise a hire when no engine is registered', () => {
    const said = consentSentences({ ...full, hire: null }).join(' ')
    expect(said).toContain('No orchestrator would be hired')
    expect(said).not.toContain('is hired on the')
  })

  it('does not promise schedules when nothing is armed', () => {
    expect(consentSentences({ ...full, triggers: [] }).join(' ')).toContain(
      'No scheduled work is armed'
    )
  })
})

describe('everyPhrase', () => {
  it('rounds to the unit a person reads', () => {
    expect(everyPhrase(60_000)).toBe('every 1 minute')
    expect(everyPhrase(30 * 60_000)).toBe('every 30 minutes')
    expect(everyPhrase(60 * 60_000)).toBe('every 1 hour')
    expect(everyPhrase(6 * 60 * 60_000)).toBe('every 6 hours')
    expect(everyPhrase(24 * 60 * 60_000)).toBe('every 1 day')
    expect(everyPhrase(7 * 24 * 60 * 60_000)).toBe('every 7 days')
  })

  it('does not claim a sub-minute cadence is "every 0 minutes"', () => {
    expect(everyPhrase(1_000)).toBe('more than once a minute')
  })
})

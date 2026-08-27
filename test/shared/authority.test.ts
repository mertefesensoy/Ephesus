import { describe, expect, it } from 'vitest'
import {
  ANY_DOMAIN,
  AUTHORITY_CLASSES,
  AUTHORITY_SCHEMA_VERSION,
  mayDecide,
  noAuthority,
  parseAuthorityTable,
  type AuthorityRule,
  type AuthorityTable
} from '../../src/shared/authority'

/**
 * The delegated-authority table (FR-5.5, ADR-0005).
 *
 * The property under test throughout is that **the default is escalation**. An
 * unnecessary escalation costs the Architect a notification; a decision taken
 * for them that they never see costs them the audit trail FR-5.5 promises. So
 * every ambiguity here — no table, no matching grant, an unknown domain, a
 * spend with no amount — resolves the same way.
 */

const CTX = { orchestratorId: 'agent.artemis', at: '2026-08-27T09:00:00.000Z' }

function table(...grants: AuthorityRule[]): AuthorityTable {
  return { schemaVersion: AUTHORITY_SCHEMA_VERSION, grants }
}

describe('the table is validated like any other file the harness reads', () => {
  it('accepts a well-formed table', () => {
    const parsed = parseAuthorityTable({
      schemaVersion: 1,
      grants: [{ class: 'memo', domains: ['test-code'] }]
    })
    expect(parsed.ok).toBe(true)
  })

  it('carries a schemaVersion (invariant §9)', () => {
    expect(parseAuthorityTable({ grants: [] }).ok).toBe(false)
    expect(parseAuthorityTable({ schemaVersion: 2, grants: [] }).ok).toBe(false)
  })

  it('names the classes that can be delegated', () => {
    expect([...AUTHORITY_CLASSES]).toEqual(['route', 'task', 'gate', 'spend', 'memo'])
  })

  it('refuses a class it does not know', () => {
    expect(parseAuthorityTable(table({ class: 'deploy', domains: ['*'] } as never)).ok).toBe(false)
  })

  it('refuses a grant with no domains rather than reading it as “all”', () => {
    // FR-5.5's authority is per domain. A rule that forgot its domains should
    // grant nothing, not everything.
    expect(
      parseAuthorityTable({ schemaVersion: 1, grants: [{ class: 'memo', domains: [] }] }).ok
    ).toBe(false)
    expect(parseAuthorityTable({ schemaVersion: 1, grants: [{ class: 'memo' }] }).ok).toBe(false)
  })

  it('refuses a spend grant with no ceiling', () => {
    const parsed = parseAuthorityTable(table({ class: 'spend', domains: ['*'] }))
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.reason).toMatch(/maxSpendTokens/)
  })

  it('accepts a spend grant that names its ceiling', () => {
    expect(
      parseAuthorityTable(table({ class: 'spend', domains: ['ci'], maxSpendTokens: 50_000 })).ok
    ).toBe(true)
  })

  it('refuses a ceiling on a class that has no spend to cap', () => {
    // A `maxSpendTokens` on a memo grant reads as a limit and is not one.
    const parsed = parseAuthorityTable(
      table({ class: 'memo', domains: ['docs'], maxSpendTokens: 10 })
    )
    expect(parsed.ok).toBe(false)
  })

  it('refuses two grants covering the same class and domain', () => {
    const parsed = parseAuthorityTable(
      table({ class: 'memo', domains: ['docs'] }, { class: 'memo', domains: ['docs'] })
    )
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.reason).toMatch(/same class and domain/)
  })

  it('refuses an unknown field rather than ignoring it', () => {
    expect(parseAuthorityTable({ schemaVersion: 1, grants: [], mode: 'wide' }).ok).toBe(false)
    expect(
      parseAuthorityTable(table({ class: 'memo', domains: ['docs'], always: true } as never)).ok
    ).toBe(false)
  })

  it.each([['Test-Code'], ['test code'], ['../etc'], ['']])(
    'refuses %s as a domain tag',
    (domain) => {
      expect(parseAuthorityTable(table({ class: 'memo', domains: [domain] })).ok).toBe(false)
    }
  )

  it('reports where a table went wrong', () => {
    const parsed = parseAuthorityTable({ schemaVersion: 1, grants: [{ class: 'nope' }] })
    expect(parsed.ok ? '' : parsed.reason).toMatch(/grants\.0/)
  })
})

describe('nothing is delegated by default', () => {
  it('delegates nothing with an empty table', () => {
    for (const cls of AUTHORITY_CLASSES) {
      const verdict = mayDecide(noAuthority, { class: cls, domain: 'anything' }, CTX)
      expect(verdict.allowed).toBe(false)
    }
  })

  it('says why, so the escalation can carry a reason', () => {
    const verdict = mayDecide(noAuthority, { class: 'memo', domain: 'docs' }, CTX)
    expect(verdict.allowed ? '' : verdict.because).toMatch(/no delegated authority for memo\/docs/)
  })

  it('does not let a grant in one class leak into another', () => {
    const held = table({ class: 'memo', domains: [ANY_DOMAIN] })
    expect(mayDecide(held, { class: 'gate', domain: 'docs' }, CTX).allowed).toBe(false)
  })

  it('does not let a grant in one domain leak into another', () => {
    const held = table({ class: 'memo', domains: ['test-code'] })
    expect(mayDecide(held, { class: 'memo', domain: 'infra' }, CTX).allowed).toBe(false)
  })
})

describe('a grant lets her decide, and countersigns it (FR-5.5)', () => {
  it('allows the class and domain it names', () => {
    const held = table({ class: 'memo', domains: ['test-code'] })
    // FR-5.5's own example: "may approve memos touching test code".
    expect(mayDecide(held, { class: 'memo', domain: 'test-code' }, CTX).allowed).toBe(true)
  })

  it('returns the countersignature WITH the permission, never separately', () => {
    const held = table({ class: 'route', domains: ['*'] })
    const verdict = mayDecide(held, { class: 'route', domain: 'ci' }, CTX)
    // There is no code path that grants authority without leaving a record:
    // the permission IS the record.
    expect(verdict.allowed && verdict.countersignature).toMatchObject({
      by: 'agent.artemis',
      class: 'route',
      domain: 'ci',
      at: CTX.at,
      under: 'route:*'
    })
  })

  it('names the specific grant it relied on when a wildcard also matched', () => {
    const held = table({ class: 'memo', domains: ['*'] }, { class: 'memo', domains: ['test-code'] })
    const verdict = mayDecide(held, { class: 'memo', domain: 'test-code' }, CTX)
    // An audit has to be able to find the rule again, and the specific rule is
    // the one an Architect wrote to be specific about this domain.
    expect(verdict.allowed && verdict.countersignature.under).toBe('memo:test-code')
  })

  it('is pure — the same table and request always give the same verdict', () => {
    const held = table({ class: 'task', domains: ['docs'] })
    const once = mayDecide(held, { class: 'task', domain: 'docs' }, CTX)
    const again = mayDecide(held, { class: 'task', domain: 'docs' }, CTX)
    expect(once).toEqual(again)
  })
})

describe('spend is the class that costs money', () => {
  const held = table({ class: 'spend', domains: ['ci'], maxSpendTokens: 50_000 })

  it('allows a spend inside the ceiling', () => {
    expect(
      mayDecide(held, { class: 'spend', domain: 'ci', spendTokens: 10_000 }, CTX).allowed
    ).toBe(true)
  })

  it('allows a spend exactly at the ceiling', () => {
    expect(
      mayDecide(held, { class: 'spend', domain: 'ci', spendTokens: 50_000 }, CTX).allowed
    ).toBe(true)
  })

  it('refuses a spend over the ceiling, and says by how much', () => {
    const verdict = mayDecide(held, { class: 'spend', domain: 'ci', spendTokens: 50_001 }, CTX)
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed ? '' : verdict.because).toMatch(/exceeds the delegated ceiling of 50000/)
  })

  it('refuses a spend that names no amount', () => {
    // "How much?" unanswered is not a small spend; it is an unknown one.
    const verdict = mayDecide(held, { class: 'spend', domain: 'ci' }, CTX)
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed ? '' : verdict.because).toMatch(/names no amount/)
  })

  it('cannot be delegated by a table that skipped the schema', () => {
    // The schema refuses a capless spend grant; if one is constructed anyway,
    // `mayDecide` refuses it too rather than treating absent as unlimited.
    const forged = table({ class: 'spend', domains: ['*'] })
    const verdict = mayDecide(forged, { class: 'spend', domain: 'ci', spendTokens: 1 }, CTX)
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed ? '' : verdict.because).toMatch(/no ceiling/)
  })
})

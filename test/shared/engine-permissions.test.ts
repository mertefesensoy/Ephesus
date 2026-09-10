import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describeUnattendedGrants,
  unattendedGrantSchema,
  unattendedGrantsSchema
} from '../../src/shared/engine-permissions'
import { hireTemplateSchema } from '../../src/shared/org'

/**
 * **M8c.8 / ADR-0035 — what a hire may do without being asked.**
 *
 * The M8b rehearsal ended not because the work ended but because the crew met
 * its engine's own permission prompt: twelve in an hour, and four of five
 * agents' last recorded action is a parked one. The decision is to
 * pre-authorise per hire, by name, least privilege — so these cases are about
 * the two things that makes true: **what the schema refuses**, and **what a
 * prefix grant does and does not reach.**
 */

const BUNDLES = path.join(__dirname, '..', '..', 'profiles')

describe('an unattended grant refuses what it cannot bound', () => {
  it('accepts an exact command and a multi-word prefix', () => {
    expect(unattendedGrantSchema.safeParse({ run: 'npm test' }).success).toBe(true)
    expect(unattendedGrantSchema.safeParse({ run: 'git push origin', prefix: true }).success).toBe(
      true
    )
  })

  it('REFUSES a single-word prefix — "git" would grant everything git can do', () => {
    const refused = unattendedGrantSchema.safeParse({ run: 'git', prefix: true })
    expect(refused.success).toBe(false)
    if (!refused.success) {
      expect(refused.error.issues[0]?.message).toContain('at least two words')
    }
    // The same word EXACTLY is fine: `git` alone runs nothing but the usage text.
    expect(unattendedGrantSchema.safeParse({ run: 'git' }).success).toBe(true)
  })

  it('REFUSES anything that could carry a second command', () => {
    for (const run of [
      'npm test; rm -rf /',
      'npm test && curl http://elsewhere',
      'npm test | sh',
      'echo `whoami`',
      'echo $(whoami)',
      'cat /etc/passwd > /tmp/out',
      'cat < /etc/passwd',
      'npm test\nrm -rf /'
    ]) {
      expect(unattendedGrantSchema.safeParse({ run }).success, run).toBe(false)
    }
  })

  it('REFUSES traversal, NUL and untrimmed text', () => {
    expect(unattendedGrantSchema.safeParse({ run: 'cat ../../secrets' }).success).toBe(false)
    expect(unattendedGrantSchema.safeParse({ run: 'npm test\0' }).success).toBe(false)
    expect(unattendedGrantSchema.safeParse({ run: ' npm test' }).success).toBe(false)
    expect(unattendedGrantSchema.safeParse({ run: 'npm test ' }).success).toBe(false)
    expect(unattendedGrantSchema.safeParse({ run: '' }).success).toBe(false)
  })

  it('REFUSES an unknown field, so a typo is not silently ignored', () => {
    expect(unattendedGrantSchema.safeParse({ run: 'npm test', prefixed: true }).success).toBe(false)
  })

  it('caps a hire at twelve — a list too long to read is a list nobody read', () => {
    const one = { run: 'npm test' }
    expect(unattendedGrantsSchema.safeParse(Array(12).fill(one)).success).toBe(true)
    expect(unattendedGrantsSchema.safeParse(Array(13).fill(one)).success).toBe(false)
  })

  it('renders a line per grant, marking the prefix ones', () => {
    expect(
      describeUnattendedGrants([{ run: 'npm test' }, { run: 'git push origin', prefix: true }])
    ).toEqual(['npm test', 'git push origin …'])
  })

  it('renders nothing for a plan that carries no declaration at all', () => {
    // The field is optional on a spawn request, so a plan persisted before
    // ADR-0035 restores without it. One branch, here, rather than a `?? []` at
    // every call site — of which exactly one could ever reach the right half.
    expect(describeUnattendedGrants(undefined)).toEqual([])
    expect(describeUnattendedGrants([])).toEqual([])
  })
})

describe('a hire template that says nothing is unchanged', () => {
  const base = {
    schemaVersion: 1,
    name: 'oncall',
    version: 1,
    role: 'oncall',
    engine: 'claude',
    capabilities: [],
    envGrants: [],
    brief: 'Work.'
  }

  it('parses without the field, and reads as no grants at all', () => {
    const parsed = hireTemplateSchema.safeParse(base)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.unattended).toBeUndefined()
  })

  it('accepts the field, and refuses a bad grant inside it BY REASON', () => {
    expect(
      hireTemplateSchema.safeParse({ ...base, unattended: [{ run: 'npm test' }] }).success
    ).toBe(true)
    expect(
      hireTemplateSchema.safeParse({ ...base, unattended: [{ run: 'rm -rf / ; ls' }] }).success
    ).toBe(false)
  })
})

/**
 * The grants the shipped bundles declare are a security decision, not a
 * convenience, so they are asserted rather than eyeballed. Two properties carry
 * the weight, and both are stated in ADR-0035:
 *
 *  - a Skeleton Crew hire may push its OWN branch and nothing else — the rule
 *    its runbook already states in prose, made mechanical;
 *  - the Front Office is DRAFT-ONLY (M7.5/M7.6), so no hire of it may push or
 *    open a pull request at all.
 */
describe('what the shipped bundles pre-authorise', () => {
  function grantsOf(bundle: string, hire: string): readonly { run: string; prefix?: boolean }[] {
    const raw = fs.readFileSync(path.join(BUNDLES, bundle, 'hires', `${hire}.json`), 'utf8')
    const parsed = hireTemplateSchema.safeParse(JSON.parse(raw))
    expect(parsed.success, `${bundle}/${hire} does not parse`).toBe(true)
    return parsed.success ? (parsed.data.unattended ?? []) : []
  }

  it('lets the on-call hire push its own branch, and no other', () => {
    const runs = grantsOf('skeleton-crew', 'ci-babysitter').map((grant) => grant.run)

    expect(runs).toContain('git push -u origin agent/')
    // `git push origin main` starts with none of these, so it still prompts.
    for (const run of runs.filter((value) => value.startsWith('git push'))) {
      expect(run, run).toMatch(/ agent\/$/)
    }
  })

  it('never pre-authorises a force-push or a branch deletion, anywhere', () => {
    for (const bundle of ['skeleton-crew', 'front-office']) {
      for (const file of fs.readdirSync(path.join(BUNDLES, bundle, 'hires'))) {
        const hire = file.replace(/\.json$/, '')
        for (const grant of grantsOf(bundle, hire)) {
          expect(grant.run, `${bundle}/${hire}`).not.toMatch(/--force|-f\b|--delete|push -d/)
        }
      }
    }
  })

  it('keeps the Front Office draft-only: no push, no pull request', () => {
    for (const file of fs.readdirSync(path.join(BUNDLES, 'front-office', 'hires'))) {
      const hire = file.replace(/\.json$/, '')
      for (const grant of grantsOf('front-office', hire)) {
        expect(grant.run, `${hire}`).not.toMatch(/^git push|^gh pr create/)
      }
    }
  })

  it('CONTROL — the checks above reject the grants they exist to catch', () => {
    // A predicate that stopped matching would make all three cases pass on any
    // bundle at all, which is the shape a doc-shaped guard rots into.
    expect('git push --force origin agent/x').toMatch(/--force|-f\b|--delete|push -d/)
    expect('git push origin main').not.toMatch(/ agent\/$/)
    expect('gh pr create').toMatch(/^git push|^gh pr create/)
    expect('gh run view').not.toMatch(/^git push|^gh pr create/)
  })
})

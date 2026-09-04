import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureHarnessHome } from '../../src/main/home'
import { loadGatePolicy } from '../../src/main/watch/gates'
import {
  composeAutonomy,
  evaluateGate,
  gatePolicySchema,
  shippedGatePolicy,
  type GateKind
} from '../../src/shared/gates'
import { authorityTableSchema, shippedAuthority } from '../../src/shared/authority'
import { removeTempDir } from '../tmpdir'

/**
 * The setup cliff (M8.4) — four files the harness requires, creates itself, and
 * never mentions.
 *
 * The one that mattered most: with no `gate-policy.json` the ceiling was
 * `manual`, and autonomy composes stricter-wins, so the Skeleton Crew's own
 * `autonomous` declaration was clamped to `manual` on every install that has
 * ever existed. Every agent sat at a permission prompt nobody was there to
 * answer, unattended running was impossible out of the box, and nothing
 * anywhere said so.
 */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-setup-'))
  temps.push(dir)
  return dir
}

const read = (root: string, file: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

describe('the shipped config cannot drift from its schema', () => {
  it('parses as a gate policy', () => {
    // Written as a VALUE, not a JSON literal, so this is true by construction —
    // and asserted anyway, because the risk the package names is precisely an
    // example config that drifts from the schema it illustrates.
    expect(gatePolicySchema.safeParse(shippedGatePolicy).success).toBe(true)
  })

  it('parses as an authority table', () => {
    expect(authorityTableSchema.safeParse(shippedAuthority).success).toBe(true)
  })

  it('holds every irreversible class and delegates nothing that spends', () => {
    const byKind = new Map(shippedGatePolicy.rules.map((rule) => [rule.kind, rule.autonomy]))
    for (const kind of ['destructive', 'prod-facing', 'scope-change', 'outbound', 'spend']) {
      expect(byKind.get(kind as GateKind)).toBe('supervised')
    }
    expect(byKind.get('needs-human')).toBe('manual')
    // `tool-permission` is the engine's own prompt; `evaluateGate` refuses that
    // kind by construction, so a rule for it would describe nothing.
    expect(byKind.has('tool-permission')).toBe(false)
    // FR-5.5 names spend as what Artemis may NOT decide, and gates are the
    // Watch's question to a human.
    expect(shippedAuthority.grants.map((grant) => grant.class).sort()).toEqual([
      'memo',
      'route',
      'task'
    ])
  })

  it('ships a spend ceiling that a spend request is actually measured against', () => {
    // The number was never asserted, so it could be changed to anything —
    // including a value that makes every spend request fail — without a test
    // noticing. Asserted through `evaluateGate` rather than by reading the
    // field back, because the ceiling only means something if the evaluator
    // uses it: an uncapped spend rule permits NOTHING (`spend-cap`), so a
    // silent loss of this number is a company that cannot spend at all.
    const spend = shippedGatePolicy.rules.find((rule) => rule.kind === 'spend')
    expect(spend?.maxSpendTokens).toBe(200_000)

    const ask = (spendTokens: number): boolean =>
      evaluateGate(shippedGatePolicy, {
        agentId: 'agent.mason',
        kind: 'spend',
        channel: 'local',
        profileAutonomy: 'autonomous',
        spendTokens
      }).allow
    expect(ask(199_999)).toBe(true)
    expect(ask(200_000)).toBe(true)
    expect(ask(200_001)).toBe(false)
  })

  it('lets a profile’s own declaration govern, which is what B5 broke', () => {
    // The Skeleton Crew ships `autonomous` with its irreversible classes at
    // `supervised`. Under the old ceiling every one of these was `manual`.
    expect(composeAutonomy(shippedGatePolicy.autonomy, 'autonomous')).toBe('autonomous')
    expect(composeAutonomy(shippedGatePolicy.autonomy, 'supervised')).toBe('supervised')
    // And the ceiling still clamps: a profile cannot buy itself more than this.
    expect(composeAutonomy('supervised', 'autonomous')).toBe('supervised')
  })
})

describe('the harness home seeds what it requires', () => {
  it('writes both files on a fresh home and says which it created', () => {
    const root = home()
    const result = ensureHarnessHome(root)
    expect([...result.seeded].sort()).toEqual(['authority.json', 'gate-policy.json'])
    expect(read(root, 'gate-policy.json')).toEqual(shippedGatePolicy)
    expect(read(root, 'authority.json')).toEqual(shippedAuthority)
  })

  it('what it writes is what the loader reads back', () => {
    // The seeded file has to survive the round trip through the real loader,
    // or the company boots on deny-all with a file sitting right there.
    const root = home()
    ensureHarnessHome(root)
    const loaded = loadGatePolicy(path.join(root, 'gate-policy.json'))
    expect(loaded.warning).toBeNull()
    expect(loaded.policy.autonomy).toBe('autonomous')
  })

  it('never overwrites a file the Architect already has', () => {
    // `~/.ephesus/` is their copy. An existing file is theirs, whatever it says.
    const root = home()
    ensureHarnessHome(root)
    const mine = { schemaVersion: 1, autonomy: 'manual', rules: [] }
    fs.writeFileSync(path.join(root, 'gate-policy.json'), JSON.stringify(mine))

    const second = ensureHarnessHome(root)
    expect(second.seeded).toEqual([])
    expect(read(root, 'gate-policy.json')).toEqual(mine)
  })

  it('is idempotent, so a second boot reports nothing new', () => {
    const root = home()
    ensureHarnessHome(root)
    expect(ensureHarnessHome(root).seeded).toEqual([])
  })
})

describe('an absent policy is reported, not assumed', () => {
  it('names the consequence instead of falling back in silence', () => {
    // The old code returned deny-all with `warning: null`: the safest possible
    // policy and no way for anyone to discover it was in force.
    const root = home()
    const loaded = loadGatePolicy(path.join(root, 'gate-policy.json'))
    expect(loaded.policy.autonomy).toBe('manual')
    expect(loaded.warning).not.toBeNull()
    expect(loaded.warning).toContain('gate-policy.json is missing')
    // The consequence, not just the fact: what it costs is what the Architect
    // needs to read.
    expect(loaded.warning).toContain('clamped to manual')
  })

  it('still refuses a policy it cannot parse, and says why', () => {
    const root = home()
    fs.writeFileSync(path.join(root, 'gate-policy.json'), '{ not json')
    const loaded = loadGatePolicy(path.join(root, 'gate-policy.json'))
    expect(loaded.policy.autonomy).toBe('manual')
    expect(loaded.warning).toContain('unreadable')
  })

  it('holds everything when the file parses but is not a policy', () => {
    const root = home()
    fs.writeFileSync(path.join(root, 'gate-policy.json'), JSON.stringify({ autonomy: 'yes' }))
    const loaded = loadGatePolicy(path.join(root, 'gate-policy.json'))
    expect(loaded.policy).toEqual({ schemaVersion: 1, autonomy: 'manual', rules: [] })
    expect(loaded.warning).toContain('invalid')
  })
})

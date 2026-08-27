import { describe, expect, it } from 'vitest'
import {
  AUTONOMY_LEVELS,
  composeAutonomy,
  denyAllPolicy,
  evaluateGate,
  GATE_KINDS,
  GATE_SCHEMA_VERSION,
  gatePackagingSchema,
  openGateSchema,
  parseGatePolicy,
  repeatBackRequired,
  strictestRuleFor,
  checkVerdictChannel,
  type AutonomyLevel,
  type GateKind,
  type GatePolicy,
  type GateRule
} from '../../src/shared/gates'

/**
 * The gate policy (SDD §9, FR-11.1, ADR-0012) as pure functions. Two properties
 * are load-bearing enough to be asserted exhaustively rather than by example:
 * an unmatched action is always held, and composition can never widen what the
 * global policy allows.
 */

function policy(over: Partial<GatePolicy> = {}): GatePolicy {
  return { schemaVersion: GATE_SCHEMA_VERSION, autonomy: 'autonomous', rules: [], ...over }
}

function rule(over: Partial<GateRule> = {}): GateRule {
  return { kind: 'destructive', autonomy: 'autonomous', ...over }
}

describe('deny by default', () => {
  it.each(GATE_KINDS)('holds a %s action under the default policy', (kind: GateKind) => {
    // An Ephesus that has never been configured holds everything. This is the
    // direction FR-11.1 requires a default to fail in.
    expect(evaluateGate(denyAllPolicy, { kind, agentId: 'agent.mason' })).toEqual({
      allow: false,
      because: 'no-rule'
    })
  })

  it.each(GATE_KINDS)('holds a %s action a policy simply never mentions', (kind: GateKind) => {
    // The absence of a rule is a refusal — a policy file written today still
    // holds tomorrow's dangerous action.
    const other: GateKind = kind === 'destructive' ? 'spend' : 'destructive'
    const decision = evaluateGate(policy({ rules: [rule({ kind: other, maxSpendTokens: 1 })] }), {
      kind,
      agentId: 'agent.mason'
    })
    expect(decision.allow).toBe(false)
  })

  it('permits only what a rule explicitly allows', () => {
    const permitted = policy({ rules: [rule({ kind: 'destructive', autonomy: 'autonomous' })] })
    expect(evaluateGate(permitted, { kind: 'destructive', agentId: 'agent.mason' })).toEqual({
      allow: true,
      because: 'rule'
    })
  })
})

describe('stricter wins (ADR-0012)', () => {
  it.each(
    AUTONOMY_LEVELS.flatMap((a) =>
      AUTONOMY_LEVELS.map((b) => [a, b] as [AutonomyLevel, AutonomyLevel])
    )
  )('composing %s with %s never widens', (global, profile) => {
    const composed = composeAutonomy(global, profile)
    const rank = { manual: 0, supervised: 1, autonomous: 2 } as const
    // The whole property in one line: composition is a minimum, both ways round.
    expect(rank[composed]).toBe(Math.min(rank[global], rank[profile]))
  })

  it('a profile cannot loosen past the global ceiling', () => {
    const global = policy({
      autonomy: 'supervised',
      rules: [rule({ kind: 'destructive', autonomy: 'autonomous' })]
    })
    // The profile asks for `autonomous`; the global says `supervised`; the rule
    // needs `autonomous`. The action is held.
    expect(
      evaluateGate(global, {
        kind: 'destructive',
        agentId: 'agent.mason',
        profileAutonomy: 'autonomous'
      })
    ).toEqual({ allow: false, because: 'autonomy' })
  })

  it('a profile CAN tighten below the global ceiling', () => {
    const global = policy({
      autonomy: 'autonomous',
      rules: [rule({ kind: 'destructive', autonomy: 'supervised' })]
    })
    expect(evaluateGate(global, { kind: 'destructive', agentId: 'agent.mason' }).allow).toBe(true)
    expect(
      evaluateGate(global, {
        kind: 'destructive',
        agentId: 'agent.mason',
        profileAutonomy: 'manual'
      })
    ).toEqual({ allow: false, because: 'autonomy' })
  })
})

describe('spend caps (in TOKENS — the ledger reports no currency)', () => {
  const spendPolicy = (maxSpendTokens?: number): GatePolicy =>
    policy({
      rules: [
        maxSpendTokens === undefined
          ? rule({ kind: 'spend' })
          : rule({ kind: 'spend', maxSpendTokens })
      ]
    })

  it('permits spend under the cap', () => {
    expect(
      evaluateGate(spendPolicy(500), { kind: 'spend', agentId: 'agent.mason', spendTokens: 499 })
        .allow
    ).toBe(true)
  })

  it('permits spend exactly at the cap', () => {
    expect(
      evaluateGate(spendPolicy(500), { kind: 'spend', agentId: 'agent.mason', spendTokens: 500 })
        .allow
    ).toBe(true)
  })

  it('holds spend over the cap', () => {
    expect(
      evaluateGate(spendPolicy(500), { kind: 'spend', agentId: 'agent.mason', spendTokens: 501 })
    ).toEqual({ allow: false, because: 'spend-cap' })
  })

  it('holds a spend whose amount was not stated', () => {
    // An unquantified spend cannot be under any cap.
    expect(evaluateGate(spendPolicy(500), { kind: 'spend', agentId: 'agent.mason' })).toEqual({
      allow: false,
      because: 'spend-cap'
    })
  })

  it('holds spend under an uncapped spend rule', () => {
    // A spend rule with no cap is an allowance nobody actually wrote.
    expect(
      evaluateGate(spendPolicy(), { kind: 'spend', agentId: 'agent.mason', spendTokens: 1 })
    ).toEqual({ allow: false, because: 'spend-cap' })
  })
})

describe('source channel and repeat-back (NFR-9, the M6/M7 seams)', () => {
  it('defaults to local only', () => {
    const local = policy({ rules: [rule()] })
    expect(evaluateGate(local, { kind: 'destructive', agentId: 'a' }).allow).toBe(true)
    // Remote approval needs the bridge's authenticated channel to be permitted
    // explicitly — it is not implied by a local allowance (NFR-9).
    expect(evaluateGate(local, { kind: 'destructive', agentId: 'a', channel: 'remote' })).toEqual({
      allow: false,
      because: 'channel'
    })
  })

  it('permits a channel the rule names', () => {
    const remote = policy({ rules: [rule({ channels: ['local', 'remote'] })] })
    expect(
      evaluateGate(remote, { kind: 'destructive', agentId: 'a', channel: 'remote' }).allow
    ).toBe(true)
  })

  it('holds a voice approval of a destructive op until it is repeated back', () => {
    // NFR-9's exact clause, testable now with a scripted stub; the Herald plugs
    // into this same seam in M6 (Architect decision).
    const voice = policy({
      rules: [rule({ channels: ['local', 'voice'], requireRepeatBack: true })]
    })
    expect(evaluateGate(voice, { kind: 'destructive', agentId: 'a', channel: 'voice' })).toEqual({
      allow: false,
      because: 'repeat-back'
    })
    expect(
      evaluateGate(
        voice,
        { kind: 'destructive', agentId: 'a', channel: 'voice' },
        { repeatBackConfirmed: true }
      ).allow
    ).toBe(true)
  })

  it('does not demand repeat-back of a click at the keyboard', () => {
    const voice = policy({
      rules: [rule({ channels: ['local', 'voice'], requireRepeatBack: true })]
    })
    expect(evaluateGate(voice, { kind: 'destructive', agentId: 'a', channel: 'local' }).allow).toBe(
      true
    )
  })
})

describe('schemas', () => {
  it('refuses a policy at an unknown schema version', () => {
    expect(parseGatePolicy({ schemaVersion: 99, autonomy: 'manual', rules: [] }).ok).toBe(false)
  })

  it('refuses an unknown autonomy level and an unknown gate kind', () => {
    expect(parseGatePolicy({ ...denyAllPolicy, autonomy: 'yolo' }).ok).toBe(false)
    expect(
      parseGatePolicy({ ...denyAllPolicy, rules: [{ kind: 'whatever', autonomy: 'manual' }] }).ok
    ).toBe(false)
  })

  it('explains what it refused', () => {
    const parsed = parseGatePolicy({ schemaVersion: 1, autonomy: 'manual' })
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.reason).toContain('rules')
  })

  it('requires all four UC-08 packaging fields', () => {
    const full = {
      what: 'rm -rf build/',
      why: 'stale artifacts break the release',
      blastRadius: 'the build directory only; source untouched',
      rollback: 'rerun the build'
    }
    expect(gatePackagingSchema.safeParse(full).success).toBe(true)
    for (const field of Object.keys(full)) {
      const missing = { ...full }
      delete (missing as Record<string, unknown>)[field]
      expect(gatePackagingSchema.safeParse(missing).success).toBe(false)
    }
  })

  it('refuses an empty packaging field, so a gate cannot be filed blank', () => {
    expect(
      gatePackagingSchema.safeParse({ what: '', why: 'w', blastRadius: 'b', rollback: 'r' }).success
    ).toBe(false)
  })

  it('requires a well-shaped gate id', () => {
    const gate = {
      schemaVersion: GATE_SCHEMA_VERSION,
      id: 'g-2026-08-27t01-00-00-000z-ab12',
      kind: 'destructive',
      agentId: 'agent.mason',
      because: 'no-rule',
      channel: 'local',
      packaging: { what: 'w', why: 'y', blastRadius: 'b', rollback: 'r' },
      taskId: null,
      requiresRepeatBack: false,
      openedAt: '2026-08-27T01:00:00.000Z'
    }
    expect(openGateSchema.safeParse(gate).success).toBe(true)
    expect(openGateSchema.safeParse({ ...gate, id: 'not-a-gate-id' }).success).toBe(false)
  })
})

describe('a rule at `manual` permits nothing', () => {
  it.each(AUTONOMY_LEVELS)('holds under a global %s when the rule is manual', (global) => {
    // The file's own contract: "At `manual` a rule permits nothing — it exists
    // to describe the class." The first draft's rank comparison let manual ===
    // manual fall through to allow.
    const manualRule = policy({ autonomy: global, rules: [rule({ autonomy: 'manual' })] })
    expect(evaluateGate(manualRule, { kind: 'destructive', agentId: 'a' })).toEqual({
      allow: false,
      because: 'autonomy'
    })
  })

  it('holds when a profile composes the effective level down to manual', () => {
    // ADR-0012's tightening has to bottom out somewhere, and `manual` is it.
    const permissive = policy({ rules: [rule({ autonomy: 'autonomous' })] })
    expect(
      evaluateGate(permissive, {
        kind: 'destructive',
        agentId: 'a',
        profileAutonomy: 'manual'
      })
    ).toEqual({ allow: false, because: 'autonomy' })
  })
})

describe('the engine’s own permission prompt is never permittable', () => {
  it.each(AUTONOMY_LEVELS)('holds at %s, whatever the policy says', (autonomy) => {
    // "Allow" is not a meaningful verdict here: the harness has no action to
    // permit — the engine is blocked on a human. Letting the policy answer it
    // would silently restore the invisible stall the M1 carried item was about.
    const permissive = policy({
      autonomy: 'autonomous',
      rules: [rule({ kind: 'tool-permission', autonomy })]
    })
    expect(evaluateGate(permissive, { kind: 'tool-permission', agentId: 'a' }).allow).toBe(false)
  })
})

describe('duplicate rules cannot make array order decide', () => {
  it('refuses a policy with two rules for one kind', () => {
    expect(
      parseGatePolicy({
        schemaVersion: GATE_SCHEMA_VERSION,
        autonomy: 'autonomous',
        rules: [
          { kind: 'spend', autonomy: 'autonomous', maxSpendTokens: 10 },
          { kind: 'spend', autonomy: 'autonomous', maxSpendTokens: 1_000_000 }
        ]
      }).ok
    ).toBe(false)
  })

  it('takes the strictest when one slips through the schema', () => {
    // Belt and braces: the matcher never depends on which was written first.
    const loose = {
      kind: 'spend' as const,
      autonomy: 'autonomous' as const,
      maxSpendTokens: 1_000_000
    }
    const strict = { kind: 'spend' as const, autonomy: 'autonomous' as const, maxSpendTokens: 10 }
    for (const rules of [
      [loose, strict],
      [strict, loose]
    ]) {
      expect(strictestRuleFor(policy({ rules }), 'spend')?.maxSpendTokens).toBe(10)
    }
  })
})

describe('the verdict side is policed too (NFR-9)', () => {
  const remoteOk = policy({
    rules: [{ kind: 'needs-human', autonomy: 'supervised', channels: ['local', 'remote'] }]
  })

  it('always admits a click at the Architect’s own keyboard', () => {
    expect(checkVerdictChannel(denyAllPolicy, 'destructive', { channel: 'local' })).toEqual({
      ok: true
    })
  })

  it('refuses a remote approval the policy never admitted', () => {
    // A gate held under deny-by-default matched no rule by definition, so a
    // channel check only on the request side binds on nothing.
    expect(checkVerdictChannel(denyAllPolicy, 'destructive', { channel: 'remote' })).toEqual({
      ok: false,
      because: 'channel'
    })
  })

  it('admits a remote approval the policy opened to remote', () => {
    expect(checkVerdictChannel(remoteOk, 'needs-human', { channel: 'remote' }).ok).toBe(true)
  })

  it('always requires repeat-back for a destructive op approved by voice', () => {
    // NFR-9 names destructive ops specifically, and deny-by-default means
    // there is usually no rule to carry the flag.
    expect(repeatBackRequired(denyAllPolicy, 'destructive')).toBe(true)
    expect(checkVerdictChannel(denyAllPolicy, 'destructive', { channel: 'voice' })).toEqual({
      ok: false,
      because: 'channel'
    })
  })

  it('takes a voice approval once it is repeated back', () => {
    const voice = policy({
      rules: [
        {
          kind: 'destructive',
          autonomy: 'supervised',
          channels: ['local', 'voice'],
          requireRepeatBack: true
        }
      ]
    })
    expect(checkVerdictChannel(voice, 'destructive', { channel: 'voice' })).toEqual({
      ok: false,
      because: 'repeat-back'
    })
    expect(
      checkVerdictChannel(voice, 'destructive', { channel: 'voice', repeatBackConfirmed: true }).ok
    ).toBe(true)
  })
})

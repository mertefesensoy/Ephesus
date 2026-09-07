import { describe, expect, it } from 'vitest'
import {
  ENGINE_IDS,
  HOOK_SUPPORTS,
  HOOK_SUPPORT_RANK,
  LEGACY_HOOK_SUPPORTS,
  REFERENCE_ENGINE,
  engineIdSchema,
  hookSupportSchema,
  isReferenceEngine,
  parseEngineId,
  storedHookSupportSchema
} from '../../src/shared/engines'

describe('engine vocabulary (ADR-0009)', () => {
  it('carries exactly the ADR-0009 engine roster', () => {
    expect([...ENGINE_IDS]).toEqual(['claude', 'codex', 'gemini', 'grok', 'opencode', 'custom'])
  })

  it('carries exactly the ADR-0009 hook fidelity grades', () => {
    // ADR-0009 wrote the bottom grade as `pty-heuristic`; ADR-0024 §3 renamed
    // it to `none` because it named a mechanism nobody ever built. ADR-0009 is
    // accepted and append-only, so the rename lives in ADR-0024 rather than as
    // an edit to it — this line is where the two records are reconciled.
    expect([...HOOK_SUPPORTS]).toEqual(['native', 'wrapper', 'none'])
  })

  it('does not still speak the retired grade', () => {
    expect(hookSupportSchema.safeParse('pty-heuristic').success).toBe(false)
  })

  it('reads the retired grade out of a file it did not write', () => {
    // The migration, at the schema. See test/main/engine-honesty.test.ts for
    // what it costs when it is missing: an empty roster and one warning line.
    expect(storedHookSupportSchema.parse('pty-heuristic')).toBe('none')
  })

  it.each([...HOOK_SUPPORTS])('reads the current grade %s unchanged', (grade) => {
    expect(storedHookSupportSchema.parse(grade)).toBe(grade)
  })

  it('does not widen the read vocabulary to anything else', () => {
    // A preprocess that passed strings through would turn a corrupt roster into
    // a silently accepted one, which is the opposite of what it is for.
    for (const raw of ['tty-guesswork', 'NATIVE', '', 7, null, {}]) {
      expect(storedHookSupportSchema.safeParse(raw).success).toBe(false)
    }
  })

  it('maps every retired grade to one that still exists', () => {
    for (const [retired, became] of Object.entries(LEGACY_HOOK_SUPPORTS)) {
      expect(HOOK_SUPPORTS).not.toContain(retired)
      expect(HOOK_SUPPORTS).toContain(became)
    }
  })

  it.each(ENGINE_IDS)('accepts the known engine id %s', (id) => {
    expect(engineIdSchema.parse(id)).toBe(id)
    expect(parseEngineId(id)).toBe(id)
  })

  it.each(HOOK_SUPPORTS)('accepts the known hook grade %s', (grade) => {
    expect(hookSupportSchema.parse(grade)).toBe(grade)
  })

  const rejected: readonly [string, unknown][] = [
    ['unknown engine name', 'copilot'],
    ['empty string', ''],
    ['wrong case', 'Claude'],
    ['number', 1],
    ['null', null],
    ['undefined', undefined],
    ['object', { id: 'claude' }]
  ]

  it.each(rejected)('rejects %s without throwing', (_label, raw) => {
    expect(parseEngineId(raw)).toBeNull()
    expect(engineIdSchema.safeParse(raw).success).toBe(false)
  })

  it('ranks fidelity native > wrapper > none', () => {
    expect(HOOK_SUPPORT_RANK.native).toBeGreaterThan(HOOK_SUPPORT_RANK.wrapper)
    expect(HOOK_SUPPORT_RANK.wrapper).toBeGreaterThan(HOOK_SUPPORT_RANK.none)
  })

  it('ranks every declared grade (no grade is unrankable)', () => {
    for (const grade of HOOK_SUPPORTS) {
      expect(typeof HOOK_SUPPORT_RANK[grade]).toBe('number')
    }
  })
})

describe('the engine this build ships (ADR-0024)', () => {
  it('is claude, and is a member of the roster', () => {
    expect(REFERENCE_ENGINE).toBe('claude')
    expect(ENGINE_IDS).toContain(REFERENCE_ENGINE)
  })

  it('accepts the reference engine', () => {
    expect(isReferenceEngine(REFERENCE_ENGINE)).toBe(true)
  })

  it.each(ENGINE_IDS.filter((id) => id !== 'claude'))('refuses %s', (id) => {
    // Including `grok` and `opencode`, which have never had an adapter at all.
    // They stay in ENGINE_IDS because that roster is ADR-0009's seam vocabulary
    // rather than a shipping list (DECISIONS-LOG 2026-09-07, M8.11 D3) — this
    // is the check that makes keeping them honest rather than a lie.
    expect(isReferenceEngine(id)).toBe(false)
  })

  it.each(['', 'Claude', ' claude', 'claude-code', 'copilot'])(
    'refuses the near miss %j rather than guessing at it',
    (raw) => {
      // A hire TEMPLATE types `engine` as a plain string, so this predicate is
      // the last thing between a typo and a spawn; a lenient match here would
      // hand `claude-code` an adapter that is not there.
      expect(isReferenceEngine(raw)).toBe(false)
    }
  )
})

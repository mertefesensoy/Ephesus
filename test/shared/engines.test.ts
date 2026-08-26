import { describe, expect, it } from 'vitest'
import {
  ENGINE_IDS,
  HOOK_SUPPORTS,
  HOOK_SUPPORT_RANK,
  engineIdSchema,
  hookSupportSchema,
  parseEngineId
} from '../../src/shared/engines'

describe('engine vocabulary (ADR-0009)', () => {
  it('carries exactly the ADR-0009 engine roster', () => {
    expect([...ENGINE_IDS]).toEqual(['claude', 'codex', 'gemini', 'grok', 'opencode', 'custom'])
  })

  it('carries exactly the ADR-0009 hook fidelity grades', () => {
    expect([...HOOK_SUPPORTS]).toEqual(['native', 'wrapper', 'pty-heuristic'])
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

  it('ranks fidelity native > wrapper > pty-heuristic', () => {
    expect(HOOK_SUPPORT_RANK.native).toBeGreaterThan(HOOK_SUPPORT_RANK.wrapper)
    expect(HOOK_SUPPORT_RANK.wrapper).toBeGreaterThan(HOOK_SUPPORT_RANK['pty-heuristic'])
  })

  it('ranks every declared grade (no grade is unrankable)', () => {
    for (const grade of HOOK_SUPPORTS) {
      expect(typeof HOOK_SUPPORT_RANK[grade]).toBe('number')
    }
  })
})

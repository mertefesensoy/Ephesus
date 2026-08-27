import { describe, expect, it } from 'vitest'
import {
  BLOCK_CAP_ENV,
  DEFAULT_BLOCK_CAP,
  PATHOLOGY_SIGNAL_AT,
  blockCapFromEnv,
  decideStop,
  isPathological,
  type StopContext
} from '../../src/shared/autonomy'

/**
 * ADR-0013's three mandatory guards, as a table. R2 ("Stop-hook loop pathology
 * burns budget overnight") is the reason these are asserted individually AND in
 * combination: a guard that only works when the others are absent is not a
 * guard.
 */

const idle: StopContext = {
  stopHookActive: false,
  blocksThisSession: 0,
  pendingMail: 0,
  pendingTasks: 0
}

describe('guard 1 — stop_hook_active is never re-blocked', () => {
  it('lets the turn end even with mail waiting', () => {
    expect(decideStop({ ...idle, stopHookActive: true, pendingMail: 5 })).toEqual({
      kind: 'continue',
      because: 'stop-hook-active'
    })
  })

  it('wins over every other reason to block', () => {
    expect(
      decideStop({ ...idle, stopHookActive: true, pendingMail: 9, pendingTasks: 9 }).kind
    ).toBe('continue')
  })
})

describe('guard 2 — the hard block cap', () => {
  it('blocks below the cap', () => {
    const decision = decideStop({
      ...idle,
      blocksThisSession: DEFAULT_BLOCK_CAP - 1,
      pendingMail: 1
    })
    expect(decision.kind).toBe('block')
  })

  it('stops blocking AT the cap, even with work still pending', () => {
    const decision = decideStop({ ...idle, blocksThisSession: DEFAULT_BLOCK_CAP, pendingMail: 1 })
    expect(decision).toEqual({ kind: 'continue', because: 'block-cap-reached' })
  })

  it('stays stopped above the cap', () => {
    expect(
      decideStop({ ...idle, blocksThisSession: DEFAULT_BLOCK_CAP + 50, pendingMail: 3 }).kind
    ).toBe('continue')
  })

  it('honours a per-spawn cap', () => {
    expect(decideStop({ ...idle, blocksThisSession: 2, blockCap: 3, pendingMail: 1 }).kind).toBe(
      'block'
    )
    expect(decideStop({ ...idle, blocksThisSession: 3, blockCap: 3, pendingMail: 1 }).kind).toBe(
      'continue'
    )
  })

  it('caps the loop even when the engine never reports stop_hook_active', () => {
    // The backstop exists precisely for an engine whose flag we cannot trust.
    let blocks = 0
    for (let turn = 0; turn < 100; turn += 1) {
      const decision = decideStop({ ...idle, blocksThisSession: blocks, pendingMail: 1 })
      if (decision.kind === 'block') blocks += 1
      else break
    }
    expect(blocks).toBe(DEFAULT_BLOCK_CAP)
  })
})

describe('guard 3 — nothing pending ends the turn', () => {
  it('continues when the inbox and the ledger are both empty', () => {
    expect(decideStop(idle)).toEqual({ kind: 'continue', because: 'nothing-pending' })
  })

  it('blocks on unread mail', () => {
    expect(decideStop({ ...idle, pendingMail: 2 })).toEqual({
      kind: 'block',
      pendingMail: 2,
      pendingTasks: 0
    })
  })

  it('blocks on an unfinished task even with an empty inbox', () => {
    expect(decideStop({ ...idle, pendingTasks: 1 })).toEqual({
      kind: 'block',
      pendingMail: 0,
      pendingTasks: 1
    })
  })

  it('returns facts, never prose — the reason is a prompt surface', () => {
    const decision = decideStop({ ...idle, pendingMail: 3, pendingTasks: 1 })
    expect(decision).toEqual({ kind: 'block', pendingMail: 3, pendingTasks: 1 })
    expect(JSON.stringify(decision)).not.toMatch(/inbox|message|you/i)
  })
})

describe('the pathology signal (ADR-0011, consumed in M3)', () => {
  it('fires below the cap, so the breaker can steer before the backstop stops', () => {
    expect(PATHOLOGY_SIGNAL_AT).toBeLessThan(DEFAULT_BLOCK_CAP)
    expect(isPathological(PATHOLOGY_SIGNAL_AT - 1)).toBe(false)
    expect(isPathological(PATHOLOGY_SIGNAL_AT)).toBe(true)
  })
})

describe('blockCapFromEnv (ADR-0013: the cap is env-configurable)', () => {
  it('accepts a positive integer', () => {
    expect(blockCapFromEnv({ [BLOCK_CAP_ENV]: '7' })).toEqual({ cap: 7 })
  })

  it('yields no cap when the variable is unset or empty', () => {
    expect(blockCapFromEnv({})).toEqual({ cap: undefined })
    expect(blockCapFromEnv({ [BLOCK_CAP_ENV]: '' })).toEqual({ cap: undefined })
  })

  it('refuses junk, zero and negatives — the cap can never be disabled by env', () => {
    for (const raw of ['abc', '0', '-3', '2.5', 'Infinity', 'NaN']) {
      const result = blockCapFromEnv({ [BLOCK_CAP_ENV]: raw })
      expect(result.cap).toBeUndefined()
      expect('invalid' in result && result.invalid).toBe(raw)
    }
  })
})

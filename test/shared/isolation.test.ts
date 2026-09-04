import { describe, expect, it } from 'vitest'
import {
  composeIsolation,
  DEFAULT_ISOLATION,
  ISOLATION_MODES,
  ISOLATION_RANK,
  type ActivationIsolation,
  type IsolationInput,
  type IsolationMode
} from '../../src/shared/isolation'

/**
 * The composition behind B10 (M8.6): hire → profile → default, then the
 * Architect's activation choice, then the world's veto.
 *
 * Table-driven on purpose. The failure this module exists to prevent was not a
 * subtle one — it was that NOBODY asked for isolation at all, in either shipped
 * bundle, for the whole life of the profile spawn path — and the way that
 * stays fixed is a table where every layer's contribution is a named row.
 */

function input(over: Partial<IsolationInput> = {}): IsolationInput {
  return {
    hire: 'ci-babysitter',
    agentId: 'agent.crew-myapp-ci-babysitter',
    declaredByHire: undefined,
    declaredByProfile: undefined,
    choice: 'as-declared',
    targetCanHoldWorktree: true,
    ...over
  }
}

describe('the layers, in order', () => {
  it('defaults to isolation when nothing declares anything', () => {
    // The case that describes both shipped bundles before M8.6. An omitted
    // field must not mean "put it in the Architect's checkout".
    const row = composeIsolation(input())
    expect(row.effective).toBe('worktree')
    expect(row.declaredFrom).toBe('default')
    expect(DEFAULT_ISOLATION).toBe('worktree')
  })

  it('takes the profile default over the built-in one', () => {
    const row = composeIsolation(input({ declaredByProfile: 'target' }))
    expect(row.effective).toBe('target')
    expect(row.declaredFrom).toBe('profile')
  })

  it('takes the hire over the profile', () => {
    const row = composeIsolation(input({ declaredByProfile: 'target', declaredByHire: 'worktree' }))
    expect(row.effective).toBe('worktree')
    expect(row.declaredFrom).toBe('hire')
  })

  it('lets a hire opt OUT of a profile that isolates', () => {
    // The direction that must work as well as the safe one: a bundle whose
    // release manager genuinely needs the working copy says so in one file.
    const row = composeIsolation(input({ declaredByProfile: 'worktree', declaredByHire: 'target' }))
    expect(row.effective).toBe('target')
    expect(row.declaredFrom).toBe('hire')
  })
})

describe("the Architect's activation choice", () => {
  it('isolate-all overrides a hire that declared the checkout', () => {
    const row = composeIsolation(input({ declaredByHire: 'target', choice: 'isolate-all' }))
    expect(row.effective).toBe('worktree')
    expect(row.tightened).toBe(true)
    expect(row.relaxed).toBe(false)
    expect(row.because).toContain('overriding the bundle')
  })

  it('none overrides a hire that declared isolation, and says so loudly', () => {
    const row = composeIsolation(input({ declaredByHire: 'worktree', choice: 'none' }))
    expect(row.effective).toBe('target')
    expect(row.relaxed).toBe(true)
    expect(row.tightened).toBe(false)
    // The relaxation is the one an Architect can regret, so it is the one the
    // sentence shouts about.
    expect(row.because).toContain('YOUR CHECKOUT')
    expect(row.because).toContain('overriding the bundle')
  })

  it('is not a relaxation when the bundle already asked for the checkout', () => {
    const row = composeIsolation(input({ declaredByHire: 'target', choice: 'none' }))
    expect(row.effective).toBe('target')
    expect(row.relaxed).toBe(false)
    expect(row.because).toContain('as the bundle declares')
  })

  it('is not a tightening when the bundle already asked for isolation', () => {
    const row = composeIsolation(input({ declaredByHire: 'worktree', choice: 'isolate-all' }))
    expect(row.tightened).toBe(false)
    expect(row.because).toContain('as the bundle declares')
  })
})

describe("the world's veto", () => {
  it('cannot make a worktree of a target that is not a repository', () => {
    const row = composeIsolation(input({ targetCanHoldWorktree: false }))
    expect(row.effective).toBe('target')
    expect(row.because).toContain('not a repository')
  })

  it('outranks even an explicit isolate-all', () => {
    // A choice cannot conjure a repository. Composing to `worktree` here would
    // produce a spawn that `git worktree add` refuses, which under M8.6's
    // second decision refuses the whole activation.
    const row = composeIsolation(
      input({ choice: 'isolate-all', declaredByHire: 'worktree', targetCanHoldWorktree: false })
    )
    expect(row.effective).toBe('target')
  })

  it('is reported as a relaxation, because that is what it is', () => {
    const row = composeIsolation(
      input({ declaredByHire: 'worktree', targetCanHoldWorktree: false })
    )
    expect(row.relaxed).toBe(true)
  })
})

describe('the shape the screen and the spawn both read', () => {
  it('always carries a sentence', () => {
    const choices: ActivationIsolation[] = ['as-declared', 'isolate-all', 'none']
    const declarations: (IsolationMode | undefined)[] = [undefined, 'worktree', 'target']
    for (const choice of choices) {
      for (const byHire of declarations) {
        for (const byProfile of declarations) {
          for (const canHold of [true, false]) {
            const row = composeIsolation(
              input({
                choice,
                declaredByHire: byHire,
                declaredByProfile: byProfile,
                targetCanHoldWorktree: canHold
              })
            )
            expect(row.because.length).toBeGreaterThan(10)
            expect(ISOLATION_MODES).toContain(row.effective)
            // `relaxed` and `tightened` are opposite claims about one
            // comparison: both true is incoherent, and a reader who saw it
            // would have no idea which way the override went.
            expect(row.relaxed && row.tightened).toBe(false)
          }
        }
      }
    }
  })

  it('ranks isolation above the shared checkout', () => {
    expect(ISOLATION_RANK.worktree).toBeGreaterThan(ISOLATION_RANK.target)
  })

  it('carries the hire and agent through unchanged', () => {
    const row = composeIsolation(input({ hire: 'verifier', agentId: 'agent.x-verifier' }))
    expect(row.hire).toBe('verifier')
    expect(row.agentId).toBe('agent.x-verifier')
  })
})

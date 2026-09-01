import { describe, expect, it } from 'vitest'
import {
  dispositionFor,
  outboundKey,
  parseOutboundDraft,
  permitFromApproval,
  permitToPost,
  permits,
  type OutboundDraft
} from '../../src/shared/outbound'
import { AUTONOMY_LEVELS, GATE_KINDS, type AutonomyLevel } from '../../src/shared/gates'

/**
 * The outbound autonomy ladder (FR-9.3, UC-10 step 3 — M7.5).
 *
 * The package line asks for "the autonomy ladder as a table — every rung
 * asserted for what it does AND what it refuses". Both halves are here on
 * purpose: a ladder tested only for what each rung permits would pass with a
 * `post` disposition on every rung.
 *
 * The load-bearing claim is the refusal one: **a draft-only profile has no code
 * path that posts.** That is asserted on the API surface (the S-SECRETS
 * pattern) rather than by inspection — `permitToPost` is the only way to obtain
 * the value the poster's signature requires, and it returns null for every
 * disposition that is not `post`.
 */

const DRAFT: OutboundDraft = {
  schemaVersion: 1,
  kind: 'outbound-draft',
  repo: 'owner/app',
  target: 'issue',
  ref: 412,
  body: 'Thanks for the report — I have opened a task to reproduce this.'
}

describe('the ladder is total, and its rungs differ', () => {
  it('maps every autonomy level to exactly one disposition', () => {
    for (const level of AUTONOMY_LEVELS) {
      const disposition = dispositionFor(level as AutonomyLevel)
      expect(['file', 'hold', 'post']).toContain(disposition.kind)
    }
  })

  it('gives each rung the treatment UC-10 step 3 describes', () => {
    // The rungs must DIFFER, or "configurable autonomy" is decoration.
    expect(dispositionFor('manual')).toEqual({ kind: 'file', because: 'draft-only' })
    expect(dispositionFor('supervised')).toEqual({
      kind: 'hold',
      because: 'above-configured-level'
    })
    expect(dispositionFor('autonomous')).toEqual({ kind: 'post' })
  })

  it('permits nothing to be sent below `autonomous`', () => {
    // What each rung REFUSES, stated directly.
    for (const level of ['manual', 'supervised'] as const) {
      expect(dispositionFor(level).kind).not.toBe('post')
      expect(permitToPost(DRAFT, dispositionFor(level))).toBeNull()
    }
  })
})

describe('a draft-only profile has no code path that posts', () => {
  it('cannot mint a permit at `manual`, which is what the poster requires', () => {
    // The poster takes a `PostPermit` and nothing else; `permitToPost` is one of
    // its only two constructors. Null here means the draft-only flow cannot
    // produce an expression that satisfies the poster's signature — the absence
    // is structural, not a guard that could be inverted.
    expect(permitToPost(DRAFT, dispositionFor('manual'))).toBeNull()
  })

  it('cannot mint a permit at `supervised` without a decided gate', () => {
    expect(permitToPost(DRAFT, dispositionFor('supervised'))).toBeNull()
    // …and the approval constructor refuses a verdict that was not an approval.
    expect(permitFromApproval(DRAFT, 'gate-1', false)).toBeNull()
  })

  it('mints exactly two kinds of permit, each naming how it was granted', () => {
    const byAutonomy = permitToPost(DRAFT, dispositionFor('autonomous'))
    expect(byAutonomy?.granted).toBe('autonomy')
    expect(byAutonomy?.gateId).toBeNull()

    const byApproval = permitFromApproval(DRAFT, 'gate-7', true)
    expect(byApproval?.granted).toBe('architect-approval')
    // The gate rides along, so an approved post is traceable to the approval
    // that permitted it years later (NFR-13).
    expect(byApproval?.gateId).toBe('gate-7')
  })
})

describe('outbound is its own gate kind', () => {
  it('is in GATE_KINDS, so a policy can name it', () => {
    expect(GATE_KINDS).toContain('outbound')
  })

  it('is distinct from prod-facing, so the two compose independently', () => {
    // The whole reason the Architect added a seventh kind: a profile must be
    // able to say "may reply, may not touch prod". If these were one kind,
    // enabling auto-post would grant autonomous production actions too.
    expect(GATE_KINDS.filter((kind) => kind === 'outbound')).toHaveLength(1)
    expect(GATE_KINDS).toContain('prod-facing')
  })
})

describe('level comparison goes through the shared rank', () => {
  it('orders the rungs least to most permissive', () => {
    expect(permits('autonomous', 'manual')).toBe(true)
    expect(permits('supervised', 'manual')).toBe(true)
    expect(permits('manual', 'supervised')).toBe(false)
    expect(permits('supervised', 'autonomous')).toBe(false)
  })
})

describe('a draft is the agent’s words, and is refused when unreadable', () => {
  it('accepts a well-formed draft', () => {
    const parsed = parseOutboundDraft(JSON.stringify(DRAFT))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.draft.body).toBe(DRAFT.body)
  })

  it('refuses an unparseable body instead of sending part of it', () => {
    expect(parseOutboundDraft('not json').ok).toBe(false)
    expect(parseOutboundDraft('').ok).toBe(false)
  })

  it('refuses an empty comment', () => {
    expect(parseOutboundDraft(JSON.stringify({ ...DRAFT, body: '' })).ok).toBe(false)
  })

  it('refuses an unknown field, so a widened draft cannot smuggle one', () => {
    const parsed = parseOutboundDraft(JSON.stringify({ ...DRAFT, autoApprove: true }))
    expect(parsed.ok).toBe(false)
  })

  it('refuses a malformed repo remote', () => {
    for (const repo of ['not-a-remote', '', 'owner/app/extra ']) {
      expect(parseOutboundDraft(JSON.stringify({ ...DRAFT, repo })).ok).toBe(false)
    }
  })

  it('refuses a target that is neither an issue nor a pull request', () => {
    expect(parseOutboundDraft(JSON.stringify({ ...DRAFT, target: 'discussion' })).ok).toBe(false)
  })

  it('keys a draft by repo, target and ref', () => {
    expect(outboundKey(DRAFT)).toBe('owner/app#issue:412')
    expect(outboundKey({ ...DRAFT, target: 'pull-request' })).toBe('owner/app#pull-request:412')
  })
})

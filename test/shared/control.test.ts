import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  CONTROL_ADDRESS_FILE,
  CONTROL_ENDPOINT_PATH,
  CONTROL_SCHEMA_VERSION,
  CONTROL_VERBS,
  REFUSED_VERBS,
  activationRequestFromArgs,
  budgetSetVerdict,
  controlAddressSchema,
  controlRequestSchema,
  renderHelp,
  renderRefusal,
  renderUnknownVerb,
  resolveControlVerb,
  triggerLines,
  resolveVerbIn
} from '../../src/shared/control'
import { activationIsolationSchema } from '../../src/shared/isolation'

/**
 * The control surface's policy (M8.14).
 *
 * The most important block in this file is `the refused set`. A mutation that
 * quietly moves `watch:approve` out of `REFUSED_VERBS` — or into `CONTROL_VERBS`
 * — is the whole package undone, and it must fail here loudly rather than
 * somewhere downstream. So the set is asserted in BOTH directions: exactly these
 * four names are refused, and no refused name is also offered.
 */

const verbNames = (): readonly string[] => CONTROL_VERBS.map((verb) => verb.name)
const argsFor = (name: string): (typeof CONTROL_VERBS)[number]['args'] => {
  const verb = CONTROL_VERBS.find((entry) => entry.name === name)
  if (!verb) throw new Error(`no verb "${name}" — the table changed and this test did not`)
  return verb.args
}

describe('the refused set', () => {
  it('is exactly the four decisions only a human may make', () => {
    expect(REFUSED_VERBS.map((entry) => entry.name).sort()).toEqual([
      'gym:set-mode',
      'odeon:verdict',
      'secrets:set',
      'watch:approve'
    ])
  })

  it('offers none of them as a verb', () => {
    for (const refused of REFUSED_VERBS) expect(verbNames()).not.toContain(refused.name)
  })

  it('refuses each of them by name, whatever else the table holds', () => {
    for (const refused of REFUSED_VERBS) {
      const resolution = resolveControlVerb(refused.name)
      expect(resolution.kind).toBe('refused')
      if (resolution.kind !== 'refused') throw new Error('unreachable')
      expect(resolution.refusal.name).toBe(refused.name)
    }
  })

  it('teaches the rule rather than merely saying no', () => {
    for (const refused of REFUSED_VERBS) {
      const text = renderRefusal(refused)
      // The three things a caller needs: that it is deliberate, why, and where
      // a human does it instead. A refusal missing any of them bills you again.
      expect(text).toContain('deliberately not scriptable')
      expect(text).toContain(refused.because)
      expect(text).toContain(refused.instead)
      expect(text).toContain('only a human may')
    }
  })

  it('names each refusal after the channel the window uses, so a caller lands on it', () => {
    // The point of naming them this way: somebody who knows `watch:approve` from
    // the app's own vocabulary gets the lesson, not "no such verb".
    expect(REFUSED_VERBS.map((entry) => entry.name)).toContain('watch:approve')
    expect(resolveControlVerb('watch:approve').kind).toBe('refused')
  })
})

describe('resolveControlVerb', () => {
  it('answers every verb in the table as allowed', () => {
    for (const verb of CONTROL_VERBS) {
      const resolution = resolveControlVerb(verb.name)
      expect(resolution.kind).toBe('allowed')
      if (resolution.kind !== 'allowed') throw new Error('unreachable')
      expect(resolution.verb.name).toBe(verb.name)
    }
  })

  it('answers a name in neither set as unknown', () => {
    expect(resolveControlVerb('watch:approve-please').kind).toBe('unknown')
    expect(resolveControlVerb('').kind).toBe('unknown')
  })

  it('prefers the refusal when a name is in BOTH tables', () => {
    // Driven through `resolveVerbIn` with tables that DO overlap, because with
    // the shipped ones the order is indistinguishable — which is what a
    // mutation pass found, and why this test exists in this shape. The mistake
    // it survives is somebody "just adding the verb" that is already refused.
    const refusal = REFUSED_VERBS[0]
    const allowed = CONTROL_VERBS[0]
    if (!refusal || !allowed) throw new Error('a table is empty — that alone is the failure')
    const collided = resolveVerbIn([refusal], [{ ...allowed, name: refusal.name }], refusal.name)
    expect(collided.kind).toBe('refused')

    // And the allowed table still answers a name the refusals do not claim.
    expect(resolveVerbIn([refusal], [allowed], allowed.name).kind).toBe('allowed')
    expect(resolveVerbIn([refusal], [allowed], 'neither').kind).toBe('unknown')
  })
})

describe('an unknown verb', () => {
  it('lists what is offered AND what is refused', () => {
    const text = renderUnknownVerb('consent:revoke')
    expect(text).toContain('no such verb: "consent:revoke"')
    for (const verb of CONTROL_VERBS) expect(text).toContain(verb.name)
    for (const refused of REFUSED_VERBS) expect(text).toContain(refused.name)
    expect(text).toContain('only a human may')
  })
})

describe('help', () => {
  it('describes every verb and every refusal', () => {
    const text = renderHelp()
    for (const verb of CONTROL_VERBS) expect(text).toContain(verb.summary)
    for (const refused of REFUSED_VERBS) expect(text).toContain(refused.name)
  })

  it('says what the surface is for in one sentence a stranger can act on', () => {
    expect(renderHelp()).toContain('It operates the company.')
  })
})

describe('the verb table', () => {
  it('marks exactly the acts that change something as writes', () => {
    // This decides what reaches the book of record. Reads are excluded on
    // purpose: `log.jsonl` is append-only, and a polled `status` would push real
    // events out of a reader's view for ever.
    const writes = CONTROL_VERBS.filter((verb) => verb.writes).map((verb) => verb.name)
    expect(writes.sort()).toEqual([
      // M8c.1. A ceiling is a CONSTRAINT, not an authorisation, so a script may
      // set one — downwards. `budgetSetVerdict` is where that line is drawn.
      'budget:set',
      'consent:grant',
      // M8b.2. `convene` shipped with no counterpart, so a CLI runner could
      // open a meeting and had no way to end one — the same absent-and-not-
      // refused shape as Finding 3's `budget:set`.
      'odeon:adjourn',
      'odeon:convene',
      'profile:activate',
      'profile:deactivate'
    ])
  })

  it('gives every verb a usage line and a summary', () => {
    for (const verb of CONTROL_VERBS) {
      expect(verb.summary.length).toBeGreaterThan(0)
      expect(verb.usage).toContain(verb.name)
    }
  })

  it('has no duplicate names', () => {
    expect(new Set(verbNames()).size).toBe(CONTROL_VERBS.length)
  })

  it('offers no --isolation value the activation schema would refuse', () => {
    // The live run found `[--isolation worktree]` in this usage line, and there
    // is no such value. A help string that sends a stranger to a flag the
    // harness refuses is worse than no help string, and it survived because the
    // usage text was only ever asserted to CONTAIN the verb's name. Prose that
    // describes an enum has to be checked against the enum.
    const usage = CONTROL_VERBS.find((verb) => verb.name === 'profile:activate')?.usage ?? ''
    const offered = /--isolation ([^\]]+)/.exec(usage)?.[1]?.split('|') ?? []
    expect(offered.length).toBeGreaterThan(0)
    for (const value of offered)
      expect(activationIsolationSchema.safeParse(value.trim()).success).toBe(true)
  })
})

describe('argument validation', () => {
  it('refuses an unknown flag rather than ignoring it', () => {
    // Strict schemas everywhere: a typo'd flag that was silently dropped would
    // activate a profile against defaults the caller did not ask for.
    expect(argsFor('consent:grant').safeParse({ force: 'yes' }).success).toBe(false)
    expect(
      argsFor('profile:activate').safeParse({
        profile: 'skeleton-crew',
        target: 'repo:myapp',
        path: '/src/myapp',
        isolatoin: 'worktree'
      }).success
    ).toBe(false)
  })

  it('coerces the command line’s strings, because a wire from a CLI is strings', () => {
    const parsed = argsFor('log:tail').safeParse({ limit: '5' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual({ limit: 5 })
  })

  it('defaults log:tail rather than demanding a limit', () => {
    const parsed = argsFor('log:tail').safeParse({})
    expect(parsed.success && parsed.data).toEqual({ limit: 40 })
  })

  it('refuses a limit outside the range the log will serve', () => {
    expect(argsFor('log:tail').safeParse({ limit: '0' }).success).toBe(false)
    expect(argsFor('log:tail').safeParse({ limit: '5000' }).success).toBe(false)
    expect(argsFor('log:tail').safeParse({ limit: 'lots' }).success).toBe(false)
  })

  it('takes one attendee or many, because --attendee repeats', () => {
    const one = argsFor('odeon:convene').safeParse({
      attendee: 'agent.artemis',
      agenda: 'the CI failure'
    })
    expect(one.success && one.data).toEqual({
      attendee: ['agent.artemis'],
      agenda: 'the CI failure'
    })
    const many = argsFor('odeon:convene').safeParse({
      attendee: ['agent.artemis', 'agent.mason'],
      agenda: 'the CI failure'
    })
    expect(many.success && many.data).toEqual({
      attendee: ['agent.artemis', 'agent.mason'],
      agenda: 'the CI failure'
    })
  })

  it('refuses a briefing with no agenda and no attendees', () => {
    expect(argsFor('odeon:convene').safeParse({ agenda: 'x' }).success).toBe(false)
    expect(argsFor('odeon:convene').safeParse({ attendee: [], agenda: 'x' }).success).toBe(false)
    expect(
      argsFor('odeon:convene').safeParse({ attendee: 'agent.artemis', agenda: '' }).success
    ).toBe(false)
  })

  it('refuses a deactivation of something that is not an instance id', () => {
    expect(argsFor('profile:deactivate').safeParse({ instance: 'skeleton-crew' }).success).toBe(
      false
    )
    expect(
      argsFor('profile:deactivate').safeParse({ instance: 'skeleton-crew@repo:myapp' }).success
    ).toBe(true)
  })
})

describe('activationRequestFromArgs', () => {
  it('splits repo:myapp into the target the IPC handler already validates', () => {
    const built = activationRequestFromArgs({
      profile: 'skeleton-crew',
      target: 'repo:myapp',
      path: '/src/myapp'
    })
    expect(built.ok).toBe(true)
    expect(built.ok && built.request).toEqual({
      profile: 'skeleton-crew',
      target: { kind: 'repo', id: 'myapp', path: '/src/myapp' }
    })
  })

  it('carries the repositories the Architect named', () => {
    const built = activationRequestFromArgs({
      profile: 'skeleton-crew',
      target: 'repo:myapp',
      path: '/src/myapp',
      repo: ['me/myapp', 'me/other']
    })
    expect(built.ok && built.request).toMatchObject({ repos: ['me/myapp', 'me/other'] })
  })

  it('refuses a target with no kind, and says what one looks like', () => {
    const built = activationRequestFromArgs({
      profile: 'skeleton-crew',
      target: 'myapp',
      path: '/src/myapp'
    })
    expect(built.ok).toBe(false)
    expect(built.ok === false && built.reason).toContain('repo:myapp')
  })

  it('refuses a target kind the activation schema does not know', () => {
    const built = activationRequestFromArgs({
      profile: 'skeleton-crew',
      target: 'wharf:myapp',
      path: '/src/myapp'
    })
    // Refused BY the schema, not by a second copy of its rules here.
    expect(built.ok).toBe(false)
    expect(built.ok === false && built.reason).toContain('target.kind')
  })

  it('takes one --repo as readily as several — normalised by the schema, not here', () => {
    // The single-string case never reaches `activationRequestFromArgs`: the
    // verb's own schema turns `--repo a` and `--repo a --repo b` into a list
    // first, which is why the normalisation is asserted THERE. Asserting it
    // here would be testing a call the production path cannot make.
    const one = argsFor('profile:activate').safeParse({
      profile: 'skeleton-crew',
      target: 'repo:myapp',
      path: '/src/myapp',
      repo: 'me/myapp'
    })
    expect(one.success && one.data).toMatchObject({ repo: ['me/myapp'] })
    const many = argsFor('profile:activate').safeParse({
      profile: 'skeleton-crew',
      target: 'repo:myapp',
      path: '/src/myapp',
      repo: ['me/one', 'me/two']
    })
    expect(many.success && many.data).toMatchObject({ repo: ['me/one', 'me/two'] })
  })

  it('carries the isolation override the Architect asked for', () => {
    const built = activationRequestFromArgs({
      profile: 'skeleton-crew',
      target: 'repo:myapp',
      path: '/src/myapp',
      isolation: 'isolate-all'
    })
    expect(built.ok && built.request).toMatchObject({ isolation: 'isolate-all' })
  })

  it('refuses an isolation the activation schema does not know, naming the field', () => {
    const built = activationRequestFromArgs({
      profile: 'skeleton-crew',
      target: 'repo:myapp',
      path: '/src/myapp',
      isolation: 'somewhere-else'
    })
    expect(built.ok).toBe(false)
    expect(built.ok === false && built.reason).toContain('isolation')
  })

  it('refuses a repository that is not owner/name', () => {
    const built = activationRequestFromArgs({
      profile: 'skeleton-crew',
      target: 'repo:myapp',
      path: '/src/myapp',
      repo: ['myapp']
    })
    expect(built.ok).toBe(false)
  })
})

describe('the request envelope', () => {
  it('accepts a verb with no arguments at all', () => {
    const parsed = controlRequestSchema.safeParse({
      schemaVersion: CONTROL_SCHEMA_VERSION,
      verb: 'status'
    })
    expect(parsed.success && parsed.data.args).toEqual({})
  })

  it('accepts repeated flags as arrays', () => {
    const parsed = controlRequestSchema.safeParse({
      schemaVersion: CONTROL_SCHEMA_VERSION,
      verb: 'profile:activate',
      args: { repo: ['a/b', 'c/d'], profile: 'skeleton-crew' }
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a body with no verb, a bad version, or extra keys', () => {
    expect(controlRequestSchema.safeParse({ schemaVersion: 1 }).success).toBe(false)
    expect(controlRequestSchema.safeParse({ schemaVersion: 0, verb: 'status' }).success).toBe(false)
    expect(
      controlRequestSchema.safeParse({ schemaVersion: 1, verb: 'status', token: 'x' }).success
    ).toBe(false)
  })

  it('refuses arguments that are not strings, so nothing arrives pre-typed', () => {
    expect(
      controlRequestSchema.safeParse({ schemaVersion: 1, verb: 'log:tail', args: { limit: 5 } })
        .success
    ).toBe(false)
  })
})

describe('the address file', () => {
  it('carries a schemaVersion and the endpoint, and refuses a stray key', () => {
    const good = {
      schemaVersion: CONTROL_SCHEMA_VERSION,
      endpoint: '/tmp/home/control.sock',
      path: CONTROL_ENDPOINT_PATH,
      pid: 4321,
      startedAt: '2026-09-08T10:00:00.000Z'
    }
    expect(controlAddressSchema.safeParse(good).success).toBe(true)
    expect(controlAddressSchema.safeParse({ ...good, token: 'x' }).success).toBe(false)
    expect(controlAddressSchema.safeParse({ ...good, endpoint: '' }).success).toBe(false)
  })

  it('is named so nobody mistakes it for configuration', () => {
    expect(CONTROL_ADDRESS_FILE).toBe('control-endpoint.json')
  })
})

/**
 * **M8c.1 — a ceiling must be reachable without a mouse.**
 *
 * `EXIT-M8.md` §2 calls setting a daily ceiling *"the step that is skipped and
 * then regretted"* and marks it mandatory. There was no budget verb at all — not
 * offered, and, unlike `watch:approve`, not in the deliberately-refused list
 * either. Both real runs went out `unbudgeted` because of it, and the first
 * spent 40.45M tokens against a script that calls a few hundred thousand
 * generous.
 *
 * The verb exists, and it may only ever make the company SAFER. ADR-0033's rule
 * is that a script may run the company and only a human may authorise what the
 * company is not otherwise allowed to do; a ceiling authorises nothing, it caps.
 * Lowering one is therefore a script's to make, and raising one is not.
 */
describe('consent:grant --unbudgeted is an answer, not a presence (M8c.3)', () => {
  const args = (): z.ZodType => {
    const entry = CONTROL_VERBS.find((candidate) => candidate.name === 'consent:grant')
    if (!entry) throw new Error('consent:grant is not in the table')
    return entry.args
  }

  it('reads the two spellings a caller can actually produce', () => {
    // A command line gives strings; a programmatic caller gives a boolean.
    expect(args().safeParse({ unbudgeted: 'true' })).toMatchObject({
      success: true,
      data: { unbudgeted: true }
    })
    expect(args().safeParse({ unbudgeted: true })).toMatchObject({
      success: true,
      data: { unbudgeted: true }
    })
  })

  it('reads an explicit NO, and an absent flag, as no answer', () => {
    expect(args().safeParse({ unbudgeted: 'false' })).toMatchObject({
      success: true,
      data: { unbudgeted: false }
    })
    expect(args().safeParse({})).toMatchObject({ success: true, data: { unbudgeted: false } })
  })

  it('REFUSES anything else rather than reading it as truthy', () => {
    // The mutation this exists to kill: `unbudgeted !== undefined`, which turns
    // `--unbudgeted no` into a permission to spend without a ceiling.
    for (const bad of ['no', 'yes', '1', '0', 'TRUE', '']) {
      expect(args().safeParse({ unbudgeted: bad }).success, bad).toBe(false)
    }
    // Strict: a typo'd flag is refused rather than silently ignored.
    expect(args().safeParse({ unbudgetted: 'true' }).success).toBe(false)
  })
})

describe('budget:set may tighten and never raise (M8c.1)', () => {
  it('accepts any ceiling when the company is unbudgeted', () => {
    // ADR-0029 ships `unbudgeted`, so the FIRST ceiling is always a tightening
    // however large it is — there was nothing to loosen.
    const verdict = budgetSetVerdict(null, 1_000_000_000)
    expect(verdict.ok).toBe(true)
    expect(verdict.because).toContain('unbudgeted')
  })

  it('accepts a lower ceiling, and says what moved', () => {
    const verdict = budgetSetVerdict(300_000, 50_000)
    expect(verdict.ok).toBe(true)
    expect(verdict.because).toContain('tightened from 300,000 to 50,000')
  })

  it('accepts the SAME ceiling rather than refusing a no-op', () => {
    // A script that cannot read the current value first would otherwise be
    // unable to assert a ceiling idempotently, which is what a setup script does.
    const verdict = budgetSetVerdict(300_000, 300_000)
    expect(verdict.ok).toBe(true)
    expect(verdict.because).toContain('unchanged')
  })

  it('REFUSES a raise, and the refusal teaches the rule', () => {
    const verdict = budgetSetVerdict(300_000, 400_000)

    expect(verdict.ok).toBe(false)
    // The standard `watch:approve` set, and the one Positive B in the exit run
    // singled out: name the act, give the reason, say where to go instead, and
    // state the general rule.
    expect(verdict.because).toContain('not something a script may do')
    expect(verdict.because).toContain('300,000')
    expect(verdict.because).toContain('400,000')
    expect(verdict.because).toContain('open the WATCH tab')
    expect(verdict.because).toContain('only a human may authorise')
  })

  it('is a WRITE, so the act reaches the book of record tagged remote', () => {
    const entry = CONTROL_VERBS.find((candidate) => candidate.name === 'budget:set')
    expect(entry?.writes).toBe(true)
  })

  it('coerces the flag a command line actually gives, and refuses a bad one', () => {
    const entry = CONTROL_VERBS.find((candidate) => candidate.name === 'budget:set')
    if (!entry) throw new Error('budget:set is not in the table')
    // Everything arrives from `ephctl` as a string.
    expect(entry.args.safeParse({ daily: '300000' })).toMatchObject({
      success: true,
      data: { daily: 300_000 }
    })
    for (const bad of [{ daily: '0' }, { daily: '-5' }, { daily: 'lots' }, { daily: '1e12' }, {}]) {
      expect(entry.args.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    // Strict: a typo'd flag is refused rather than silently ignored.
    expect(entry.args.safeParse({ daily: '300000', dally: '1' }).success).toBe(false)
  })
})

/**
 * **M8c.6 — a label true in the producer's vocabulary and false in the
 * reader's.**
 *
 * Finding 4 of the M8 exit run, met AGAIN by the M8b rehearsal. `armed` means
 * "has a clock running", so it can only ever list `kind: "schedule"` triggers —
 * an event trigger has no clock to arm and was structurally invisible on that
 * line however correctly it was bound. `EXIT-M8.md` §5.1 tells the runner that a
 * missing `ci` trigger *"is a setup defect, and the run cannot proceed past
 * it"*, so **the documented reading of that output was: stop, the run is
 * invalid.** It was bound the whole time, and proved bound minutes later when
 * the ingest raised eight incidents through it.
 */
describe('an activation names both kinds of trigger (M8c.6)', () => {
  const sweep = {
    id: 'dependency-sweep',
    everyMs: 900_000,
    event: null,
    agentId: 'agent.deps'
  }
  const ci = { id: 'ci-failure', everyMs: null, event: 'ci', agentId: 'agent.oncall' }

  it('lists an event trigger that no clock could ever arm', () => {
    // The 2026-09-09 output was `armed dependency-sweep, health-sweep` and
    // nothing else. This is the line whose absence a runner read as fatal.
    const lines = triggerLines([sweep, ci], ['crew@repo:app/dependency-sweep'])

    expect(lines[0]).toContain('armed (schedules)')
    expect(lines[0]).toContain('dependency-sweep')
    expect(lines[1]).toContain('event triggers')
    expect(lines[1]).toContain('ci → agent.oncall (ci-failure)')
  })

  it('prints the event line even when there is NONE, so absence is visible', () => {
    // The whole defect is that a missing line read as a missing trigger. An
    // empty list must say so out loud, because that IS the setup defect §5.1
    // is about.
    const lines = triggerLines([sweep], ['crew@repo:app/dependency-sweep'])

    expect(lines[1]).toBe('event triggers     (none)')
  })

  it('prints the schedule line even when there is none', () => {
    expect(triggerLines([ci], [])[0]).toBe('armed (schedules)  (none)')
  })

  it('says when a declared schedule is NOT actually armed', () => {
    // `armed` is the scheduler's own list. A schedule the plan declares and the
    // clock does not hold is the real version of the thing §5.1 worries about,
    // and it was previously indistinguishable from one that simply was not
    // declared.
    const lines = triggerLines([sweep], [])

    expect(lines[0]).toContain('dependency-sweep — NOT ARMED')
  })

  it('matches the scheduler’s instance-qualified ids against the plan’s bare ones', () => {
    // Two vocabularies for one id: the scheduler holds
    // `<instance>/<trigger>` and the plan holds `<trigger>`. They meet here
    // rather than in a caller that would have to know both — which is exactly
    // the shape of the `when === "ci"` defect that cost the incident path its
    // whole production life.
    expect(triggerLines([sweep], ['dependency-sweep'])[0]).not.toContain('NOT ARMED')
    expect(triggerLines([sweep], ['crew@repo:app/dependency-sweep'])[0]).not.toContain('NOT ARMED')
    expect(triggerLines([sweep], ['other@repo:x/dependency-sweep'])[0]).not.toContain('NOT ARMED')
  })

  it('CONTROL — a plan with only an event trigger produced an EMPTY armed list', () => {
    // The old rendering, reproduced: `armed` alone, over a plan whose only
    // trigger is the `ci` one. This is what a runner was shown, and what §5.1
    // told them to abort on.
    const armedOnly = [ci].filter((trigger) => trigger.everyMs !== null).map((t) => t.id)
    expect(armedOnly).toEqual([])
    // …and the new rendering says the trigger is there.
    expect(triggerLines([ci], [])[1]).toContain('ci → agent.oncall')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AutonomyRow,
  EMPTY_TARGET,
  InstanceRow,
  PlanView,
  activationRequest,
  targetReady
} from '../../src/renderer/src/ProfilesPanel'
import type { ActivationPlan, ComposedAutonomy } from '../../src/shared/profile-activation'
import type { ProfileInstanceView } from '../../src/shared/profile-view'

/**
 * The activation desk (ADR-0012, M7.2's owed UI — built at M7.8).
 *
 * ADR-0012 chose declarative bundles so an Architect could "read what a profile
 * may do before activating it". That is a promise about a SCREEN, and M7.2
 * shipped the plan, the composition and the IPC with no renderer caller — so
 * the promise was unkeepable, and SRS §6.1's first step ("the Architect
 * activates Skeleton Crew on a real repo") could not be performed at all.
 *
 * These cases assert the screen SHOWS the disclosure, not that a function
 * returned it. Static markup, no DOM — the M6.1 harness pattern.
 */

const AUTONOMY: readonly ComposedAutonomy[] = [
  {
    kind: 'destructive',
    global: 'autonomous',
    requested: 'manual',
    effective: 'manual',
    clamped: false
  },
  {
    kind: 'outbound',
    global: 'supervised',
    requested: 'autonomous',
    effective: 'supervised',
    clamped: true
  }
]

function plan(over: Partial<ActivationPlan> = {}): ActivationPlan {
  return {
    instanceId: 'skeleton-crew:repo:myapp',
    profile: 'skeleton-crew',
    profileVersion: 1,
    targetRef: 'repo:myapp',
    targetPath: '/repos/myapp',
    hires: [
      {
        agentId: 'agent.skeleton-crew-myapp-ci-babysitter',
        hire: 'ci-babysitter',
        hireRef: 'ci-babysitter@1',
        spawn: {
          agentId: 'agent.skeleton-crew-myapp-ci-babysitter',
          name: 'ci-babysitter',
          role: 'ci-babysitter',
          engine: 'claude',
          cwd: '/repos/myapp',
          capabilities: ['ci'],
          envGrants: ['GH_TOKEN']
        }
      }
    ],
    envGrants: ['GH_TOKEN'],
    grantsUnavailable: [],
    autonomy: AUTONOMY,
    triggers: [
      {
        id: 'health-sweep',
        when: 'every 15 min',
        everyMs: 900_000,
        event: null,
        agentId: 'agent.skeleton-crew-myapp-health-watcher',
        playbook: 'health-check.md'
      },
      {
        // `when` says "on ci" for humans; `event` is what code keys on. The
        // two are deliberately different strings here so a consumer that went
        // back to matching the label fails this suite.
        id: 'ci-failure',
        when: 'on ci',
        everyMs: null,
        event: 'ci',
        agentId: 'agent.skeleton-crew-myapp-ci-babysitter',
        playbook: 'incident.md'
      }
    ],
    memoRequires: ['new-dependency'],
    repos: ['owner/app'],
    playbooks: ['incident.md'],
    ...over
  }
}

describe('the plan is rendered as a disclosure', () => {
  it('names every secret the instance would hold', () => {
    const html = renderToStaticMarkup(<PlanView plan={plan()} />)
    // ADR-0010: names, never values — and the screen is where the Architect
    // actually sees which ones before saying yes.
    expect(html).toContain('It would hold these secrets')
    expect(html).toContain('GH_TOKEN')
  })

  it('says so when the instance would hold nothing', () => {
    const html = renderToStaticMarkup(<PlanView plan={plan({ envGrants: [] })} />)
    expect(html).toContain('none')
  })

  it('shows a CLAMPED autonomy row, not just the effective level', () => {
    const html = renderToStaticMarkup(<AutonomyRow row={AUTONOMY[1] as ComposedAutonomy} />)
    // A profile that wanted `autonomous` and was cut back is a fact about the
    // bundle being trusted. Showing only `supervised` would hide the ask.
    expect(html).toContain('supervised')
    expect(html).toContain('asked for autonomous')
    expect(html).toContain('cut back by the global supervised')
  })

  it('shows an unclamped row without the warning', () => {
    const html = renderToStaticMarkup(<AutonomyRow row={AUTONOMY[0] as ComposedAutonomy} />)
    expect(html).toContain('manual')
    expect(html).not.toContain('asked for')
  })

  it('distinguishes armed triggers from ones nothing publishes', () => {
    const html = renderToStaticMarkup(<PlanView plan={plan()} />)
    expect(html).toContain('health-sweep')
    expect(html).toContain('every 15 min')
    // The `ci` binding is declared and NOT armed — nothing publishes that event
    // yet. A screen that listed it beside the scheduled one would be showing a
    // watcher on duty that no clock will ever wake.
    expect(html).toContain('NOT armed')
    expect(html).toContain('ci-failure')
  })

  it('says when a profile would reach no repository at all', () => {
    const html = renderToStaticMarkup(<PlanView plan={plan({ repos: [] })} />)
    // Both built-ins ship with `repos: []`, so this is the state a fresh
    // install is actually in — and the reason its CI babysitter sees nothing.
    expect(html).toContain('no repositories')
  })

  it('lists what is held for a memo and what the agents read', () => {
    const html = renderToStaticMarkup(<PlanView plan={plan()} />)
    expect(html).toContain('new-dependency')
    expect(html).toContain('incident.md')
  })
})

describe('a live instance discloses what is NOT on duty', () => {
  const instance: ProfileInstanceView = {
    instanceId: 'skeleton-crew:repo:myapp',
    plan: plan(),
    agentIds: ['agent.a', 'agent.b'],
    armed: ['health-sweep'],
    pendingEvents: [{ id: 'ci-failure', event: 'ci' }],
    activatedAt: '2026-09-01T09:00:00.000Z'
  }

  it('shows the armed count and names the events nothing publishes', () => {
    const html = renderToStaticMarkup(<InstanceRow instance={instance} onDeactivate={() => {}} />)
    expect(html).toContain('2 agent(s)')
    expect(html).toContain('1 trigger(s) armed')
    expect(html).toContain('waiting on events nothing publishes')
    expect(html).toContain('ci-failure')
  })

  it('offers a way to take it back down', () => {
    const html = renderToStaticMarkup(<InstanceRow instance={instance} onDeactivate={() => {}} />)
    expect(html).toContain('DEACTIVATE')
  })
})

describe('the target form', () => {
  it('needs both an id and a path before a preview can be asked for', () => {
    expect(targetReady(EMPTY_TARGET)).toBe(false)
    expect(targetReady({ kind: 'repo', id: 'myapp', path: '' })).toBe(false)
    expect(targetReady({ kind: 'repo', id: '', path: '/repos/myapp' })).toBe(false)
    expect(targetReady({ kind: 'repo', id: 'myapp', path: '/repos/myapp' })).toBe(true)
  })

  it('treats whitespace as absent, so a spacebar cannot arm the button', () => {
    expect(targetReady({ kind: 'repo', id: '   ', path: '/repos/myapp' })).toBe(false)
  })

  it('trims the request it builds', () => {
    expect(
      activationRequest('skeleton-crew', { kind: 'repo', id: ' myapp ', path: ' /repos/myapp ' })
    ).toEqual({
      profile: 'skeleton-crew',
      target: { kind: 'repo', id: 'myapp', path: '/repos/myapp' }
    })
  })
})

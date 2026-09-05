import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AutonomyRow,
  EMPTY_TARGET,
  InstanceRow,
  PlanView,
  activationRequest,
  parseRepoList,
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
        isolation: {
          hire: 'ci-babysitter',
          agentId: 'agent.skeleton-crew-myapp-ci-babysitter',
          declared: 'worktree',
          declaredFrom: 'profile',
          effective: 'worktree',
          relaxed: false,
          tightened: false,
          because: 'its own worktree of the target, declared by the profile'
        },
        onExit: 'respawn',
        spawn: {
          agentId: 'agent.skeleton-crew-myapp-ci-babysitter',
          name: 'ci-babysitter',
          role: 'ci-babysitter',
          engine: 'claude',
          cwd: '/repos/myapp',
          capabilities: ['ci'],
          envGrants: ['GH_TOKEN'],
          worktree: true
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
    reposFrom: 'bundle',
    reposBecause: "declared by skeleton-crew's harbor.json",
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

  it('warns about a declared secret the broker cannot actually supply (M8.4)', () => {
    // The screen used to list what the profile DECLARES and stop, so it
    // promised `GH_TOKEN` on an install with no `github-app.json` and no such
    // secret. The promise is the problem: the Architect said yes to a crew
    // they were told would have it, and the hires started without it.
    const html = renderToStaticMarkup(
      <PlanView
        plan={plan({ envGrants: ['GH_TOKEN', 'NPM_TOKEN'], grantsUnavailable: ['GH_TOKEN'] })}
      />
    )
    expect(html).toContain('the broker cannot supply')
    expect(html).toContain('GH_TOKEN')
    expect(html).toContain('without them')
  })

  it('says nothing about the broker when it can supply everything', () => {
    // The warning is a fact, not decoration: an install where nothing is
    // missing must not carry a line that reads as though something is.
    const html = renderToStaticMarkup(<PlanView plan={plan({ grantsUnavailable: [] })} />)
    expect(html).not.toContain('the broker cannot supply')
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
    const html = renderToStaticMarkup(
      <PlanView
        plan={plan({ repos: [], reposFrom: 'none', reposBecause: 'the target has no git remote' })}
      />
    )
    // Both built-ins ship with `repos: []`, so this is the state a fresh
    // install is actually in — and the reason its CI babysitter sees nothing.
    // Since M8.5 it says WHY, which is what makes it actionable.
    expect(html).toContain('nothing')
    expect(html).toContain('the target has no git remote')
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
/**
 * What the instance will watch, on the screen before it is activated (M8.5, B7).
 *
 * The old line was `no repositories — add them to the bundle's harbor.json`:
 * the fix for a problem the screen never said you had, rendered in the quiet
 * `note` style beside everything that was working. Both shipped bundles carry
 * `repos: []`, so that sentence was on screen for every activation there has
 * ever been, and the mission it described was inert.
 */
describe('the screen says what the instance will watch', () => {
  it('names the repositories and where they came from', () => {
    const html = renderToStaticMarkup(
      <PlanView
        plan={plan({
          repos: ['owner/app'],
          reposFrom: 'target',
          reposBecause: "read from the target's origin remote"
        })}
      />
    )
    expect(html).toContain('It would watch')
    expect(html).toContain('owner/app')
    // Provenance, so a repository the Architect chose reads differently from
    // one the harness read off the checkout.
    expect(html).toContain('read from the target')
    expect(html).toContain('origin remote')
  })

  it('says a mission that watches nothing is a mission that cannot work', () => {
    const html = renderToStaticMarkup(
      <PlanView
        plan={plan({
          repos: [],
          reposFrom: 'none',
          reposBecause:
            'the target has no git remote — this instance will watch no repository, so no CI run, issue or pull request can reach it'
        })}
      />
    )
    expect(html).toContain('nothing')
    expect(html).toContain('no CI run, issue or pull request can reach it')
    // In the WARNING colour, not the quiet note the old line used — and
    // asserted on this line rather than on the page, because the page carries
    // other warnings and a colour found anywhere would pass either way.
    expect(html).toContain('color:var(--eph-wine);margin:4px 0">nothing —')
    // And never the old sentence, which described a fix for a problem the
    // screen had not said you had.
    expect(html).not.toContain('add them to')
  })
})

/**
 * The override, and the pure functions behind it (M8.5).
 *
 * A derivation can be refused — a fork has two remotes and two answers — and a
 * refusal the Architect cannot answer is a dead end. These are exported and
 * tested rather than inlined in the component for the M5b.1 reason: a one-line
 * mapping inside a component is a mapping no table test can reach.
 */
describe('the repository the Architect names', () => {
  it('splits a typed or pasted list on commas and whitespace', () => {
    expect(parseRepoList('owner/app')).toEqual(['owner/app'])
    expect(parseRepoList('owner/app, owner/other')).toEqual(['owner/app', 'owner/other'])
    expect(parseRepoList('owner/app owner/other')).toEqual(['owner/app', 'owner/other'])
    expect(parseRepoList('  owner/app ,,  owner/other  ')).toEqual(['owner/app', 'owner/other'])
    expect(parseRepoList('owner/app\nowner/other')).toEqual(['owner/app', 'owner/other'])
  })

  it('keeps the order and drops a repeat', () => {
    expect(parseRepoList('b/two, a/one, b/two')).toEqual(['b/two', 'a/one'])
  })

  it('reads an empty box as nothing typed', () => {
    expect(parseRepoList('')).toEqual([])
    expect(parseRepoList('   ')).toEqual([])
    expect(parseRepoList(',, ,')).toEqual([])
  })

  it('does not pre-judge what main will validate', () => {
    // A renderer that refused a slug would be a second opinion that can drift
    // from the one that decides; main validates against the Harbor's schema.
    expect(parseRepoList('not-a-slug')).toEqual(['not-a-slug'])
  })

  it('OMITS the field when nothing was typed, rather than sending an empty list', () => {
    // "the Architect chose no repositories" and "the Architect did not choose"
    // are different statements, and only the second may fall through to the
    // bundle's own declaration.
    const request = activationRequest('skeleton-crew', {
      kind: 'repo',
      id: 'myapp',
      path: '/repos/myapp'
    })
    expect(request).not.toHaveProperty('repos')
    expect(Object.keys(request).sort()).toEqual(['profile', 'target'])
  })

  it('carries the typed list into the request', () => {
    const request = activationRequest(
      'skeleton-crew',
      { kind: 'repo', id: 'myapp', path: '  /repos/myapp  ' },
      'owner/app, owner/other'
    )
    expect(request.repos).toEqual(['owner/app', 'owner/other'])
    // …and the target is still trimmed, which the same function has always done.
    expect(request.target.path).toBe('/repos/myapp')
  })
})

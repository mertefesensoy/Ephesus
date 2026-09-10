import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ControlServer,
  controlEndpointFor,
  performVerb,
  startControlSurface,
  type ControlDeps
} from '../../src/main/control'
import { isListening } from '../../src/main/home-lock'
import { DiagnosisWriter, DIAGNOSIS_FILE } from '../../src/main/diagnosis'
import { CONTROL_ADDRESS_FILE, CONTROL_VERBS, type ControlVerb } from '../../src/shared/control'
import type { DiagnosisInput } from '../../src/shared/diagnosis'
import { removeTempDir } from '../tmpdir'

/**
 * What each verb actually SAYS (M8.14).
 *
 * Driven against `performVerb` directly rather than over the socket, because
 * what is under test here is the answer a reader gets — and every one of these
 * has two sides that a single happy-path fixture never shows: a crew and an
 * empty roster, a mission watching repositories and one watching none, a grant
 * that worked and one that could not be written down. An empty-list branch that
 * nothing exercises is how a panel ships saying "undefined".
 */

const temps: string[] = []
const servers: ControlServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

const SNAPSHOT: DiagnosisInput = {
  at: Date.parse('2026-09-08T10:00:00.000Z'),
  home: 'C:\\eph',
  pid: 4321,
  version: '0.0.1',
  conditions: [],
  events: [],
  fileWarnings: [],
  crew: [],
  consented: false,
  armed: []
}

const verb = (name: string): ControlVerb => {
  const found = CONTROL_VERBS.find((entry) => entry.name === name)
  if (!found) throw new Error(`no verb "${name}" — the table changed and this test did not`)
  return found
}

function deps(overrides: Record<string, unknown> = {}): ControlDeps {
  return {
    consent: {
      view: () => ({
        state: 'not-granted',
        mayStartWork: false,
        because: 'nobody has said go',
        terms: 1,
        grantedAt: null,
        disclosure: { hire: null, triggers: [], dailyCeiling: null }
      }),
      grant: () => ({
        ok: true,
        reason: null,
        view: {
          state: 'granted',
          mayStartWork: true,
          because: 'granted',
          terms: 1,
          grantedAt: null,
          disclosure: { hire: null, triggers: [], dailyCeiling: null }
        }
      })
    },
    agents: { list: () => [] },
    agora: { appendLog: () => undefined, tailLog: () => [] },
    profilesList: () => [],
    profilesInstances: () => [],
    profilesActivate: () => Promise.resolve({ ok: false, reasons: ['no such profile'] }),
    profilesDeactivate: () => ({ ok: true, reason: null }),
    convene: () => ({ ok: true, id: 'meeting-1' }),
    meetingClose: () => ({ ok: true, ref: 'agora/odeon/minutes/meeting-1.md' }),
    diagnosis: { snapshot: () => SNAPSHOT },
    gatePolicyView: () => ({ autonomy: 'autonomous', maxDailyTokens: null, warning: null }),
    saveGateCeilings: (ceilings: { autonomy: string; maxDailyTokens: number | null }) => ({
      ok: true,
      view: { ...ceilings, warning: null }
    }),
    ...overrides
  } as unknown as ControlDeps
}

describe('the switch is total over the table', () => {
  it('answers every listed verb without falling through', async () => {
    // The guarantee the `default` case exists for: a verb added to the shared
    // table and forgotten here must be caught by a test, not by a caller.
    for (const entry of CONTROL_VERBS) {
      const answer = await performVerb(deps(), entry, defaultArgsFor(entry.name))
      expect(answer.verb).toBe(entry.name)
      expect(answer.text).not.toContain('listed but not implemented')
    }
  })

  it('says so plainly when a listed verb has no case', async () => {
    const answer = await performVerb(
      deps(),
      { name: 'company:disband', summary: '', args: verb('help').args, writes: false, usage: '' },
      {}
    )
    expect(answer.ok).toBe(false)
    // Not "no such verb": the caller spelled it correctly and the harness is
    // the one that is behind.
    expect(answer.text).toContain('listed but not implemented')
  })
})

function defaultArgsFor(name: string): unknown {
  switch (name) {
    case 'budget:set':
      return { daily: 300_000 }
    case 'profile:activate':
      return { profile: 'skeleton-crew', target: 'repo:myapp', path: 'C:\\src\\myapp' }
    case 'profile:deactivate':
      return { instance: 'skeleton-crew@repo:myapp' }
    case 'odeon:convene':
      return { attendee: ['agent.artemis'], agenda: 'the CI failure' }
    case 'log:tail':
      return { limit: 40 }
    default:
      return {}
  }
}

describe('empty and full, for every list', () => {
  it('says nobody is hired, and then names the crew', async () => {
    expect((await performVerb(deps(), verb('agents:list'), {})).text).toBe('nobody is hired')
    const full = await performVerb(
      deps({
        agents: {
          list: () => [
            {
              agentId: 'agent.artemis',
              lifecycle: 'running',
              role: 'orchestrator',
              engine: 'claude'
            }
          ]
        }
      }),
      verb('agents:list'),
      {}
    )
    expect(full.text).toContain('agent.artemis')
    expect(full.text).toContain('orchestrator on claude')
  })

  it('says no profiles are installed, and then lists them — invalid ones included', async () => {
    expect((await performVerb(deps(), verb('profile:list'), {})).text).toBe(
      'no mission profiles are installed'
    )
    const full = await performVerb(
      deps({
        profilesList: () => [
          { name: 'skeleton-crew', source: 'builtin', valid: true, version: 2, knownTargets: [] },
          { name: 'broken', source: 'home', valid: false, version: null, knownTargets: [] }
        ]
      }),
      verb('profile:list'),
      {}
    )
    // ADR-0012: a bundle that fails validation still gets a row, or it looks
    // uninstalled and the Architect hunts for a missing directory.
    expect(full.text).toContain('skeleton-crew')
    expect(full.text).toContain('v2')
    expect(full.text).toContain('broken')
    expect(full.text).toContain('INVALID')
  })

  it('says nothing is activated, and then describes each instance', async () => {
    expect((await performVerb(deps(), verb('profile:instances'), {})).text).toBe(
      'nothing is activated'
    )
    const full = await performVerb(
      deps({
        profilesInstances: () => [
          {
            instanceId: 'skeleton-crew@repo:myapp',
            agentIds: ['agent.mason@myapp'],
            armed: ['sweep'],
            pendingEvents: [],
            activatedAt: '2026-09-08T10:00:00.000Z',
            plan: {
              targetRef: 'repo:myapp',
              targetPath: 'C:\\src\\myapp',
              repos: ['me/myapp'],
              reposBecause: 'read off the checkout',
              // A real Skeleton Crew plan carries both kinds, and the event one
              // is what a runner could not see before M8c.6.
              triggers: [
                { id: 'sweep', everyMs: 900_000, event: null, agentId: 'agent.mason@myapp' },
                { id: 'ci-failure', everyMs: null, event: 'ci', agentId: 'agent.mason@myapp' }
              ]
            }
          }
        ]
      }),
      verb('profile:instances'),
      {}
    )
    expect(full.text).toContain('repo:myapp at C:\\src\\myapp')
    expect(full.text).toContain('repos me/myapp')
    expect(full.text).toContain('agents agent.mason@myapp')
    expect(full.text).toContain('armed (schedules)  sweep')
    // M8c.6: the line whose absence a runner read as a missing trigger.
    expect(full.text).toContain('event triggers     ci → agent.mason@myapp (ci-failure)')
  })

  it('says an instance watching nothing watches (none), rather than printing a blank', async () => {
    // M8.5's finding: both shipped bundles carry `repos: []`, so this was the
    // SILENT outcome of every activation that had ever happened.
    const answer = await performVerb(
      deps({
        profilesInstances: () => [
          {
            instanceId: 'skeleton-crew@repo:myapp',
            agentIds: [],
            armed: [],
            pendingEvents: [],
            activatedAt: '2026-09-08T10:00:00.000Z',
            plan: {
              targetRef: 'repo:myapp',
              targetPath: 'C:\\src\\myapp',
              repos: [],
              reposBecause: 'the bundle declares none',
              triggers: []
            }
          }
        ]
      }),
      verb('profile:instances'),
      {}
    )
    expect(answer.text).toContain('repos (none)')
    expect(answer.text).toContain('agents (none)')
    expect(answer.text).toContain('armed (schedules)  (none)')
    // Printed even when empty (M8c.6): the ABSENCE of this line is what a
    // runner took for the absence of the trigger.
    expect(answer.text).toContain('event triggers     (none)')
  })

  it('says the book of record is empty, and then prints rows with and without an event', async () => {
    expect((await performVerb(deps(), verb('log:tail'), { limit: 40 })).text).toBe(
      'the book of record is empty'
    )
    const full = await performVerb(
      deps({
        agora: {
          appendLog: () => undefined,
          tailLog: () => [
            { ts: 0, seq: 1, kind: 'spawn', event: 'spawned' },
            { ts: 0, seq: 2, kind: 'message' }
          ]
        }
      }),
      verb('log:tail'),
      { limit: 40 }
    )
    expect(full.text).toContain('spawn')
    expect(full.text).toContain('spawned')
    expect(full.text).toContain('message')
  })
})

describe('consent, read and granted', () => {
  it('names the hire, the ceiling and every cadence when there is one', async () => {
    const answer = await performVerb(
      deps({
        consent: {
          view: () => ({
            state: 'not-granted',
            mayStartWork: false,
            because: 'nobody has said go',
            terms: 3,
            grantedAt: '2026-09-01T00:00:00.000Z',
            disclosure: {
              hire: { agentId: 'agent.artemis', engine: 'claude' },
              triggers: [{ id: 'standup', everyMs: 86_400_000 }],
              dailyCeiling: 250_000
            }
          }),
          grant: () => ({ ok: false, reason: null, view: null })
        }
      }),
      verb('consent:status'),
      {}
    )
    expect(answer.text).toContain('agent.artemis on claude')
    expect(answer.text).toContain('250000 tokens/day')
    expect(answer.text).toContain('standup every 1 day')
    expect(answer.text).toContain('granted 2026-09-01T00:00:00.000Z')
    expect(answer.text).toContain('nobody has said go')
  })

  it('says nobody is hired when no engine adapter is registered', async () => {
    // Not a blank line. ADR-0024 refuses a hire on an unregistered engine, and a
    // consent screen that promised one anyway would be promising nothing.
    const answer = await performVerb(deps(), verb('consent:status'), {})
    expect(answer.text).toContain('nobody — no engine adapter is registered')
    expect(answer.text).toContain('unbudgeted')
  })

  it('reports a grant that could not be written down as a failure', async () => {
    // ADR-0032: work running under a consent the next boot will not find is
    // worse than a button that reports its own failure.
    const answer = await performVerb(
      deps({
        consent: {
          view: () => ({
            state: 'not-granted',
            mayStartWork: false,
            because: 'x',
            terms: 1,
            grantedAt: null,
            disclosure: { hire: null, triggers: [], dailyCeiling: null }
          }),
          grant: () => ({
            ok: false,
            reason: 'consent could not be recorded: EACCES',
            view: {
              state: 'not-granted',
              mayStartWork: false,
              because: 'x',
              terms: 1,
              grantedAt: null,
              disclosure: { hire: null, triggers: [], dailyCeiling: null }
            }
          })
        }
      }),
      verb('consent:grant'),
      {}
    )
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('consent was NOT granted')
    expect(answer.text).toContain('EACCES')
  })

  it('falls back to a reason rather than printing "null" when there is none', async () => {
    const answer = await performVerb(
      deps({
        consent: {
          view: () => ({
            state: 'not-granted',
            mayStartWork: false,
            because: 'x',
            terms: 1,
            grantedAt: null,
            disclosure: { hire: null, triggers: [], dailyCeiling: null }
          }),
          grant: () => ({ ok: false, reason: null, view: { grantedAt: null } })
        }
      }),
      verb('consent:grant'),
      {}
    )
    expect(answer.text).toContain('unknown reason')
  })

  it('says when the grant is on file', async () => {
    const answer = await performVerb(
      deps({
        consent: {
          view: () => ({}),
          grant: () => ({
            ok: true,
            reason: null,
            view: { grantedAt: '2026-09-08T10:00:00.000Z' }
          })
        }
      }),
      verb('consent:grant'),
      {}
    )
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain('on file since 2026-09-08T10:00:00.000Z')
  })
})

describe('activation and deactivation', () => {
  it('reports every reason an activation was refused, not just the first', async () => {
    const answer = await performVerb(
      deps({
        profilesActivate: () =>
          Promise.resolve({ ok: false, reasons: ['no such profile', 'and the path is not a repo'] })
      }),
      verb('profile:activate'),
      { profile: 'ghost', target: 'repo:myapp', path: 'C:\\src\\myapp' }
    )
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('no such profile')
    expect(answer.text).toContain('and the path is not a repo')
  })

  it('refuses a target that is not `kind:id` before it reaches the harness', async () => {
    const answer = await performVerb(deps(), verb('profile:activate'), {
      profile: 'skeleton-crew',
      target: 'myapp',
      path: 'C:\\src\\myapp'
    })
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('Usage:')
  })

  it('names the repositories the activated instance will watch', async () => {
    const answer = await performVerb(
      deps({
        profilesActivate: () =>
          Promise.resolve({
            ok: true,
            instance: {
              instanceId: 'skeleton-crew@repo:myapp',
              agentIds: [],
              armed: [],
              pendingEvents: [],
              activatedAt: '2026-09-08T10:00:00.000Z',
              plan: {
                targetRef: 'repo:myapp',
                targetPath: 'C:\\src\\myapp',
                repos: ['me/myapp'],
                reposBecause: 'read off the checkout',
                triggers: []
              }
            }
          })
      }),
      verb('profile:activate'),
      { profile: 'skeleton-crew', target: 'repo:myapp', path: 'C:\\src\\myapp' }
    )
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain('me/myapp — read off the checkout')
    expect(answer.text).toContain('agents      (none)')
  })

  it('says why a deactivation did not happen, and does not claim it did', async () => {
    const refused = await performVerb(
      deps({ profilesDeactivate: () => ({ ok: false, reason: 'no such instance' }) }),
      verb('profile:deactivate'),
      { instance: 'ghost@repo:none' }
    )
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('no such instance')

    const unexplained = await performVerb(
      deps({ profilesDeactivate: () => ({ ok: false, reason: null }) }),
      verb('profile:deactivate'),
      { instance: 'ghost@repo:none' }
    )
    expect(unexplained.text).toContain('unknown reason')
  })
})

describe('convening', () => {
  it('names who was convened', async () => {
    const answer = await performVerb(deps(), verb('odeon:convene'), {
      attendee: ['agent.artemis', 'agent.mason'],
      agenda: 'the CI failure'
    })
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain('agent.artemis, agent.mason')
  })

  it('reports a refusal as one', async () => {
    const answer = await performVerb(
      deps({ convene: () => ({ ok: false, reason: 'a meeting is already in session' }) }),
      verb('odeon:convene'),
      { attendee: ['agent.artemis'], agenda: 'x' }
    )
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('a meeting is already in session')
  })
})

describe('status', () => {
  it('lists live conditions when there are any, and omits the section when there are none', async () => {
    const quiet = await performVerb(deps(), verb('status'), {})
    expect(quiet.text).not.toContain('Live conditions:')

    const noisy = await performVerb(
      deps({
        diagnosis: {
          snapshot: () => ({
            ...SNAPSHOT,
            consented: true,
            crew: [{ agentId: 'agent.artemis', lifecycle: 'running' }],
            armed: [{ id: 'standup', everyMs: 86_400_000 }],
            conditions: [
              {
                source: 'library',
                cause: 'library/recall-rung',
                detail: 'recall is on the grep rung',
                count: 2,
                since: SNAPSHOT.at,
                freshness: 'live' as const
              }
            ]
          })
        }
      }),
      verb('status'),
      {}
    )
    expect(noisy.text).toContain('consent: granted')
    expect(noisy.text).toContain('crew: 1')
    expect(noisy.text).toContain('Live conditions:')
    expect(noisy.text).toContain('library/recall-rung — recall is on the grep rung')
  })
})

describe('the fold has one owner', () => {
  it('reads status through the REAL DiagnosisWriter, which is what index.ts hands it', async () => {
    // The seam `index.ts` actually wires: `deps.diagnosis` IS the writer that
    // produces `DIAGNOSIS.md`. Stubbing it everywhere would leave the one thing
    // this design turns on — that there is a single fold, not two — untested.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-fold-'))
    temps.push(home)
    let taken = 0
    const writer = new DiagnosisWriter({
      home,
      snapshot: () => {
        taken += 1
        return { ...SNAPSHOT, home, consented: true }
      },
      onFailed: () => undefined
    })

    const answer = await performVerb(deps({ diagnosis: writer }), verb('status'), {})
    expect(answer.text).toContain('consent: granted')
    expect(answer.text).toContain(home)

    // And the report on disk is the SAME fold, rendered differently.
    expect(writer.write()).toBe(path.join(home, DIAGNOSIS_FILE))
    const onDisk = fs.readFileSync(path.join(home, DIAGNOSIS_FILE), 'utf8')
    const report = await performVerb(deps({ diagnosis: writer }), verb('diagnosis'), {})
    expect(onDisk).toContain('# Ephesus — what is working')
    expect(report.text).toContain('# Ephesus — what is working')
    expect(taken).toBe(3)
  })
})

describe('isListening', () => {
  it('says yes to an endpoint a harness is serving', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-probe-'))
    temps.push(home)
    const server = await startControlSurface({
      deps: deps(),
      home,
      report: () => undefined,
      announce: () => undefined
    })
    servers.push(server)
    await expect(isListening(controlEndpointFor(home))).resolves.toBe(true)
  })

  it('says no to an address nothing is serving, without throwing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-noprobe-'))
    temps.push(home)
    // Never started: the answer must be a `false`, not a rejection, because the
    // caller is deciding whether a leftover address is rubbish and an exception
    // there would take the boot down over a file.
    await expect(isListening(controlEndpointFor(home))).resolves.toBe(false)
  })
})

describe('startControlSurface', () => {
  it('returns a listening server and announces where', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-boot-'))
    temps.push(home)
    const heard: string[] = []
    const degraded: string[] = []
    const server = await startControlSurface({
      deps: deps(),
      home,
      report: (_cause, detail) => degraded.push(detail),
      announce: (line) => heard.push(line)
    })
    servers.push(server)
    expect(heard).toHaveLength(1)
    expect(heard[0]).toContain(String(server.endpoint()))
    expect(degraded).toEqual([])
  })

  it('announces through the console when nothing else is listening for it', async () => {
    // The production path: `index.ts` passes no `announce`, so the default is
    // the one that actually ships and it must not be an untested branch.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-say-'))
    temps.push(home)
    const said: unknown[] = []
    const spy = vi.spyOn(console, 'info').mockImplementation((...args) => {
      said.push(args.join(' '))
    })
    try {
      const server = await startControlSurface({ deps: deps(), home, report: () => undefined })
      servers.push(server)
    } finally {
      spy.mockRestore()
    }
    expect(said.join(' ')).toContain('control endpoint listening on')
  })

  it('reports rather than throws when the endpoint will not bind', async () => {
    // A harness whose control surface would not bind still runs: the window
    // works and the condition is visible (invariant §7).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-clash-'))
    temps.push(home)
    const first = await startControlSurface({
      deps: deps(),
      home,
      report: () => undefined,
      announce: () => undefined
    })
    servers.push(first)
    const degraded: string[] = []
    const second = await startControlSurface({
      deps: deps(),
      home,
      report: (_cause, detail) => degraded.push(detail),
      announce: () => undefined
    })
    servers.push(second)
    expect(degraded.join('\n')).toContain('the control surface is not listening')
    // The SENTENCE, not just the failure: on Windows the OS would refuse the
    // duplicate pipe name anyway, but with `EADDRINUSE`, and a reader cannot act
    // on that. Asserting the words is also what makes the guard's absence
    // detectable on a platform whose kernel happens to enforce the same rule.
    expect(degraded.join(' ')).toContain('another harness is already listening')
    expect(degraded.join(' ')).toContain('stop the first one')
    expect(second.endpoint()).toBeNull()
    // And the FIRST one is untouched: it still holds the address and still answers.
    expect(first.endpoint()).toBe(controlEndpointFor(home))
    const advertised = JSON.parse(
      fs.readFileSync(path.join(home, CONTROL_ADDRESS_FILE), 'utf8')
    ) as { pid: number }
    expect(advertised.pid).toBe(process.pid)
  })

  it('still binds over a socket a CRASHED harness left behind', async () => {
    // The other half of the same branch, and the regression the fix could have
    // caused: a leftover socket that answers nobody must not block the next
    // boot. On Windows the pipe dies with its process and there is nothing to
    // leave behind, so the setup is POSIX-only while the assertion is not.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-stale-'))
    temps.push(home)
    const first = await startControlSurface({
      deps: deps(),
      home,
      report: () => undefined,
      announce: () => undefined
    })
    await first.stop()
    if (process.platform !== 'win32')
      fs.writeFileSync(controlEndpointFor(home), 'a socket nobody is listening on')

    const degraded: string[] = []
    const second = await startControlSurface({
      deps: deps(),
      home,
      report: (_cause, detail) => degraded.push(detail),
      announce: () => undefined
    })
    servers.push(second)
    expect(degraded).toEqual([])
    expect(second.endpoint()).toBe(controlEndpointFor(home))
  })

  it('stops cleanly even when it never started', async () => {
    const server = new ControlServer({ deps: deps(), onDegraded: () => undefined })
    await expect(server.stop()).resolves.toBeUndefined()
    expect(server.endpoint()).toBeNull()
  })
})

describe('odeon:adjourn (M8b.2)', () => {
  it('closes the open meeting and names where the minutes went', async () => {
    const answer = await performVerb(deps(), verb('odeon:adjourn'), {})
    expect(answer.ok).toBe(true)
    // The runner is told WHERE, because §5.4 asks them to read it. A verb
    // that said only 'adjourned' would leave them hunting for the file, which
    // is the whole of Finding 13's cost.
    expect(answer.text).toContain('agora/odeon/minutes/meeting-1.md')
  })

  it('reports a refusal as one', async () => {
    const answer = await performVerb(
      deps({ meetingClose: () => ({ ok: false, reason: 'no meeting is open' }) }),
      verb('odeon:adjourn'),
      {}
    )
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('no meeting is open')
  })

  it('sends no action items — those are the chair’s reading, not a script’s', () => {
    const seen: unknown[][] = []
    return performVerb(
      deps({
        meetingClose: (actions: unknown[]) => {
          seen.push(actions)
          return { ok: true, ref: 'agora/odeon/minutes/m.md' }
        }
      }),
      verb('odeon:adjourn'),
      {}
    ).then(() => {
      // The line `watch:approve` refuses to cross: a control surface that
      // invented action items would be writing the ledger's input on nobody's
      // authority.
      expect(seen).toEqual([[]])
    })
  })
})

/**
 * **M8c.1** — the handler half. `budgetSetVerdict` decides; this is what the
 * decision does to the policy file, and the three things it must never do:
 * touch the autonomy ceiling, write into the deny-all fallback, or report a
 * save that did not happen.
 */
describe('consent:grant carries the ceiling answer (M8c.3)', () => {
  const withGrantSpy = (): { readonly answers: boolean[]; readonly deps: ControlDeps } => {
    const answers: boolean[] = []
    return {
      answers,
      deps: deps({
        consent: {
          view: () => ({
            state: 'never-asked',
            mayStartWork: false,
            because: 'nobody has said go',
            terms: 2,
            grantedAt: null,
            disclosure: { hire: null, triggers: [], dailyCeiling: null }
          }),
          grant: (unbudgeted: boolean) => {
            answers.push(unbudgeted)
            return {
              ok: true,
              reason: null,
              view: {
                state: 'granted',
                mayStartWork: true,
                because: 'granted',
                terms: 2,
                grantedAt: null,
                disclosure: { hire: null, triggers: [], dailyCeiling: null }
              }
            }
          }
        }
      })
    }
  }

  it('passes --unbudgeted through, rather than deciding for the Architect', async () => {
    const spy = withGrantSpy()
    await performVerb(spy.deps, verb('consent:grant'), { unbudgeted: true })
    expect(spy.answers).toEqual([true])
  })

  it('passes NO answer when the flag is absent', async () => {
    const spy = withGrantSpy()
    await performVerb(spy.deps, verb('consent:grant'), { unbudgeted: false })
    expect(spy.answers).toEqual([false])
  })
})

describe('budget:set', () => {
  const view = (over: Record<string, unknown> = {}) => ({
    autonomy: 'autonomous',
    maxDailyTokens: null,
    warning: null,
    ...over
  })

  it('sets the ceiling and leaves the autonomy ceiling exactly where it was', async () => {
    const saves: unknown[] = []
    const answer = await performVerb(
      deps({
        gatePolicyView: () => view({ autonomy: 'supervised' }),
        saveGateCeilings: (ceilings: unknown) => {
          saves.push(ceilings)
          return { ok: true, view: { ...(ceilings as object), warning: null } }
        }
      }),
      verb('budget:set'),
      { daily: 300_000 }
    )

    expect(answer.ok).toBe(true)
    expect(answer.text).toContain('daily ceiling set')
    // The one thing this verb must not do: `saveGateCeilings` patches BOTH
    // ceilings, so a handler that rebuilt the object instead of carrying the
    // current autonomy through would move a safety dial nobody asked it to.
    expect(saves).toEqual([{ autonomy: 'supervised', maxDailyTokens: 300_000 }])
  })

  it('REFUSES a raise without writing anything', async () => {
    const saves: unknown[] = []
    const answer = await performVerb(
      deps({
        gatePolicyView: () => view({ maxDailyTokens: 300_000 }),
        saveGateCeilings: (ceilings: unknown) => {
          saves.push(ceilings)
          return { ok: true, view: { ...(ceilings as object), warning: null } }
        }
      }),
      verb('budget:set'),
      { daily: 900_000 }
    )

    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('only a human may authorise')
    expect(saves).toEqual([])
  })

  it('REFUSES to write into the deny-all fallback, naming it', async () => {
    // `gate-policy.json` unreadable means the harness is running on
    // `denyAllPolicy`. Saving a ceiling then would persist that fallback's
    // `manual` autonomy as though it had been chosen — a degradation written
    // back as a setting, which is invariant §7's exact failure.
    const saves: unknown[] = []
    const answer = await performVerb(
      deps({
        gatePolicyView: () => view({ warning: 'gate-policy.json could not be read' }),
        saveGateCeilings: (ceilings: unknown) => {
          saves.push(ceilings)
          return { ok: true, view: { ...(ceilings as object), warning: null } }
        }
      }),
      verb('budget:set'),
      { daily: 300_000 }
    )

    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('could not be read')
    expect(saves).toEqual([])
  })

  it('reports a refused save as a failure rather than as done', async () => {
    const answer = await performVerb(
      deps({ saveGateCeilings: () => ({ ok: false, reason: 'the home is read-only' }) }),
      verb('budget:set'),
      { daily: 300_000 }
    )

    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('the home is read-only')
  })
})

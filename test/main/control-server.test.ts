import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlServer, controlEndpointFor, type ControlDeps } from '../../src/main/control'
import {
  CONTROL_ADDRESS_FILE,
  CONTROL_ENDPOINT_PATH,
  CONTROL_SCHEMA_VERSION,
  controlAddressSchema,
  type ControlAnswer
} from '../../src/shared/control'
import type { DiagnosisInput } from '../../src/shared/diagnosis'
import { removeTempDir } from '../tmpdir'

/**
 * The control endpoint (M8.14) — driven over a REAL socket, in a real home,
 * because everything that makes it a trust boundary is in the transport and the
 * dispatch, not in the arithmetic.
 *
 * Two properties matter more than the rest and both are asserted directly:
 *
 *  1. **The four refusals reach the wire.** A caller who asks to approve a gate
 *     gets a 403 and a reason, and the attempt lands in the book of record.
 *  2. **Every act that changes something is tagged `remote`.** Not "usually";
 *     the audit's whole value is that the log can always tell a script from the
 *     window.
 */

interface Rig {
  readonly home: string
  readonly server: ControlServer
  readonly endpoint: string
  readonly logged: Record<string, unknown>[]
  readonly degraded: string[]
  readonly calls: string[]
  call(verb: string, args?: Record<string, string | string[]>): Promise<ControlAnswer>
  raw(
    body: string,
    options?: { method?: string; path?: string }
  ): Promise<{
    status: number
    body: string
  }>
  close(): Promise<void>
}

const rigs: Rig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close()
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

function stubDeps(
  logged: Record<string, unknown>[],
  calls: string[],
  overrides: Partial<ControlDeps> = {}
): ControlDeps {
  const deps = {
    consent: {
      view: () => {
        calls.push('consent.view')
        return {
          state: 'not-granted' as const,
          mayStartWork: false,
          because: 'nobody has said go',
          terms: 1,
          grantedAt: null,
          disclosure: {
            hire: { agentId: 'agent.artemis', engine: 'claude' },
            triggers: [{ id: 'standup', everyMs: 86_400_000 }],
            dailyCeiling: null
          }
        }
      },
      grant: () => {
        calls.push('consent.grant')
        return {
          ok: true,
          reason: null,
          view: {
            state: 'granted' as const,
            mayStartWork: true,
            because: 'granted',
            terms: 1,
            grantedAt: '2026-09-08T10:00:00.000Z',
            disclosure: { hire: null, triggers: [], dailyCeiling: null }
          }
        }
      }
    },
    agents: {
      list: () => {
        calls.push('agents.list')
        return [
          { agentId: 'agent.artemis', lifecycle: 'running', role: 'orchestrator', engine: 'claude' }
        ]
      }
    },
    agora: {
      appendLog: (draft: Record<string, unknown>) => {
        logged.push(draft)
        return { ...draft, ts: 0, seq: logged.length }
      },
      tailLog: (limit: number) => {
        calls.push(`agora.tailLog:${String(limit)}`)
        return [{ ts: 0, seq: 1, kind: 'spawn', event: 'spawned' }]
      }
    },
    profilesList: () => {
      calls.push('profilesList')
      return [
        { name: 'skeleton-crew', source: 'builtin', valid: true, version: 1, knownTargets: [] }
      ]
    },
    profilesInstances: () => {
      calls.push('profilesInstances')
      return []
    },
    profilesActivate: (request: unknown) => {
      calls.push(`profilesActivate:${JSON.stringify(request)}`)
      return Promise.resolve({
        ok: true,
        instance: {
          instanceId: 'skeleton-crew@repo:myapp',
          agentIds: ['agent.mason@myapp'],
          armed: ['sweep'],
          pendingEvents: [],
          activatedAt: '2026-09-08T10:00:00.000Z',
          plan: {
            targetRef: 'repo:myapp',
            targetPath: 'C:\\src\\myapp',
            repos: ['me/myapp'],
            reposBecause: 'read off the checkout’s origin remote'
          }
        }
      })
    },
    profilesDeactivate: (instanceId: string) => {
      calls.push(`profilesDeactivate:${instanceId}`)
      return { ok: true, reason: null }
    },
    convene: (attendees: readonly string[], agenda: string) => {
      calls.push(`convene:${attendees.join('+')}:${agenda}`)
      return { ok: true, id: 'meeting-1' }
    },
    diagnosis: { snapshot: () => SNAPSHOT },
    ...overrides
  }
  return deps as unknown as ControlDeps
}

async function startRig(overrides: Partial<ControlDeps> = {}): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-'))
  const logged: Record<string, unknown>[] = []
  const degraded: string[] = []
  const calls: string[] = []
  const server = new ControlServer({
    deps: stubDeps(logged, calls, overrides),
    onDegraded: (detail) => degraded.push(detail)
  })
  const endpoint = await server.start(home)

  const raw = (
    body: string,
    options: { method?: string; path?: string } = {}
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: endpoint,
          path: options.path ?? CONTROL_ENDPOINT_PATH,
          method: options.method ?? 'POST',
          headers: { 'content-type': 'application/json' }
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => (text += chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
        }
      )
      req.on('error', reject)
      req.end(body)
    })

  const rig: Rig = {
    home,
    server,
    endpoint,
    logged,
    degraded,
    calls,
    raw,
    async call(verb, args = {}) {
      const answered = await raw(
        JSON.stringify({ schemaVersion: CONTROL_SCHEMA_VERSION, verb, args })
      )
      return JSON.parse(answered.body) as ControlAnswer
    },
    async close() {
      await server.stop()
      removeTempDir(home)
    }
  }
  rigs.push(rig)
  return rig
}

describe('the endpoint', () => {
  it('listens where the home says it does, and advertises it', async () => {
    const rig = await startRig()
    expect(rig.endpoint).toBe(controlEndpointFor(rig.home))

    const advertised = controlAddressSchema.parse(
      JSON.parse(fs.readFileSync(path.join(rig.home, CONTROL_ADDRESS_FILE), 'utf8'))
    )
    expect(advertised.endpoint).toBe(rig.endpoint)
    expect(advertised.path).toBe(CONTROL_ENDPOINT_PATH)
    expect(advertised.pid).toBe(process.pid)
  })

  it('gives two homes two addresses, so they cannot collide', async () => {
    const a = await startRig()
    const b = await startRig()
    expect(a.endpoint).not.toBe(b.endpoint)
  })

  it('takes the address away when the harness stops', async () => {
    const rig = await startRig()
    const advertised = path.join(rig.home, CONTROL_ADDRESS_FILE)
    expect(fs.existsSync(advertised)).toBe(true)
    await rig.server.stop()
    // So a CLI run after a clean quit says "no harness is running" rather than
    // "nothing is listening at the address I found".
    expect(fs.existsSync(advertised)).toBe(false)
  })

  it('stamps the address with the clock it was given', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-clock-'))
    const server = new ControlServer({
      deps: stubDeps([], []),
      onDegraded: () => undefined,
      now: () => new Date('2026-09-08T10:00:00.000Z')
    })
    await server.start(home)
    const advertised = controlAddressSchema.parse(
      JSON.parse(fs.readFileSync(path.join(home, CONTROL_ADDRESS_FILE), 'utf8'))
    )
    expect(advertised.startedAt).toBe('2026-09-08T10:00:00.000Z')
    await server.stop()
    removeTempDir(home)
  })

  it('refuses to start twice on one home', async () => {
    const rig = await startRig()
    await expect(rig.server.start(rig.home)).rejects.toThrow('already started')
  })

  it('serves POST /control and nothing else', async () => {
    const rig = await startRig()
    const wrongPath = await rig.raw('{}', { path: '/hook' })
    expect(wrongPath.status).toBe(404)
    expect(JSON.parse(wrongPath.body).text).toContain(CONTROL_ENDPOINT_PATH)
    const wrongMethod = await rig.raw('', { method: 'GET' })
    expect(wrongMethod.status).toBe(404)
  })

  it('serves anyway, visibly, when it cannot advertise its address', async () => {
    // A DIRECTORY where the address file belongs: the atomic rename onto it
    // fails on every platform, so the failure is forced rather than hoped for.
    // Invariant §7 — the endpoint is still up, the give-up is visible, and the
    // app survives it, because a CLI can still be pointed at the address by hand.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-noaddr-'))
    fs.mkdirSync(path.join(home, CONTROL_ADDRESS_FILE))
    const degraded: string[] = []
    const server = new ControlServer({
      deps: stubDeps([], []),
      onDegraded: (detail) => degraded.push(detail)
    })
    const endpoint = await server.start(home)
    expect(endpoint).toBe(controlEndpointFor(home))
    expect(degraded.join('\n')).toContain(CONTROL_ADDRESS_FILE)
    expect(degraded.join('\n')).toContain('ephctl cannot find it')

    // And it still answers: the surface is degraded, not down.
    const answered = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { socketPath: endpoint, path: CONTROL_ENDPOINT_PATH, method: 'POST' },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ schemaVersion: CONTROL_SCHEMA_VERSION, verb: 'help', args: {} }))
    })
    expect(answered).toBe(200)

    await server.stop()
    removeTempDir(home)
  })
})

describe('the four refusals', () => {
  const four = ['watch:approve', 'odeon:verdict', 'secrets:set', 'gym:set-mode'] as const

  it('are refused by name, with a reason, and a 403', async () => {
    const rig = await startRig()
    for (const verb of four) {
      const answered = await rig.raw(
        JSON.stringify({ schemaVersion: CONTROL_SCHEMA_VERSION, verb, args: {} })
      )
      expect(answered.status).toBe(403)
      const answer = JSON.parse(answered.body) as ControlAnswer
      expect(answer.ok).toBe(false)
      expect(answer.verb).toBe(verb)
      expect(answer.text).toContain('deliberately not scriptable')
      expect(answer.text).toContain('only a human may')
    }
  })

  it('reach the book of record — an attempted escalation is what an audit wants', async () => {
    const rig = await startRig()
    for (const verb of four) await rig.call(verb)
    expect(rig.logged).toHaveLength(four.length)
    for (const [index, entry] of rig.logged.entries()) {
      expect(entry['kind']).toBe('remote')
      expect(entry['event']).toBe('control')
      expect(entry['channel']).toBe('remote')
      expect(entry['verb']).toBe(four[index])
      expect(entry['ok']).toBe(false)
    }
  })

  it('touch nothing — no dep is called on the way to a refusal', async () => {
    const rig = await startRig()
    for (const verb of four) await rig.call(verb)
    expect(rig.calls).toEqual([])
  })

  it('are refused even when arguments would have made them valid', async () => {
    const rig = await startRig()
    const answer = await rig.call('watch:approve', { gateId: 'gate-1', verdict: 'approve' })
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('WATCH')
  })
})

describe('an unknown verb', () => {
  it('teaches the shape of the surface instead of 404ing silently', async () => {
    const rig = await startRig()
    const answered = await rig.raw(
      JSON.stringify({ schemaVersion: CONTROL_SCHEMA_VERSION, verb: 'company:stop', args: {} })
    )
    expect(answered.status).toBe(404)
    const answer = JSON.parse(answered.body) as ControlAnswer
    expect(answer.text).toContain('no such verb')
    expect(answer.text).toContain('consent:grant')
    expect(answer.text).toContain('watch:approve')
  })

  it('is not written down — nothing happened and nothing was attempted', async () => {
    const rig = await startRig()
    await rig.call('company:stop')
    expect(rig.logged).toEqual([])
  })
})

describe('validation, in main', () => {
  it('refuses a body that is not JSON', async () => {
    const rig = await startRig()
    const answered = await rig.raw('{oh no')
    expect(answered.status).toBe(400)
    expect(JSON.parse(answered.body).text).toContain('not valid JSON')
  })

  it('names the request itself when the fault is not in a field', async () => {
    // A valid JSON body that is not an object at all: the issue carries no path,
    // and the answer must still say WHAT was wrong rather than printing ": …".
    const rig = await startRig()
    const answered = await rig.raw('"hello"')
    expect(answered.status).toBe(400)
    expect(JSON.parse(answered.body).text).toContain('request:')
  })

  it('refuses an envelope missing its verb', async () => {
    const rig = await startRig()
    const answered = await rig.raw(JSON.stringify({ schemaVersion: 1 }))
    expect(answered.status).toBe(400)
    expect(JSON.parse(answered.body).text).toContain('malformed request')
  })

  it('refuses a bad argument and prints the usage', async () => {
    const rig = await startRig()
    const answer = await rig.call('profile:activate', { profile: 'skeleton-crew' })
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain('Usage:')
    expect(rig.calls).toEqual([])
  })

  it('refuses a body larger than the limit rather than reading it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-big-'))
    const server = new ControlServer({
      deps: stubDeps([], []),
      onDegraded: () => undefined,
      maxBodyBytes: 64
    })
    const endpoint = await server.start(home)
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { socketPath: endpoint, path: CONTROL_ENDPOINT_PATH, method: 'POST' },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ schemaVersion: 1, verb: 'status', args: { pad: 'x'.repeat(4096) } }))
    })
    expect(status).toBe(413)
    await server.stop()
    removeTempDir(home)
  })
})

describe('the acts a script may perform', () => {
  it('grants consent through the same CompanyStart the window reaches', async () => {
    const rig = await startRig()
    const answer = await rig.call('consent:grant')
    expect(answer.ok).toBe(true)
    expect(rig.calls).toContain('consent.grant')
    expect(rig.logged).toHaveLength(1)
    expect(rig.logged[0]).toMatchObject({
      kind: 'remote',
      event: 'control',
      channel: 'remote',
      verb: 'consent:grant',
      ok: true
    })
  })

  it('reads consent without granting it, and states what granting would do', async () => {
    const rig = await startRig()
    const answer = await rig.call('consent:status')
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain('agent.artemis on claude')
    expect(answer.text).toContain('unbudgeted')
    expect(rig.calls).toContain('consent.view')
    expect(rig.calls).not.toContain('consent.grant')
  })

  it('activates a profile through the SAME request shape the window sends', async () => {
    const rig = await startRig()
    const answer = await rig.call('profile:activate', {
      profile: 'skeleton-crew',
      target: 'repo:myapp',
      path: 'C:\\src\\myapp'
    })
    expect(answer.ok).toBe(true)
    expect(rig.calls).toContain(
      `profilesActivate:${JSON.stringify({
        profile: 'skeleton-crew',
        target: { kind: 'repo', id: 'myapp', path: 'C:\\src\\myapp' }
      })}`
    )
    // The clause the exit run needs: the answer says which repository.
    expect(answer.text).toContain('me/myapp')
    expect(answer.text).toContain('repo:myapp')
  })

  it('deactivates, convenes, and lists, each through its own dep', async () => {
    const rig = await startRig()
    expect(
      (await rig.call('profile:deactivate', { instance: 'skeleton-crew@repo:myapp' })).ok
    ).toBe(true)
    expect(
      (await rig.call('odeon:convene', { attendee: 'agent.artemis', agenda: 'the CI failure' })).ok
    ).toBe(true)
    expect((await rig.call('agents:list')).ok).toBe(true)
    expect((await rig.call('profile:list')).ok).toBe(true)
    expect((await rig.call('profile:instances')).ok).toBe(true)
    expect(rig.calls).toEqual([
      'profilesDeactivate:skeleton-crew@repo:myapp',
      'convene:agent.artemis:the CI failure',
      'agents.list',
      'profilesList',
      'profilesInstances'
    ])
  })

  it('tails the log at the limit asked for', async () => {
    const rig = await startRig()
    const answer = await rig.call('log:tail', { limit: '7' })
    expect(answer.ok).toBe(true)
    expect(rig.calls).toContain('agora.tailLog:7')
  })

  it('answers status from the SAME fold DIAGNOSIS.md is written from', async () => {
    const rig = await startRig()
    const answer = await rig.call('status')
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain('consent: NOT granted')
    // The rendered report, from one snapshot — never a second opinion.
    const report = await rig.call('diagnosis')
    expect(report.text).toContain('# Ephesus — what is working')
  })

  it('answers help without touching a single dep', async () => {
    const rig = await startRig()
    const answer = await rig.call('help')
    expect(answer.ok).toBe(true)
    expect(answer.text).toContain('It operates the company.')
    expect(rig.calls).toEqual([])
  })
})

describe('the audit tag', () => {
  it('is written for every act that changes something', async () => {
    const rig = await startRig()
    await rig.call('consent:grant')
    await rig.call('profile:activate', {
      profile: 'skeleton-crew',
      target: 'repo:myapp',
      path: 'C:\\src\\myapp'
    })
    await rig.call('profile:deactivate', { instance: 'skeleton-crew@repo:myapp' })
    await rig.call('odeon:convene', { attendee: 'agent.artemis', agenda: 'x' })
    expect(rig.logged.map((entry) => entry['verb'])).toEqual([
      'consent:grant',
      'profile:activate',
      'profile:deactivate',
      'odeon:convene'
    ])
    for (const entry of rig.logged) {
      expect(entry['kind']).toBe('remote')
      expect(entry['channel']).toBe('remote')
    }
  })

  it('is NOT written for a read, so a polled status cannot bury the log', async () => {
    const rig = await startRig()
    await rig.call('status')
    await rig.call('diagnosis')
    await rig.call('consent:status')
    await rig.call('agents:list')
    await rig.call('profile:list')
    await rig.call('profile:instances')
    await rig.call('log:tail')
    await rig.call('help')
    expect(rig.logged).toEqual([])
  })

  it('records a refused act as ok:false, distinguishable from one that worked', async () => {
    const rig = await startRig({
      profilesDeactivate: () => ({ ok: false, reason: 'no such instance' })
    })
    const answer = await rig.call('profile:deactivate', { instance: 'ghost@repo:none' })
    expect(answer.ok).toBe(false)
    expect(rig.logged[0]).toMatchObject({ verb: 'profile:deactivate', ok: false })
    expect(String(rig.logged[0]?.['because'])).toContain('no such instance')
  })

  it('reports rather than throws when the book of record cannot be written', async () => {
    // A control act that took the surface down because the Agora was unwritable
    // would be a worse failure than a missing row.
    const rig = await startRig({
      agora: {
        appendLog: () => {
          throw new Error('agora is read-only')
        },
        tailLog: () => []
      } as unknown as ControlDeps['agora']
    })
    const answer = await rig.call('consent:grant')
    expect(answer.ok).toBe(true)
    expect(rig.degraded.join('\n')).toContain('could not be written to the book of record')
  })
})

describe('a dep that throws', () => {
  it('describes a thrown NON-Error rather than printing [object Object]', async () => {
    const rig = await startRig({
      profilesList: () => {
        throw 'the profiles directory vanished'
      }
    })
    const answered = await rig.raw(
      JSON.stringify({ schemaVersion: CONTROL_SCHEMA_VERSION, verb: 'profile:list', args: {} })
    )
    expect(answered.status).toBe(500)
    expect(JSON.parse(answered.body).text).toContain('the profiles directory vanished')
  })

  it('is answered as a failure, and reported, never as an unhandled rejection', async () => {
    const rig = await startRig({
      profilesList: () => {
        throw new Error('the profiles directory vanished')
      }
    })
    const answered = await rig.raw(
      JSON.stringify({ schemaVersion: CONTROL_SCHEMA_VERSION, verb: 'profile:list', args: {} })
    )
    expect(answered.status).toBe(500)
    expect(JSON.parse(answered.body).text).toContain('the profiles directory vanished')
    expect(rig.degraded.join('\n')).toContain('failed to answer')
  })
})

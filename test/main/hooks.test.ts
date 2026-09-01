import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_ENVELOPE_SCHEMA_VERSION } from '../../src/shared/hooks'
import { HookServer, HOOK_SOCKET_MODE, hookEndpointFor } from '../../src/main/hooks'
import type { HookEventRecord, HookRejection } from '../../src/main/hooks'
import { postHookEvent, buildEnvelope } from '../../shims/hook-client.mjs'
import { removeTempDir } from '../tmpdir'

/**
 * Integration over a real socket / real named pipe in a temp harness home
 * (EPH_HOME discipline, TEST-STRATEGY §4) — the transport is the mechanism
 * under test, so nothing here is mocked.
 */

interface Rig {
  readonly server: HookServer
  readonly endpoint: string
  readonly home: string
  readonly events: HookEventRecord[]
  readonly rejections: HookRejection[]
}

const rigs: Rig[] = []
const homes: string[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.server.stop()
  for (const home of homes.splice(0)) removeTempDir(home)
})

async function startRig(): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-home-'))
  homes.push(home)
  const events: HookEventRecord[] = []
  const rejections: HookRejection[] = []
  const server = new HookServer({
    onEvent: (record) => {
      events.push(record)
    },
    onRejected: (rejection) => rejections.push(rejection)
  })
  const endpoint = await server.start(home)
  const rig: Rig = { server, endpoint, home, events, rejections }
  rigs.push(rig)
  return rig
}

function envelope(over: Partial<Parameters<typeof buildEnvelope>[0]> = {}) {
  return buildEnvelope({
    agentId: 'agent.mason',
    token: 'spawn-token-1',
    event: 'pre-tool',
    sessionId: 'sess-1',
    payload: { tool: 'Read' },
    ts: 1724668800123,
    ...over
  })
}

describe('hook server — transport (FR-2.1)', () => {
  it('listens on a per-home endpoint and reports it', async () => {
    const rig = await startRig()
    expect(rig.server.endpoint()).toBe(rig.endpoint)
    expect(rig.endpoint).toBe(hookEndpointFor(rig.home))
  })

  it('isolates two harness homes on distinct endpoints', async () => {
    const a = await startRig()
    const b = await startRig()
    expect(a.endpoint).not.toBe(b.endpoint)
  })

  it.runIf(process.platform !== 'win32')('creates the socket owner-only (0600)', async () => {
    const rig = await startRig()
    expect(rig.endpoint.endsWith('events.sock')).toBe(true)
    expect(fs.statSync(rig.endpoint).mode & 0o777).toBe(HOOK_SOCKET_MODE)
  })

  it.runIf(process.platform === 'win32')(
    'uses the local named-pipe namespace on Windows (the 0600 equivalent)',
    async () => {
      const rig = await startRig()
      // `\\.\pipe\` is machine-local by construction: libuv rejects remote
      // clients, which is what stands in for a mode a pipe cannot carry.
      expect(rig.endpoint.startsWith('\\\\.\\pipe\\ephesus-events-')).toBe(true)
      expect(fs.existsSync(path.join(rig.home, 'events.sock'))).toBe(false)
    }
  )

  it.runIf(process.platform !== 'win32')(
    'clears a socket left behind by a crashed run',
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-home-'))
      homes.push(home)
      fs.writeFileSync(hookEndpointFor(home), 'stale', 'utf8')
      const server = new HookServer({ onEvent: () => {}, onRejected: () => {} })
      const endpoint = await server.start(home)
      rigs.push({ server, endpoint, home, events: [], rejections: [] })
      expect(endpoint).toBe(hookEndpointFor(home))
    }
  )

  it('removes the socket on stop so the next boot binds cleanly', async () => {
    const rig = await startRig()
    await rig.server.stop()
    rigs.length = 0
    expect(rig.server.endpoint()).toBeNull()
    if (process.platform !== 'win32') expect(fs.existsSync(rig.endpoint)).toBe(false)
  })
})

describe('hook server — authentication (ENGINEERING-STANDARDS §5)', () => {
  it('accepts a payload carrying the registered per-spawn token', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')

    const delivery = await postHookEvent(rig.endpoint, envelope())

    expect(delivery.delivered).toBe(true)
    expect(rig.events).toHaveLength(1)
    expect(rig.events[0]?.envelope.event).toBe('pre-tool')
    expect(rig.events[0]?.warning).toBeNull()
    expect(rig.events[0]?.receivedAt).toBeGreaterThan(0)
    expect(rig.rejections).toEqual([])
  })

  it('validates the token on every payload, not once per connection', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')

    await postHookEvent(rig.endpoint, envelope())
    rig.server.unregisterSpawn('agent.mason')
    const second = await postHookEvent(rig.endpoint, envelope())

    expect(second.delivered).toBe(false)
    expect(second.status).toBe(401)
    expect(rig.events).toHaveLength(1)
    expect(rig.rejections.at(-1)?.reason).toContain('no live spawn registered')
  })

  it('rejects a wrong token and never echoes the presented credential', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')

    const delivery = await postHookEvent(rig.endpoint, envelope({ token: 'stolen-token' }))

    expect(delivery.delivered).toBe(false)
    expect(delivery.status).toBe(401)
    expect(rig.events).toEqual([])
    const rejection = rig.rejections.at(-1)
    expect(rejection?.reason).toContain('token mismatch')
    expect(rejection?.agentId).toBe('agent.mason')
    expect(rejection?.reason).not.toContain('stolen-token')
    expect(rejection?.reason).not.toContain('spawn-token-1')
  })

  it('rejects a token registered for a different agent', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')
    rig.server.registerSpawn('agent.artemis', 'spawn-token-2')

    const delivery = await postHookEvent(
      rig.endpoint,
      envelope({ agentId: 'agent.artemis', token: 'spawn-token-1' })
    )

    expect(delivery.status).toBe(401)
    expect(rig.events).toEqual([])
  })

  it('refuses to register an empty spawn token', async () => {
    const rig = await startRig()
    expect(() => rig.server.registerSpawn('agent.mason', '')).toThrow(/empty spawn token/)
  })
})

describe('hook server — malformed input (FR-2.3: rejected and reported, never silent)', () => {
  it('rejects a non-JSON body', async () => {
    const rig = await startRig()
    const delivery = await postRaw(rig.endpoint, 'not json at all')
    expect(delivery.status).toBe(400)
    expect(rig.rejections.at(-1)?.reason).toContain('not valid JSON')
    expect(rig.events).toEqual([])
  })

  it('rejects an envelope with an unknown top-level key, naming the agent', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')
    const delivery = await postRaw(
      rig.endpoint,
      JSON.stringify({ ...envelope(), rogueField: 'surprise' })
    )
    expect(delivery.status).toBe(400)
    expect(rig.rejections.at(-1)?.reason).toContain('malformed envelope')
    expect(rig.rejections.at(-1)?.agentId).toBe('agent.mason')
    expect(rig.events).toEqual([])
  })

  it('rejects a drifted envelope schemaVersion', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')
    const delivery = await postRaw(
      rig.endpoint,
      JSON.stringify({ ...envelope(), schemaVersion: HOOK_ENVELOPE_SCHEMA_VERSION + 1 })
    )
    expect(delivery.status).toBe(400)
    expect(rig.events).toEqual([])
  })

  it('rejects an oversized body without accepting a partial event', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-home-'))
    homes.push(home)
    const rejections: HookRejection[] = []
    const server = new HookServer({
      onEvent: () => {},
      onRejected: (r) => rejections.push(r),
      maxBodyBytes: 512
    })
    const endpoint = await server.start(home)
    rigs.push({ server, endpoint, home, events: [], rejections })
    server.registerSpawn('agent.mason', 'spawn-token-1')

    await postRaw(endpoint, JSON.stringify(envelope({ payload: { tool: 'x'.repeat(2000) } })))

    expect(rejections.at(-1)?.reason).toContain('exceeds 512 bytes')
  })

  it('rejects a request to the wrong path or method', async () => {
    const rig = await startRig()
    const delivery = await postRaw(rig.endpoint, '{}', '/not-the-hook')
    expect(delivery.status).toBe(404)
    expect(rig.rejections.at(-1)?.reason).toContain('/not-the-hook')
  })
})

describe('hook server — schema drift (FR-2.3: accepted with a visible warning)', () => {
  it('accepts an unknown event name and records a drift warning', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')

    const delivery = await postHookEvent(rig.endpoint, envelope({ event: 'SubagentStop' }))

    expect(delivery.delivered).toBe(true)
    expect(rig.events).toHaveLength(1)
    expect(rig.events[0]?.known).toBe(false)
    expect(rig.events[0]?.envelope.event).toBe('SubagentStop')
    expect(rig.events[0]?.warning).toContain('unknown hook event "SubagentStop"')
    expect(rig.server.driftWarnings()).toHaveLength(1)
    expect(rig.rejections).toEqual([])
  })

  it('accepts a drifted payload for a known event and warns about the missing field', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')

    const delivery = await postHookEvent(rig.endpoint, envelope({ payload: { toolName: 'Read' } }))

    expect(delivery.delivered).toBe(true)
    expect(rig.events[0]?.known).toBe(true)
    expect(rig.events[0]?.warning).toContain('hook payload drift on "pre-tool"')
    expect(rig.events[0]?.warning).toContain('tool')
  })

  it('accepts extra payload fields without warning (engines may grow)', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')

    await postHookEvent(rig.endpoint, envelope({ payload: { tool: 'Read', newField: [1, 2] } }))

    expect(rig.events[0]?.warning).toBeNull()
    expect(rig.server.driftWarnings()).toEqual([])
  })

  it('keeps one entry per distinct warning, however often the drift repeats', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')

    await postHookEvent(rig.endpoint, envelope({ event: 'SubagentStop' }))
    await postHookEvent(rig.endpoint, envelope({ event: 'SubagentStop' }))
    await postHookEvent(rig.endpoint, envelope({ event: 'PreCompact' }))

    expect(rig.server.driftWarnings()).toHaveLength(2)
    expect(rig.events).toHaveLength(3)
  })
})

describe('hook server — fail-open for the agent (SDD §10)', () => {
  it('leaves a posting agent unharmed when the endpoint is gone', async () => {
    const rig = await startRig()
    rig.server.registerSpawn('agent.mason', 'spawn-token-1')
    await rig.server.stop()
    rigs.length = 0

    const delivery = await postHookEvent(rig.endpoint, envelope(), 1000)

    expect(delivery.delivered).toBe(false)
    expect(delivery.error).toBeTruthy()
  })
})

describe('hook server — async replies (ADR-0013 hand-over)', () => {
  it('relays a reply the handler resolves asynchronously', async () => {
    // decideOnStop consumes the inbox before replying, so onEvent may return a
    // promise; the engine must still receive the decision in the response body.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-home-'))
    homes.push(home)
    const server = new HookServer({
      onEvent: async () => {
        await new Promise((resolve) => setImmediate(resolve))
        return { decision: 'block' as const, reason: 'mail handed over' }
      },
      onRejected: () => {}
    })
    const endpoint = await server.start(home)
    rigs.push({ server, endpoint, home, events: [], rejections: [] })
    server.registerSpawn('agent.mason', 'spawn-token-1')

    const delivery = await postHookEvent(endpoint, envelope({ event: 'stop', payload: {} }))

    expect(delivery.delivered).toBe(true)
    expect(JSON.parse(delivery.body ?? '{}')).toMatchObject({
      ok: true,
      decision: 'block',
      reason: 'mail handed over'
    })
  })

  it('fails open and reports when the handler itself throws', async () => {
    // A harness-side failure must never fail the agent's hook post (SDD §10)
    // and must never become an unhandledRejection — it is reported instead.
    const seen: unknown[] = []
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-home-'))
    homes.push(home)
    const server = new HookServer({
      onEvent: async () => {
        throw new Error('handler blew up')
      },
      onRejected: () => {},
      onEventError: (err) => seen.push(err)
    })
    const endpoint = await server.start(home)
    rigs.push({ server, endpoint, home, events: [], rejections: [] })
    server.registerSpawn('agent.mason', 'spawn-token-1')

    const unhandled: unknown[] = []
    const capture = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', capture)
    try {
      const delivery = await postHookEvent(endpoint, envelope({ event: 'stop', payload: {} }))
      expect(delivery.delivered).toBe(true)
      expect(JSON.parse(delivery.body ?? '{}')).toMatchObject({ ok: true })
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', capture)
    }

    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toMatch(/handler blew up/)
    expect(unhandled).toEqual([])
  })
})

/** Posts a raw body, bypassing the client's envelope building. */
async function postRaw(
  endpoint: string,
  body: string,
  urlPath = '/hook'
): Promise<{ status: number | null }> {
  const http = await import('node:http')
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: endpoint,
        path: urlPath,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? null }))
      }
    )
    req.on('error', () => resolve({ status: null }))
    req.end(body)
  })
}

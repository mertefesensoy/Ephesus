import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HookServer } from '../../src/main/hooks'
import {
  GH_TOKEN_ENDPOINT_PATH,
  GH_TOKEN_SCHEMA_VERSION,
  type GhTokenResponse
} from '../../src/shared/gh-token'
// Through the shim's own helper, so the test exercises the path an agent
// actually takes rather than a second client that could drift from it.
import { postGhToken } from '../../shims/eph-gh-token.mjs'
import { postJson } from '../../shims/hook-client.mjs'

const temps: string[] = []
const servers: HookServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface Rig {
  readonly endpoint: string
  readonly ask: (agentId: string, token: string) => Promise<{ status: number | null; body: string }>
}

async function rig(
  onGhToken?: (agentId: string) => GhTokenResponse,
  grants: readonly string[] = []
): Promise<Rig> {
  void grants
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ghtok-'))
  temps.push(root)
  const server = new HookServer({
    onEvent: () => undefined,
    onRejected: () => undefined,
    ...(onGhToken ? { onGhToken } : {})
  })
  servers.push(server)
  const endpoint = await server.start(root)
  server.registerSpawn('agent.mason', 'spawn-token-1')
  return {
    endpoint,
    ask: async (agentId, token) => {
      const answer = await postGhToken(endpoint, {
        schemaVersion: GH_TOKEN_SCHEMA_VERSION,
        token,
        agentId
      })
      return { status: answer.status, body: answer.body }
    }
  }
}

const granted = (): GhTokenResponse => ({
  schemaVersion: GH_TOKEN_SCHEMA_VERSION,
  ok: true,
  token: 'a-fresh-installation-token',
  expiresAt: null
})

/**
 * A running agent's way to a fresh GitHub credential (ADR-0022).
 *
 * An installation token lives an hour; an agent holds the copy it was spawned
 * with for as long as it runs. Without this, a crew member still working after
 * an hour pushes with a dead credential and reads the 401 as "I lack
 * permission" — the worst possible misreading, because it is the one that makes
 * an agent stop trying rather than ask.
 *
 * This answer IS a credential, which is what makes the refusal paths the
 * important ones.
 */
describe('handing a running agent a fresh GitHub token', () => {
  it('answers an agent the harness actually spawned', async () => {
    const r = await rig(granted)
    const answer = await r.ask('agent.mason', 'spawn-token-1')
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toMatchObject({ ok: true, token: 'a-fresh-installation-token' })
  })

  it('refuses a wrong per-spawn token, and hands back nothing', async () => {
    const r = await rig(granted)
    const answer = await r.ask('agent.mason', 'not-the-token')
    expect(answer.status).toBe(401)
    expect(answer.body).not.toContain('a-fresh-installation-token')
  })

  it('refuses an agent that is not live at all', async () => {
    const r = await rig(granted)
    const answer = await r.ask('agent.stranger', 'spawn-token-1')
    expect(answer.status).toBe(401)
    expect(answer.body).not.toContain('a-fresh-installation-token')
  })

  it('never repeats the presented token back in the refusal', async () => {
    // The reason goes to log.jsonl, and a credential does not go in logs.
    const r = await rig(granted)
    const answer = await r.ask('agent.mason', 'sensitive-guess')
    expect(answer.body).not.toContain('sensitive-guess')
  })

  it('says why, rather than 404ing, when no company identity is configured', async () => {
    const r = await rig(undefined)
    const answer = await r.ask('agent.mason', 'spawn-token-1')
    expect(answer.status).toBe(503)
    expect(answer.body).toContain('no company GitHub identity')
  })

  /**
   * The refusal that carries the least-privilege rule: the endpoint's own gate
   * proves only that a live agent is asking. Whether it may HAVE this is
   * decided by the same thing that decided at spawn — whether its hire declared
   * the grant. Without it the researcher, whose spawns are no-secrets by
   * NFR-17, could ask for the company credential and be given it.
   */
  it('refuses a role that never declared the grant, with a reason it can act on', async () => {
    const r = await rig(() => ({
      schemaVersion: GH_TOKEN_SCHEMA_VERSION,
      ok: false,
      because: 'your role does not declare GH_TOKEN'
    }))
    const answer = await r.ask('agent.mason', 'spawn-token-1')
    expect(answer.status).toBe(403)
    const body = JSON.parse(answer.body) as { ok: boolean; token?: string; because: string }
    expect(body.ok).toBe(false)
    expect(body.token).toBeUndefined()
    expect(body.because).toContain('does not declare')
  })

  it('refuses a malformed request without reaching the identity at all', async () => {
    let called = 0
    const r = await rig(() => {
      called += 1
      return granted()
    })
    const answer = await postJson(r.endpoint, GH_TOKEN_ENDPOINT_PATH, { nonsense: true }, 5000)
    expect(answer.status).toBe(400)
    expect(called).toBe(0)
  })
})

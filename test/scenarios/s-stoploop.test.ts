import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_BLOCK_CAP, PATHOLOGY_SIGNAL_AT } from '../../src/shared/autonomy'
import { cleanupHomes, startCompany, scenarioMessage, sendStep, type Company } from './company'

/**
 * **S-STOPLOOP** (TEST-STRATEGY §3): "fake engine's Stop hook cycles with
 * pending mail; assert `stop_hook_active` respected, hard block-cap honored,
 * breaker rung 1 on pathology."
 *
 * The Stop hook is fired by the REAL `eph-hook.mjs` shim as a spawned process,
 * because the thing under test is the whole loop — engine → shim → socket →
 * guards → reply → engine. A harness that decides correctly but never gets the
 * decision back to the agent is the exact defect this caught during M2.5.
 */

const SHIM = fileURLToPath(new URL('../../shims/eph-hook.mjs', import.meta.url))

let company: Company | null = null

afterEach(async () => {
  await company?.close()
  company = null
  cleanupHomes()
})

/** Fires one Stop hook the way an engine does, returning what it printed. */
function fireStopHook(
  endpoint: string,
  agentId: string,
  payload: Record<string, unknown>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SHIM, '--event', 'stop', '--session-field', 'session_id'],
      {
        env: {
          ...process.env,
          EPH_AGENT_ID: agentId,
          EPH_HOOK_TOKEN: `token-${agentId}`,
          EPH_HOOK_ENDPOINT: endpoint
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stderr.resume()
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', reject)
    child.on('close', () => resolve(stdout))
    child.stdin.end(JSON.stringify(payload))
  })
}

async function withMail(options: Parameters<typeof startCompany>[0] = {}): Promise<Company> {
  const c = await startCompany(options)
  c.hire('agent.a')
  c.hire('agent.b')
  await c.runTurn('agent.a', [
    sendStep(scenarioMessage({ from: 'agent.a', to: 'agent.b', act: 'request' }))
  ])
  await c.hermes.sweep()
  return c
}

describe('S-STOPLOOP', () => {
  it('continues the turn when mail is pending, all the way through the shim', async () => {
    company = await withMail()
    const endpoint = company.hookServer.endpoint() ?? ''

    const stdout = await fireStopHook(endpoint, 'agent.b', { session_id: 's1' })

    const reply = JSON.parse(stdout.trim()) as { decision: string; reason: string }
    expect(reply.decision).toBe('block')
    expect(reply.reason).toContain('unread message')
    expect(company.hermes.blockCount('agent.b')).toBe(1)
  })

  it('ends the turn quietly when nothing is pending', async () => {
    company = await startCompany()
    company.hire('agent.b')

    const stdout = await fireStopHook(company.hookServer.endpoint() ?? '', 'agent.b', {
      session_id: 's1'
    })

    expect(stdout).toBe('')
    expect(company.hermes.blockCount('agent.b')).toBe(0)
  })

  it('respects stop_hook_active — a hook never chains off its own continuation', async () => {
    company = await withMail()
    const endpoint = company.hookServer.endpoint() ?? ''

    const stdout = await fireStopHook(endpoint, 'agent.b', {
      session_id: 's1',
      stop_hook_active: true
    })

    expect(stdout).toBe('')
    expect(company.hermes.blockCount('agent.b')).toBe(0)
  })

  it('honours the hard block cap even though the mail never goes away', async () => {
    company = await withMail({ blockCap: 4 })
    const endpoint = company.hookServer.endpoint() ?? ''

    const replies: string[] = []
    for (let turn = 0; turn < 10; turn += 1) {
      replies.push(await fireStopHook(endpoint, 'agent.b', { session_id: 's1' }))
    }

    // The first four continue the agent; every turn after that ends quietly.
    expect(replies.slice(0, 4).every((r) => r.includes('"decision":"block"'))).toBe(true)
    expect(replies.slice(4).every((r) => r === '')).toBe(true)
    expect(company.hermes.blockCount('agent.b')).toBe(4)

    // The mail really is still there — the cap stopped the loop, not the work.
    expect(company.hermes.pendingMailCount('agent.b')).toBe(1)
  })

  it('signals the breaker at rung 1 before the cap fires (ADR-0011)', async () => {
    const signals: { agentId: string; blocks: number }[] = []
    company = await withMail({
      blockCap: DEFAULT_BLOCK_CAP,
      onPathology: (agentId, blocks) => signals.push({ agentId, blocks })
    })
    const endpoint = company.hookServer.endpoint() ?? ''

    for (let turn = 0; turn < PATHOLOGY_SIGNAL_AT; turn += 1) {
      await fireStopHook(endpoint, 'agent.b', { session_id: 's1' })
    }

    expect(signals.at(-1)).toEqual({ agentId: 'agent.b', blocks: PATHOLOGY_SIGNAL_AT })
    // Signalled while the loop is still running, so rung 1 can steer before the
    // backstop stops the work outright.
    expect(PATHOLOGY_SIGNAL_AT).toBeLessThan(DEFAULT_BLOCK_CAP)
    expect(company.hermes.blockCount('agent.b')).toBeLessThan(DEFAULT_BLOCK_CAP)
  })

  it('leaves an auditable trail of every decision it made', async () => {
    company = await withMail({ blockCap: 2 })
    const endpoint = company.hookServer.endpoint() ?? ''

    await fireStopHook(endpoint, 'agent.b', { session_id: 's1' })
    await fireStopHook(endpoint, 'agent.b', { session_id: 's1', stop_hook_active: true })
    await fireStopHook(endpoint, 'agent.b', { session_id: 's1' })
    await fireStopHook(endpoint, 'agent.b', { session_id: 's1' })

    const stops = company.agora
      .readLog()
      .filter((e) => e['kind'] === 'hook' && e['event'] === 'stop')
      .map((e) => e['because'])

    expect(stops).toEqual(['pending-work', 'stop-hook-active', 'pending-work', 'block-cap-reached'])
  })

  it('gives a respawned agent a fresh budget', async () => {
    company = await withMail({ blockCap: 1 })
    const endpoint = company.hookServer.endpoint() ?? ''

    expect(await fireStopHook(endpoint, 'agent.b', { session_id: 's1' })).toContain('block')
    expect(await fireStopHook(endpoint, 'agent.b', { session_id: 's1' })).toBe('')

    company.hermes.resetSession('agent.b')

    expect(await fireStopHook(endpoint, 'agent.b', { session_id: 's2' })).toContain('block')
  })
})

/** Keeps the shim path honest if the file ever moves. */
it('runs the real shim, not a copy of it', () => {
  expect(path.basename(SHIM)).toBe('eph-hook.mjs')
})

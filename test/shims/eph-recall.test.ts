import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs, renderAnswer } from '../../shims/eph-recall.mjs'
import { HookServer } from '../../src/main/hooks'
import { Library } from '../../src/main/library'
import { PromptStore } from '../../src/main/prompts'
import { FtsIndex } from '../../src/main/library-fts'
import { removeTempDir } from '../tmpdir'

/**
 * `eph-recall` is what an agent actually runs, so it is exercised the way an
 * agent runs it: a spawned process talking to the real `HookServer` over a real
 * socket, answered by the real `Library`.
 *
 * The behaviour under test that matters most is the one this shim does
 * *differently* from `eph-hook`: it does not fail open. An agent that asked what
 * the company knows and got silence would conclude the company knows nothing.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SHIM = fileURLToPath(new URL('../../shims/eph-recall.mjs', import.meta.url))
const AGENT = 'agent.mason'
const TOKEN = 'recall-token'

interface Rig {
  readonly endpoint: string
  readonly library: Library
  close(): Promise<void>
}

const rigs: Rig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close()
})

async function startRig(options: { withLibrary?: boolean } = {}): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-recall-shim-'))
  const agoraRoot = path.join(home, 'agora')
  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))
  const library = new Library({
    agoraRoot,
    prompts,
    indexes: [new FtsIndex({ store: null, because: 'no keyword index in this test' })]
  })
  library.note(AGENT, AGENT, 'The checkout suite is flaky because the fixture seeds two carts.')

  const hookServer = new HookServer({
    onEvent: () => undefined,
    onRejected: () => undefined,
    ...(options.withLibrary === false
      ? {}
      : { onRecall: (request) => library.recall(request.query, request.scope, request.limit) })
  })
  const endpoint = await hookServer.start(home)
  hookServer.registerSpawn(AGENT, TOKEN)

  const rig: Rig = {
    endpoint,
    library,
    async close() {
      await hookServer.stop()
      removeTempDir(home)
    }
  }
  rigs.push(rig)
  return rig
}

function runShim(
  args: readonly string[],
  env: Readonly<Record<string, string>>
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

describe('parseArgs', () => {
  it('joins bare words into the query and reads the flags', () => {
    expect(parseArgs(['flaky', 'checkout', '--scope', 'agent.iris', '--limit', '3'])).toEqual({
      query: 'flaky checkout',
      scope: 'agent.iris',
      limit: 3,
      json: false
    })
  })

  it('takes the default limit for an unreadable one, never zero', () => {
    expect(parseArgs(['q', '--limit', 'lots']).limit).toBe(5)
    expect(parseArgs(['q', '--limit', '-4']).limit).toBe(5)
  })

  it('caps the limit', () => {
    expect(parseArgs(['q', '--limit', '9999']).limit).toBe(25)
  })
})

describe('renderAnswer', () => {
  it('names the rung on every answer, and the degradation when there is one', () => {
    const text = renderAnswer({
      query: 'q',
      rung: 'grep',
      degraded: 'fts: no keyword index',
      hits: [{ ref: '/a/memory.md', source: 'memory', scope: 'agent.a', title: 't', snippet: 's' }]
    })
    expect(text).toContain('[grep]')
    expect(text).toContain('recall degraded: fts: no keyword index')
    expect(text).toContain('/a/memory.md')
  })

  it('says an empty answer is an answer', () => {
    const text = renderAnswer({ query: 'q', rung: 'grep', degraded: null, hits: [] })
    expect(text).toContain('0 result(s)')
    expect(text).toContain('not a failure')
  })
})

describe('the shim against a real socket', () => {
  it('answers a real query from the real Library', async () => {
    const rig = await startRig()
    const result = await runShim(['flaky', 'checkout'], {
      EPH_AGENT_ID: AGENT,
      EPH_HOOK_TOKEN: TOKEN,
      EPH_HOOK_ENDPOINT: rig.endpoint
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('two carts')
    // The ladder is visible to the agent, not just to the Architect.
    expect(result.stdout).toContain('[grep]')
    expect(result.stdout).toContain('recall degraded: fts: no keyword index in this test')
  })

  it('speaks JSON when asked, for an agent that wants to parse it', async () => {
    const rig = await startRig()
    const result = await runShim(['flaky', 'checkout', '--json'], {
      EPH_AGENT_ID: AGENT,
      EPH_HOOK_TOKEN: TOKEN,
      EPH_HOOK_ENDPOINT: rig.endpoint
    })
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout) as { rung: string; hits: unknown[] }
    expect(parsed.rung).toBe('grep')
    expect(parsed.hits.length).toBeGreaterThan(0)
  })

  it('refuses a wrong token and says so, rather than answering nothing', async () => {
    const rig = await startRig()
    const result = await runShim(['flaky'], {
      EPH_AGENT_ID: AGENT,
      EPH_HOOK_TOKEN: 'not-the-token',
      EPH_HOOK_ENDPOINT: rig.endpoint
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('recall unavailable')
    expect(result.stdout).toBe('')
  })

  it('says the harness is unreachable rather than printing an empty result', async () => {
    const result = await runShim(['flaky'], {
      EPH_AGENT_ID: AGENT,
      EPH_HOOK_TOKEN: TOKEN,
      EPH_HOOK_ENDPOINT: path.join(os.tmpdir(), 'eph-no-such.sock')
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('recall unavailable')
  })

  it('says so when the harness has no Library at all', async () => {
    const rig = await startRig({ withLibrary: false })
    const result = await runShim(['flaky'], {
      EPH_AGENT_ID: AGENT,
      EPH_HOOK_TOKEN: TOKEN,
      EPH_HOOK_ENDPOINT: rig.endpoint
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no library configured')
  })

  it('refuses to run outside a harness spawn', async () => {
    const result = await runShim(['flaky'], {
      EPH_AGENT_ID: '',
      EPH_HOOK_TOKEN: '',
      EPH_HOOK_ENDPOINT: ''
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not started by the harness')
  })

  it('refuses an empty query', async () => {
    const rig = await startRig()
    const result = await runShim([], {
      EPH_AGENT_ID: AGENT,
      EPH_HOOK_TOKEN: TOKEN,
      EPH_HOOK_ENDPOINT: rig.endpoint
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('nothing to search for')
  })
})

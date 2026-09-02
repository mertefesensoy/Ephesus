import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseHookEnvelope } from '../../src/shared/hooks'
import { startHookStubServer, tempEndpoint, type HookStubServer } from './hook-stub-server'
import { removeTempDir } from '../tmpdir'

/**
 * Script-driven smoke for the fake engine (TEST-STRATEGY §1.2). The fake is the
 * test double every later milestone leans on, so its own contract is asserted
 * against *observed* behavior: real process spawn, real stdout bytes, real
 * posts landing on a real socket, real files on disk.
 */

const FAKE = fileURLToPath(new URL('./fake-engine/fake-engine.mjs', import.meta.url))

interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface RunOptions {
  readonly script: unknown
  readonly env?: Readonly<Record<string, string>>
  /** Written to the fake's stdin once it reports `idle`. */
  readonly stdin?: readonly string[]
}

const temps: string[] = []
const servers: HookStubServer[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-fake-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

async function stubServer(): Promise<HookStubServer> {
  const server = await startHookStubServer()
  servers.push(server)
  return server
}

function runFake(options: RunOptions): Promise<RunResult> {
  const dir = tempDir()
  const scriptPath = path.join(dir, 'script.json')
  fs.writeFileSync(scriptPath, JSON.stringify(options.script), 'utf8')

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE, '--script', scriptPath], {
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let sent = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!sent && options.stdin && stdout.includes('[fake-engine] idle')) {
        sent = true
        for (const line of options.stdin) child.stdin.write(line)
        child.stdin.end()
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    if (!options.stdin) child.stdin.end()
  })
}

describe('fake engine — scripted lifecycle', () => {
  it('emits scripted stdout and posts every scripted hook to the endpoint', async () => {
    const server = await stubServer()
    const result = await runFake({
      env: {
        EPH_AGENT_ID: 'agent.fake',
        EPH_HOOK_TOKEN: 'spawn-token-1',
        EPH_HOOK_ENDPOINT: server.endpoint,
        EPH_FAKE_SESSION: 'sess-42'
      },
      script: {
        schemaVersion: 1,
        steps: [
          { kind: 'hook', event: 'session-start', payload: { cwd: '/repo' } },
          { kind: 'stdout', text: 'Reading src/index.ts\n' },
          { kind: 'hook', event: 'pre-tool', payload: { tool: 'Read' } },
          { kind: 'hook', event: 'post-tool', payload: { tool: 'Read', ok: true } },
          { kind: 'hook', event: 'stop', payload: {} },
          { kind: 'exit', code: 0 }
        ]
      }
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Reading src/index.ts')
    expect(result.stdout).toContain('[fake-engine] hook-sent pre-tool')
    expect(result.stdout).toContain('[fake-engine] exit 0')

    const posts = await server.waitForPosts(4)
    const envelopes = posts.map((post) => {
      const parsed = parseHookEnvelope(post.parsed)
      if (!parsed.ok) throw new Error(`stub received an invalid envelope: ${parsed.reason}`)
      return parsed.envelope
    })

    expect(envelopes.map((e) => e.event)).toEqual([
      'session-start',
      'pre-tool',
      'post-tool',
      'stop'
    ])
    for (const envelope of envelopes) {
      expect(envelope.schemaVersion).toBe(1)
      expect(envelope.token).toBe('spawn-token-1')
      expect(envelope.agentId).toBe('agent.fake')
      expect(envelope.sessionId).toBe('sess-42')
      expect(envelope.ts).toBeGreaterThan(0)
    }
    expect(envelopes[1]?.payload).toEqual({ tool: 'Read' })
    expect(posts.every((post) => post.url === '/hook')).toBe(true)
  })

  it('exits on cue with the scripted code', async () => {
    const result = await runFake({
      script: { schemaVersion: 1, steps: [{ kind: 'exit', code: 3 }] }
    })
    expect(result.code).toBe(3)
  })
})

describe('fake engine — inbox and outbox', () => {
  it('reads inbox files, consumes them to .done/, and writes the outbox atomically', async () => {
    const agentDir = tempDir()
    const inbox = path.join(agentDir, 'inbox')
    fs.mkdirSync(inbox, { recursive: true })
    fs.writeFileSync(path.join(inbox, 'msg-001.json'), '{"subject":"hello"}', 'utf8')
    fs.writeFileSync(path.join(inbox, 'notes.txt'), 'ignored', 'utf8')

    const result = await runFake({
      env: { EPH_AGENT_ID: 'agent.fake', EPH_AGENT_DIR: agentDir },
      script: {
        schemaVersion: 1,
        steps: [
          { kind: 'read-inbox', consume: true },
          {
            kind: 'write-outbox',
            message: { id: 'out-001', to: 'agent.artemis', act: 'inform', subject: 'done' }
          },
          { kind: 'exit', code: 0 }
        ]
      }
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('[fake-engine] inbox-count 1')
    expect(result.stdout).toContain('[fake-engine] inbox-message msg-001.json')
    expect(result.stdout).toContain('[fake-engine] outbox-wrote out-001.json')

    expect(fs.existsSync(path.join(inbox, 'msg-001.json'))).toBe(false)
    expect(fs.existsSync(path.join(inbox, '.done', 'msg-001.json'))).toBe(true)

    const outboxDir = path.join(agentDir, 'outbox')
    expect(fs.readdirSync(outboxDir)).toEqual(['out-001.json'])
    expect(JSON.parse(fs.readFileSync(path.join(outboxDir, 'out-001.json'), 'utf8'))).toMatchObject(
      {
        to: 'agent.artemis',
        act: 'inform'
      }
    )
  })
})

describe('fake engine — interaction and failure paths', () => {
  it('answers typed prompts and the interrupt key over stdin', async () => {
    const result = await runFake({
      env: { EPH_AGENT_ID: 'agent.fake' },
      stdin: ['refactor the parser\n', String.fromCharCode(0x1b)],
      script: {
        schemaVersion: 1,
        steps: [{ kind: 'stdout', text: 'booted\n' }],
        onPrompt: [{ kind: 'stdout', text: 'working on it\n' }],
        onInterrupt: [{ kind: 'stdout', text: 'stopped\n' }]
      }
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('[fake-engine] prompt refactor the parser')
    expect(result.stdout).toContain('working on it')
    expect(result.stdout).toContain('[fake-engine] interrupted')
    expect(result.stdout).toContain('stopped')
  })

  it('fails open when the hook endpoint is not listening (SDD §10)', async () => {
    const result = await runFake({
      env: {
        EPH_AGENT_ID: 'agent.fake',
        EPH_HOOK_TOKEN: 'spawn-token-1',
        EPH_HOOK_ENDPOINT: tempEndpoint('eph-absent')
      },
      script: {
        schemaVersion: 1,
        steps: [
          { kind: 'hook', event: 'pre-tool', payload: {} },
          { kind: 'stdout', text: 'kept working\n' },
          { kind: 'exit', code: 0 }
        ]
      }
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('[fake-engine] hook-failed pre-tool')
    expect(result.stdout).toContain('kept working')
  })

  it('reports a non-2xx answer as undelivered without stopping the agent', async () => {
    const server = await stubServer()
    server.respondWith(503)
    const result = await runFake({
      env: {
        EPH_AGENT_ID: 'agent.fake',
        EPH_HOOK_TOKEN: 'spawn-token-1',
        EPH_HOOK_ENDPOINT: server.endpoint
      },
      script: {
        schemaVersion: 1,
        steps: [
          { kind: 'hook', event: 'stop', payload: {} },
          { kind: 'exit', code: 0 }
        ]
      }
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('[fake-engine] hook-failed stop harness answered 503')
  })

  it('refuses a script whose schemaVersion drifted, rather than guessing', async () => {
    const result = await runFake({ script: { schemaVersion: 99, steps: [] } })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('script schemaVersion must be 1')
  })

  it('refuses an unknown step kind', async () => {
    const result = await runFake({
      script: { schemaVersion: 1, steps: [{ kind: 'launch-missiles' }] }
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('script.steps[0].kind must be one of')
  })
})

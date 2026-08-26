import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseHookEnvelope } from '../../src/shared/hooks'
import { classifyTool, normalizePayload, parseArgs, sessionIdOf } from '../../shims/eph-hook.mjs'
import { startHookStubServer, tempEndpoint, type HookStubServer } from '../fakes/hook-stub-server'

/**
 * The shim is what a real engine actually executes, so it is exercised the way
 * an engine runs it: a spawned process, a JSON payload on stdin, arguments as
 * the adapter would write them into the settings file.
 */

const SHIM = fileURLToPath(new URL('../../shims/eph-hook.mjs', import.meta.url))
const servers: HookStubServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

async function stub(): Promise<HookStubServer> {
  const server = await startHookStubServer('eph-shim-stub')
  servers.push(server)
  return server
}

function runShim(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  stdin: string
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stdout.resume()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
    child.stdin.end(stdin)
  })
}

const CLAUDE_PRE_TOOL = JSON.stringify({
  session_id: 'sess-77',
  hook_event_name: 'PreToolUse',
  cwd: '/repo',
  transcript_path: '/transcripts/sess-77.jsonl',
  tool_name: 'Edit',
  tool_input: { file_path: 'src/app.ts' }
})

describe('eph-hook — argument parsing', () => {
  it('reads the event, repeated field maps and the session field', () => {
    expect(
      parseArgs([
        '--event',
        'pre-tool',
        '--field',
        'tool=tool_name',
        '--field',
        'target=file_path',
        '--session-field',
        'session_id'
      ])
    ).toMatchObject({
      event: 'pre-tool',
      fields: [
        ['tool', 'tool_name'],
        ['target', 'file_path']
      ],
      sessionField: 'session_id'
    })
  })

  it('defaults to no mapping at all', () => {
    expect(parseArgs([])).toEqual({
      event: '',
      fields: [],
      sessionField: null,
      classifyKey: null,
      classes: [],
      classPrefixes: []
    })
  })

  it('reads tool-class lists and prefixes the adapter supplies', () => {
    expect(
      parseArgs([
        '--classify',
        'tool',
        '--class',
        'file=Read,Write,Edit',
        '--class',
        'shell=Bash',
        '--class-prefix',
        'mcp=mcp__'
      ])
    ).toMatchObject({
      classifyKey: 'tool',
      classes: [
        ['file', ['Read', 'Write', 'Edit']],
        ['shell', ['Bash']]
      ],
      classPrefixes: [['mcp', 'mcp__']]
    })
  })

  it('ignores a field argument with no "="', () => {
    expect(parseArgs(['--field', 'nonsense']).fields).toEqual([])
  })
})

describe('eph-hook — payload normalization (NFR-12: engine names stay in the adapter)', () => {
  const args = parseArgs(['--event', 'pre-tool', '--field', 'tool=tool_name'])

  it('adds the harness name without dropping what the engine sent', () => {
    const payload = normalizePayload(JSON.parse(CLAUDE_PRE_TOOL), args)
    expect(payload['tool']).toBe('Edit')
    expect(payload['tool_name']).toBe('Edit')
    expect(payload['tool_input']).toEqual({ file_path: 'src/app.ts' })
  })

  it('leaves an existing harness key alone', () => {
    expect(normalizePayload({ tool: 'Read', tool_name: 'Edit' }, args)['tool']).toBe('Read')
  })

  it('survives a payload that is not an object', () => {
    for (const raw of [null, 'text', 42, ['a']]) {
      expect(normalizePayload(raw, args)).toEqual({})
    }
  })

  it('reads the session id only from the configured key', () => {
    const withField = parseArgs(['--session-field', 'session_id'])
    expect(sessionIdOf({ session_id: 'sess-77' }, withField)).toBe('sess-77')
    expect(sessionIdOf({ session_id: '' }, withField)).toBeNull()
    expect(sessionIdOf({ other: 'sess-77' }, withField)).toBeNull()
    expect(sessionIdOf({ session_id: 'sess-77' }, parseArgs([]))).toBeNull()
  })
})

describe('eph-hook — tool classification (SDD §6 station map is keyed by class)', () => {
  const args = parseArgs([
    '--field',
    'tool=tool_name',
    '--classify',
    'tool',
    '--class',
    'file=Read,Write,Edit',
    '--class',
    'shell=Bash',
    '--class-prefix',
    'mcp=mcp__'
  ])

  it.each([
    ['Read', 'file'],
    ['Edit', 'file'],
    ['Bash', 'shell'],
    ['mcp__github__create_issue', 'mcp']
  ])('classifies %s as %s', (tool, cls) => {
    expect(normalizePayload({ tool_name: tool }, args)['toolClass']).toBe(cls)
  })

  it('leaves an unknown tool unclassified rather than guessing a station', () => {
    expect(normalizePayload({ tool_name: 'BrandNewTool' }, args)['toolClass']).toBeUndefined()
  })

  it('prefers an exact name over a prefix', () => {
    const both = parseArgs([
      '--classify',
      'tool',
      '--class',
      'file=mcp__fs__read',
      '--class-prefix',
      'mcp=mcp__'
    ])
    expect(classifyTool({ tool: 'mcp__fs__read' }, both)['toolClass']).toBe('file')
  })

  it('does nothing without a --classify key', () => {
    expect(classifyTool({ tool: 'Read' }, parseArgs([]))['toolClass']).toBeUndefined()
  })

  it('ignores a non-string tool name', () => {
    expect(classifyTool({ tool: 42 }, args)['toolClass']).toBeUndefined()
    expect(classifyTool({ tool: '' }, args)['toolClass']).toBeUndefined()
  })
})

describe('eph-hook — as an engine actually runs it', () => {
  it('turns one Claude PreToolUse invocation into one normalized envelope', async () => {
    const server = await stub()
    const result = await runShim(
      ['--event', 'pre-tool', '--field', 'tool=tool_name', '--session-field', 'session_id'],
      {
        EPH_AGENT_ID: 'agent.mason',
        EPH_HOOK_TOKEN: 'spawn-token-1',
        EPH_HOOK_ENDPOINT: server.endpoint
      },
      CLAUDE_PRE_TOOL
    )

    expect(result.code).toBe(0)
    const posts = await server.waitForPosts(1)
    const parsed = parseHookEnvelope(posts[0]?.parsed)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.envelope.event).toBe('pre-tool')
    expect(parsed.envelope.agentId).toBe('agent.mason')
    expect(parsed.envelope.token).toBe('spawn-token-1')
    expect(parsed.envelope.sessionId).toBe('sess-77')
    expect(parsed.envelope.payload).toMatchObject({ tool: 'Edit', tool_name: 'Edit' })
  })

  it('writes nothing to stdout — an engine reads hook stdout as instructions', async () => {
    const server = await stub()
    const child = await new Promise<string>((resolve, reject) => {
      const proc = spawn(
        process.execPath,
        [SHIM, '--event', 'stop', '--session-field', 'session_id'],
        {
          env: {
            ...process.env,
            EPH_AGENT_ID: 'agent.mason',
            EPH_HOOK_TOKEN: 'spawn-token-1',
            EPH_HOOK_ENDPOINT: server.endpoint
          },
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
      let out = ''
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        out += chunk
      })
      proc.stderr.resume()
      proc.on('error', reject)
      proc.on('close', () => resolve(out))
      proc.stdin.end('{"session_id":"sess-77","hook_event_name":"Stop"}')
    })

    expect(child).toBe('')
    await server.waitForPosts(1)
  })

  it('exits 0 and posts nothing when it is not wired', async () => {
    const result = await runShim(['--event', 'stop'], { EPH_HOOK_ENDPOINT: '' }, '{}')
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('not wired')
  })

  it('fails open when the harness is not listening (SDD §10)', async () => {
    const result = await runShim(
      ['--event', 'stop'],
      {
        EPH_AGENT_ID: 'agent.mason',
        EPH_HOOK_TOKEN: 'spawn-token-1',
        EPH_HOOK_ENDPOINT: tempEndpoint('eph-absent-shim')
      },
      '{}'
    )

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('not delivered')
  })

  it('still reports the event when the engine payload is not JSON', async () => {
    const server = await stub()
    const result = await runShim(
      ['--event', 'stop'],
      {
        EPH_AGENT_ID: 'agent.mason',
        EPH_HOOK_TOKEN: 'spawn-token-1',
        EPH_HOOK_ENDPOINT: server.endpoint
      },
      'not json'
    )

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('was not JSON')
    const posts = await server.waitForPosts(1)
    const parsed = parseHookEnvelope(posts[0]?.parsed)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.envelope.event).toBe('stop')
  })
})

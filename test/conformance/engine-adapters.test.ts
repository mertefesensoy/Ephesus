import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_EVENTS, HOOK_ENVELOPE_SCHEMA_VERSION } from '../../src/shared/hooks'
import { HOOK_SUPPORT_RANK, type HookSupport } from '../../src/shared/engines'
import { HookServer, type HookEventRecord } from '../../src/main/hooks'
import { CLAUDE_SETTINGS_REL, ClaudeAdapter } from '../../src/main/engines/claude'
import { CodexAdapter } from '../../src/main/engines/codex'
import { GeminiAdapter } from '../../src/main/engines/gemini'
import { PromptStore } from '../../src/main/prompts'
import { conformanceRig, runAdapterConformance } from './adapter-conformance'
import { FAKE_SETTINGS_REL, makeFakeAdapter } from '../fakes/fake-adapter'
import { removeTempDir } from '../tmpdir'

/**
 * The conformance run (TEST-STRATEGY §5): the table above every adapter, plus
 * the behavioral half that only the fake engine can carry per-PR — it is a real
 * process we can spawn in CI, where a real `claude` is nightly territory.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []
const servers: HookServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-conf-run-'))
  temps.push(dir)
  return dir
}

function scriptFile(script: unknown): string {
  const file = path.join(tempDir(), 'script.json')
  fs.writeFileSync(file, JSON.stringify(script), 'utf8')
  return file
}

/** A script that reports every harness event, backing a `native` claim. */
const FULL_LIFECYCLE_SCRIPT = {
  schemaVersion: 1,
  steps: [
    { kind: 'echo-env', name: 'EPH_IDENTITY' },
    ...HOOK_EVENTS.map((event) => ({
      kind: 'hook',
      event,
      payload: event === 'pre-tool' || event === 'post-tool' ? { tool: 'Read' } : {}
    })),
    { kind: 'stdout', text: 'ready-for-input\n' }
  ],
  onInterrupt: [{ kind: 'stdout', text: 'interrupt-observed\n' }]
}

// ── the table, run against both adapters ────────────────────────────────────

runAdapterConformance({
  name: 'fake engine',
  make: () => makeFakeAdapter({ scriptPath: scriptFile(FULL_LIFECYCLE_SCRIPT) }),
  settingsRel: [FAKE_SETTINGS_REL],
  wiresEveryEvent: true,
  // The fake's format: one usage fact per line, as its adapter documents.
  transcriptSample: {
    goodLines: [
      JSON.stringify({
        sessionId: 's-1',
        model: 'test-model',
        inTokens: 10,
        outTokens: 20,
        costUsd: 0.5,
        at: '2026-08-27T09:00:00.000Z'
      })
    ],
    expected: [
      {
        sessionId: 's-1',
        model: 'test-model',
        inTokens: 10,
        outTokens: 20,
        costUsd: 0.5,
        at: '2026-08-27T09:00:00.000Z'
      }
    ],
    ignoredLines: ['not json at all', JSON.stringify({ sessionId: 's-2', model: 'test-model' })]
  }
})

runAdapterConformance({
  name: 'claude code',
  make: () =>
    new ClaudeAdapter({
      prompts: new PromptStore(path.join(tempDir(), 'prompts'), BUNDLED_PROMPTS),
      hookShimPath: path.join(tempDir(), 'shims', 'eph-hook.mjs')
    }),
  settingsRel: [CLAUDE_SETTINGS_REL],
  wiresEveryEvent: true,
  // Claude Code's format, captured from a real transcript: usage lives under
  // `message.usage` on `assistant` lines, and cache tokens are input tokens.
  transcriptSample: {
    goodLines: [
      JSON.stringify({
        type: 'assistant',
        sessionId: 's-1',
        requestId: 'req_1',
        timestamp: '2026-08-27T09:00:00.000Z',
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 8,
            cache_read_input_tokens: 0,
            output_tokens: 20
          }
        }
      })
    ],
    expected: [
      {
        sessionId: 's-1',
        model: 'claude-opus-5',
        inTokens: 10,
        outTokens: 20,
        costUsd: null,
        at: '2026-08-27T09:00:00.000Z'
      }
    ],
    ignoredLines: [
      'not json at all',
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      JSON.stringify({ type: 'user', sessionId: 's-1', message: { content: 'hi' } })
    ]
  }
})

runAdapterConformance({
  name: 'codex',
  make: () =>
    new CodexAdapter({
      prompts: new PromptStore(path.join(tempDir(), 'prompts'), BUNDLED_PROMPTS)
    }),
  // Nothing: this adapter writes no settings, which is the strongest possible
  // answer to ADR-0009's hygiene rule and the honest one for `pty-heuristic`.
  settingsRel: [],
  wiresEveryEvent: false
  // No `transcriptSample`: the adapter declares no transcript reader, so the
  // table skips those cases rather than inventing a format for it.
})

runAdapterConformance({
  name: 'gemini',
  make: () =>
    new GeminiAdapter({
      prompts: new PromptStore(path.join(tempDir(), 'prompts'), BUNDLED_PROMPTS)
    }),
  settingsRel: [],
  wiresEveryEvent: false
})

// ── the behavioral half, per-PR against the fake engine ──────────────────────

/**
 * The suite's operational reading of ADR-0009's grades: `native` claims the
 * whole lifecycle reaches the harness, `wrapper` claims some of it, and
 * `pty-heuristic` claims none of it arrives as events at all. An adapter is
 * honest when what it demonstrated is at least what it declared.
 */
function demonstratedGrade(events: ReadonlySet<string>): HookSupport {
  if (HOOK_EVENTS.every((event) => events.has(event))) return 'native'
  return events.size > 0 ? 'wrapper' : 'pty-heuristic'
}

interface LiveRun {
  readonly stdout: string
  readonly code: number
  readonly events: Set<string>
}

async function runAdapterLive(
  scriptPath: string,
  opts: { interrupt?: boolean; hooks?: HookSupport } = {}
): Promise<LiveRun> {
  const home = tempDir()
  const received: HookEventRecord[] = []
  const server = new HookServer({
    onEvent: (record) => {
      received.push(record)
    },
    onRejected: () => {}
  })
  await server.start(home)
  servers.push(server)

  const rig = conformanceRig()
  const adapter = makeFakeAdapter({ scriptPath, ...(opts.hooks ? { hooks: opts.hooks } : {}) })
  const cfg = { ...rig.cfg, hookEndpoint: server.endpoint() ?? '' }

  const hookPlan = adapter.wireHooks(cfg)
  await hookPlan.install()
  const plan = adapter.spawnArgs(cfg)
  server.registerSpawn(cfg.agentId, cfg.hookToken)

  const [command, ...args] = plan.argv
  const result = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    const child = spawn(command ?? '', args, {
      cwd: plan.cwd,
      env: { ...plan.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let interrupted = false
    child.stdout.setEncoding('utf8')
    child.stderr.resume()
    // A late stdout chunk can arrive after the child is gone, and writing to a
    // dead child's stdin throws EPIPE asynchronously — which fails the whole
    // run rather than the assertion. Send the key exactly once, and treat a
    // pipe that has already closed as the success it is.
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (opts.interrupt && !interrupted && stdout.includes('ready-for-input')) {
        interrupted = true
        if (child.stdin.writable) child.stdin.write(adapter.interrupt().bytes)
      }
      if (stdout.includes('interrupt-observed') && !child.killed) child.kill()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, code: code ?? -1 }))
    if (!opts.interrupt) child.stdin.end()
  })

  await hookPlan.uninstall()
  return { ...result, events: new Set(received.map((r) => r.envelope.event)) }
}

describe('conformance: fake engine — behavioral (TEST-STRATEGY §5)', () => {
  it('spawns from its own plan, is interruptible by its own key, and can be killed', async () => {
    const run = await runAdapterLive(scriptFile(FULL_LIFECYCLE_SCRIPT), { interrupt: true })

    expect(run.stdout).toContain('ready-for-input')
    expect(run.stdout).toContain('[fake-engine] interrupted')
    expect(run.stdout).toContain('interrupt-observed')
  })

  it('shows identity injection in-session — the agent reports it itself', async () => {
    const run = await runAdapterLive(
      scriptFile({
        schemaVersion: 1,
        steps: [
          { kind: 'echo-env', name: 'EPH_IDENTITY' },
          { kind: 'exit', code: 0 }
        ]
      })
    )

    expect(run.code).toBe(0)
    // Not "the plan contains it" — the running process printed it back.
    expect(run.stdout).toContain('pomegranate-42')
    expect(run.stdout).toContain('Write only inside your own agent directory')
  })

  it('demonstrates the grade it declares', async () => {
    const run = await runAdapterLive(
      scriptFile({
        schemaVersion: 1,
        steps: [
          ...HOOK_EVENTS.map((event) => ({
            kind: 'hook',
            event,
            payload: event === 'pre-tool' || event === 'post-tool' ? { tool: 'Read' } : {}
          })),
          { kind: 'exit', code: 0 }
        ]
      })
    )

    expect(run.code).toBe(0)
    expect([...run.events].sort()).toEqual([...HOOK_EVENTS].sort())
    expect(HOOK_SUPPORT_RANK[demonstratedGrade(run.events)]).toBeGreaterThanOrEqual(
      HOOK_SUPPORT_RANK['native']
    )
  })

  it('CATCHES an adapter that claims a grade it does not demonstrate', async () => {
    // The honesty check has to bite, or it proves nothing. This adapter claims
    // `native` while reporting two events out of eight.
    const run = await runAdapterLive(
      scriptFile({
        schemaVersion: 1,
        steps: [
          { kind: 'hook', event: 'session-start', payload: {} },
          { kind: 'hook', event: 'stop', payload: {} },
          { kind: 'exit', code: 0 }
        ]
      }),
      { hooks: 'native' }
    )

    const demonstrated = demonstratedGrade(run.events)
    expect(demonstrated).toBe('wrapper')
    expect(HOOK_SUPPORT_RANK[demonstrated]).toBeLessThan(HOOK_SUPPORT_RANK['native'])
  })

  it('posts envelopes the harness accepts, at the current schema version', async () => {
    const run = await runAdapterLive(
      scriptFile({
        schemaVersion: 1,
        steps: [
          { kind: 'hook', event: 'pre-tool', payload: { tool: 'Read', toolClass: 'file' } },
          { kind: 'exit', code: 0 }
        ]
      })
    )

    expect(run.events.has('pre-tool')).toBe(true)
    expect(HOOK_ENVELOPE_SCHEMA_VERSION).toBe(1)
  })

  it('leaves the agent cwd exactly as it found it', async () => {
    const rig = conformanceRig()
    const before = fs.readdirSync(rig.cwd)
    const adapter = makeFakeAdapter({ scriptPath: scriptFile(FULL_LIFECYCLE_SCRIPT) })

    const plan = adapter.wireHooks(rig.cfg)
    await plan.install()
    await plan.uninstall()

    expect(fs.readdirSync(rig.cwd)).toEqual(before)
  })
})

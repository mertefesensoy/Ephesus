import { describe, expect, it } from 'vitest'
import type { EngineId } from '../../../src/shared/engines'
import { EngineRegistry, engines } from '../../../src/main/engines'
import type { AgentSpawnConfig, EngineAdapter } from '../../../src/main/engines'

/** The Escape key, U+001B — Claude Code's cancel key (ADR-0009 `interrupt()`). */
const ESCAPE_BYTE = String.fromCharCode(0x1b)

/**
 * A minimal adapter that exists only to prove the ADR-0009 surface is
 * implementable as written (type-level conformance). Behavioral conformance is
 * the job of the M1.7 suite against the fake and claude adapters.
 */
function dummyAdapter(id: EngineId): EngineAdapter {
  return {
    id,
    hooks: 'native',
    binary: () => ({
      name: id,
      install: { command: 'npm', args: ['i', '-g', id] },
      versionProbe: { command: id, args: ['--version'] },
      parseVersion: (stdout) => stdout.trim() || null
    }),
    spawnArgs: (cfg) => ({
      argv: [id],
      cwd: cfg.cwd,
      commitIdentity: null,
      ghTokenCommand: '',
      env: { ...cfg.envGrants, EPH_AGENT_ID: cfg.agentId, EPH_HOOK_TOKEN: cfg.hookToken },
      settings: []
    }),
    wireHooks: () => ({
      injections: [],
      install: async () => {},
      uninstall: async () => {}
    }),
    injectIdentity: () => {},
    interrupt: () => ({ label: 'Escape', bytes: ESCAPE_BYTE })
  }
}

const spawnConfig: AgentSpawnConfig = {
  agentId: 'agent.test',
  hookToken: 'token-abc',
  hookEndpoint: '/tmp/eph/events.sock',
  cwd: '/tmp/eph/repo',
  commitIdentity: null,
  ghTokenCommand: '',
  envGrants: { GH_TOKEN: 'granted' },
  identityPath: '/tmp/eph/agora/agents/agent.test/identity.md',
  protocolPath: '/tmp/eph/agora/PROTOCOL.md',
  memory: '',
  recallCommand: '',
  autonomy: 'manual'
}

describe('EngineRegistry (ADR-0009, SDD §1.1)', () => {
  it('returns the adapter registered under an id', () => {
    const registry = new EngineRegistry()
    const adapter = dummyAdapter('claude')
    registry.register(adapter)

    expect(registry.has('claude')).toBe(true)
    expect(registry.get('claude')).toBe(adapter)
  })

  it('throws with the id and the registered set on an unknown id', () => {
    const registry = new EngineRegistry()
    registry.register(dummyAdapter('claude'))

    expect(registry.has('codex')).toBe(false)
    expect(() => registry.get('codex')).toThrow(/"codex"/)
    expect(() => registry.get('codex')).toThrow(/registered: claude/)
  })

  it('names the empty registry honestly when nothing is registered', () => {
    expect(() => new EngineRegistry().get('claude')).toThrow(/registered: \(none\)/)
  })

  it('refuses a duplicate id rather than silently replacing the adapter', () => {
    const registry = new EngineRegistry()
    const first = dummyAdapter('claude')
    registry.register(first)

    expect(() => registry.register(dummyAdapter('claude'))).toThrow(/already registered/)
    expect(registry.get('claude')).toBe(first)
  })

  it('lists adapters in registration order', () => {
    const registry = new EngineRegistry()
    registry.register(dummyAdapter('claude'))
    registry.register(dummyAdapter('codex'))

    expect(registry.list().map((a) => a.id)).toEqual(['claude', 'codex'])
  })

  it('exposes a process-wide registry that starts empty (adapters land in M1.4)', () => {
    expect(engines).toBeInstanceOf(EngineRegistry)
    expect(engines.list()).toEqual([])
  })
})

describe('EngineAdapter surface (ADR-0009 transcription)', () => {
  const adapter = dummyAdapter('claude')

  it('composes env from grants plus the two harness variables (SDD §3)', () => {
    const plan = adapter.spawnArgs(spawnConfig)

    expect(plan.cwd).toBe(spawnConfig.cwd)
    expect(plan.env).toMatchObject({
      GH_TOKEN: 'granted',
      EPH_AGENT_ID: 'agent.test',
      EPH_HOOK_TOKEN: 'token-abc'
    })
    expect(plan.settings).toEqual([])
  })

  it('describes its binary with an install command and a version probe', () => {
    const spec = adapter.binary()

    expect(spec.name).toBe('claude')
    expect(spec.install.command).toBe('npm')
    expect(spec.versionProbe.args).toEqual(['--version'])
    expect(spec.parseVersion('1.2.3\n')).toBe('1.2.3')
    expect(spec.parseVersion('   ')).toBeNull()
  })

  it('exposes an interrupt key sequence with inspectable bytes', () => {
    expect(adapter.interrupt()).toEqual({ label: 'Escape', bytes: ESCAPE_BYTE })
    expect(ESCAPE_BYTE.charCodeAt(0)).toBe(27)
  })

  it('leaves resume and transcripts optional', () => {
    expect(adapter.resume).toBeUndefined()
    expect(adapter.transcripts).toBeUndefined()
  })

  it('installs and uninstalls hook plans without throwing when there is nothing to wire', async () => {
    const plan = adapter.wireHooks(spawnConfig)
    await expect(plan.install()).resolves.toBeUndefined()
    await expect(plan.uninstall()).resolves.toBeUndefined()
    expect(plan.injections).toEqual([])
  })
})

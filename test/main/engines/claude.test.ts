import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_EVENTS } from '../../../src/shared/hooks'
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_SETTINGS_BACKUP_REL,
  CLAUDE_SETTINGS_REL,
  ClaudeAdapter,
  mergeClaudeSettings
} from '../../../src/main/engines/claude'
import { AGENT_BASE_ENV_KEYS, baseAgentEnv } from '../../../src/main/engines/spawn-env'
import { PromptStore } from '../../../src/main/prompts'
import type { AgentSpawnConfig } from '../../../src/main/engines'

/**
 * Settings hygiene runs entirely inside temp cwds. Nothing here may touch the
 * Architect's real `~/.claude` — that is the M1.4 risk note, and it is enforced
 * by never naming a path outside `os.tmpdir()`.
 */

const ESCAPE_KEY = String.fromCharCode(0x1b)
const BUNDLED_PROMPTS = fileURLToPath(new URL('../../../prompts/', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface Rig {
  readonly adapter: ClaudeAdapter
  readonly cfg: AgentSpawnConfig
  readonly cwd: string
  readonly settingsPath: string
  readonly backupPath: string
}

function rig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-claude-'))
  temps.push(root)
  const cwd = path.join(root, 'repo')
  const agora = path.join(root, 'agora', 'agents', 'agent.mason')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(agora, { recursive: true })
  fs.writeFileSync(path.join(agora, 'identity.md'), '# Mason\nRole: ci-babysitter.\n', 'utf8')
  fs.writeFileSync(
    path.join(root, 'agora', 'PROTOCOL.md'),
    '# Protocol\nWrite only your outbox.\n',
    'utf8'
  )

  const adapter = new ClaudeAdapter({
    prompts: new PromptStore(path.join(root, 'home-prompts'), BUNDLED_PROMPTS),
    hookShimPath: path.join(root, 'shims', 'eph-hook.mjs')
  })

  return {
    adapter,
    cwd,
    settingsPath: path.join(cwd, CLAUDE_SETTINGS_REL),
    backupPath: path.join(cwd, CLAUDE_SETTINGS_BACKUP_REL),
    cfg: {
      agentId: 'agent.mason',
      hookToken: 'spawn-token-1',
      hookEndpoint: '/tmp/eph/events.sock',
      cwd,
      envGrants: { GH_TOKEN: 'granted-value' },
      identityPath: path.join(agora, 'identity.md'),
      protocolPath: path.join(root, 'agora', 'PROTOCOL.md')
    }
  }
}

describe('claude adapter — declared surface (ADR-0009)', () => {
  it('declares the reference engine at native hook fidelity', () => {
    const { adapter } = rig()
    expect(adapter.id).toBe('claude')
    expect(adapter.hooks).toBe('native')
  })

  it('interrupts with Escape', () => {
    const { adapter } = rig()
    expect(adapter.interrupt()).toEqual({ label: 'Escape', bytes: ESCAPE_KEY })
    expect(adapter.interrupt().bytes.charCodeAt(0)).toBe(27)
  })

  it('declares resume, and resumes by the session id the event plane records', () => {
    // The M1 audit recorded this as missing: `ResumeSupport` was in the type
    // and no adapter implemented it, so a crashed agent came back with no idea
    // what it had been doing. `--resume` is Claude Code's own flag.
    const { adapter } = rig()
    expect(adapter.resume).toBeDefined()
    expect(adapter.resume?.resumeArgs('sess-9f3')).toEqual(['--resume', 'sess-9f3'])
  })

  it('declares transcripts, so the Watch can fold its spend', () => {
    expect(rig().adapter.transcripts).toBeDefined()
  })

  it('maps every Claude hook onto a harness event, and covers the whole vocabulary', () => {
    const mapped = Object.values(CLAUDE_HOOK_EVENTS)
    expect(new Set(mapped).size).toBe(mapped.length)
    expect([...mapped].sort()).toEqual([...HOOK_EVENTS].sort())
  })
})

describe('claude adapter — version probe (FR-1.6)', () => {
  const probe = rig().adapter.binary()

  it('offers an install command that can run in the agent terminal', () => {
    expect(probe.install).toEqual({
      command: 'npm',
      args: ['install', '-g', '@anthropic-ai/claude-code']
    })
    expect(probe.versionProbe).toEqual({ command: 'claude', args: ['--version'] })
    expect(probe.name).toBe('claude')
  })

  const versions: readonly [string, string | null][] = [
    ['2.1.195 (Claude Code)\n', '2.1.195'],
    ['1.0.0\n', '1.0.0'],
    ['2.1.195-beta.3 (Claude Code)', '2.1.195-beta.3'],
    ['claude version 0.9.12 built today', '0.9.12'],
    ['command not found: claude', null],
    ['', null],
    ['no digits here', null]
  ]

  it.each(versions)('parses %j', (stdout, expected) => {
    expect(probe.parseVersion(stdout)).toBe(expected)
  })
})

describe('claude adapter — spawn plan (SDD §3)', () => {
  it('carries the two harness variables and the declared grants, and nothing else', () => {
    const { adapter, cfg, cwd } = rig()
    const plan = adapter.spawnArgs(cfg)

    expect(plan.cwd).toBe(cwd)
    expect(plan.env['EPH_AGENT_ID']).toBe('agent.mason')
    expect(plan.env['EPH_HOOK_TOKEN']).toBe('spawn-token-1')
    expect(plan.env['EPH_HOOK_ENDPOINT']).toBe('/tmp/eph/events.sock')
    expect(plan.env['GH_TOKEN']).toBe('granted-value')

    // Everything else must be an allowlisted base variable — no ungranted
    // inheritance from the harness's own environment (ADR-0010).
    const harnessOnly = Object.keys(plan.env).filter(
      (key) =>
        !['EPH_AGENT_ID', 'EPH_HOOK_TOKEN', 'EPH_HOOK_ENDPOINT', 'GH_TOKEN'].includes(key) &&
        !AGENT_BASE_ENV_KEYS.includes(key.toUpperCase())
    )
    expect(harnessOnly).toEqual([])
  })

  it('injects identity and protocol on the command line', () => {
    const { adapter, cfg } = rig()
    const plan = adapter.spawnArgs(cfg)

    expect(plan.argv[0]).toBe('claude')
    expect(plan.argv[1]).toBe('--append-system-prompt')
    const appendix = plan.argv[2] ?? ''
    expect(appendix).toContain('agent.mason')
    expect(appendix).toContain('Role: ci-babysitter.')
    expect(appendix).toContain('Write only your outbox.')
    expect(appendix).not.toContain('{{')
  })

  it('refuses to spawn an agent whose identity source is missing', () => {
    const { adapter, cfg } = rig()
    fs.rmSync(cfg.identityPath, { force: true })

    expect(() => adapter.injectIdentity(cfg)).toThrow(
      /identity\.md missing for agent "agent\.mason"/
    )
    expect(() => adapter.spawnArgs(cfg)).toThrow(/identity\.md missing/)
  })

  it('refuses to spawn when the company protocol is missing', () => {
    const { adapter, cfg } = rig()
    fs.rmSync(cfg.protocolPath, { force: true })
    expect(() => adapter.injectIdentity(cfg)).toThrow(/PROTOCOL\.md missing/)
  })

  it('announces the settings file it will write, for the agent card', () => {
    const { adapter, cfg, settingsPath } = rig()
    const plan = adapter.spawnArgs(cfg)

    expect(plan.settings).toHaveLength(1)
    expect(plan.settings[0]?.path).toBe(settingsPath)
    expect(plan.settings[0]?.contents).toContain('--event pre-tool')
  })
})

describe('claude adapter — base environment (ADR-0010 least privilege)', () => {
  it('passes through allowlisted variables under their original names', () => {
    expect(baseAgentEnv({ Path: 'C:/bin', HOME: '/home/x' })).toEqual({
      Path: 'C:/bin',
      HOME: '/home/x'
    })
  })

  it('drops anything not on the list, whatever it is called', () => {
    expect(
      baseAgentEnv({
        ANTHROPIC_API_KEY: 'test-grant-value-not-secret',
        AWS_SECRET_ACCESS_KEY: 'nope',
        MY_TEAM_TOKEN: 'nope',
        PATH: '/usr/bin'
      })
    ).toEqual({ PATH: '/usr/bin' })
  })

  it('skips undefined values', () => {
    expect(baseAgentEnv({ PATH: undefined, HOME: '/home/x' })).toEqual({ HOME: '/home/x' })
  })
})

describe('claude adapter — settings hygiene (TEST-STRATEGY §5)', () => {
  it('writes only the local variant, wiring every hook through the shim', async () => {
    const { adapter, cfg, settingsPath, cwd } = rig()
    const plan = adapter.wireHooks(cfg)
    await plan.install()

    expect(fs.existsSync(settingsPath)).toBe(true)
    expect(fs.existsSync(path.join(cwd, '.claude', 'settings.json'))).toBe(false)

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
    }
    expect(Object.keys(written.hooks).sort()).toEqual(Object.keys(CLAUDE_HOOK_EVENTS).sort())

    const preTool = written.hooks['PreToolUse']?.[0]?.hooks[0]
    expect(preTool?.type).toBe('command')
    expect(preTool?.command).toContain('eph-hook.mjs')
    expect(preTool?.command).toContain('--event pre-tool')
    expect(preTool?.command).toContain('--field tool=tool_name')
    expect(preTool?.command).toContain('--session-field session_id')

    // Events without a payload rename get no --field argument.
    expect(written.hooks['Stop']?.[0]?.hooks[0]?.command).not.toContain('--field')

    await plan.uninstall()
  })

  it('backs up a pre-existing file and restores it byte-for-byte on uninstall', async () => {
    const { adapter, cfg, settingsPath, backupPath, cwd } = rig()
    const original = '{\r\n  "permissions": { "allow": ["Bash(ls)"] }\r\n}\r\n'
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    fs.writeFileSync(settingsPath, original, 'utf8')
    const originalBytes = fs.readFileSync(settingsPath)

    const plan = adapter.wireHooks(cfg)
    await plan.install()

    expect(fs.existsSync(backupPath)).toBe(true)
    expect(fs.readFileSync(backupPath).equals(originalBytes)).toBe(true)
    const installed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      permissions: { allow: string[]; additionalDirectories: string[] }
    }
    // The Architect's own rule survives, with the mailbox grant merged in
    // beside it — never replacing it.
    expect(installed.permissions.allow[0]).toBe('Bash(ls)')
    expect(installed.permissions.allow.some((rule) => rule.startsWith('Write('))).toBe(true)
    expect(installed.permissions.additionalDirectories).toHaveLength(1)

    await plan.uninstall()

    expect(fs.readFileSync(settingsPath).equals(originalBytes)).toBe(true)
    expect(fs.existsSync(backupPath)).toBe(false)
  })

  it('keeps the Architect own hooks alongside ours', async () => {
    const { adapter, cfg, settingsPath, cwd } = rig()
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'sh ./mine.sh' }] }]
        }
      }),
      'utf8'
    )

    const plan = adapter.wireHooks(cfg)
    await plan.install()

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const stopCommands = (written.hooks['Stop'] ?? []).flatMap((g) => g.hooks.map((h) => h.command))
    expect(stopCommands[0]).toBe('sh ./mine.sh')
    expect(stopCommands[1]).toContain('--event stop')

    await plan.uninstall()
  })

  it('removes the file and the directory it created when there was nothing before', async () => {
    const { adapter, cfg, settingsPath, cwd } = rig()
    const plan = adapter.wireHooks(cfg)
    await plan.install()
    expect(fs.existsSync(settingsPath)).toBe(true)

    await plan.uninstall()

    expect(fs.existsSync(settingsPath)).toBe(false)
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false)
  })

  it('leaves a .claude directory that already had other files in it', async () => {
    const { adapter, cfg, cwd } = rig()
    const claudeDir = path.join(cwd, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}', 'utf8')

    const plan = adapter.wireHooks(cfg)
    await plan.install()
    await plan.uninstall()

    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true)
  })

  it('is safe to uninstall twice, and to uninstall without installing', async () => {
    const { adapter, cfg } = rig()
    const plan = adapter.wireHooks(cfg)
    await expect(plan.uninstall()).resolves.toBeUndefined()
    await plan.install()
    await plan.uninstall()
    await expect(plan.uninstall()).resolves.toBeUndefined()
  })

  it('refuses to overwrite a settings file it cannot parse', () => {
    const { adapter, cfg, settingsPath, cwd } = rig()
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    fs.writeFileSync(settingsPath, '{ this is not json', 'utf8')

    expect(() => adapter.wireHooks(cfg)).toThrow(/not valid JSON, refusing to overwrite/)
  })
})

describe('claude adapter — the mailbox grant (FR-3.2)', () => {
  it('grants the agent its OWN directory, and nothing wider', async () => {
    const { adapter, cfg, settingsPath } = rig()
    const plan = adapter.wireHooks(cfg)
    await plan.install()

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      permissions: { allow: string[]; additionalDirectories: string[] }
    }
    const agentDir = path.dirname(cfg.identityPath).split(path.sep).join('/')

    expect(written.permissions.additionalDirectories).toEqual([agentDir])
    expect(written.permissions.allow).toContain(`Read(${agentDir}/**)`)
    expect(written.permissions.allow).toContain(`Write(${agentDir}/**)`)
    expect(written.permissions.allow).toContain(`Glob(${agentDir}/**)`)
    // Never the Agora, never `agents/`, never a sibling mailbox — single-writer-
    // per-file has to survive the grant that makes the mailbox usable at all.
    // Every rule is scoped to THIS agent's own directory and nothing above it.
    for (const rule of written.permissions.allow) {
      expect(rule.endsWith(`(${agentDir}/**)`)).toBe(true)
    }
    const parent = path.dirname(path.dirname(cfg.identityPath)).split(path.sep).join('/')
    for (const rule of written.permissions.allow) {
      expect(rule).not.toBe(`Write(${parent}/**)`)
      expect(rule).not.toContain(`${parent}/**`)
    }
    expect(written.permissions.additionalDirectories).not.toContain(parent)

    await plan.uninstall()
  })

  it('adds no permissions block when there is no spawn to grant for', () => {
    const { adapter } = rig()
    const settings = JSON.parse(
      mergeClaudeSettings(null, {
        prompts: new PromptStore('x', BUNDLED_PROMPTS),
        hookShimPath: 'shim'
      })
    ) as Record<string, unknown>
    expect(settings['permissions']).toBeUndefined()
    expect(adapter.id).toBe('claude')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_EVENTS } from '../../../src/shared/hooks'
import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HARNESS_SETTINGS_REL,
  claudeCredentialsDir,
  CLAUDE_SETTINGS_BACKUP_SUFFIX,
  ClaudeAdapter,
  claudePermissionMode,
  mergeClaudeSettings,
  CLAUDE_FILE_RULE_TOOLS,
  GH_TOKEN_REFRESH_COMMAND
} from '../../../src/main/engines/claude'
import { AGENT_BASE_ENV_KEYS, baseAgentEnv } from '../../../src/main/engines/spawn-env'
import { PromptStore } from '../../../src/main/prompts'
import type { AgentSpawnConfig } from '../../../src/main/engines'
import { removeTempDir } from '../../tmpdir'
import { NO_TOOLS } from '../../../src/shared/engine-tools'

/**
 * Settings hygiene runs entirely inside temp cwds. Nothing here may touch the
 * Architect's real `~/.claude` — that is the M1.4 risk note, and it is enforced
 * by never naming a path outside `os.tmpdir()`.
 */

const ESCAPE_KEY = String.fromCharCode(0x1b)
const BUNDLED_PROMPTS = fileURLToPath(new URL('../../../prompts/', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

interface Rig {
  readonly adapter: ClaudeAdapter
  readonly cfg: AgentSpawnConfig
  readonly cwd: string
  readonly engineConfigDir: string
  readonly settingsPath: string
  readonly backupPath: string
}

function rig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-claude-'))
  temps.push(root)
  const cwd = path.join(root, 'repo')
  // ADR-0026: the harness's settings live in the agent's OWN engine config
  // directory now, not inside the checkout. The rig names it so every
  // assertion about where a file lands reads the same path the adapter uses.
  const engineConfigDir = path.join(root, 'engine-config')
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
    engineConfigDir,
    settingsPath: path.join(engineConfigDir, CLAUDE_HARNESS_SETTINGS_REL),
    backupPath: path.join(
      engineConfigDir,
      `${CLAUDE_HARNESS_SETTINGS_REL}${CLAUDE_SETTINGS_BACKUP_SUFFIX}`
    ),
    cfg: {
      agentId: 'agent.mason',
      hookToken: 'spawn-token-1',
      hookEndpoint: '/tmp/eph/events.sock',
      cwd,
      engineConfigDir,
      tools: NO_TOOLS,
      commitIdentity: null,
      ghTokenCommand: '',
      envGrants: { GH_TOKEN: 'granted-value' },
      identityPath: path.join(agora, 'identity.md'),
      protocolPath: path.join(root, 'agora', 'PROTOCOL.md'),
      memory: '',
      recallCommand: '',
      autonomy: 'manual'
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

    // ADR-0026: the agent's OWN engine install, and the Architect's credentials
    // borrowed rather than copied. Asserted by value, not merely by presence —
    // a config dir pointing anywhere else is an agent inheriting the
    // Architect's hooks again, which is precisely what nothing would report.
    expect(plan.env['CLAUDE_CONFIG_DIR']).toBe(cfg.engineConfigDir)
    expect(plan.env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(claudeCredentialsDir())

    // Everything else must be an allowlisted base variable — no ungranted
    // inheritance from the harness's own environment (ADR-0010).
    const harnessOnly = Object.keys(plan.env).filter(
      (key) =>
        ![
          'EPH_AGENT_ID',
          'EPH_HOOK_TOKEN',
          'EPH_HOOK_ENDPOINT',
          'GH_TOKEN',
          'CLAUDE_CONFIG_DIR',
          'CLAUDE_SECURESTORAGE_CONFIG_DIR',
          'DISABLE_AUTOUPDATER'
        ].includes(key) && !AGENT_BASE_ENV_KEYS.includes(key.toUpperCase())
    )
    expect(harnessOnly).toEqual([])
  })

  it('never lets an agent upgrade the engine the whole company is running', () => {
    // Measured on the shipped binary: this variable is read from `process.env`
    // before any config is consulted, and short-circuits the updater outright.
    // The settings key `autoUpdates: false` was refuted as the mechanism — the
    // engine's own text scopes it to BACKGROUND updates only, so it would have
    // left the startup path this defect came through still live.
    const { adapter, cfg } = rig()

    expect(adapter.spawnArgs(cfg).env['DISABLE_AUTOUPDATER']).toBe('1')
  })

  it('keeps the switch out of a granted variable’s reach', () => {
    // A grant is a value the Architect chose for one agent; this is a decision
    // the harness makes for the company. Order in the env literal is the only
    // thing enforcing that, so it is pinned here rather than left to reading.
    const { adapter, cfg } = rig()
    const env = adapter.spawnArgs({
      ...cfg,
      envGrants: { ...cfg.envGrants, DISABLE_AUTOUPDATER: '0' }
    }).env

    expect(env['DISABLE_AUTOUPDATER']).toBe('1')
  })

  it('injects identity and protocol on the command line', () => {
    const { adapter, cfg } = rig()
    const plan = adapter.spawnArgs(cfg)

    expect(plan.argv[0]).toBe('claude')
    // By pairing, not by position: argv gained `--permission-mode` at M7.7 and
    // a positional assertion turned a correct addition into a failure. What
    // matters is that the flag carries the identity, not where it sits.
    expect(plan.argv).toContain('--append-system-prompt')
    const appendix = plan.argv[plan.argv.indexOf('--append-system-prompt') + 1] ?? ''
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
    const { engineConfigDir, adapter, cfg, settingsPath, backupPath } = rig()
    const original = '{\r\n  "permissions": { "allow": ["Bash(ls)"] }\r\n}\r\n'
    fs.mkdirSync(engineConfigDir, { recursive: true })
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
    // `Edit(` is the probe because it is the rule that actually grants: the
    // engine matches file rules by exact tool name and only ever looks up
    // `Edit` and `Read`.
    expect(installed.permissions.allow.some((rule) => rule.startsWith('Edit('))).toBe(true)
    expect(installed.permissions.additionalDirectories).toHaveLength(1)

    await plan.uninstall()

    expect(fs.readFileSync(settingsPath).equals(originalBytes)).toBe(true)
    expect(fs.existsSync(backupPath)).toBe(false)
  })

  it('keeps the Architect own hooks alongside ours', async () => {
    const { engineConfigDir, adapter, cfg, settingsPath } = rig()
    fs.mkdirSync(engineConfigDir, { recursive: true })
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
    const { engineConfigDir, adapter, cfg, settingsPath } = rig()
    fs.mkdirSync(engineConfigDir, { recursive: true })
    fs.writeFileSync(settingsPath, '{ this is not json', 'utf8')

    expect(() => adapter.wireHooks(cfg)).toThrow(/not valid JSON, refusing to overwrite/)
  })

  it('refuses valid JSON that is not a settings OBJECT', () => {
    // Parseable and still not a settings file. Without its own guard the merge
    // spreads an array into `{}` and writes back a settings file whose keys are
    // "0", "1", "2" — the Architect's file destroyed by a write that succeeded.
    const { engineConfigDir, adapter, cfg, settingsPath } = rig()
    fs.mkdirSync(engineConfigDir, { recursive: true })
    fs.writeFileSync(settingsPath, '["hooks"]', 'utf8')

    expect(() => adapter.wireHooks(cfg)).toThrow(/not a JSON object, refusing to overwrite/)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('["hooks"]')
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

    // The shape the ENGINE actually matches, not the shape that reads well.
    // Claude Code filters its rule table by `toolName === n` (exact equality)
    // and only ever asks for `'Edit'` (every file-editing tool) or `'Read'`
    // (every file-reading tool). `Edit` is therefore the rule that keeps the
    // outbox writable, and ADR-0013's autonomy loop rests on it.
    expect(written.permissions.allow).toContain(`Edit(${agentDir}/**)`)
    expect(written.permissions.allow).toContain(`Read(${agentDir}/**)`)
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

  // The half that `toContain` cannot express. A grant is wrong in two
  // directions, and only one of them is a missing rule: a rule the engine never
  // looks up is worse than absent, because it reads like a grant, it survives
  // review, and it makes the one load-bearing rule beside it look redundant.
  // Adding `Write(<dir>/**)` back — the single most plausible future edit here,
  // since the tool the agent calls IS `Write` — must fail this test.
  it('writes no rule the engine will silently ignore', async () => {
    const { adapter, cfg, settingsPath } = rig()
    const plan = adapter.wireHooks(cfg)
    await plan.install()

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      permissions: { allow: string[] }
    }
    const agentDir = path.dirname(cfg.identityPath).split(path.sep).join('/')
    const mine = written.permissions.allow.filter((rule) => rule.includes(agentDir))

    expect(mine.length).toBeGreaterThan(0)
    for (const rule of mine) {
      const toolName = rule.slice(0, rule.indexOf('('))
      expect(CLAUDE_FILE_RULE_TOOLS).toContain(toolName)
    }
    // Named individually so a failure says which decoy came back rather than
    // only that the set changed.
    for (const inert of ['Write', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'MultiEdit']) {
      expect(mine).not.toContain(`${inert}(${agentDir}/**)`)
    }

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

describe('autonomy reaches the engine as its own permission mode', () => {
  /**
   * The harness gates its OWN actions, and `evaluateGate` refuses
   * `tool-permission` by construction — correctly, since the harness has no
   * action to permit there; the ENGINE is the thing blocked on a human. So
   * until this, an Architect who granted a profile full autonomy still answered
   * "Claude is waiting for your input" every few minutes, and no policy they
   * could write would stop it.
   */
  it('maps each level to the mode that matches it', () => {
    expect(claudePermissionMode('manual')).toBe('default')
    expect(claudePermissionMode('supervised')).toBe('acceptEdits')
    expect(claudePermissionMode('autonomous')).toBe('auto')
  })

  it('stops at `auto` and never reaches `bypassPermissions`', () => {
    // The case for autonomy was that a standing policy beats a human who has
    // stopped reading prompts. That is an argument for a better classifier,
    // not for switching the classifier off — so the top of the ladder is the
    // engine's own judgement, not the absence of judgement.
    const modes = (['manual', 'supervised', 'autonomous'] as const).map(claudePermissionMode)
    expect(modes).not.toContain('bypassPermissions')
  })

  it('puts the flag on the command line at spawn', () => {
    const r = rig()
    const argv = r.adapter.spawnArgs({ ...r.cfg, autonomy: 'autonomous' }).argv
    expect(argv[0]).toBe('claude')
    expect(argv).toContain('--permission-mode')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto')
  })

  it('asks by default for an agent nobody granted anything', () => {
    const r = rig()
    const argv = r.adapter.spawnArgs({ ...r.cfg, autonomy: 'manual' }).argv
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('default')
  })
})

/**
 * The seam, not the two halves.
 *
 * `test/main/settings-registry.test.ts` already proves the refcount: three
 * agents in one working directory, only the last one out restores the file.
 * But it hand-simulates the merged content as `'{"who":"a+b"}'`, so
 * `mergeClaudeSettings` never runs in it and nothing there could ever notice
 * what the merge actually produced. What it produced was every hook registered
 * once per agent, because the merge base is re-read from disk and agent two
 * merges into agent one's output rather than into the Architect's.
 *
 * That is not a cosmetic duplicate. Claude Code reads the result as a folder
 * pre-approving a pile of permissions for itself, and answers with a blocking
 * trust dialog whose highlighted default is "No, exit" — so on a live run all
 * three crew agents parked on that screen and never opened a session at all.
 */
describe('several agents sharing one working directory (live-run regression)', () => {
  const crew = ['agent.mason', 'agent.smith', 'agent.cooper'] as const

  /** Runs the real merge once per agent, feeding each result to the next. */
  function mergeForCrew(r: Rig, start: string | null = null): Record<string, never> {
    let text = start
    for (const agentId of crew) {
      const agentDir = path.join(path.dirname(path.dirname(r.cfg.identityPath)), agentId)
      fs.mkdirSync(agentDir, { recursive: true })
      fs.writeFileSync(path.join(agentDir, 'identity.md'), `# ${agentId}\n`, 'utf8')
      text = mergeClaudeSettings(
        text,
        {
          prompts: new PromptStore(path.join(r.cwd, 'home-prompts'), BUNDLED_PROMPTS),
          hookShimPath: path.join(r.cwd, '..', 'shims', 'eph-hook.mjs')
        },
        { ...r.cfg, agentId, identityPath: path.join(agentDir, 'identity.md') }
      )
    }
    return JSON.parse(text as string) as Record<string, never>
  }

  function agentDirOf(r: Rig, agentId: string): string {
    return path
      .join(path.dirname(path.dirname(r.cfg.identityPath)), agentId)
      .split(path.sep)
      .join('/')
  }

  it('registers each hook exactly once, however many agents share the directory', () => {
    const r = rig()
    const settings = mergeForCrew(r)
    const hooks = settings['hooks'] as unknown as Record<string, unknown[]>
    for (const engineEvent of Object.keys(CLAUDE_HOOK_EVENTS)) {
      expect(hooks[engineEvent], `${engineEvent} should be installed once`).toHaveLength(1)
    }
  })

  it('keeps every agent its own mailbox grant, and no agent two of them', () => {
    const r = rig()
    const settings = mergeForCrew(r)
    const permissions = settings['permissions'] as unknown as {
      allow: string[]
      additionalDirectories: string[]
    }
    // One rule per matched file-rule tool per agent, three agents, none
    // repeated. Derived rather than hardcoded: the count is a consequence of
    // the grant's shape, and pinning the number here would make a future
    // change to that shape look like a broken crew merge.
    const expected = CLAUDE_FILE_RULE_TOOLS.length * crew.length
    expect(permissions.allow).toHaveLength(expected)
    expect(new Set(permissions.allow).size).toBe(expected)
    expect(permissions.additionalDirectories).toHaveLength(3)
    for (const agentId of crew) {
      expect(permissions.additionalDirectories).toContain(agentDirOf(r, agentId))
      expect(permissions.allow).toContain(`Read(${agentDirOf(r, agentId)}/**)`)
    }
  })

  it('grows nothing when the same crew is installed again', () => {
    const r = rig()
    const once = mergeForCrew(r)
    const twice = mergeForCrew(r, JSON.stringify(once))
    expect(twice).toEqual(once)
  })

  it('leaves the Architect\u2019s own hooks and permissions alone', () => {
    const r = rig()
    const theirs = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node ./mine.js' }] }]
      },
      permissions: { allow: ['Bash(git status)'], additionalDirectories: ['/their/dir'] }
    }
    const settings = mergeForCrew(r, JSON.stringify(theirs))
    const hooks = settings['hooks'] as unknown as Record<string, unknown[]>
    expect(hooks['SessionStart']).toHaveLength(2)
    expect(JSON.stringify(hooks['SessionStart'])).toContain('./mine.js')
    const permissions = settings['permissions'] as unknown as {
      allow: string[]
      additionalDirectories: string[]
    }
    expect(permissions.allow).toContain('Bash(git status)')
    expect(permissions.additionalDirectories).toContain('/their/dir')
  })
})

describe('the auth probe reads a denial as a denial (M8.4)', () => {
  const probe = (): NonNullable<ReturnType<ClaudeAdapter['binary']>['authProbe']> => {
    const found = new ClaudeAdapter({
      prompts: null as never,
      hookShimPath: 'shim'
    }).binary().authProbe
    if (found === undefined) throw new Error('the reference adapter must have an auth probe')
    return found
  }

  it('does NOT read "Not logged in" as logged in', () => {
    // `Not logged in` contains `logged in`. A bare substring test therefore
    // sends a company to work with no session — the same shape as `reproduce`
    // matching `prod` (M7.4) and a spoken refusal confirming a gate (M6).
    expect(probe().authenticated('Not logged in. Run `claude auth login`.', 1)).toBe(false)
    expect(probe().authenticated('You are not authenticated.', 1)).toBe(false)
  })

  it('does not read a negation this adapter has never seen as a session', () => {
    // The ORDER above catches the wordings we know. This is what makes the
    // positive PATTERN load-bearing too: no denial phrase here matches, so the
    // only thing standing between 'Never logged in' and a company sent to work
    // with no session is that the positive test demands 'logged in AS'.
    expect(probe().authenticated('Never logged in on this machine', 1)).not.toBe(true)
    expect(probe().authenticated('previously logged in; session expired', 1)).not.toBe(true)
  })

  it('reads a real session as logged in', () => {
    expect(probe().authenticated('Logged in as architect@example.test', 0)).toBe(true)
    expect(probe().authenticated('Account: architect@example.test', 0)).toBe(true)
  })

  it('answers null when it cannot tell, which the manager trusts', () => {
    // Three-valued on purpose (`test/pin.ts`'s rule): a wording this adapter
    // does not know must not refuse to start a healthy company.
    expect(probe().authenticated('', 0)).toBeNull()
    expect(probe().authenticated('unknown subcommand: auth', 127)).toBeNull()
  })

  it('names the command that fixes it', () => {
    expect(probe().login).toBe('claude auth login')
    expect(probe().command).toEqual({ command: 'claude', args: ['auth', 'status'] })
  })
})

/**
 * The matcher, against what the CLI actually prints (2026-09-04).
 *
 * Everything above this block feeds the probe strings WE wrote, and every one
 * of them passed while the shipped matcher could not read a single byte of the
 * real `claude auth status`: it answers JSON by default
 * (`{"loggedIn": true, …}`) and, in `--text` mode, `Login method: … / Email: …`
 * — so the pre-fix patterns matched neither, always answered "cannot tell", and
 * `needs-login` could never fire on any machine that has ever existed.
 *
 * These read `test/fixtures/engine-output/`, whose provenance names the exact
 * command, CLI version and platform each capture came from, and pass the bytes
 * to the SHIPPED matcher. That is the whole difference: a test that can be
 * wrong about the engine is not a test of the engine.
 */
describe('the auth probe reads what the real CLI prints', () => {
  const FIXTURES = fileURLToPath(new URL('../../fixtures/engine-output/', import.meta.url))

  const probe = (): NonNullable<ReturnType<ClaudeAdapter['binary']>['authProbe']> => {
    const found = new ClaudeAdapter({ prompts: null as never, hookShimPath: 'shim' }).binary()
      .authProbe
    if (found === undefined) throw new Error('the reference adapter must have an auth probe')
    return found
  }
  const fixture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf8')

  it('reads the DEFAULT json answer of a logged-in machine', () => {
    expect(probe().authenticated(fixture('claude/auth-status.json'), 0)).toBe(true)
  })

  it('reads the same document with loggedIn false as logged out', () => {
    // The one case that cannot be captured — capturing it means signing the
    // Architect out of their own machine (recorded in PROVENANCE.json under
    // `notCaptured`). It is derived from the CAPTURED document by flipping the
    // one field the matcher keys on, not invented: every other key, type and
    // byte is the real answer.
    const loggedOut = fixture('claude/auth-status.json').replace(
      '"loggedIn": true',
      '"loggedIn": false'
    )
    expect(loggedOut).toContain('"loggedIn": false')
    expect(probe().authenticated(loggedOut, 0)).toBe(false)
  })

  it('reads the opt-in --text answer of a logged-in machine', () => {
    expect(probe().authenticated(fixture('claude/auth-status-text.txt'), 0)).toBe(true)
  })

  it('reads the CLI’s own logged-out wording, taken from the shipped binary', () => {
    // These three literals were read out of `@anthropic-ai/claude-code`'s
    // packaged binary at 2.1.252 — they are the CLI's words, not ours.
    expect(probe().authenticated('Not logged in · Run /login', 1)).toBe(false)
    expect(probe().authenticated('Not logged in · Please run /login', 1)).toBe(false)
    expect(probe().authenticated('Not logged in', 1)).toBe(false)
  })

  it('does not read a usage line as a denial', () => {
    // The literal `auth login` appears in this CLI's own help output — the
    // observed formatter prints `Usage: claude auth status [options]`, so the
    // login subcommand's is `Usage: claude auth login [options]`. Treating the
    // mere presence of those two words as "logged out" would refuse to start a
    // perfectly healthy company because the CLI printed its usage, so the
    // denial pattern demands the imperative around it.
    expect(probe().authenticated('Usage: claude auth login [options]', 1)).toBeNull()
    expect(probe().authenticated('Commands:\n  login\n  logout\n  status\n', 1)).toBeNull()
    expect(probe().authenticated('Usage: claude auth [options] [command]', 1)).toBeNull()
    // …and the imperative IS a denial, whichever way it is worded.
    expect(probe().authenticated('Run `claude auth login` to sign in.', 1)).toBe(false)
    expect(probe().authenticated('run claude auth login first', 1)).toBe(false)
  })

  it('falls back to cannot-tell when the json is not that document', () => {
    // A JSON answer without the field, and a truncated one. Both must reach
    // the manager as trusted, never as a refusal to start.
    expect(probe().authenticated('{"apiProvider":"firstParty"}', 0)).toBeNull()
    expect(probe().authenticated('{"loggedIn": tru', 0)).toBeNull()
    // A STRING is not a boolean: the matcher will not invent an answer from it.
    expect(probe().authenticated('{"loggedIn": "false"}', 0)).toBeNull()
  })

  it('parses the recorded version output with the shipped parser', () => {
    const binary = new ClaudeAdapter({ prompts: null as never, hookShimPath: 'shim' }).binary()
    expect(binary.parseVersion(fixture('claude/version.txt'))).toBe('2.1.252')
  })

  it('keeps the provenance honest about every fixture it ships', () => {
    const provenance = JSON.parse(fixture('PROVENANCE.json')) as {
      fixtures: { engine: string; probe: string; file: string; redacted: string[] }[]
    }
    for (const entry of provenance.fixtures) {
      // The file it names exists and is not empty…
      expect(fixture(entry.file).length).toBeGreaterThan(0)
      // …and a redacted field is never one the matcher reads, or the fixture
      // would be testing our redaction rather than the engine.
      expect(entry.redacted).not.toContain('loggedIn')
    }
  })
})

/**
 * The company signs its own work (ADR-0022), and nothing in a target repository
 * names the vendor whose model wrote the diff.
 *
 * Not hypothetical. On 2026-09-06 the crew opened MUSAHIT #1 — authored
 * correctly by `app/ephesus-crew` and trailed by a model name and an
 * `@anthropic.com` address, which SRS §6 criterion 10 forbids in the same
 * sentence that requires the co-author trailer. `check-attribution.cjs` scans
 * THIS repository and structurally could not have caught it: the commit was in
 * the target.
 */
describe('no vendor identity reaches a target repository', () => {
  const settingsFor = (existing: string | null): Record<string, unknown> =>
    JSON.parse(
      mergeClaudeSettings(existing, {
        prompts: new PromptStore(BUNDLED_PROMPTS, BUNDLED_PROMPTS),
        hookShimPath: 'hook-shim'
      })
    ) as Record<string, unknown>

  it('hides the engine’s commit trailer, its PR line, and its session URL', () => {
    const attribution = settingsFor(null)['attribution'] as Record<string, unknown>

    // Empty string is the engine's documented "hide it" value, not a placeholder.
    expect(attribution).toEqual({ commit: '', pr: '', sessionUrl: false })
  })

  it('sets the deprecated switch too, because the engine build is not pinned', () => {
    // ADR-0028 removes the agent's ability to change the install; it does not
    // pin which install the machine has. These are one switch across versions.
    expect(settingsFor(null)['includeCoAuthoredBy']).toBe(false)
  })

  it('OVERRIDES an attribution already in the file rather than merging it', () => {
    // Unlike hooks, permissions and the status line — surfaces an Architect may
    // be using — this is a company rule about whose name goes on the work.
    const settings = settingsFor(
      JSON.stringify({ attribution: { commit: 'Co-Authored-By: Someone <s@x>' } })
    )

    expect(settings['attribution']).toEqual({ commit: '', pr: '', sessionUrl: false })
  })

  it('reaches the per-agent settings file too, not just the shared one', () => {
    // Two branches return from `mergeClaudeSettings`, and only one of them is
    // the file an agent actually spawns with.
    const { adapter, cfg } = rig()
    const written = adapter.spawnArgs(cfg).settings?.[0]?.contents ?? '{}'
    const settings = JSON.parse(written) as Record<string, unknown>

    expect(settings['attribution']).toEqual({ commit: '', pr: '', sessionUrl: false })
    expect(settings['includeCoAuthoredBy']).toBe(false)
  })
})

describe('the per-agent settings file overrides attribution too', () => {
  it('replaces an attribution already written into the agent’s own file', () => {
    // The other override case goes through the no-cfg branch. This is the file
    // an agent actually spawns with, and a mutation that merged under the
    // existing value survived until this test existed.
    const { adapter, cfg, engineConfigDir, settingsPath } = rig()
    fs.mkdirSync(engineConfigDir, { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ attribution: { commit: 'Co-Authored-By: Someone <s@x>' } }),
      'utf8'
    )

    const written = adapter.spawnArgs(cfg).settings?.[0]?.contents ?? '{}'

    expect((JSON.parse(written) as Record<string, unknown>)['attribution']).toEqual({
      commit: '',
      pr: '',
      sessionUrl: false
    })
  })
})

/**
 * `GH_TOKEN` is a GitHub App installation token and expires an hour after the
 * spawn (ADR-0022) — inside the length of one ordinary run. PROTOCOL.md tells
 * an agent to run `$EPH_GH_TOKEN` after a 401, and nothing granted permission
 * to run it, so under `auto` the classifier refused and the agent had no way
 * through. Found live on 2026-09-06: the on-call agent pushed its second fix
 * branch, could not open the pull request, and escalated instead.
 */
describe('an agent may refresh the token the harness gave it', () => {
  const allowIn = (cfg: AgentSpawnConfig, adapter: ClaudeAdapter): readonly string[] => {
    const written = adapter.spawnArgs(cfg).settings?.[0]?.contents ?? '{}'
    const parsed = JSON.parse(written) as { permissions?: { allow?: string[] } }
    return parsed.permissions?.allow ?? []
  }

  it('grants exactly the literal PROTOCOL.md tells it to run', () => {
    const { adapter, cfg } = rig()
    const withToken = { ...cfg, ghTokenCommand: '/usr/bin/node /app/shims/eph-gh-token.mjs' }

    // The rule and the sentence live in different files; one that does not
    // match the other grants nothing at all.
    expect(allowIn(withToken, adapter)).toContain(`Bash(${GH_TOKEN_REFRESH_COMMAND})`)
    expect(GH_TOKEN_REFRESH_COMMAND).toBe('$EPH_GH_TOKEN')
  })

  it('grants the expanded form too, for an agent that resolves it first', () => {
    const { adapter, cfg } = rig()
    const withToken = { ...cfg, ghTokenCommand: '/usr/bin/node /app/shims/eph-gh-token.mjs' }

    expect(allowIn(withToken, adapter)).toContain('Bash(/usr/bin/node /app/shims/eph-gh-token.mjs)')
  })

  it('uses EXACT rules, never a prefix — this is a credential command', () => {
    // A `:*` prefix would also admit whatever an injected suffix appended to
    // it, and this command has no use for a suffix.
    const { adapter, cfg } = rig()
    const withToken = { ...cfg, ghTokenCommand: '/usr/bin/node /app/shims/eph-gh-token.mjs' }

    for (const rule of allowIn(withToken, adapter).filter((r) => r.startsWith('Bash('))) {
      expect(rule).not.toContain(':*')
      expect(rule).not.toContain('*')
    }
  })

  it('grants nothing when no company GitHub identity is configured', () => {
    // An empty command means there is no fresher token to get; a rule for it
    // would be a permission to run nothing.
    const { adapter, cfg } = rig()

    expect(
      allowIn({ ...cfg, ghTokenCommand: '' }, adapter).some((r) => r.startsWith('Bash('))
    ).toBe(false)
  })

  it('keeps the mailbox grant alongside it', () => {
    // Both are the harness's own grants and one must not displace the other.
    const { adapter, cfg } = rig()
    const withToken = { ...cfg, ghTokenCommand: '/usr/bin/node /app/shims/eph-gh-token.mjs' }
    const allow = allowIn(withToken, adapter)

    expect(allow.some((r) => r.startsWith('Edit('))).toBe(true)
    expect(allow.some((r) => r.startsWith('Bash('))).toBe(true)
  })
})

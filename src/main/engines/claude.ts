import fs from 'node:fs'
import path from 'node:path'
import type { HookEvent } from '../../shared/hooks'
import { writeFileAtomic } from '../fsx'
import type { PromptStore } from '../prompts'
import { baseAgentEnv } from './spawn-env'
import type {
  AgentSpawnConfig,
  BinarySpec,
  EngineAdapter,
  HookPlan,
  KeySequence,
  SettingsInjection,
  SpawnPlan
} from './types'

/**
 * The Claude Code adapter — the reference engine (ADR-0009: the only adapter
 * that may gate a release). Everything Claude-specific in Ephesus lives in this
 * file: which of its hooks means which harness event, which payload key holds a
 * tool name, where its settings file lives, what its cancel key is. Core never
 * learns any of it (NFR-12).
 */

/** `<cwd>/.claude/settings.local.json` — the local, gitignored variant only. */
export const CLAUDE_SETTINGS_REL = path.join('.claude', 'settings.local.json')
/** Where the pre-existing settings file is preserved while an agent runs. */
export const CLAUDE_SETTINGS_BACKUP_REL = `${CLAUDE_SETTINGS_REL}.eph-backup`
/** The prompt template that carries identity + protocol into the session. */
export const IDENTITY_PROMPT = path.join('engines', 'identity-appendix.md')

/**
 * Claude Code hook name → harness event (`src/shared/hooks.ts`). Verified
 * against the engine's documented hook set; the mapping is 1:1, so no harness
 * event is synthesised and none is dropped.
 */
export const CLAUDE_HOOK_EVENTS: Readonly<Record<string, HookEvent>> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt-submitted',
  PreToolUse: 'pre-tool',
  PostToolUse: 'post-tool',
  Stop: 'stop',
  PreCompact: 'compact-start',
  PostCompact: 'compact-end',
  SessionEnd: 'session-end'
}

/**
 * Payload key renames the shim applies, per hook. Claude Code sends
 * `tool_name`; the station map (SDD §6) reads `tool`. Unmapped keys pass
 * through untouched.
 */
const CLAUDE_FIELD_MAPS: Readonly<Record<string, readonly string[]>> = {
  PreToolUse: ['tool=tool_name'],
  PostToolUse: ['tool=tool_name']
}

/**
 * Claude Code's tools, sorted into the SDD §6 station-map classes. This table is
 * the *only* place these names exist in Ephesus: it is handed to the shim as
 * arguments, so the floor and the avatar machine see `file`/`shell`/`web`/`mcp`/
 * `ledger` and never a Claude tool name (NFR-12).
 *
 * A tool matching nothing here gets no class, and the avatar works at its desk
 * rather than walking to an invented station — the honest degradation when a new
 * engine tool appears (FR-2.3 in the visual domain).
 */
const CLAUDE_TOOL_CLASSES: Readonly<Record<string, readonly string[]>> = {
  file: ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'],
  shell: ['Bash', 'BashOutput', 'KillShell', 'KillBash'],
  web: ['WebFetch', 'WebSearch'],
  ledger: ['TodoWrite']
}

/** MCP tools are named `mcp__<server>__<tool>`; matched by prefix. */
const CLAUDE_TOOL_CLASS_PREFIXES: Readonly<Record<string, string>> = {
  mcp: 'mcp__'
}

/** The payload key the shim classifies from, after the `tool=tool_name` rename. */
const CLAUDE_CLASSIFY_KEY = 'tool'

/** Claude Code's cancel key is Escape (ADR-0009 `interrupt()`): U+001B. */
const ESCAPE_KEY = String.fromCharCode(0x1b)

/** Claude Code puts the session id in `session_id` on every hook payload. */
const CLAUDE_SESSION_FIELD = 'session_id'

interface ClaudeAdapterDeps {
  readonly prompts: PromptStore
  /** Absolute path to `shims/eph-hook.mjs`. */
  readonly hookShimPath: string
  /** Interpreter used to run the shim; `node`, resolved on the agent's PATH. */
  readonly nodeCommand?: string
}

/** Quotes a path for a shell command line; engines run hook commands via a shell. */
function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

/**
 * Composes the identity appendix from the agent's own `identity.md` and the
 * company `PROTOCOL.md` (SDD §2). Throws with the offending path when a source
 * is missing: an agent running without its identity is a silent failure, and
 * silent failure is the one unforgivable mode here (ENGINEERING-STANDARDS §4).
 */
function composeIdentity(cfg: AgentSpawnConfig, prompts: PromptStore): string {
  const read = (file: string, label: string): string => {
    if (!fs.existsSync(file)) {
      throw new Error(`claude: ${label} missing for agent "${cfg.agentId}" at ${file}`)
    }
    return fs.readFileSync(file, 'utf8').trim()
  }
  return prompts.render(IDENTITY_PROMPT, {
    agentId: cfg.agentId,
    identity: read(cfg.identityPath, 'identity.md'),
    protocol: read(cfg.protocolPath, 'PROTOCOL.md')
  })
}

/** The `hooks` block this adapter merges into the engine's settings file. */
function hookSettingsBlock(deps: ClaudeAdapterDeps): Record<string, unknown> {
  const node = deps.nodeCommand ?? 'node'
  const hooks: Record<string, unknown> = {}
  for (const [engineEvent, harnessEvent] of Object.entries(CLAUDE_HOOK_EVENTS)) {
    const maps = CLAUDE_FIELD_MAPS[engineEvent] ?? []
    const fields = maps.map((pair) => ` --field ${pair}`).join('')
    // Only the tool hooks carry a tool name, so only they need classifying.
    const classify =
      maps.length > 0
        ? ` --classify ${CLAUDE_CLASSIFY_KEY}` +
          Object.entries(CLAUDE_TOOL_CLASSES)
            .map(([cls, names]) => ` --class ${shellQuote(`${cls}=${names.join(',')}`)}`)
            .join('') +
          Object.entries(CLAUDE_TOOL_CLASS_PREFIXES)
            .map(([cls, prefix]) => ` --class-prefix ${shellQuote(`${cls}=${prefix}`)}`)
            .join('')
        : ''
    hooks[engineEvent] = [
      {
        hooks: [
          {
            type: 'command',
            command:
              `${node} ${shellQuote(deps.hookShimPath)} --event ${harnessEvent}` +
              `${fields}${classify} --session-field ${CLAUDE_SESSION_FIELD}`
          }
        ]
      }
    ]
  }
  return hooks
}

/**
 * Merges our hooks into whatever the repo already had, rather than replacing
 * the file: the Architect's own local settings keep working while an agent runs,
 * and their hooks still fire alongside ours.
 *
 * Contract: throws when the existing file is not valid JSON. Backing up
 * something we cannot parse and writing our own over it would look like it
 * worked; refusing to spawn until the file is fixed is the honest answer.
 */
export function mergeClaudeSettings(existing: string | null, deps: ClaudeAdapterDeps): string {
  let base: Record<string, unknown> = {}
  if (existing !== null && existing.trim().length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(existing)
    } catch (err) {
      throw new Error(
        `claude: ${CLAUDE_SETTINGS_REL} is not valid JSON, refusing to overwrite it: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`,
        { cause: err }
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `claude: ${CLAUDE_SETTINGS_REL} is not a JSON object, refusing to overwrite it`
      )
    }
    base = { ...(parsed as Record<string, unknown>) }
  }

  const existingHooks =
    typeof base['hooks'] === 'object' && base['hooks'] !== null && !Array.isArray(base['hooks'])
      ? (base['hooks'] as Record<string, unknown>)
      : {}

  const merged: Record<string, unknown> = { ...existingHooks }
  for (const [engineEvent, entry] of Object.entries(hookSettingsBlock(deps))) {
    const prior = Array.isArray(existingHooks[engineEvent]) ? existingHooks[engineEvent] : []
    merged[engineEvent] = [...prior, ...(entry as unknown[])]
  }

  return `${JSON.stringify({ ...base, hooks: merged }, null, 2)}\n`
}

class ClaudeHookPlan implements HookPlan {
  private installed = false
  private hadSettings = false
  private createdDir = false

  constructor(
    readonly injections: readonly SettingsInjection[],
    private readonly settingsPath: string,
    private readonly backupPath: string
  ) {}

  async install(): Promise<void> {
    if (this.installed) return
    const dir = path.dirname(this.settingsPath)
    this.createdDir = !fs.existsSync(dir)
    fs.mkdirSync(dir, { recursive: true })

    this.hadSettings = fs.existsSync(this.settingsPath)
    // Byte-for-byte, so restoring cannot re-encode the Architect's file.
    if (this.hadSettings) writeFileAtomic(this.backupPath, fs.readFileSync(this.settingsPath))

    for (const injection of this.injections) writeFileAtomic(injection.path, injection.contents)
    this.installed = true
  }

  async uninstall(): Promise<void> {
    if (!this.installed) return
    if (this.hadSettings && fs.existsSync(this.backupPath)) {
      writeFileAtomic(this.settingsPath, fs.readFileSync(this.backupPath))
      fs.rmSync(this.backupPath, { force: true })
    } else {
      fs.rmSync(this.settingsPath, { force: true })
      const dir = path.dirname(this.settingsPath)
      if (this.createdDir && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir)
      }
    }
    this.installed = false
  }
}

export class ClaudeAdapter implements EngineAdapter {
  readonly id = 'claude' as const
  /**
   * `native`: Claude Code fires real lifecycle hooks for every harness event, so
   * the floor reflects what actually happened rather than a guess at it.
   */
  readonly hooks = 'native' as const

  constructor(private readonly deps: ClaudeAdapterDeps) {}

  binary(): BinarySpec {
    return {
      name: 'claude',
      install: { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
      versionProbe: { command: 'claude', args: ['--version'] },
      // `claude --version` prints e.g. "2.1.195 (Claude Code)".
      parseVersion: (stdout) => /(\d+\.\d+\.\d+[\w.+-]*)/.exec(stdout)?.[1] ?? null
    }
  }

  spawnArgs(cfg: AgentSpawnConfig): SpawnPlan {
    const identity = composeIdentity(cfg, this.deps.prompts)
    return {
      argv: ['claude', '--append-system-prompt', identity],
      cwd: cfg.cwd,
      env: {
        ...baseAgentEnv(),
        ...cfg.envGrants,
        EPH_AGENT_ID: cfg.agentId,
        EPH_HOOK_TOKEN: cfg.hookToken,
        EPH_HOOK_ENDPOINT: cfg.hookEndpoint
      },
      settings: this.settingsInjections(cfg)
    }
  }

  wireHooks(cfg: AgentSpawnConfig): HookPlan {
    return new ClaudeHookPlan(
      this.settingsInjections(cfg),
      path.join(cfg.cwd, CLAUDE_SETTINGS_REL),
      path.join(cfg.cwd, CLAUDE_SETTINGS_BACKUP_REL)
    )
  }

  /**
   * Claude Code takes identity on the command line (`--append-system-prompt`),
   * so the injection itself happens in `spawnArgs`. What this method owes is the
   * precondition: the identity sources must exist and render. Failing here is
   * how a mis-hired agent is caught at spawn instead of quietly running with no
   * idea who it is.
   */
  injectIdentity(cfg: AgentSpawnConfig): void {
    composeIdentity(cfg, this.deps.prompts)
  }

  interrupt(): KeySequence {
    return { label: 'Escape', bytes: ESCAPE_KEY }
  }

  private settingsInjections(cfg: AgentSpawnConfig): readonly SettingsInjection[] {
    const settingsPath = path.join(cfg.cwd, CLAUDE_SETTINGS_REL)
    const existing = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null
    return [{ path: settingsPath, contents: mergeClaudeSettings(existing, this.deps) }]
  }
}

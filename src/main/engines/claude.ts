import fs from 'node:fs'
import path from 'node:path'
import type { HookEvent } from '../../shared/hooks'
import type { PromptStore } from '../prompts'
import type { SettingsRegistry } from '../settings-registry'
import { InstalledSettingsPlan } from './settings-install'
import { baseAgentEnv } from './spawn-env'
import type {
  AgentSpawnConfig,
  BinarySpec,
  EngineAdapter,
  HookPlan,
  KeySequence,
  ResumeSupport,
  SettingsInjection,
  SpawnPlan,
  TranscriptReader,
  UsageFact
} from './types'

/**
 * Claude Code writes one JSONL transcript per session under
 * `~/.claude/projects/<slugged cwd>/<sessionId>.jsonl`.
 *
 * The slug rule is "replace every character that is not ASCII alphanumeric
 * with a dash" — NOT merely the path separators. That distinction is the point
 * of this comment, because a narrower rule fails silently rather than loudly:
 * the directory simply does not exist, `transcriptFiles` finds nothing, and the
 * agent's ledger reads a permanent zero while `budgets.foldOne` still reports
 * the `'engine'` tier (FR-11.2). A wrong slug is therefore a spend
 * UNDER-reporting bug — the exact class ADR-0011 exists to close — so it is
 * pinned to observed behaviour, not to a guess about which characters matter.
 *
 * Verified empirically against 31 real `~/.claude/projects/*` directories on
 * Windows, matching each against the `cwd` recorded inside its own transcripts:
 *
 *   C:/Users/u/OneDrive/Masaüstü/ephesus     -> C--Users-u-OneDrive-Masa-st--ephesus
 *   C:/Users/u/OneDrive/Masaüstü/IBM Z Proj  -> C--Users-u-OneDrive-Masa-st--IBM-Z-Proj
 *   /home/user/ephesus                       -> -home-user-ephesus
 *
 * The drive-letter colon, both separators, a dotdir's dot, the space and the
 * non-ASCII `ü` all collapse to a dash; `-`, digits and letter case survive.
 * (An underscore is unattested in that corpus; this rule maps it to a dash.)
 *
 * `path.resolve` runs first because the engine slugs the ABSOLUTE cwd — a
 * relative one would otherwise slug to a different, non-existent directory.
 */
export function claudeTranscriptDir(cwd: string): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''
  const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')
  return path.join(home, '.claude', 'projects', slug)
}

/**
 * Folds Claude Code's transcript into usage facts (ADR-0009 `transcripts`,
 * FR-11.2).
 *
 * Only `assistant` lines carrying a `message.usage` object are facts. Cache
 * reads and cache writes are counted as input tokens because that is what they
 * are — tokens the provider billed on the way in; leaving them out would
 * under-report spend, which is the exact bug class ADR-0011 exists to close.
 *
 * The engine reports no per-message cost, so `costUsd` is null and the figure
 * stays a token figure. Deriving dollars would need a price table this
 * milestone has no source for, and a guessed price is worse than an honest
 * "not reported" (invariant §7).
 */
const claudeTranscripts: TranscriptReader = {
  transcriptDir: (cfg) => claudeTranscriptDir(cfg.cwd),
  read: async (filePath) => {
    // Read asynchronously and catch ENOENT rather than pre-checking: this runs
    // on the same event loop that carries PTY bytes and hook events (SDD §11,
    // NFR-1/NFR-2), and these transcripts reach tens of megabytes.
    let text: string
    try {
      text = await fs.promises.readFile(filePath, 'utf8')
    } catch {
      return []
    }
    const facts: UsageFact[] = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        // A torn final line from a killed engine yields no fact, never a
        // guessed one (ADR-0009's "unrecognized lines are skipped").
        continue
      }
      const fact = claudeUsageFact(raw)
      if (fact) facts.push(fact)
    }
    return facts
  }
}

/** Contract: one fact, or null for any line that is not a usage-bearing one. */
export function claudeUsageFact(raw: unknown): UsageFact | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (row['type'] !== 'assistant') return null
  const sessionId = row['sessionId']
  const message = row['message']
  if (typeof sessionId !== 'string' || typeof message !== 'object' || message === null) return null
  const msg = message as Record<string, unknown>
  const model = msg['model']
  const usage = msg['usage']
  if (typeof model !== 'string' || typeof usage !== 'object' || usage === null) return null
  const u = usage as Record<string, unknown>
  const num = (key: string): number => {
    const value = u[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  }
  const outTokens = num('output_tokens')
  const inTokens =
    num('input_tokens') + num('cache_creation_input_tokens') + num('cache_read_input_tokens')
  // A line with a usage object but no tokens at all is not a fact worth a row.
  if (inTokens === 0 && outTokens === 0) return null
  const timestamp = row['timestamp']
  return {
    sessionId,
    model,
    inTokens,
    outTokens,
    costUsd: null,
    at: typeof timestamp === 'string' && timestamp.length > 0 ? timestamp : null
  }
}

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
export const CLAUDE_SETTINGS_BACKUP_SUFFIX = '.eph-backup'
export const CLAUDE_SETTINGS_BACKUP_REL = `${CLAUDE_SETTINGS_REL}${CLAUDE_SETTINGS_BACKUP_SUFFIX}`
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
  // The engine's permission dialogs and trust prompts. Mapped from M3.3: an
  // agent stalled behind a dialog now becomes a visible gate (SDD §9 choke
  // point 1) instead of a floor that quietly stops moving.
  Notification: 'notification',
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

/**
 * Grants the agent access to its OWN mailbox, and nothing else.
 *
 * An agent's `agora/agents/<id>/` directory lives in the harness home, outside
 * the working directory it was spawned in — so the engine's own permission
 * model blocks writing to it, and the agent cannot post to its outbox at all.
 * That makes FR-3.2 ("agents SHALL write only inside their own `agents/<id>/`
 * directory") impossible to satisfy, which is how this was found: a real agent
 * in the M2 exit demo answered "the write was blocked by permissions".
 *
 * The grant is deliberately the narrowest thing that makes the documented
 * design work: this agent's own directory. Not the Agora, not `agents/`, not
 * another agent's mailbox — single-writer-per-file survives intact.
 */
function mailboxPermissions(cfg: AgentSpawnConfig): Record<string, unknown> {
  // Settings paths use forward slashes on every platform.
  const agentDir = path.dirname(cfg.identityPath).split(path.sep).join('/')
  // Every file tool the agent needs to work its own mailbox: read a message,
  // list what is waiting, write a reply, move a handled one aside.
  const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'NotebookEdit']
  return {
    allow: tools.map((tool) => `${tool}(${agentDir}/**)`),
    additionalDirectories: [agentDir]
  }
}

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
  /** Durable record of installed settings, so a killed harness can undo them. */
  readonly settingsRegistry?: SettingsRegistry
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
  return prompts
    .render(IDENTITY_PROMPT, {
      agentId: cfg.agentId,
      identity: read(cfg.identityPath, 'identity.md'),
      protocol: read(cfg.protocolPath, 'PROTOCOL.md'),
      // Layer 1 of the Library (ADR-0006). Composed and budgeted in main and
      // handed over on the spawn config, so a respawn carries what the agent
      // wrote before it died — this is `memory survives process death and
      // respawn` (FR-6.1) at the point it actually reaches the engine. Empty
      // for a hire that has not written anything yet, which is why it is the
      // last slot: nothing else has to move when it is absent.
      memory: cfg.memory
    })
    .replace(/\n{3,}$/, '\n')
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
export function mergeClaudeSettings(
  existing: string | null,
  deps: ClaudeAdapterDeps,
  cfg?: AgentSpawnConfig
): string {
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

  if (!cfg) return `${JSON.stringify({ ...base, hooks: merged }, null, 2)}\n`

  // Merge the mailbox grant into whatever the Architect already allowed, never
  // replacing their list.
  const grant = mailboxPermissions(cfg)
  const existingPermissions =
    typeof base['permissions'] === 'object' &&
    base['permissions'] !== null &&
    !Array.isArray(base['permissions'])
      ? (base['permissions'] as Record<string, unknown>)
      : {}
  const priorAllow = Array.isArray(existingPermissions['allow']) ? existingPermissions['allow'] : []
  const priorDirs = Array.isArray(existingPermissions['additionalDirectories'])
    ? existingPermissions['additionalDirectories']
    : []

  const permissions = {
    ...existingPermissions,
    allow: [...priorAllow, ...(grant['allow'] as unknown[])],
    additionalDirectories: [...priorDirs, ...(grant['additionalDirectories'] as unknown[])]
  }

  return `${JSON.stringify({ ...base, hooks: merged, permissions }, null, 2)}\n`
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
        EPH_HOOK_ENDPOINT: cfg.hookEndpoint,
        // The Library's agent-facing surface (ADR-0006 layer 2). Harness-owned
        // and identical for every engine, so the adapter only forwards it.
        ...(cfg.recallCommand.length === 0 ? {} : { EPH_RECALL: cfg.recallCommand })
      },
      settings: this.settingsInjections(cfg)
    }
  }

  wireHooks(cfg: AgentSpawnConfig): HookPlan {
    return new InstalledSettingsPlan(
      this.settingsInjections(cfg),
      cfg.agentId,
      CLAUDE_SETTINGS_BACKUP_SUFFIX,
      this.deps.settingsRegistry
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

  /**
   * `claude --resume <session>` reopens a session by the id the event plane
   * already records (ADR-0009 `ResumeSupport`, FR-1.4, FR-5.4). Declared but
   * unimplemented since M1 — the M1-audit gap — so a crashed agent came back
   * with no idea what it had been doing.
   */
  readonly resume: ResumeSupport = {
    resumeArgs: (sessionId) => ['--resume', sessionId]
  }

  readonly transcripts: TranscriptReader = claudeTranscripts

  private settingsInjections(cfg: AgentSpawnConfig): readonly SettingsInjection[] {
    const settingsPath = path.join(cfg.cwd, CLAUDE_SETTINGS_REL)
    const existing = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null
    return [{ path: settingsPath, contents: mergeClaudeSettings(existing, this.deps, cfg) }]
  }
}

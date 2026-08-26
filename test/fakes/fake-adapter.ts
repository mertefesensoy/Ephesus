import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOOK_EVENTS } from '../../src/shared/hooks'
import { writeFileAtomic } from '../../src/main/fsx'
import { baseAgentEnv } from '../../src/main/engines/spawn-env'
import type {
  AgentSpawnConfig,
  BinarySpec,
  EngineAdapter,
  HookPlan,
  KeySequence,
  SettingsInjection,
  SpawnPlan,
  TranscriptReader,
  UsageFact
} from '../../src/main/engines'

/**
 * An `EngineAdapter` over the fake engine — the second adapter the conformance
 * suite runs against (TEST-STRATEGY §5).
 *
 * It exists so the suite proves something. A conformance suite with one
 * implementation only proves that implementation compiles; with two it starts
 * catching assumptions that leaked out of `claude.ts` and into core. This one
 * deliberately uses a *different* mechanism for every part it can: settings in
 * its own file name, identity through the environment rather than argv, its own
 * cancel key.
 *
 * Its `EngineId` is `custom`, which is exactly what ADR-0009 reserves that id
 * for — no engine roster change is needed to test the surface.
 */

export const FAKE_ENGINE_CLI = fileURLToPath(
  new URL('./fake-engine/fake-engine.mjs', import.meta.url)
)

/** The fake's settings file — a local variant, like every engine's (ADR-0009). */
export const FAKE_SETTINGS_REL = path.join('.fake-engine', 'settings.local.json')
const FAKE_BACKUP_REL = `${FAKE_SETTINGS_REL}.eph-backup`

const ESCAPE_KEY = String.fromCharCode(0x1b)

export interface FakeAdapterOptions {
  /** Script the spawned fake will run. */
  readonly scriptPath: string
  /** Declared hook grade — overridable so the suite can prove a lie is caught. */
  readonly hooks?: EngineAdapter['hooks']
  /** Pretend the binary is absent, for the FR-1.6 path. */
  readonly missingBinary?: boolean
}

class FakeHookPlan implements HookPlan {
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

/** Reads the fake's transcript format: one JSON usage fact per line. */
const transcripts: TranscriptReader = {
  transcriptDir: (cfg) => path.join(cfg.cwd, '.fake-engine', 'transcripts'),
  read: async (filePath) => {
    if (!fs.existsSync(filePath)) return []
    const facts: UsageFact[] = []
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const raw: unknown = JSON.parse(line)
        if (typeof raw !== 'object' || raw === null) continue
        const row = raw as Record<string, unknown>
        if (typeof row['sessionId'] !== 'string' || typeof row['model'] !== 'string') continue
        if (typeof row['inTokens'] !== 'number' || typeof row['outTokens'] !== 'number') continue
        facts.push({
          sessionId: row['sessionId'],
          model: row['model'],
          inTokens: row['inTokens'],
          outTokens: row['outTokens'],
          costUsd: typeof row['costUsd'] === 'number' ? row['costUsd'] : null
        })
      } catch {
        // A line we cannot read yields no fact — never an invented one.
      }
    }
    return facts
  }
}

export function makeFakeAdapter(options: FakeAdapterOptions): EngineAdapter {
  const identityOf = (cfg: AgentSpawnConfig): string => {
    const read = (file: string, label: string): string => {
      if (!fs.existsSync(file)) {
        throw new Error(`fake: ${label} missing for agent "${cfg.agentId}" at ${file}`)
      }
      return fs.readFileSync(file, 'utf8').trim()
    }
    return `${read(cfg.identityPath, 'identity.md')}\n\n${read(cfg.protocolPath, 'PROTOCOL.md')}`
  }

  const injections = (cfg: AgentSpawnConfig): readonly SettingsInjection[] => [
    {
      path: path.join(cfg.cwd, FAKE_SETTINGS_REL),
      contents: `${JSON.stringify(
        {
          hookCommand: `node ${FAKE_ENGINE_CLI}`,
          events: [...HOOK_EVENTS]
        },
        null,
        2
      )}\n`
    }
  ]

  return {
    id: 'custom',
    hooks: options.hooks ?? 'native',

    binary(): BinarySpec {
      return {
        name: options.missingBinary ? 'fake-engine-not-installed' : process.execPath,
        install: { command: 'echo', args: ['pretend-install'] },
        versionProbe: { command: process.execPath, args: ['--version'] },
        parseVersion: (stdout) => /v?(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null
      }
    },

    spawnArgs(cfg: AgentSpawnConfig): SpawnPlan {
      return {
        argv: [process.execPath, FAKE_ENGINE_CLI, '--script', options.scriptPath],
        cwd: cfg.cwd,
        env: {
          ...baseAgentEnv(),
          ...cfg.envGrants,
          EPH_AGENT_ID: cfg.agentId,
          EPH_HOOK_TOKEN: cfg.hookToken,
          EPH_HOOK_ENDPOINT: cfg.hookEndpoint,
          EPH_AGENT_DIR: path.dirname(cfg.identityPath),
          // A different mechanism from claude's `--append-system-prompt`, on
          // purpose: the suite must test the effect, not the mechanism.
          EPH_IDENTITY: identityOf(cfg)
        },
        settings: injections(cfg)
      }
    },

    wireHooks(cfg: AgentSpawnConfig): HookPlan {
      return new FakeHookPlan(
        injections(cfg),
        path.join(cfg.cwd, FAKE_SETTINGS_REL),
        path.join(cfg.cwd, FAKE_BACKUP_REL)
      )
    },

    injectIdentity(cfg: AgentSpawnConfig): void {
      identityOf(cfg)
    },

    interrupt(): KeySequence {
      return { label: 'Escape', bytes: ESCAPE_KEY }
    },

    resume: {
      resumeArgs: (sessionId) => ['--resume', sessionId]
    },

    transcripts
  }
}

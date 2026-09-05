import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_CONFIG_REL,
  CLAUDE_HARNESS_SETTINGS_REL,
  ClaudeAdapter,
  claudeCredentialsDir,
  claudeTranscriptDir,
  prepareClaudeConfigDir
} from '../../../src/main/engines/claude'
import { ENGINES_DIR, engineConfigDir } from '../../../src/main/engines/engine-home'
import { PromptStore } from '../../../src/main/prompts'
import type { AgentSpawnConfig } from '../../../src/main/engines/types'
import { removeTempDir } from '../../tmpdir'
import { NO_TOOLS } from '../../../src/shared/engine-tools'

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../../prompts/', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-iso-'))
  temps.push(dir)
  return dir
}

function rig(agentId = 'agent.mason'): {
  readonly root: string
  readonly adapter: ClaudeAdapter
  readonly cfg: AgentSpawnConfig
} {
  const root = tempRoot()
  const cwd = path.join(root, 'repo')
  const agora = path.join(root, 'agora', 'agents', agentId)
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(agora, { recursive: true })
  fs.writeFileSync(path.join(agora, 'identity.md'), '# Mason\nRole: ci-babysitter.\n', 'utf8')
  fs.writeFileSync(path.join(root, 'agora', 'PROTOCOL.md'), '# Protocol\nRules.\n', 'utf8')
  return {
    root,
    adapter: new ClaudeAdapter({
      prompts: new PromptStore(path.join(root, 'prompts'), BUNDLED_PROMPTS),
      hookShimPath: path.join(root, 'shims', 'eph-hook.mjs')
    }),
    cfg: {
      agentId,
      hookToken: 'iso-token',
      hookEndpoint: path.join(root, 'events.sock'),
      cwd,
      engineConfigDir: engineConfigDir(path.join(root, ENGINES_DIR), 'claude', agentId),
      tools: NO_TOOLS,
      commitIdentity: null,
      envGrants: {},
      identityPath: path.join(agora, 'identity.md'),
      protocolPath: path.join(root, 'agora', 'PROTOCOL.md'),
      memory: '',
      recallCommand: '',
      ghTokenCommand: '',
      autonomy: 'manual'
    }
  }
}

/**
 * Until M8.7 a hire simply ran the Architect's own engine install. The measured
 * consequence was not only the token floor — that figure is machine-specific and
 * the package is not sold on it — but six Stop hooks per turn, five of them the
 * Architect's, any of which could continue an agent by answering
 * `{"decision":"block"}` outside the harness's decision entirely: uncounted by
 * the block cap, invisible to the breaker's stop-loop signal (ADR-0011), and
 * unaffected by pacing (ADR-0023). ADR-0013's claim that the Stop hook is *the*
 * autonomy hinge was therefore false in the way nothing would ever report.
 */
describe('the agent runs its own engine install, not the Architect’s (ADR-0026)', () => {
  it('gives every agent a different config directory, under the harness home', () => {
    const root = path.join(tempRoot(), ENGINES_DIR)
    const mason = engineConfigDir(root, 'claude', 'agent.mason')
    const kallias = engineConfigDir(root, 'claude', 'agent.kallias')

    expect(mason).not.toBe(kallias)
    expect(path.relative(root, mason).startsWith('..')).toBe(false)
    expect(path.relative(root, kallias).startsWith('..')).toBe(false)
    // Different engines are separate too, so an agent hired twice on different
    // engines does not run the second one against the first one's state.
    expect(engineConfigDir(root, 'codex', 'agent.mason')).not.toBe(mason)
  })

  it('refuses an id that could escape or collide, rather than sanitising it', () => {
    // Sanitising is how two agents quietly end up sharing one config file —
    // exactly the sharing per-agent directories exist to prevent — and a
    // company that silently pairs two agents is worse than one that will not
    // hire the second.
    const root = tempRoot()
    for (const bad of ['..', 'a/b', 'a\\b', '', '.hidden', 'C:agent', 'a..b']) {
      expect(() => engineConfigDir(root, 'claude', bad)).toThrow(/refusing agent id/)
    }
    expect(() => engineConfigDir(root, '../escape', 'agent.mason')).toThrow(/refusing engine id/)
  })

  it('points the engine at that directory, and its credentials at the Architect’s', () => {
    // Measured on a real install: an isolated config directory alone reports
    // `loggedIn:false`, so every hire would meet a login prompt before any
    // session — no hook, no report, a parked agent. Adding the credentials
    // directory reports `loggedIn:true` with the config still isolated.
    const { adapter, cfg } = rig()
    const plan = adapter.spawnArgs(cfg)

    expect(plan.env['CLAUDE_CONFIG_DIR']).toBe(cfg.engineConfigDir)
    expect(plan.env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(claudeCredentialsDir())
    // The credentials are the Architect's, so they must NOT be inside the
    // isolated directory — that is the whole difference between borrowing a
    // session and having none.
    expect(plan.env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).not.toBe(cfg.engineConfigDir)
  })

  it('follows an Architect who already runs the engine elsewhere', () => {
    // Their credentials live wherever their config directory is. Reading
    // `$HOME/.claude` unconditionally would hand such a machine an empty
    // credentials directory and park the whole company.
    expect(claudeCredentialsDir({ CLAUDE_CONFIG_DIR: '/opt/cc', HOME: '/home/u' })).toBe('/opt/cc')
    expect(claudeCredentialsDir({ HOME: '/home/u' })).toBe(path.join('/home/u', '.claude'))
    // No home at all: the empty value is deliberate and must survive, because
    // the engine reads it as `<homedir>/.claude` while OMITTING the variable
    // would send it back to the isolated directory, which has no credentials.
    expect(claudeCredentialsDir({})).toBe('')
  })
})

describe('the harness is the only hook author (ADR-0026)', () => {
  it('loads no user, project or local settings, and names its own file instead', () => {
    const { adapter, cfg } = rig()
    const plan = adapter.spawnArgs(cfg)
    const settingsFile = path.join(cfg.engineConfigDir, CLAUDE_HARNESS_SETTINGS_REL)

    // By pairing, not by position: argv has gained flags at M7.7 and M8.7 and
    // will gain more.
    expect(plan.argv).toContain('--setting-sources=')
    expect(plan.argv[plan.argv.indexOf('--settings') + 1]).toBe(settingsFile)
    // The flag must point at the file the plan actually writes. Two expressions
    // computing this path would give an agent a flag pointing at a file nothing
    // wrote — no harness hooks, no lifecycle events, and it reads as a quiet
    // agent rather than as a bug.
    expect(plan.settings.map((injection) => injection.path)).toEqual([settingsFile])
  })

  it('uses the attached form, because an empty argv element can be lost on Windows', () => {
    // `--setting-sources ''` as two elements is one that Windows command-line
    // composition may drop on the way to conpty; a dropped lockdown flag is a
    // check that cannot fail. Stated as a rule over the WHOLE vector so a later
    // flag cannot reintroduce the hazard.
    const { adapter, cfg } = rig()
    for (const argument of adapter.spawnArgs(cfg).argv) {
      expect(argument).not.toBe('')
    }
  })

  it('writes its settings outside every checkout', () => {
    const { adapter, cfg } = rig()
    for (const injection of adapter.spawnArgs(cfg).settings) {
      expect(path.relative(cfg.cwd, injection.path).startsWith('..')).toBe(true)
      expect(path.relative(cfg.engineConfigDir, injection.path).startsWith('..')).toBe(false)
    }
  })
})

describe('a fresh config directory is usable without a human (ADR-0026)', () => {
  it('accepts the onboarding the Architect has already completed', () => {
    // A directory the engine has never seen starts at its onboarding flow, which
    // runs BEFORE any session and therefore fires no hook — the same shape as
    // the trust dialog ADR-0021 exists to close.
    const dir = path.join(tempRoot(), 'engine-config')
    const result = prepareClaudeConfigDir(dir)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.seeded).toEqual([path.join(dir, CLAUDE_CONFIG_REL)])
    const config: Record<string, unknown> = JSON.parse(
      fs.readFileSync(path.join(dir, CLAUDE_CONFIG_REL), 'utf8')
    ) as Record<string, unknown>
    expect(config['hasCompletedOnboarding']).toBe(true)
  })

  it('is idempotent, and keeps every key already in the file', () => {
    // It shares the file with `trustWorkspace`: seeding that dropped the trust
    // records would put the agent back on the dialog this all exists to avoid.
    const dir = path.join(tempRoot(), 'engine-config')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, CLAUDE_CONFIG_REL),
      JSON.stringify({ projects: { '/repo': { hasTrustDialogAccepted: true } } }),
      'utf8'
    )

    const first = prepareClaudeConfigDir(dir)
    expect(first.ok && first.seeded).toEqual([path.join(dir, CLAUDE_CONFIG_REL)])
    const second = prepareClaudeConfigDir(dir)
    // Already onboarded: nothing to report, and nothing written.
    expect(second.ok && second.seeded).toEqual([])

    const config = JSON.parse(fs.readFileSync(path.join(dir, CLAUDE_CONFIG_REL), 'utf8')) as Record<
      string,
      Record<string, Record<string, unknown>>
    >
    expect(config['hasCompletedOnboarding']).toBe(true)
    expect(config['projects']?.['/repo']?.['hasTrustDialogAccepted']).toBe(true)
  })

  it('refuses rather than repairs a file it cannot read', () => {
    const dir = path.join(tempRoot(), 'engine-config')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, CLAUDE_CONFIG_REL), '{ not json', 'utf8')

    const result = prepareClaudeConfigDir(dir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.because).toMatch(/unreadable/)
    expect(fs.readFileSync(path.join(dir, CLAUDE_CONFIG_REL), 'utf8')).toBe('{ not json')
  })

  it('refuses an empty directory rather than writing to the process cwd', () => {
    const result = prepareClaudeConfigDir('')
    expect(result.ok).toBe(false)
  })
})

/**
 * The defect class this codebase keeps paying for is two correct halves with no
 * test spanning them. Moving the config directory moves four things at once, and
 * each of these cases exists to hold one producer and its consumer together.
 */
describe('everything that follows the config directory follows it (ADR-0026)', () => {
  it('reads transcripts from the directory the spawn actually used', () => {
    const { adapter, cfg } = rig()
    const reader = adapter.transcripts
    const dir = reader.transcriptDir(cfg)

    expect(dir).toBe(claudeTranscriptDir(cfg.engineConfigDir, cfg.cwd))
    expect(path.relative(cfg.engineConfigDir, dir).startsWith('..')).toBe(false)
    // A reader still computing `$HOME/.claude/projects` finds nothing, folds a
    // permanent zero, and `budgets.foldOne` still reports the `engine` tier —
    // silent spend UNDER-reporting, the class ADR-0011 exists to close.
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''
    if (home.length > 0) expect(dir.startsWith(path.join(home, '.claude'))).toBe(false)
  })

  it('records workspace trust in that directory, not in the Architect’s', () => {
    const { adapter, cfg } = rig()
    fs.mkdirSync(cfg.engineConfigDir, { recursive: true })

    const result = adapter.trustWorkspace(cfg.engineConfigDir, cfg.cwd)
    expect(result.ok).toBe(true)
    const config = JSON.parse(
      fs.readFileSync(path.join(cfg.engineConfigDir, CLAUDE_CONFIG_REL), 'utf8')
    ) as Record<string, Record<string, Record<string, unknown>>>
    if (result.ok) expect(config['projects']?.[result.path]?.['hasTrustDialogAccepted']).toBe(true)
  })

  it('asks about the agent’s own install when it probes for a login', () => {
    // Equivalent to probing the harness's environment only because the company
    // currently borrows the Architect's credentials. The moment that decision
    // changes, a probe run in the harness's environment reports the Architect's
    // session for an agent that has none, and the agent spawns `running` onto a
    // login prompt — the failure M8.4's probe was added to prevent, arriving
    // from the other side.
    const { adapter, cfg } = rig()
    const probeEnv = adapter.probeEnv(cfg)
    const spawnEnv = adapter.spawnArgs(cfg).env

    expect(probeEnv['CLAUDE_CONFIG_DIR']).toBe(cfg.engineConfigDir)
    expect(probeEnv['CLAUDE_CONFIG_DIR']).toBe(spawnEnv['CLAUDE_CONFIG_DIR'])
    expect(probeEnv['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(
      spawnEnv['CLAUDE_SECURESTORAGE_CONFIG_DIR']
    )
  })
})

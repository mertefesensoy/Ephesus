import fs from 'node:fs'
import path from 'node:path'
import type { PromptStore } from '../prompts'
import { baseAgentEnv } from './spawn-env'
import type {
  AgentSpawnConfig,
  BinarySpec,
  EngineAdapter,
  HookPlan,
  KeySequence,
  SpawnPlan
} from './types'

/**
 * The **Gemini CLI** adapter (ADR-0009's roster, M4.7).
 *
 * Everything asserted here was checked against a real `gemini` 0.57.0: its
 * `--version` output, its `--help` surface (`gemini [options] [query..]`,
 * `-r/--resume`, `--skip-trust`, `--include-directories`), its
 * `gemini hooks` subcommand, and its own bundled hook documentation.
 *
 * ## Why this adapter declares `pty-heuristic`
 *
 * Gemini CLI has the best-documented hook plane in the roster after Claude
 * Code's — `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`,
 * `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`,
 * `AfterTool`, `PreCompress`, `Notification`, declared in a `hooks` block whose
 * shape is published. Two documented facts still stand between wiring it and
 * an event reaching this harness, and neither is ours to wave away:
 *
 *  1. **The file is tracked.** Gemini's project settings live at
 *     `.gemini/settings.json` — its own docs show it being `git add`-ed. It has
 *     no project-local variant (the only `settings.local.json` in the CLI is
 *     the *Claude Code* file its `hooks migrate` command reads). ADR-0009 is
 *     categorical: engine settings are "only ever written to local/gitignored
 *     variants". Writing a tracked file into the Architect's repository — even
 *     with a backup and an uninstall — is the harm that rule exists to prevent,
 *     and deviating from it is a BUILD-PROMPT §8 must-ask.
 *  2. **Project hooks are untrusted by default.** Gemini's own best-practices
 *     page says so, and the override is `--skip-trust`. The harness lowering a
 *     trust default on the Architect's behalf is what the Watch exists to
 *     prevent (SDD §9).
 *
 * So this adapter writes nothing, claims no events, and the agent card says
 * `pty-heuristic`. The wiring is a small change away once the Architect rules
 * on the tracked-file question — and it owes a live demonstration before the
 * grade moves, which is what the grade means (FR-2.3).
 */

/** Verified: `gemini --version` prints a bare `0.57.0`. */
const VERSION_LINE = /v?(\d+\.\d+\.\d+[\w.+-]*)/

/** Escape cancels the running turn in the Gemini TUI, as in the rest of the roster. */
const ESCAPE_KEY = String.fromCharCode(0x1b)

const IDENTITY_PROMPT = path.join('engines', 'identity-appendix.md')

export interface GeminiAdapterDeps {
  readonly prompts: PromptStore
}

function composeIdentity(cfg: AgentSpawnConfig, prompts: PromptStore): string {
  const read = (file: string, label: string): string => {
    if (!fs.existsSync(file)) {
      throw new Error(`gemini: ${label} missing for agent "${cfg.agentId}" at ${file}`)
    }
    return fs.readFileSync(file, 'utf8').trim()
  }
  return prompts
    .render(IDENTITY_PROMPT, {
      agentId: cfg.agentId,
      identity: read(cfg.identityPath, 'identity.md'),
      protocol: read(cfg.protocolPath, 'PROTOCOL.md'),
      memory: cfg.memory
    })
    .replace(/\n{3,}$/, '\n')
}

/** The honest plan for an adapter that declares `pty-heuristic`: install nothing. */
class NoSettingsPlan implements HookPlan {
  readonly injections: readonly never[] = []

  install(): Promise<void> {
    return Promise.resolve()
  }

  uninstall(): Promise<void> {
    return Promise.resolve()
  }
}

export class GeminiAdapter implements EngineAdapter {
  readonly id = 'gemini' as const

  /** See the class comment: the grade this build can demonstrate is none. */
  readonly hooks = 'pty-heuristic' as const

  constructor(private readonly deps: GeminiAdapterDeps) {}

  binary(): BinarySpec {
    return {
      name: 'gemini',
      install: { command: 'npm', args: ['install', '-g', '@google/gemini-cli'] },
      versionProbe: { command: 'gemini', args: ['--version'] },
      parseVersion: (stdout) => VERSION_LINE.exec(stdout.trim())?.[1] ?? null
    }
  }

  /**
   * `gemini <identity>` — the positional `[query..]`, which the CLI's own help
   * calls the "Initial prompt. Runs in interactive mode by default". That is
   * SDD §3's first-prompt injection, and the only mechanism available: Gemini's
   * context file (`GEMINI.md`) and its settings both live at tracked paths
   * ADR-0009 forbids writing.
   *
   * `-p/--prompt` is deliberately NOT used: it runs headless and exits, and an
   * agent whose terminal is not interactive is not an agent this harness can
   * steer (FR-1.3).
   */
  spawnArgs(cfg: AgentSpawnConfig): SpawnPlan {
    const identity = composeIdentity(cfg, this.deps.prompts)
    return {
      argv: ['gemini', identity],
      cwd: cfg.cwd,
      env: {
        ...baseAgentEnv(),
        ...cfg.envGrants,
        EPH_AGENT_ID: cfg.agentId,
        EPH_HOOK_TOKEN: cfg.hookToken,
        EPH_HOOK_ENDPOINT: cfg.hookEndpoint,
        ...(cfg.recallCommand.length === 0 ? {} : { EPH_RECALL: cfg.recallCommand })
      },
      settings: []
    }
  }

  /**
   * Contract: a plan that installs nothing, for every spawn. The config is
   * unused precisely because nothing about a spawn changes what gets written —
   * which is the point.
   */
  wireHooks(): HookPlan {
    return new NoSettingsPlan()
  }

  injectIdentity(cfg: AgentSpawnConfig): void {
    composeIdentity(cfg, this.deps.prompts)
  }

  interrupt(): KeySequence {
    return { label: 'Escape', bytes: ESCAPE_KEY }
  }

  /**
   * **No `resume`, for a different reason than codex's.**
   *
   * Gemini's resume IS an appendable flag — `-r/--resume` — so the contract
   * shape fits. What does not fit is the argument: its own help says
   * `--resume` takes `"latest"` or an *index number*, never a session id, and
   * `ResumeSupport.resumeArgs` is handed the id the event plane recorded.
   * `--resume latest` would ignore that id and reopen whatever session ran most
   * recently *in that directory* — which, for two agents sharing a repo, is the
   * cross-attribution bug M3 spent a package removing from the cost ledger.
   *
   * So: no resume, `respawnOffer.resumable: false`, and the card is honest.
   */

  /**
   * **No `transcripts`.** Gemini records sessions (`--list-sessions`,
   * `--session-file`), but this environment has no Gemini credentials, so the
   * on-disk shape is unverified. A reader written against a guessed format
   * would fold invented numbers into the append-only cost ledger, which
   * ADR-0011 forbids. Spend reports source `none`, visibly.
   */
}

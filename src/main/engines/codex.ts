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
 * The **Codex CLI** adapter (ADR-0009's roster, M4.6).
 *
 * Everything asserted here was checked against a real `codex-cli 0.150.1`:
 * its `--version` output, its `--help` surface (`codex [OPTIONS] [PROMPT]`,
 * `-C/--cd <DIR>`, `--dangerously-bypass-hook-trust`), and
 * `codex resume [SESSION_ID] [PROMPT]`. Nothing below is inferred from how
 * another engine works.
 *
 * ## Why this adapter declares `pty-heuristic`
 *
 * ADR-0009 grades hook fidelity and FR-2.3 requires the grade to be honest:
 * **declared must be what is demonstrated**, and the conformance suite exists
 * to catch the other direction. Codex 0.150.1 does have a hook plane — its
 * binary carries `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`,
 * `Stop`, `SubagentStop`, `PreCompact`, `PostCompact`, `UserPromptSubmit`,
 * `Notification`, `TurnStart`, `TurnEnd` — but two things stand between an
 * installed hook file and an event reaching this harness:
 *
 *  1. **Hook trust.** Codex refuses to run enabled hooks without persisted
 *     trust, and the only override is `--dangerously-bypass-hook-trust`, whose
 *     own help calls it dangerous. Passing that on every spawn would be the
 *     harness quietly lowering a permission default on the Architect's behalf —
 *     precisely what the Watch exists to prevent (SDD §9), and a BUILD-PROMPT §8
 *     must-ask rather than an implementation detail.
 *  2. **An unverified file format.** The hook file's schema and its discovery
 *     precedence are not something this build could confirm against the real
 *     CLI, and writing a guessed config into the Architect's repository is the
 *     improvisation BUILD-PROMPT §7 forbids.
 *
 * So this adapter writes **no settings at all** and claims the grade that
 * matches: `pty-heuristic`, no events. The agent card says so, the breaker
 * scales its sensitivity down accordingly (ADR-0011), and nothing is left in
 * anyone's repository. Raising the grade is a later package's job, and it owes
 * a live demonstration first — that is what the grade means.
 */

/** Verified: `codex --version` prints `codex-cli 0.150.1`. */
const VERSION_LINE = /codex(?:-cli)?\s+v?(\d+\.\d+\.\d+[\w.+-]*)/i

/**
 * Verified from the TUI's own key surface: Escape cancels the running turn.
 * Same byte as every other engine in the roster uses for cancel (ADR-0009).
 */
const ESCAPE_KEY = String.fromCharCode(0x1b)

/** `prompts/engines/identity-appendix.md` — shared by every adapter. */
const IDENTITY_PROMPT = path.join('engines', 'identity-appendix.md')

export interface CodexAdapterDeps {
  readonly prompts: PromptStore
}

/**
 * Composes the standing context Codex is started with.
 *
 * Throws with the offending path when a source is missing, exactly as the
 * reference adapter does: an agent running without its identity is a silent
 * failure, and silent failure is the one unforgivable mode here.
 */
function composeIdentity(cfg: AgentSpawnConfig, prompts: PromptStore): string {
  const read = (file: string, label: string): string => {
    if (!fs.existsSync(file)) {
      throw new Error(`codex: ${label} missing for agent "${cfg.agentId}" at ${file}`)
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

/**
 * A `HookPlan` that installs nothing.
 *
 * Not a stub: it is the honest plan for an adapter that declares
 * `pty-heuristic`. ADR-0009's settings-hygiene rule is about what an adapter
 * leaves behind, and the strongest possible answer is nothing. `uninstall()` is
 * safe before, after and twice, which is what the conformance table checks.
 */
class NoSettingsPlan implements HookPlan {
  readonly injections: readonly never[] = []

  install(): Promise<void> {
    return Promise.resolve()
  }

  uninstall(): Promise<void> {
    return Promise.resolve()
  }
}

export class CodexAdapter implements EngineAdapter {
  readonly id = 'codex' as const

  /** See the class comment: the grade this build can demonstrate is none. */
  readonly hooks = 'pty-heuristic' as const
  /**
   * ADR-0031. This adapter has no flag to map autonomy onto, so the engine's
   * own configuration decides — and that configuration is the OPERATOR'S,
   * not the harness's. Declaring `none` is what makes a `manual` or
   * `supervised` hire refuse to spawn here rather than run at a level nobody
   * chose. It becomes `enforced` when the flags are established by execution,
   * the way ADR-0026 established Claude's — never by guessing them.
   */
  readonly autonomySupport = 'none' as const

  constructor(private readonly deps: CodexAdapterDeps) {}

  binary(): BinarySpec {
    return {
      name: 'codex',
      install: { command: 'npm', args: ['install', '-g', '@openai/codex'] },
      versionProbe: { command: 'codex', args: ['--version'] },
      parseVersion: (stdout) => VERSION_LINE.exec(stdout)?.[1] ?? null
    }
  }

  /**
   * `codex --cd <cwd> <identity>`.
   *
   * Identity reaches the agent as the **first prompt** — one of the three
   * mechanisms SDD §3 names, and the only one available here: Codex has no
   * `--append-system-prompt`, and its context files (`AGENTS.md`) live at paths
   * ADR-0009 forbids writing to, because they are not local/gitignored variants
   * of the Architect's own files.
   */
  spawnArgs(cfg: AgentSpawnConfig): SpawnPlan {
    const identity = composeIdentity(cfg, this.deps.prompts)
    return {
      argv: ['codex', '--cd', cfg.cwd, identity],
      cwd: cfg.cwd,
      env: {
        ...baseAgentEnv(),
        ...cfg.envGrants,
        // The company authors, the agent co-authors itself (ADR-0022). Set as
        // environment rather than repo config so nothing is written into the
        // Architect's checkout, and absent entirely when no App is configured —
        // an agent with no identity commits as whoever git already thought it
        // was, which is visible, rather than as a name we invented.
        ...(cfg.commitIdentity === null
          ? {}
          : {
              GIT_AUTHOR_NAME: cfg.commitIdentity.name,
              GIT_AUTHOR_EMAIL: cfg.commitIdentity.email,
              GIT_COMMITTER_NAME: cfg.commitIdentity.name,
              GIT_COMMITTER_EMAIL: cfg.commitIdentity.email,
              // Ready-made so the agent never has to compose an address it
              // cannot know: the company authors, and this names which of its
              // agents actually did the work.
              EPH_COAUTHOR: `Co-authored-by: ${cfg.agentId} <${cfg.commitIdentity.email}>`
            }),
        EPH_AGENT_ID: cfg.agentId,
        EPH_HOOK_TOKEN: cfg.hookToken,
        EPH_HOOK_ENDPOINT: cfg.hookEndpoint,
        ...(cfg.recallCommand.length === 0 ? {} : { EPH_RECALL: cfg.recallCommand }),
        ...(cfg.ghTokenCommand.length === 0 ? {} : { EPH_GH_TOKEN: cfg.ghTokenCommand })
      },
      settings: []
    }
  }

  /**
   * Contract: a plan that installs nothing, for every spawn. The config is
   * unused precisely because there is nothing about this spawn that changes
   * what gets written — which is the point.
   */
  wireHooks(): HookPlan {
    return new NoSettingsPlan()
  }

  /**
   * Codex takes identity on the command line, so the injection itself happens
   * in `spawnArgs`. What this method owes is the precondition — that the
   * identity sources exist and render — so a mis-hired agent is caught at spawn
   * rather than running with no idea who it is.
   */
  injectIdentity(cfg: AgentSpawnConfig): void {
    composeIdentity(cfg, this.deps.prompts)
  }

  interrupt(): KeySequence {
    return { label: 'Escape', bytes: ESCAPE_KEY }
  }

  /**
   * **No `resume`, and that is a finding rather than an omission.**
   *
   * Codex can resume — `codex resume <SESSION_ID>` is real — but `ResumeSupport`
   * is contractually "an argv fragment *appended* to the spawn plan's argv",
   * and Codex's resume is a *subcommand*, which has to come first. Appending
   * `resume <id>` to `codex --cd … <identity>` would produce a command line
   * that means something else entirely.
   *
   * Declaring `resume` and silently not resuming would be the dishonesty
   * ADR-0009 grades against, so this adapter declares none: `respawnOffer`
   * reports `resumable: false` for a codex agent (M4.1), which is true. Widening
   * `ResumeSupport` is an ADR-0009 change and belongs to the Architect.
   */

  /**
   * **No `transcripts`.** Codex records sessions under `$CODEX_HOME`, but this
   * build could not confirm the on-disk format against a real session — the CLI
   * needs credentials this environment does not have. A reader written against
   * a guessed format would fold invented numbers into the durable cost ledger,
   * which is the one thing ADR-0011 must never do. Spend for a codex agent
   * therefore reports source `none`, visibly, until a session can be read.
   */
}

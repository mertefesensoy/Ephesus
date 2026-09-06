import fs from 'node:fs'
import path from 'node:path'
import type { CapacityLimit } from '../../shared/capacity'
import type { HookEvent } from '../../shared/hooks'
import type { PromptStore } from '../prompts'
import type { SettingsRegistry } from '../settings-registry'
import { InstalledSettingsPlan } from './settings-install'
import { baseAgentEnv } from './spawn-env'
import { writeFileAtomic } from '../fsx'
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
  NotificationKind,
  UsageFact,
  CostFact,
  EngineConfigDirResult,
  WorkspaceExistence,
  WorkspaceTrustResult
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
 * **The directory it hangs off is a PARAMETER, not `$HOME`.** Since M8.7 each
 * agent runs against its own `CLAUDE_CONFIG_DIR`, and the engine puts
 * `projects/` inside whichever directory that is — confirmed by asking the
 * engine itself, which reports `projectsDirectory` under the isolated dir. A
 * reader still computing `$HOME/.claude/projects` would find nothing, report a
 * permanent zero, and `budgets.foldOne` would still say `'engine'`: the same
 * silent under-reporting the slug rule above is pinned to observation to avoid.
 *
 * `path.resolve` runs first because the engine slugs the ABSOLUTE cwd — a
 * relative one would otherwise slug to a different, non-existent directory.
 */
export function claudeTranscriptDir(configDir: string, cwd: string): string {
  const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')
  return path.join(configDir, CLAUDE_PROJECTS_REL, slug)
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
  transcriptDir: (cfg) => claudeTranscriptDir(cfg.engineConfigDir, cfg.cwd),
  limitOf: claudeCapacityLimit,
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
  },
  costs: async (filePath) => {
    let text: string
    try {
      text = await fs.promises.readFile(filePath, 'utf8')
    } catch {
      return []
    }
    // Keyed by (session, model) and OVERWRITTEN as later lines are read, so a
    // file carrying several snapshots yields only the newest running total —
    // the contract `TranscriptReader.costs` states. The engine writes the line
    // twice at session end (17 of 17 files in the corpus), and a resumed
    // session can carry an older, smaller snapshot earlier in the same file;
    // both collapse here rather than reaching the fold as separate figures.
    const newest = new Map<string, CostFact>()
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue
      }
      for (const fact of claudeCostFacts(raw)) {
        newest.set(`${fact.sessionId}\u0000${fact.model}`, fact)
      }
    }
    return [...newest.values()]
  }
}

/**
 * Contract: pure. The engine's own money figures carried by one `cost-state`
 * line, or none for any other line.
 *
 * Claude Code writes `cost-state` into the transcript itself:
 *
 * ```json
 * { "type": "cost-state", "sessionId": "…", "totalCostUSD": 0.4845,
 *   "modelUsage": { "claude-sonnet-5": { "costUSD": 0.4824, … } },
 *   "hasUnknownModelCost": false }
 * ```
 *
 * Three properties of that line drive everything downstream, and all three were
 * established by reading a real corpus of 20 transcripts rather than assumed:
 *
 *  - **it is cumulative, not incremental.** Every file that had one carried
 *    exactly one distinct `totalCostUSD`, and 17 of 17 wrote it TWICE. Hence
 *    `foldCosts` differences rather than appends (see there);
 *  - **it carries no timestamp**, so it cannot name the day it belongs to;
 *  - **it is written at session end**, so a live agent has no money figure at
 *    all until it stops — and 3 of the 20 files had none, which is what a
 *    killed session looks like. That must stay distinguishable from "$0", which
 *    is why an absent figure leaves `costUsd` null rather than zero.
 *
 * `totalCostUSD` is deliberately NOT read. The per-model `costUSD` figures are
 * what the ledger is keyed on (SDD §4.6), they sum to the total anyway, and a
 * model the engine could not price simply contributes no row — which is exactly
 * the "not reported" the ledger already knows how to carry.
 */
export function claudeCostFacts(raw: unknown): readonly CostFact[] {
  if (typeof raw !== 'object' || raw === null) return []
  const row = raw as Record<string, unknown>
  if (row['type'] !== 'cost-state') return []
  const sessionId = row['sessionId']
  const usage = row['modelUsage']
  if (typeof sessionId !== 'string' || sessionId.length === 0) return []
  if (typeof usage !== 'object' || usage === null) return []
  // Absent means "the engine did not say"; only an explicit `true` claims an
  // unpriced model. A missing flag must not silently mark the bill incomplete.
  const priced = row['hasUnknownModelCost'] !== true
  const facts: CostFact[] = []
  for (const [model, entry] of Object.entries(usage as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const cost = (entry as Record<string, unknown>)['costUSD']
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) continue
    if (model.length === 0 || model.length > 128) continue
    facts.push({ sessionId, model, cumulativeUsd: cost, priced })
  }
  return facts
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
 * Contract: pure. One provider-capacity refusal, or null for every other line.
 *
 * ## What this matches, and the evidence for it
 *
 * When a turn ends because the provider refused on quota, Claude Code appends a
 * SYNTHETIC assistant record to the session transcript. Three fields identify
 * it, and all three are required here:
 *
 * ```
 *   "type": "assistant"
 *   "isApiErrorMessage": true
 *   "error": "rate_limit"
 * ```
 *
 * Two independent sources say so, and they agree:
 *
 *  1. **Recorded reality.** Three such records exist in a real transcript on the
 *     Architect's own machine (`~/.claude/projects/…/39ba11ac-….jsonl`, engine
 *     2.1.237, 2026-08-30T21:58:55Z and two more), each carrying exactly those
 *     three fields plus `apiErrorStatus: 429` and an `errorDetails` string
 *     holding the provider's `rate_limit_error` body.
 *  2. **The engine's own test.** The shipped 2.1.252 binary contains the guard
 *     `type === "assistant" && isApiErrorMessage && error === "rate_limit"`
 *     before it reads `quotaLimits`. This predicate is the engine's, not ours.
 *
 * ## What it deliberately does NOT match
 *
 * The SAME transcript carries `error: "server_error"` records — a DNS failure
 * and a `529 Overloaded` — which are a real negative control, not a supposed
 * one. The engine's own taxonomy separates `rate_limit` ("wait and retry") from
 * `server_error`, `overloaded`, `billing_error` and `invalid_request`; of those,
 * waiting fixes only `rate_limit`. `billing_error` in particular is excluded on
 * purpose: the engine glosses it "usage limit reached — check plan", and a
 * company parked on it would wait for a reset that a human has to buy.
 *
 * `apiErrorStatus` is NOT required. It is absent from the older synthetic
 * records in that corpus, and demanding it would make the detector miss the
 * very events it was built from.
 *
 * ## The reset time
 *
 * `quotaLimits.resetsAt` is UNIX SECONDS: the engine builds `quotaLimits` from
 * the `anthropic-ratelimit-unified-*` response headers
 * (`resetsAt = Math.round(Number(header 'anthropic-ratelimit-unified-reset'))`)
 * and elsewhere compares it as `resetsAt * 1000 <= Date.now()`. It is absent
 * from every record observed here, so it is read when present and never
 * substituted when missing — `CapacityLimit.resetsAt` stays null, and the wait
 * falls back to a ladder rather than to a fabricated deadline.
 */
export function claudeCapacityLimit(raw: unknown): CapacityLimit | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (row['type'] !== 'assistant') return null
  if (row['isApiErrorMessage'] !== true) return null
  if (row['error'] !== 'rate_limit') return null
  const sessionId = row['sessionId']
  const uuid = row['uuid']
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  // No uuid means no identity, and no identity means the same refusal would
  // re-park the company on every tick. A record we cannot name is skipped.
  if (typeof uuid !== 'string' || uuid.length === 0) return null
  const timestamp = row['timestamp']
  return {
    kind: 'rate-limit',
    recordId: uuid,
    sessionId,
    at: typeof timestamp === 'string' && timestamp.length > 0 ? timestamp : '',
    detail: claudeErrorText(row['message']) ?? 'the provider refused this turn on usage limits',
    resetsAt: claudeResetsAt(row['quotaLimits'])
  }
}

/** Contract: the engine's own sentence from a synthetic error record, or null. */
function claudeErrorText(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const content = (message as Record<string, unknown>)['content']
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const cell = block as Record<string, unknown>
    if (cell['type'] !== 'text') continue
    const text = cell['text']
    if (typeof text === 'string' && text.trim().length > 0) parts.push(text.trim())
  }
  return parts.length === 0 ? null : parts.join(' ')
}

/**
 * Contract: the provider's reset instant as ISO, or null when it did not say.
 *
 * Unix seconds in, ISO out. A value that is not a finite positive number is
 * treated as "did not say" rather than coerced — a reset time of `0` would park
 * a company until 1970, which is to say not at all.
 */
function claudeResetsAt(quotaLimits: unknown): string | null {
  if (typeof quotaLimits !== 'object' || quotaLimits === null) return null
  const seconds = (quotaLimits as Record<string, unknown>)['resetsAt']
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
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
 * The ONLY two tool names Claude Code's file permission checks ever look up.
 *
 * This is not a style preference and not a subset chosen for brevity — it is
 * the engine's matcher. Established by reading the shipped binary
 * (`@anthropic-ai/claude-code` 2.1.252) rather than inferred from its docs,
 * because a permission rule that silently grants nothing is exactly the class
 * of defect that cannot be seen from the outside:
 *
 *  - the rule table is filtered by `ruleValue.toolName === n` — EXACT string
 *    equality, no aliasing, no tool-family expansion;
 *  - the only values `n` ever takes for a file check come from one switch:
 *    `'edit' -> 'Edit'`, `'read' -> 'Read'`. There is no third case, and no
 *    per-tool lookup anywhere on the path.
 *
 * So `Edit(<glob>)` is the rule that authorises EVERY file-editing tool —
 * `Write`, `MultiEdit`, `NotebookEdit` included — and `Read(<glob>)` authorises
 * every file-reading tool, `Glob` included. A `Write(<glob>)` rule is not a
 * narrower grant than `Edit(<glob>)`; it is not a grant at all.
 *
 * The harness used to write seven rules here — `Read`, `Write`, `Edit`, `Glob`,
 * `Grep`, `LS`, `NotebookEdit` — on the reasonable-looking assumption that a
 * grant should name each tool it means to permit. Five of those seven were
 * inert. Three measurements on a real agent settled it (see the implementation
 * doc): with all seven the outbox write SUCCEEDED, because `Edit` happened to
 * be among them; with the five inert ones ALONE the write was refused and no
 * file appeared; with `Read` + `Edit` alone it succeeded and stderr was silent.
 *
 * That is why this is a correctness fix and not a tidy-up. The autonomy loop
 * ADR-0013 depends on was never broken, but it was resting on one load-bearing
 * rule hidden among four decoys and a fifth that looked like the real one.
 * Anyone deduplicating that list would have deleted `Edit` as the redundant
 * twin of `Write` and taken the outbox down — a failure that surfaces only on a
 * live agent, never in a unit test. Two rules that are all load-bearing cannot
 * be tidied into a broken state.
 *
 * `Grep` and `LS` were worse than inert: neither is in the engine's
 * `filePatternTools` list, so they are dropped without even the warning the
 * other three earn on every agent's stderr.
 */
export const CLAUDE_FILE_RULE_TOOLS: readonly string[] = ['Read', 'Edit']

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
  return {
    allow: CLAUDE_FILE_RULE_TOOLS.map((tool) => `${tool}(${agentDir}/**)`),
    additionalDirectories: [agentDir]
  }
}

/**
 * The literal PROTOCOL.md tells an agent to run when its GitHub token expires.
 *
 * Kept as one exported constant because a rule that does not match the sentence
 * the agent was given is a rule that grants nothing, and the two live in
 * different files (`prompts/agora/PROTOCOL.md`, "run `$EPH_GH_TOKEN` for a
 * fresh one").
 */
export const GH_TOKEN_REFRESH_COMMAND = '$EPH_GH_TOKEN'

/**
 * Lets the agent refresh the GitHub token the harness already gave it.
 *
 * `GH_TOKEN` is a GitHub App installation token and expires an hour after the
 * spawn (ADR-0022), which is inside the length of one ordinary run. PROTOCOL.md
 * accordingly tells an agent to run `$EPH_GH_TOKEN` after a 401 — and nothing
 * granted permission to run it, so under `auto` the engine's classifier refused
 * it and the agent had no way through. Found live on 2026-09-06: the on-call
 * agent pushed its second fix branch, could not open the pull request, and
 * escalated "GH token expired, and I could not refresh it" instead.
 *
 * The grant widens nothing. The shim mints the same scoped installation token
 * the harness already put in this agent's environment at spawn; the only thing
 * it adds is the ability to replace one that timed out. Withholding it does not
 * make the agent less capable of reaching GitHub — it makes it capable for the
 * first hour and silently blind afterwards, which is the worse of the two.
 *
 * EXACT rules, never a `:*` prefix. A prefix on a credential command would also
 * admit whatever an injected suffix appended to it, and there is no suffix this
 * command has any use for.
 */
function ghTokenPermissions(cfg: AgentSpawnConfig): readonly string[] {
  if (cfg.ghTokenCommand.length === 0) return []
  return [
    `Bash(${GH_TOKEN_REFRESH_COMMAND})`,
    // The same call with the variable already expanded, which is what an agent
    // that resolves it before running lands on.
    `Bash(${cfg.ghTokenCommand.split(path.sep).join('/')})`
  ]
}

/**
 * Claude Code's own record of which working directories a human has approved:
 * `~/.claude.json` → `projects[<cwd>].hasTrustDialogAccepted`.
 *
 * Two things about this file were established by experiment rather than assumed,
 * and both matter:
 *
 *  - the key is the working directory with FORWARD slashes. The engine
 *    normalises before it writes, and compares against the normalised form, so
 *    a backslash key — the form Windows hands you, and the form this harness
 *    spawns with — sits in the file being ignored;
 *  - the prompt is per-workspace and once-only. No settings content triggers it
 *    or re-triggers it after an answer; it is a first-run gate, not a content
 *    check.
 */
export const CLAUDE_CONFIG_REL = '.claude.json'

/** Where the engine keeps session transcripts inside a config directory. */
export const CLAUDE_PROJECTS_REL = 'projects'

/**
 * The settings file the harness hands the engine with `--settings` (M8.7).
 *
 * It lives in the agent's OWN config directory, so nothing is written into the
 * Architect's checkout or the agent's worktree any more. That retires the whole
 * backup/restore/reference-count dance ADR-0009's settings hygiene needed when
 * this file had to be `<cwd>/.claude/settings.local.json` — a shared file two
 * agents in one repository fought over, which is what the reference counting in
 * `settings-install.ts` was there to survive.
 */
export const CLAUDE_HARNESS_SETTINGS_REL = 'eph-settings.json'

/**
 * The Architect's OWN engine config directory — the one holding the
 * credentials every hire borrows (ADR-0026 decision 3).
 *
 * Isolation without this is a company that cannot start: measured on this
 * machine, `CLAUDE_CONFIG_DIR=<fresh> claude auth status` reports
 * `loggedIn:false`, so every hire would meet a login prompt before any session
 * and therefore with no hook to report it — the same shape as the trust dialog
 * ADR-0021 exists to close. Adding `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointing
 * here reports `loggedIn:true` with the config directory still isolated.
 *
 * Contract: pure given `env`. Honours an Architect who already runs the engine
 * against a non-default config directory, because THEIR credentials are there,
 * not in `~/.claude`. Returns the empty string when there is no home to name;
 * the engine reads that as `<homedir>/.claude`, which is the right fallback and
 * is why an empty value is still exported rather than omitted — omitting the
 * variable entirely would send the engine back to the ISOLATED directory, where
 * there are no credentials at all.
 */
/**
 * Contract: the harness's settings file for one spawn. Pure.
 *
 * One function, because the path is produced in `spawnArgs` (as the value of
 * `--settings`) and again in `settingsInjections` (as the file to write). Two
 * expressions computing it would be a flag pointing at a file nothing wrote —
 * the agent would start with none of the harness's hooks and every lifecycle
 * event would simply never arrive, which reads as a quiet agent, not a bug.
 */
function harnessSettingsPath(cfg: AgentSpawnConfig): string {
  return path.join(cfg.engineConfigDir, CLAUDE_HARNESS_SETTINGS_REL)
}

export function claudeCredentialsDir(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const explicit = env['CLAUDE_CONFIG_DIR']
  if (explicit !== undefined && explicit.length > 0) return explicit
  const home = env['HOME'] ?? env['USERPROFILE'] ?? ''
  return home.length === 0 ? '' : path.join(home, '.claude')
}

/**
 * Makes a fresh, harness-owned config directory usable by an unattended agent.
 *
 * A config directory the engine has never seen starts at onboarding — the
 * engine's own startup takes that branch on `!hasCompletedOnboarding` — and
 * onboarding is an interactive first-run flow that happens BEFORE any session,
 * so no hook fires for it and nothing in the harness could see the agent
 * parked on it. That is the identical failure mode as the workspace trust
 * dialog (ADR-0021), arriving from the direction isolation opened, which is why
 * seeding is done here rather than left to be discovered on a live run.
 *
 * Contract: idempotent, atomic (invariant §3), and additive — an existing
 * `.claude.json` keeps every key it has, including the trust records
 * `trustWorkspace` writes into the same file. Returns the files it created so
 * the caller can say so out loud (M8.4's rule: a file the harness requires,
 * creates itself and never names is the setup cliff).
 */
export function prepareClaudeConfigDir(configDir: string): EngineConfigDirResult {
  if (configDir.length === 0) return { ok: false, because: 'no engine config directory' }
  const configPath = path.join(configDir, CLAUDE_CONFIG_REL)
  let config: Record<string, unknown> = {}
  if (fs.existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, because: `${CLAUDE_CONFIG_REL} is not a JSON object` }
      }
      config = parsed as Record<string, unknown>
    } catch (err) {
      return {
        ok: false,
        because: `${CLAUDE_CONFIG_REL} unreadable, refusing to overwrite it: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`
      }
    }
  }
  if (config['hasCompletedOnboarding'] === true) return { ok: true, seeded: [] }
  try {
    fs.mkdirSync(configDir, { recursive: true })
    writeFileAtomic(
      configPath,
      `${JSON.stringify({ ...config, hasCompletedOnboarding: true }, null, 2)}\n`
    )
  } catch (err) {
    return {
      ok: false,
      because: `could not seed ${CLAUDE_CONFIG_REL}: ${
        err instanceof Error ? err.message.split('\n')[0] : String(err)
      }`
    }
  }
  return { ok: true, seeded: [configPath] }
}

/** Contract: pure. The key Claude Code will actually match on for this directory. */
export function claudeProjectKey(cwd: string): string {
  return path.resolve(cwd).split(path.sep).join('/')
}

/**
 * Contract: the canonical project key for `cwd`, or why it could not be made.
 * Reads the filesystem (`realpath`) and never throws.
 *
 * `must-exist` resolves the whole path, which is ADR-0021's junction guard: the
 * record must name the directory that was actually approved, not a link that
 * can be repointed at another one afterwards.
 *
 * `will-be-created` resolves the PARENT and appends the leaf, because the leaf
 * is a worktree git has not made yet (M8.7). The guard is not weakened where it
 * matters: the parent is `<home>/worktrees`, which the harness creates and
 * owns, and the leaf is a name the harness derives from an agent id — neither
 * is a path a repository or a target can influence. A leaf that already exists
 * and is a real directory resolves to the same key either way.
 */
function resolveProjectKey(
  cwd: string,
  existence: WorkspaceExistence
): { readonly ok: true; readonly key: string } | { readonly ok: false; readonly because: string } {
  const reason = (err: unknown): string =>
    err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
  if (existence === 'must-exist') {
    try {
      return { ok: true, key: claudeProjectKey(fs.realpathSync.native(cwd)) }
    } catch (err) {
      return { ok: false, because: `target does not resolve: ${reason(err)}` }
    }
  }
  const absolute = path.resolve(cwd)
  const parent = path.dirname(absolute)
  if (parent === absolute) {
    // A filesystem root has no parent to resolve, and no worktree is ever one.
    return { ok: false, because: 'workspace does not resolve: it has no parent directory' }
  }
  try {
    return {
      ok: true,
      key: claudeProjectKey(path.join(fs.realpathSync.native(parent), path.basename(absolute)))
    }
  } catch (err) {
    return { ok: false, because: `workspace parent does not resolve: ${reason(err)}` }
  }
}

/**
 * `loggedIn` out of `claude auth status`'s JSON answer, or null.
 *
 * Contract: null means "this output is not that document" — not parseable, not
 * an object, or carrying no boolean `loggedIn`. Null routes the caller to the
 * prose patterns and, failing those, to "cannot tell", so a CLI that changes
 * its answer degrades to trusted rather than to logged-out.
 *
 * Deliberately strict about the TYPE: a `loggedIn` that is the string
 * `"false"`, or absent, is not an answer this function will invent one from.
 * See `test/fixtures/engine-output/claude/auth-status.json` for the real shape.
 */
function loggedInField(stdout: string): boolean | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const value = (parsed as Record<string, unknown>)['loggedIn']
  return typeof value === 'boolean' ? value : null
}

/** Claude Code's cancel key is Escape (ADR-0009 `interrupt()`): U+001B. */
const ESCAPE_KEY = String.fromCharCode(0x1b)

/** Claude Code puts the session id in `session_id` on every hook payload. */
const CLAUDE_SESSION_FIELD = 'session_id'

interface ClaudeAdapterDeps {
  readonly prompts: PromptStore
  /** Absolute path to `shims/eph-hook.mjs`. */
  readonly hookShimPath: string
  /**
   * Absolute path to `shims/eph-usage.mjs`, and where it should write what it
   * observes (ADR-0023). Both or neither: a shim with nowhere to write is a
   * status line that costs a process launch and reports nothing.
   *
   * Optional because the statusline is a *pacing* input, not a correctness one.
   * An engine installed without it still runs; the company simply paces on
   * `unobserved`, which `paceFor` treats as `full`.
   */
  readonly usageShimPath?: string
  /** Directory the shim writes one report per agent into. */
  readonly usageStatusDir?: string
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
/**
 * Contract: true when this hook entry is one this harness installed. Pure, and
 * deliberately conservative — an unrecognisable entry is never ours.
 *
 * Claude Code's settings schema has nowhere to hang a marker of our own, so the
 * marker is the thing itself: only our entries invoke our hook shim. Nothing an
 * Architect writes by hand does, which is what makes stripping these before a
 * re-install safe. An empty shim path matches nothing rather than everything —
 * a predicate that answers "yes" to every entry would silently delete the
 * Architect's hooks.
 */
function isHarnessHookEntry(entry: unknown, shimPath: string): boolean {
  if (shimPath.length === 0) return false
  if (typeof entry !== 'object' || entry === null) return false
  const hooks = (entry as Record<string, unknown>)['hooks']
  if (!Array.isArray(hooks)) return false
  return hooks.some((hook) => {
    if (typeof hook !== 'object' || hook === null) return false
    const command = (hook as Record<string, unknown>)['command']
    return typeof command === 'string' && command.includes(shimPath)
  })
}

/**
 * The `statusLine` block that turns every status render into one observation of
 * the account's usage window (ADR-0023).
 *
 * Returns null when the harness did not supply the shim, and the caller then
 * leaves whatever `statusLine` the Architect already had entirely alone.
 */
function usageStatusLine(deps: ClaudeAdapterDeps): Record<string, unknown> | null {
  if (!deps.usageShimPath || !deps.usageStatusDir) return null
  const node = deps.nodeCommand ?? 'node'
  return {
    type: 'command',
    command: `${node} ${shellQuote(deps.usageShimPath)} --dir ${shellQuote(deps.usageStatusDir)}`
  }
}

/**
 * Contract: true when this `statusLine` entry is one this harness installed.
 * Same marker discipline as `isHarnessHookEntry` — the shim path IS the marker,
 * because the engine's schema has nowhere to hang one of our own, and an empty
 * path must match nothing rather than everything.
 */
function isHarnessStatusLine(entry: unknown, shimPath: string | undefined): boolean {
  if (!shimPath || shimPath.length === 0) return false
  if (typeof entry !== 'object' || entry === null) return false
  const command = (entry as Record<string, unknown>)['command']
  return typeof command === 'string' && command.includes(shimPath)
}

/**
 * The company signs its own work (ADR-0022): the commit author is the GitHub
 * App, and nothing names the vendor whose model happened to write the diff.
 *
 * Left unset, the engine appends its own `Co-Authored-By: <model> <vendor
 * address>` to every commit it makes and its own line to every PR body. That
 * reached a real pull request on 2026-09-06 — MUSAHIT #1, authored correctly by
 * `app/ephesus-crew` and trailed by a model name — which SRS §6 criterion 10
 * forbids in the same sentence that requires the co-author trailer ("no
 * Architect or vendor identity anywhere"). `scripts/check-attribution.cjs`
 * scans this repository's history and could never have seen it: the offending
 * commit is in the TARGET.
 *
 * Established against the shipped binary, not assumed. `attribution.commit` and
 * `attribution.pr` are documented there as "Attribution text … Empty string
 * hides attribution", and `sessionUrl` appends a claude.ai session link — an
 * identity leak of its own, and a live URL in somebody else's repository.
 * `includeCoAuthoredBy` is the same switch under the older name, marked
 * "Deprecated: Use attribution instead"; it is set as well because the harness
 * runs whatever engine build is on the machine (ADR-0028 pins nothing), and of
 * all the rules in this codebase this is the one where a redundant belt costs
 * less than a single point of failure. The two are one switch across versions,
 * not two mechanisms that half-overlap.
 *
 * This OVERRIDES rather than merges, unlike hooks, permissions and the status
 * line. Those are surfaces the Architect may legitimately be using; this is a
 * company rule about what the company's name goes on. Their own
 * `~/.claude/settings.json` is a different file and is never touched (ADR-0026).
 */
export const NO_VENDOR_ATTRIBUTION = {
  attribution: { commit: '', pr: '', sessionUrl: false },
  includeCoAuthoredBy: false
} as const

export function mergeClaudeSettings(
  existing: string | null,
  deps: ClaudeAdapterDeps,
  cfg?: AgentSpawnConfig,
  /** What to call the file in a refusal. Named so the message cannot point at a file we are not touching. */
  label: string = CLAUDE_SETTINGS_REL
): string {
  let base: Record<string, unknown> = {}
  if (existing !== null && existing.trim().length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(existing)
    } catch (err) {
      throw new Error(
        `claude: ${label} is not valid JSON, refusing to overwrite it: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`,
        { cause: err }
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`claude: ${label} is not a JSON object, refusing to overwrite it`)
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
    // Drop what a previous install of ours left here before adding ours back.
    // Without this the merge is an append: the base is re-read from disk per
    // agent, so the second agent to enter a shared working directory merges
    // into the first agent's output rather than into the Architect's, and every
    // hook is registered again. Three crew agents in one repository produced
    // nine events × three copies, and Claude Code reads that pile as a folder
    // arming itself — which is exactly what its trust dialog then warns about.
    // Our hook entries carry no agent id (the id travels in the environment),
    // so all agents' copies are byte-identical and one copy serves every agent.
    const kept = prior.filter((item) => !isHarnessHookEntry(item, deps.hookShimPath))
    merged[engineEvent] = [...kept, ...(entry as unknown[])]
  }

  // ADR-0023's observation point. Ours replaces a previous install of ours and
  // nothing else: an Architect's own status line is left exactly where it is,
  // and we simply do not install (so pacing runs on `unobserved`) rather than
  // taking a surface they were already using.
  const ourStatusLine = usageStatusLine(deps)
  const priorStatusLine = base['statusLine']
  const statusLine = ourStatusLine
    ? priorStatusLine === undefined || isHarnessStatusLine(priorStatusLine, deps.usageShimPath)
      ? ourStatusLine
      : priorStatusLine
    : priorStatusLine
  const withStatus = statusLine === undefined ? {} : { statusLine }

  if (!cfg) {
    return `${JSON.stringify({ ...base, ...withStatus, ...NO_VENDOR_ATTRIBUTION, hooks: merged }, null, 2)}\n`
  }

  // Merge the harness's own grants into whatever the Architect already allowed,
  // never replacing their list: this agent's mailbox, and the one command that
  // refreshes the credential the harness itself handed it.
  const grant = mailboxPermissions(cfg)
  const tokenRules = ghTokenPermissions(cfg)
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

  // Unlike hooks, a mailbox grant names one agent's own directory, so several
  // agents sharing a working directory must accumulate several grants. What
  // must not accumulate is the *same* agent's grant twice, which is what a
  // plain append produced on every re-install.
  const mine = new Set([
    ...(grant['allow'] as unknown[]),
    ...(grant['additionalDirectories'] as unknown[]),
    ...tokenRules
  ])
  const permissions = {
    ...existingPermissions,
    allow: [
      ...priorAllow.filter((item) => !mine.has(item)),
      ...(grant['allow'] as unknown[]),
      ...tokenRules
    ],
    additionalDirectories: [
      ...priorDirs.filter((item) => !mine.has(item)),
      ...(grant['additionalDirectories'] as unknown[])
    ]
  }

  return `${JSON.stringify(
    { ...base, ...withStatus, ...NO_VENDOR_ATTRIBUTION, hooks: merged, permissions },
    null,
    2
  )}\n`
}

/**
 * Contract: the engine's permission mode for a composed autonomy level. Pure.
 *
 * Claude Code offers `default`, `acceptEdits`, `auto` and `bypassPermissions`.
 * The mapping stops deliberately short at the top: `autonomous` becomes `auto`
 * — the engine's own classifier — and NOT `bypassPermissions`, which disables
 * every check rather than deciding it.
 *
 * That distinction is the whole argument. The case for autonomy here was that a
 * standing policy beats a human who has stopped reading prompts, which is an
 * argument for a better classifier, not for switching the classifier off. An
 * Architect who wants the blanket bypass can still ask for it; nothing should
 * arrive at it by way of a default.
 */
export function claudePermissionMode(
  autonomy: 'manual' | 'supervised' | 'autonomous'
): 'default' | 'acceptEdits' | 'auto' {
  switch (autonomy) {
    case 'manual':
      return 'default'
    case 'supervised':
      return 'acceptEdits'
    case 'autonomous':
      return 'auto'
  }
}

/** Contract: pure. The engine's own words on a notification payload, or null. */
function claudeNotificationMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const message = (payload as Record<string, unknown>)['message']
  return typeof message === 'string' && message.trim().length > 0 ? message.trim() : null
}

export class ClaudeAdapter implements EngineAdapter {
  readonly id = 'claude' as const
  /**
   * `native`: Claude Code fires real lifecycle hooks for every harness event, so
   * the floor reflects what actually happened rather than a guess at it.
   */
  readonly hooks = 'native' as const
  /** ADR-0031: every level reaches the engine as `--permission-mode`. */
  readonly autonomySupport = 'enforced' as const

  constructor(private readonly deps: ClaudeAdapterDeps) {}

  binary(): BinarySpec {
    return {
      name: 'claude',
      install: { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
      versionProbe: { command: 'claude', args: ['--version'] },
      /**
       * Whether this machine is logged in (M8.4, corrected 2026-09-04).
       *
       * `claude auth status` is the CLI's own answer, and it is a different
       * question from `--version`: the binary can be present and perfectly
       * healthy while no session exists, which is when the agent starts, prints
       * a login prompt and does nothing until somebody notices.
       *
       * ## The JSON document is the contract; the prose is the fallback
       *
       * `claude auth status --help` states that `--json` is the DEFAULT and
       * `--text` is opt-in, and the default answer is
       * `{"loggedIn": true, "authMethod": …}` on exit 0. The first version of
       * this matcher looked only for `logged in as` / `authenticated as` /
       * `account:` and so matched **neither** of the CLI's two output modes —
       * it always answered "cannot tell", and `needs-login` could not fire on
       * any real machine. Forty-five tests passed because every one of them fed
       * it a string we had written ourselves. The recorded output now lives in
       * `test/fixtures/engine-output/` and the matcher is tested against it.
       *
       * So: read the machine-readable field when the CLI gives one, and keep
       * the prose patterns for the `--text` mode and for a future version that
       * changes its mind about the default.
       *
       * Still three-valued, and still conservative in the direction that
       * matters: anything unrecognised is "cannot tell", which the manager
       * treats as trusted. A wording we have not seen must never be the reason
       * a healthy company refuses to start.
       */
      authProbe: {
        command: { command: 'claude', args: ['auth', 'status'] },
        authenticated: (stdout, exitCode) => {
          // 1. The answer the CLI means to be read by a program.
          const declared = loggedInField(stdout)
          if (declared !== null) return declared

          // 2. Prose. The DENIAL is read first, because the positive patterns
          //    are substrings of denials: `Not logged in` contains `logged in`,
          //    and a bare substring test therefore reads a logged-out engine as
          //    ready. That is the same trap that made `reproduce` match `prod`
          //    in the M7.4 scorer and a spoken refusal confirm a gate in M6 —
          //    here it would send a company to work with no session at all.
          //    The wordings are the CLI's own, read out of the shipped binary.
          if (/not logged in|not authenticated|no active session/i.test(stdout)) return false
          if (/\brun\b[^.\n]{0,24}\bauth login\b/i.test(stdout)) return false
          // 3. `Login method:` and `Email:` are what `--text` prints for a live
          //    session; the other two are wordings other builds have used.
          if (/^login method:/im.test(stdout)) return true
          if (/logged in as|authenticated as|account:/i.test(stdout)) return true
          // A non-zero exit with nothing recognisable is still not proof of
          // being logged out: the subcommand may not exist on this version.
          void exitCode
          return null
        },
        login: 'claude auth login'
      },
      // `claude --version` prints e.g. "2.1.195 (Claude Code)".
      parseVersion: (stdout) => /(\d+\.\d+\.\d+[\w.+-]*)/.exec(stdout)?.[1] ?? null
    }
  }

  spawnArgs(cfg: AgentSpawnConfig): SpawnPlan {
    const identity = composeIdentity(cfg, this.deps.prompts)
    return {
      argv: [
        'claude',
        '--permission-mode',
        claudePermissionMode(cfg.autonomy),
        // ADR-0026. `--setting-sources=` loads NO user, project or local
        // settings, so the only hooks that can fire are the ones in the file
        // named next — the harness's. Without it a target repository's own
        // Stop hook can answer `{"decision":"block"}` and continue an agent
        // outside the harness's decision: uncounted by the block cap, invisible
        // to the breaker's stop-loop signal, unaffected by pacing. Measured,
        // not assumed: with the flag only the harness's hook fires; without it
        // the repository's and the user's fire too.
        //
        // The ATTACHED empty value is deliberate. A bare `''` argv element is
        // one Windows command-line composition may drop on the way to conpty,
        // and a dropped lockdown flag is a check that cannot fail — this
        // codebase's recurring defect. `--setting-sources=` is one non-empty
        // token and cannot vanish that way.
        '--setting-sources=',
        '--settings',
        harnessSettingsPath(cfg),
        // M8.7b: the tools the company granted this hire BY NAME. A hire that
        // declared none passes no flag at all, which is what an agent with no
        // profile gets - the lockdown's default, not an exception to it.
        ...cfg.tools.pluginDirs.flatMap((dir) => ['--plugin-dir', dir]),
        '--append-system-prompt',
        identity
      ],
      cwd: cfg.cwd,
      env: {
        ...baseAgentEnv(),
        ...cfg.envGrants,
        // ADR-0026: the agent's OWN engine install. This is what stops it
        // inheriting the Architect's memory file, plugins, skills, MCP servers
        // and hooks. `projects/` moves with it, which is why the transcript
        // reader is handed the same directory rather than recomputing $HOME.
        ...this.engineEnv(cfg),
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
        // The Library's agent-facing surface (ADR-0006 layer 2). Harness-owned
        // and identical for every engine, so the adapter only forwards it.
        ...(cfg.recallCommand.length === 0 ? {} : { EPH_RECALL: cfg.recallCommand }),
        ...(cfg.ghTokenCommand.length === 0 ? {} : { EPH_GH_TOKEN: cfg.ghTokenCommand })
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

  /**
   * Claude Code says "Claude needs your permission to use X" when it is
   * blocked on a decision, and "Claude is waiting for your input" when it is
   * simply idle at an empty prompt. Both arrive as `Notification`.
   *
   * Measured, not assumed: on the 2026-09-01 live run, nine of the ten gates
   * the Architect was asked to answer carried the idle message. They asked a
   * human to approve an agent doing nothing, and approving them did nothing
   * back.
   */
  notificationKind(payload: unknown): NotificationKind | null {
    const message = claudeNotificationMessage(payload)
    if (message === null) return null
    if (/waiting for your input/i.test(message)) return 'waiting'
    if (/needs your permission|permission to use/i.test(message)) return 'permission'
    return null
  }

  interrupt(): KeySequence {
    return { label: 'Escape', bytes: ESCAPE_KEY }
  }

  /**
   * Writes the Architect's activation into Claude Code's own trust record, so
   * the crew it just hired can start (ADR-0021).
   *
   * The prompt this answers is a first-run gate whose highlighted default is
   * "No, exit", and it appears BEFORE any session begins — so no engine hook
   * fires for it, nothing in the harness could see it, and on the live MUSAHIT
   * run all three crew agents parked on that screen for their whole lives
   * while the floor showed them as spawned.
   *
   * What keeps this narrow:
   *
   *  - it is called from an activation and nowhere else, with that activation's
   *    own target, so the Architect's click is the consent and the scope is one
   *    directory they named;
   *  - the path is canonicalised through `realpath`, so the record names the
   *    directory that was actually approved rather than a junction that can be
   *    repointed at another one afterwards;
   *  - a directory already trusted is reported as such and rewritten with
   *    nothing, so the log can tell "the Architect had already approved this"
   *    apart from "the harness approved it just now";
   *  - it never widens anything else in the file: one key, one field.
   *
   * Known limitation, stated rather than hidden: a Claude Code process running
   * elsewhere may rewrite this file wholesale from its own in-memory copy and
   * drop the key. The failure is visible rather than dangerous — the dialog
   * returns and the agent parks — but it is a race this cannot close from here.
   */
  trustWorkspace(
    configDir: string,
    cwd: string,
    existence: WorkspaceExistence = 'must-exist'
  ): WorkspaceTrustResult {
    // The record goes in the agent's OWN config directory, because that is the
    // only file the agent's engine will read. Writing the Architect's
    // `~/.claude.json` here — which is what this did before M8.7 — would record
    // consent in a file no isolated agent opens, and the only symptom would be
    // the trust dialog reappearing: a hung agent, again.
    if (configDir.length === 0) {
      return { ok: false, because: 'no engine config directory to write the record in' }
    }
    const configPath = path.join(configDir, CLAUDE_CONFIG_REL)
    const resolved = resolveProjectKey(cwd, existence)
    if (!resolved.ok) return resolved
    const canonical = resolved.key
    let config: Record<string, unknown> = {}
    if (fs.existsSync(configPath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { ok: false, because: `${CLAUDE_CONFIG_REL} is not a JSON object` }
        }
        config = parsed as Record<string, unknown>
      } catch (err) {
        // Refusing beats repairing: this is the engine's own file and rewriting
        // it from a guess would cost the Architect every project setting in it.
        return {
          ok: false,
          because: `${CLAUDE_CONFIG_REL} unreadable, refusing to overwrite it: ${
            err instanceof Error ? err.message.split('\n')[0] : String(err)
          }`
        }
      }
    }
    const projects =
      typeof config['projects'] === 'object' &&
      config['projects'] !== null &&
      !Array.isArray(config['projects'])
        ? (config['projects'] as Record<string, unknown>)
        : {}
    const entry =
      typeof projects[canonical] === 'object' &&
      projects[canonical] !== null &&
      !Array.isArray(projects[canonical])
        ? (projects[canonical] as Record<string, unknown>)
        : {}
    const alreadyTrusted = entry['hasTrustDialogAccepted'] === true
    if (alreadyTrusted) return { ok: true, path: canonical, alreadyTrusted: true }
    const next = {
      ...config,
      projects: { ...projects, [canonical]: { ...entry, hasTrustDialogAccepted: true } }
    }
    try {
      writeFileAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`)
    } catch (err) {
      return {
        ok: false,
        because: `could not write ${CLAUDE_CONFIG_REL}: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`
      }
    }
    return { ok: true, path: canonical, alreadyTrusted: false }
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

  /**
   * The two variables that point this engine at ONE agent's private install.
   *
   * One expression with two consumers — the spawn and the auth probe — rather
   * than two that agree today. A probe that asked about a different directory
   * than the spawn uses would answer about the wrong install and be right about
   * nothing, silently.
   */
  private engineEnv(cfg: AgentSpawnConfig): Readonly<Record<string, string>> {
    return {
      // ADR-0026: the agent's own engine install — its memory file, plugins,
      // skills, MCP servers, hooks and `projects/` transcripts all move here.
      CLAUDE_CONFIG_DIR: cfg.engineConfigDir,
      // ...but NOT its own credentials: the company borrows the Architect's
      // session (decision 3). Always exported, empty value included — see
      // `claudeCredentialsDir`, where omitting it is the failure case.
      CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeCredentialsDir(),
      // The company does not upgrade itself mid-run. Up to 30 agents share one
      // engine install, so a background self-update is many processes racing to
      // replace the binary all of them are executing — and on Windows the loser
      // gets `update_apply_exe_locked` and retries at every subsequent startup.
      // The harness upgrades the engine deliberately, between runs, or not at
      // all; an agent must never decide that for the company.
      DISABLE_AUTOUPDATER: '1'
    }
  }

  probeEnv(cfg: AgentSpawnConfig): Readonly<Record<string, string>> {
    return this.engineEnv(cfg)
  }

  /** ADR-0026. See `prepareClaudeConfigDir`. */
  prepareConfigDir(configDir: string): EngineConfigDirResult {
    return prepareClaudeConfigDir(configDir)
  }

  readonly transcripts: TranscriptReader = claudeTranscripts

  /**
   * The harness's settings for one agent, in that agent's OWN config directory
   * (ADR-0026).
   *
   * It used to be `<cwd>/.claude/settings.local.json` — inside the Architect's
   * checkout, backed up, reference-counted between agents sharing a repository,
   * and restored on the way out. None of that is needed once the file is
   * per-agent and outside every checkout, and all of it was risk: the rule an
   * adapter is most likely to get subtly wrong is the one that modifies
   * somebody else's repository.
   */
  private settingsInjections(cfg: AgentSpawnConfig): readonly SettingsInjection[] {
    const settingsPath = harnessSettingsPath(cfg)
    const existing = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null
    return [
      {
        path: settingsPath,
        contents: mergeClaudeSettings(existing, this.deps, cfg, CLAUDE_HARNESS_SETTINGS_REL)
      }
    ]
  }
}

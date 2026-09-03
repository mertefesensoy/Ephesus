import path from 'node:path'
import { statSync } from 'node:fs'
import { app, BrowserWindow, dialog, screen, shell } from 'electron'
import type { AgentCard } from '../shared/agents'
import type { AvatarSnapshot } from '../shared/avatar'
import type { CommandState } from '../shared/commands'
import { BLOCK_CAP_ENV, blockCapFromEnv } from '../shared/autonomy'
import {
  AGENTS_STATE_CHANNEL,
  AVATARS_STATE_CHANNEL,
  COMMANDS_STATE_CHANNEL,
  GATE_OPEN_CHANNEL,
  CAPACITY_STATE_CHANNEL,
  LOG_APPEND_CHANNEL,
  ODEON_QUEUE_CHANNEL,
  TASKS_STATE_CHANNEL,
  type AgoraHealth,
  type HooksState
} from '../shared/ipc'
import { sanitizeBounds } from '../shared/window-state'
import { AgentManager } from './agents'
import { Artemis, ARTEMIS_AGENT_ID } from './artemis'
import { ExecGitRunner, Worktrees } from './git'
import { randomBytes } from 'node:crypto'
import { composeMessage, makeMessageId } from '../shared/message'
import { ODEON_ENDPOINT } from '../shared/reserved'
import type { OpenGate } from '../shared/gates'
import { BriefingJob, STANDUP_EVERY_MS } from './briefing'
import { MeetingDriver } from './meeting'
import { Gymnasium } from './gymnasium'
import { KNOWN_TARGETS_REL, KnownTargets } from './known-targets'
import { GitHubAppIdentity, TOKEN_REFRESH_MS } from './harbor/app-auth'
import { GITHUB_APP_KEY_SECRET, GITHUB_TOKEN_GRANT } from '../shared/github-app'
import { GH_TOKEN_SCHEMA_VERSION, type GhTokenResponse } from '../shared/gh-token'
import { targetRef, verifierAgentFor } from '../shared/profile-activation'
import { ProfileActivations, ProfileStore, triggerWakeMessage } from './profiles'
import { GitHubHarbor, HARBOR_INGEST_EVERY_MS } from './harbor/github'
import { IncidentEndpoint, VERDICT_SUBJECT } from './incidents'
import { HireExchange } from './harbor/hires'
import { FrontOffice, OUTBOUND_SUBJECT } from './frontoffice'
import { HARBOR_SCHEMA_VERSION } from '../shared/harbor'
import { STOA_EVERY_MS, Stoa } from './stoa'
import { CompanyModes } from './modes'
import { stoaCadenceTick } from './stoa-cadence'
import { GYM_CHECK_EVERY_MS, gymCadenceTick } from './gym-cadence'
import { attributeSpend, type AttributableAgent } from '../shared/attribution'
import { tokensOf, ZERO_TOTALS } from '../shared/cost'
import { checkIntake, checkStudiable } from '../shared/stoa'
import { isImprovementRole } from '../shared/mode'
import type { SourceView } from '../shared/stoa-view'
import { wireOdeonEndpoint } from './odeon-endpoint'
import { OrgLayer, RETRO_EVERY_MS } from './org'
import { orgChart as orgChartOf } from '../shared/org'
import { emptyLedger as emptyTaskLedger } from '../shared/tasks'
import { LedgerEndpoint } from './ledger'
import { Odeon } from './odeon'
import { Library } from './library'
import { RECALL_SCHEMA_VERSION } from '../shared/recall'
import { ReflectionJob } from './reflection'
import { Scheduler } from './scheduler'
import { FtsIndex } from './library-fts'
import { MEMPALACE_BINARY, MemPalaceIndex } from './library-mempalace'
import { openFtsStore } from './library-fts-sqlite'
import { Agora } from './agora'
import { AvatarDirector } from './avatars'
import { ClosingTime } from './closing'
import { QuitSequence, summarizeQuit } from './shutdown'
import { UiBridge } from './ui-bridge'
import { DegradationLog } from './degradations'
import type { DegradationCause, DegradationRow } from '../shared/degradation'
import { CommandQueue } from './commands'
import { Hermes } from './hermes'
import { getHome, initHome, saveConfig } from './config'
import { AppDb } from './db'
import { ClaudeAdapter } from './engines/claude'
import { CodexAdapter } from './engines/codex'
import { GeminiAdapter } from './engines/gemini'
import { engines } from './engines'
import { HookServer, type HookEventRecord } from './hooks'
import { registerIpc } from './ipc'
import { PromptStore } from './prompts'
import { PtyManager } from './pty'
import { PASS_THROUGH } from './pty-stream'
import { sweepInstalledSettings } from './settings-registry'
import { Breaker } from './watch/breaker'
import { BudgetWatcher } from './watch/budgets'
import { CapacityWatch } from './watch/capacity'
import { safeStorageCipher } from './watch/cipher'
import { GateManager, loadGatePolicy, wireGateChokePoints } from './watch/gates'
import { CostLedger } from './watch/ledger'
import { SecretBroker } from './watch/secrets'
import { SteerNotes } from './watch/steer-notes'
import { UsageWatch } from './watch/usage-watch'
import { canDeliverWake, DEFAULT_WAKE_CAP_MS, WakeClock } from './watch/wake-clock'
import { DEFAULT_PACE_THRESHOLDS } from '../shared/pacing'

let secrets: SecretBroker | null = null
let costLedger: CostLedger | null = null
let budgetWatcher: BudgetWatcher | null = null
let capacityWatch: CapacityWatch | null = null
let usageWatch: UsageWatch | null = null
let wakeClock: WakeClock | null = null
let gates: GateManager | null = null
let breaker: Breaker | null = null
/** SDD §9's choke points, wired once (see `wireGateChokePoints`). */
let chokePoints: ReturnType<typeof wireGateChokePoints> | null = null
/** The composed gate policy, reloaded from disk on every evaluation. */
let gatePolicyPath = ''
/** Last reported policy warning, so a re-read does not re-report it. */
let lastPolicyWarning: string | null = null
// The redaction filter reads through the broker on every chunk (ADR-0010), so
// a credential stored while an agent is already running is masked in that
// agent's live stream too.
const ptyManager = new PtyManager({
  redactor: () => secrets?.redactor() ?? PASS_THROUGH
})
let db: AppDb | null = null
let agentManager: AgentManager | null = null
let agora: Agora | null = null
let artemis: Artemis | null = null
let ledger: LedgerEndpoint | null = null
let odeon: Odeon | null = null
let briefing: BriefingJob | null = null
let meetings: MeetingDriver | null = null
let org: OrgLayer | null = null
let gymnasium: Gymnasium | null = null
let stoa: Stoa | null = null
// Profile activations (ADR-0012, M7.2). Late-bound like the rest: the Watch is
// built before the AgentManager this needs, and the gate seam below reads
// through the handle rather than capturing a value that does not exist yet.
let activations: ProfileActivations | null = null
// The targets already activated once (M7.9). Deliberately separate from
// `activations`: that Map is what is RUNNING, this file is what has been TYPED,
// and only the second is worth surviving a restart.
let knownTargets: KnownTargets | null = null
// The company's GitHub identity (ADR-0022). Null until boot; `configured()` is
// false until BOTH github-app.json exists and the broker holds the signing key,
// so an Ephesus with neither behaves exactly as it did before.
let companyGitHub: GitHubAppIdentity | null = null
let companyTokenTimer: NodeJS.Timeout | null = null
// The Harbor's inbound half (FR-10.1, M7.3). Its registered repositories are the
// ones the ACTIVE profiles declare in `harbor.json` — the company watches what
// it was actually pointed at, not a second list that could disagree.
let harbor: GitHubHarbor | null = null
let incidents: IncidentEndpoint | null = null
let frontOffice: FrontOffice | null = null
let exchange: HireExchange | null = null
let modes: CompanyModes | null = null
// The prompt store the memo helpers below render from (invariant §8 keeps
// every word an agent reads in a file). boot() assigns it before anything
// can file a memo; the helpers are top-level because the endpoint dispatch
// and the IPC bench both reach them.
let promptStore: PromptStore | null = null
let library: Library | null = null
let reflection: ReflectionJob | null = null
const scheduler = new Scheduler({
  onError: (triggerId, err) =>
    reportDegradation(
      `scheduler/trigger:${triggerId}`,
      `${triggerId} failed: ${err instanceof Error ? err.message : String(err)}`
    )
})
let hermes: Hermes | null = null
let closingTime: ClosingTime | null = null
/**
 * The one door to the renderer (M8.1). Nothing else in this file may hold the
 * window: a destroyed window is not null, which is how every send on the quit
 * path used to throw and take Closing Time and the agent unwind down with it.
 * `check-invariants.cjs` fails on a `webContents.send` written anywhere else.
 */
const ui = new UiBridge({
  onDropped: (channel, detail) => reportDegradation('renderer/send', `${channel}: ${detail}`)
})
// The terminal stream goes to the bridge, once — not to the `webContents` of a
// window a later window replaces (SDD §1.1 `pty.ts`: 'a window recreated
// mid-run still receives bytes').
ptyManager.attachSink(ui)
/** Non-null when the hook endpoint failed to bind — a visible state, not a crash. */
let hookFailure: string | null = null

/**
 * Runtime degradations, bounded and surfaced through `agora:health` so every
 * give-up is a visible UI state (invariant §7) — `console.warn` alone is a
 * developer console the Architect never sees.
 */
/**
 * Agents whose budget is tightened by breaker rung 2 (ADR-0011 "lower its
 * remaining budget"). Consulted when the budget watcher reads its agents; the
 * ledger itself is never touched (append-only, invariant §5).
 */
const constrainedBudgets = new Set<string>()
/** While constrained, an agent runs on this fraction of its daily budget. */
const CONSTRAINED_BUDGET_FACTOR = 0.5

/**
 * Degradations reported before the Agora exists (M8.2). Boot reports through
 * this channel from its first line, and the book of record is not open until a
 * few lines later — so those rows wait here rather than being lost, which is
 * precisely the window a first-run failure happens in.
 */
const pendingDegradationRows: DegradationRow[] = []

/**
 * The degradation channel (M8.2) — invariant §7's "every degradation is a
 * visible UI state". Keyed by CAUSE, so the pacing check's once-a-second report
 * is one row with a count instead of fifty rows that push everything else out.
 */
const degradations = new DegradationLog({
  append: (row) => {
    if (agora === null) pendingDegradationRows.push(row)
    else agora.appendLog(row)
  },
  warn: (line) => console.warn(line)
})

/** How much of the log's tail the boot replay reads back. */
const DEGRADATION_REPLAY_LIMIT = 400

function reportDegradation(cause: DegradationCause, detail: string): void {
  degradations.report(cause, detail)
}

/**
 * The floor's only source of motion (ADR-0002). It is constructed before the
 * hook server has a chance to deliver anything, so no event can arrive with
 * nowhere to go.
 */
const commandQueue = new CommandQueue({
  sink: { write: (agentId, data) => ptyManager.write(agentId, data) },
  onChange: (state: CommandState) => ui.send(COMMANDS_STATE_CHANNEL, state)
})

/**
 * GYM-002 (ADR-0011 rung 1): the corrective sentence rides the hook boundary on
 * `native`-grade engines — the next `post-tool` reply carries it, mid-turn —
 * and keeps the queue-until-idle path below that grade. The channel choice and
 * its rules live in `watch/steer-notes.ts`; the scenario rig constructs the
 * same class (shipped wiring, never a copy — the M5.1 rule).
 */
const steerNotes = new SteerNotes({
  hookFidelity: (agentId) => {
    try {
      return agentManager?.card(agentId).hookFidelity ?? 'native'
    } catch {
      return 'native'
    }
  },
  queueSubmit: (agentId, text) => commandQueue.submit(agentId, text),
  onSteer: (agentId, _text, channel) => {
    // The channel is part of the trip's record (invariant §7, NFR-13) — a
    // reader of `log.jsonl` must be able to tell how the sentence traveled.
    agora?.appendLog({ kind: 'breaker', action: 'steer-channel', agentId, channel })
    ui.send(LOG_APPEND_CHANNEL)
    agora?.commitSoon(`breaker steer for ${agentId}`)
  }
})

/**
 * The one place the mail count is read. The autonomy loop (ADR-0013), the push
 * below and the `avatars:list` handler all go through it, so the floor's desk
 * tray, the wake watchdog and a freshly-opened window can never disagree about
 * how much mail is waiting.
 *
 * That it is ONE source is the point: the M5b close-out's standing lesson is
 * that a fact supplied on the listing path and not on the others (or the
 * reverse) is a seam no unit test sees.
 */
const pendingMailFor = (agentId: string): number => hermes?.pendingMailCount(agentId) ?? 0

const avatarDirector = new AvatarDirector({
  // The floor and the autonomy loop read the SAME fact about pending work, so
  // they can never disagree about whether an agent is done (ADR-0013).
  hasPendingWork: (agentId: string) => pendingMailFor(agentId) > 0,
  onChange: (agentId: string, snapshot: AvatarSnapshot) => {
    ui.send(AVATARS_STATE_CHANNEL, {
      agentId,
      snapshot,
      pendingMail: pendingMailFor(agentId)
    })
    // The queue flushes off the same snapshots the floor draws, so held text
    // goes out exactly when the avatar says the agent is free (FR-1.3).
    commandQueue.observe(agentId, snapshot)
    // SDD §6/§10 `ghost ──30s──► archived`: the avatar clock owns the timer, and
    // the roster mirrors it, so the two planes cannot disagree about when an
    // agent stopped being a ghost.
    if (snapshot.phase === 'archived') agentManager?.archive(agentId)
  }
})

/**
 * The event plane's front door (ADR-0002). Until the Agora's `log.jsonl` lands
 * in M2 these two sinks are the book of record, so both say enough to find the
 * event again (ENGINEERING-STANDARDS §4 "errors carry refs"). Drift warnings are
 * also retained on the server for the UI to surface (FR-2.3).
 */
const hookServer = new HookServer({
  onEvent: (record) => {
    const { envelope, known, warning } = record
    if (warning) console.warn(`hook drift [${envelope.agentId}/${envelope.event}]: ${warning}`)
    else if (!known) console.warn(`hook unknown [${envelope.agentId}]: ${envelope.event}`)
    avatarDirector.handleHook(record)
    // Span capture (FR-11.6) and the breaker's repetition/error signals
    // (ADR-0011) both read the same tool stream the floor reads (ADR-0002).
    recordSpan(record)
    // The ledger learns which session a spawn is running under from the same
    // event plane the floor reads (ADR-0002) — the attribution key that lets
    // "session" and "cumulative" be told apart without a running total.
    if (envelope.sessionId) {
      costLedger?.noteSession(envelope.agentId, envelope.sessionId)
      // The Watch folds only the transcripts these sessions produced, so a
      // shared repo cannot cross-attribute spend between agents (ADR-0011).
      agentManager?.noteSession(envelope.agentId, envelope.sessionId)
    }

    // ADR-0023's wall-clock cap. A wake begins when a prompt is submitted and
    // ends when the turn stops — the two events that bracket exactly one wake.
    // `session-end` closes it too, because an agent that exits mid-turn emits
    // no `stop` and would otherwise leave a timer that fires at an agent which
    // is no longer there.
    if (envelope.event === 'prompt-submitted') wakeClock?.began(envelope.agentId)
    if (envelope.event === 'stop' || envelope.event === 'session-end') {
      wakeClock?.ended(envelope.agentId)
    }

    // GYM-002: a pending rung-1 steer rides this very boundary. `recordSpan`
    // above already ran the breaker's evaluate for a `post-tool`, so a trip on
    // THIS event is answered on THIS reply — zero added latency. (Non-post-tool
    // events answer null; `session-start` clears a stale note.)
    const steerReply = steerNotes.answer(envelope.agentId, envelope.event)
    if (steerReply) return steerReply

    // SDD §9 choke point 1: the engine is waiting on a human. Through M1 and
    // M2 this event was unmapped, so an agent stalled behind a permission
    // dialog was invisible — the floor simply stopped moving (M1 carried item).
    if (envelope.event === 'notification') {
      // Engines repeat `notification` while one dialog stands; reporting each
      // repeat floods the 50-entry health buffer (M3 close-out audit). One
      // report per blocked episode: only the event that OPENS the wait.
      const alreadyBlocked = gates?.isBlocked(envelope.agentId) ?? false
      chokePoints?.submitNotification(envelope.agentId, envelope.payload)
      // Whether or not the policy would ever permit it, the engine is stalled
      // behind a dialog the harness cannot answer — the M1 carried item is
      // about that being *visible*, not about who may allow it (invariant §7).
      if (!alreadyBlocked) {
        reportDegradation(
          `gates/awaiting-human:${envelope.agentId}`,
          `${envelope.agentId} is waiting on a human decision`
        )
      }
    }

    // The autonomy hinge (ADR-0013): a finished turn continues only if the
    // guards allow it. Returning nothing lets the turn end normally.
    if (envelope.event === 'stop') {
      return hermes
        ? hermes
            .decideOnStop(envelope.agentId, envelope.payload)
            .then((reply) => reply ?? undefined)
        : undefined
    }
    return undefined
  },
  onRejected: ({ agentId, status, reason }) => {
    console.warn(`hook rejected [${agentId ?? 'unknown-agent'}] ${status}: ${reason}`)
  },
  /**
   * `eph-recall` (ADR-0006 layer 2). It answers on the hook socket because that
   * is where the per-spawn token registry already lives; the Library decides
   * which rung answers, and the answer carries that fact to the agent.
   */
  onRecall: (request) => {
    if (!library) throw new Error('recall: the Library is not up yet')
    return library.recall(request.query, request.scope, request.limit)
  },
  /**
   * A fresh GitHub installation token for a still-running agent (ADR-0022).
   *
   * Least privilege survives the refresh: the endpoint's own gate is the
   * per-spawn hook token, which proves only that a live agent is asking. What
   * decides whether it may HAVE this is the same thing that decided at spawn —
   * whether its hire declared the grant. Without this check the researcher,
   * whose spawns are no-secrets by NFR-17, could ask for the company credential
   * and get it.
   */
  onGhToken: (agentId) => {
    const refuse = (because: string): GhTokenResponse => ({
      schemaVersion: GH_TOKEN_SCHEMA_VERSION,
      ok: false,
      because
    })
    let declared: readonly string[]
    try {
      declared = agentManager?.card(agentId).envGrants ?? []
    } catch {
      return refuse(`no live spawn for "${agentId}"`)
    }
    if (!declared.includes(GITHUB_TOKEN_GRANT)) {
      return refuse(`your role does not declare ${GITHUB_TOKEN_GRANT}`)
    }
    const token = companyGitHub?.token() ?? null
    if (token === null) {
      return refuse('the company has no current GitHub token — check the Watch for why')
    }
    return { schemaVersion: GH_TOKEN_SCHEMA_VERSION, ok: true, token, expiresAt: null }
  },
  onEventError: (err) =>
    reportDegradation(
      'hooks/handler',
      `event handler failed: ${err instanceof Error ? err.message : String(err)}`
    )
})

/**
 * Feeds the breaker's span capture from the event plane (FR-11.6, ADR-0011).
 *
 * The engine tells us a tool started and a tool finished; the outcome comes
 * from the payload when the engine reports one and is `ok` otherwise — an
 * engine that does not report failures gives a weaker error signal, which is
 * what ADR-0011's reduced-protection note is about, not something to guess at.
 */
/**
 * Tells an agent which memo its held action owes (SDD §7.3).
 *
 * Harness-authored mail signed by the endpoint that will receive the memo —
 * the reserved-identity rule, so nothing forges a `from` (see `reserved.ts`).
 */
function noticeMemoOwed(gate: OpenGate): void {
  const mail = hermes
  const words = promptStore
  if (gate.memoTrigger === null || mail === null || words === null) return
  mail.deliverFromHarness(
    composeMessage({
      id: makeMessageId(new Date(), `memo${randomBytes(3).toString('hex')}`),
      conversation: `conv-memo-${gate.id}`,
      in_reply_to: null,
      from: ODEON_ENDPOINT,
      to: gate.agentId,
      act: 'request',
      subject: `memo required: ${gate.memoTrigger}`,
      body: words
        .render(path.join('odeon', 'memo-required.md'), {
          trigger: gate.memoTrigger,
          gateId: gate.id,
          what: gate.packaging.what,
          taskId: JSON.stringify(gate.taskId)
        })
        .trim(),
      hops: 0,
      created_at: new Date().toISOString()
    })
  )
}

/**
 * FR-7.3 triage — and `mayDecide`'s first production caller.
 *
 * Delegated classes the orchestrator settles herself, with the harness
 * recording her countersignature; everything else waits for the Architect.
 * Deny-by-default is the whole shape: no table, no matching grant, an unknown
 * domain — every one escalates, because an escalation costs a notification
 * and a wrong delegation costs a decision nobody signed.
 */
function triageMemo(memoId: string, trigger: string, filedBy: string): void {
  const archive = odeon
  const mail = hermes
  const words = promptStore
  if (archive === null || mail === null || words === null) return
  const may = artemis?.mayDecide({ class: 'memo', domain: trigger }) ?? {
    allowed: false as const,
    because: 'no orchestrator is hired to triage it'
  }
  if (!may.allowed) {
    // The Architect queue. The badge is the `odeon:queue` push; the memo is
    // already archived, so nothing depends on this notification arriving.
    ui.send(ODEON_QUEUE_CHANNEL)
    agora?.appendLog({
      kind: 'memo',
      event: 'escalated',
      memoId,
      trigger,
      by: filedBy,
      because: may.because
    })
    return
  }
  const body = archive.memoBody(memoId) ?? ''
  mail.deliverFromHarness(
    composeMessage({
      id: makeMessageId(new Date(), `tri${randomBytes(3).toString('hex')}`),
      conversation: `conv-memo-${memoId}`,
      in_reply_to: null,
      from: ODEON_ENDPOINT,
      to: may.countersignature.by,
      act: 'request',
      subject: words
        .render(path.join('odeon', 'memo-triage-subject.md'), { memoId, trigger })
        .trim()
        .slice(0, 200),
      body: words
        .render(path.join('odeon', 'memo-triage.md'), { memoId, trigger, memo: body })
        .trim(),
      hops: 0,
      created_at: new Date().toISOString()
    })
  )
  agora?.appendLog({
    kind: 'memo',
    event: 'delegated',
    memoId,
    trigger,
    to: may.countersignature.by,
    under: may.countersignature.under
  })
}

/**
 * Applies a settled memo: the gate is released or refused, and the agent that
 * filed it is told which (UC-06 step 4).
 *
 * A rejected memo REVERSES the held action — ADR-0008 says so in as many
 * words — which is a `denied` verdict on the gate, so the action never runs.
 */
function applyMemoVerdict(input: {
  readonly gateId: string
  readonly gateVerdict: 'approved' | 'denied'
  readonly verdict: string
  readonly memoId: string
  readonly notes: string
  readonly decidedBy: string
}): void {
  const gate = gates?.get(input.gateId) ?? null
  gates?.decide(input.gateId, input.gateVerdict)
  const mail = hermes
  const words = promptStore
  if (gate === null || mail === null || words === null) return
  mail.deliverFromHarness(
    composeMessage({
      id: makeMessageId(new Date(), `vrd${randomBytes(3).toString('hex')}`),
      conversation: `conv-memo-${input.memoId}`,
      in_reply_to: null,
      from: ODEON_ENDPOINT,
      to: gate.agentId,
      act: 'inform',
      subject: words
        .render(path.join('odeon', 'memo-verdict-subject.md'), {
          memoId: input.memoId,
          verdict: input.verdict
        })
        .trim()
        .slice(0, 200),
      body: words
        .render(path.join('odeon', 'memo-verdict.md'), {
          memoId: input.memoId,
          verdict: input.verdict,
          decidedBy: input.decidedBy,
          notes: input.notes,
          consequence: words.read(path.join('odeon', `memo-consequence-${input.verdict}.md`)).trim()
        })
        .trim(),
      hops: 0,
      created_at: new Date().toISOString()
    })
  )
}

/**
 * One agent’s cumulative token spend, folded from the durable ledger.
 *
 * ADR-0011 and invariant §11: the figure comes from stored rows every time,
 * never from a counter this process kept, so a restart cannot zero it.
 */
function totalOfSpend(agentId: string): number {
  const totals = costLedger?.spendFor(agentId, null).cumulativeTotals
  return totals === undefined ? 0 : totals.inTokens + totals.outTokens
}

function recordSpan(record: HookEventRecord): void {
  const { envelope } = record
  const payload = envelope.payload as Record<string, unknown> | null
  const tool = typeof payload?.['tool'] === 'string' ? payload['tool'] : null
  if (tool === null) return
  if (envelope.event === 'pre-tool') {
    breaker?.openSpan(envelope.agentId, tool, payload)
    // SDD §7.3 step 1: a choice matching memo policy is HELD before it lands.
    // The event plane already carries what the trigger table reads, so this is
    // the same stream the breaker watches, asked a different question.
    chokePoints?.submitMemoTrigger(envelope.agentId, {
      tool,
      ...(typeof payload?.['path'] === 'string' ? { path: payload['path'] } : {}),
      ...(typeof payload?.['file_path'] === 'string' ? { path: payload['file_path'] } : {}),
      ...(typeof payload?.['command'] === 'string' ? { text: payload['command'] } : {})
    })
    return
  }
  if (envelope.event === 'post-tool') {
    const failed =
      payload?.['error'] !== undefined ||
      payload?.['success'] === false ||
      payload?.['ok'] === false
    breaker?.closeSpan(envelope.agentId, tool, failed ? 'error' : 'ok')
    // Evaluated on close, not on a timer: the signals are about tool calls, so
    // a tool call finishing is exactly when the answer can have changed.
    breaker?.evaluate(envelope.agentId)
  }
}

/**
 * Which steer template a signal uses. A mapping, not prose: the words live in
 * `prompts/watch/steer-*.md` and the tag chooses which file (invariant §8).
 */
function steerTemplateFor(hit: { signal: string; detail: Record<string, unknown> }): string {
  return hit.detail['source'] === 'stop-loop' ? 'stop-loop' : hit.signal
}

function createWindow(): void {
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const restored = sanitizeBounds(db?.getWindowBounds(), displays)

  const win = new BrowserWindow({
    width: restored?.width ?? 1280,
    height: restored?.height ?? 800,
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => win.show())

  win.on('close', () => {
    const [x, y] = win.getPosition()
    const [width, height] = win.getSize()
    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
      db?.saveWindowBounds({ x, y, width, height })
    }
  })

  // External URLs open in the system browser, never in-app (ENGINEERING-STANDARDS §5).
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  ui.attach(win)

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app
  .whenReady()
  .then(() => boot())
  .catch((err: unknown) => {
    // Boot is fire-and-forget by nature, so its failure must be a visible
    // failure — never an unhandled rejection (the M2/M3 audit class, found at
    // this exact call by the M3 close-out audit).
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.error(`boot failed: ${detail}`)
    dialog.showErrorBox('Ephesus failed to start', detail)
    app.quit()
  })

async function boot(): Promise<void> {
  const home = initHome()
  db = new AppDb(home.dbPath)
  // A stored ledger row that fails validation on read is dropped and reported,
  // never repaired — the ledger is append-only (invariant §5).
  db.onUnreadableRow = (detail) => reportDegradation('ledger/unreadable-row', detail)
  // Bound before any agent can spawn, so no spawn ever races its own hooks.
  // A failure here is a *visible* degraded state, never a dead app: agents still
  // run, the floor freezes, and the UI says why (SDD §10, invariant §7).
  try {
    const endpoint = await hookServer.start(home.root)
    console.info(`hook endpoint listening on ${endpoint}`)
  } catch (err) {
    hookFailure = err instanceof Error ? err.message : String(err)
    console.warn(`hook endpoint unavailable: ${hookFailure}`)
  }

  // `prompts/` and `shims/` ship beside the app; the harness home holds the
  // Architect-editable copies (invariant §8).
  const appRoot = app.getAppPath()
  const prompts = new PromptStore(path.join(home.root, 'prompts'), path.join(appRoot, 'prompts'))
  // Mission profiles (ADR-0012, SDD §2). Two roots, home first: the Architect's
  // own bundles shadow the built-ins that ship in `profiles/`. Constructed here
  // and read on demand — the store holds no state and caches nothing, so a
  // bundle edited on disk is the bundle the next `inspect` reads.
  // What has been activated before, so the panel offers a target instead of
  // asking for a long absolute path again after every restart. Read-only to
  // `list()`; written only by a successful activation below.
  knownTargets = new KnownTargets(path.join(home.root, KNOWN_TARGETS_REL))
  const knownTargetsWarning = knownTargets.warning()
  if (knownTargetsWarning !== null) reportDegradation('profiles/known-targets', knownTargetsWarning)
  const profiles = new ProfileStore(
    path.join(home.root, 'profiles'),
    path.join(appRoot, 'profiles'),
    () => knownTargets?.list() ?? []
  )
  // Export/import (FR-10.4 — M7.6). Accepted imports land in the HOME profiles
  // directory, never beside the built-ins: a shared bundle must not be able to
  // shadow or overwrite one that ships with the app.
  exchange = new HireExchange({
    homeProfilesDir: path.join(home.root, 'profiles'),
    store: profiles
  })
  promptStore = prompts

  // The broker is constructed before anything can spawn: an agent must never
  // start before the harness knows which credentials it is allowed to hand it
  // (ADR-0010).
  secrets = new SecretBroker({
    storePath: path.join(home.root, 'secrets.enc'),
    cipher: safeStorageCipher(),
    onRotated: (name, change) => {
      // The NAME, never the value — rotation is auditable without the book of
      // record becoming the read path the broker refuses to be (SDD §4.3).
      agora?.appendLog({ kind: 'secret-rotated', name, removed: change === 'removed' })
      ui.send(LOG_APPEND_CHANNEL)
    },
    onDegraded: (detail) => reportDegradation('secrets/broker', detail)
  })

  // The company's GitHub identity (ADR-0022). The signing key comes out of the
  // broker by name and never leaves this process: it signs a JWT locally, and
  // only the JWT is sent. What agents receive is an installation token that
  // expires within the hour, so a leaked credential dies on its own and there
  // is no long-lived PAT for the Architect to rotate.
  companyGitHub = new GitHubAppIdentity({
    configPath: path.join(home.root, 'github-app.json'),
    privateKey: () => secrets?.grantsFor([GITHUB_APP_KEY_SECRET]).env[GITHUB_APP_KEY_SECRET] ?? null
  })
  const companyWarning = companyGitHub.warning()
  if (companyWarning !== null) reportDegradation('secrets/company-identity', companyWarning)
  if (companyGitHub.configured()) {
    const mintCompanyToken = (): void => {
      void companyGitHub?.refresh().then((minted) => {
        if (minted.ok) {
          // The token is never logged. What is logged is that the company can
          // act on GitHub and until when — enough to explain a 401 later.
          const who = companyGitHub?.gitIdentity() ?? null
          agora?.appendLog({
            kind: 'remote',
            source: 'github',
            event: 'company-token-minted',
            expiresAt: minted.expiresAt,
            // Public, and the point of the exercise: if this is null the
            // company can act on GitHub but its commits carry no author, which
            // is a different degradation from having no token at all.
            authorName: who?.name ?? null,
            authorEmail: who?.email ?? null
          })
          if (who === null) {
            reportDegradation(
              'secrets/bot-identity',
              'company GitHub token minted, but the bot identity could not be read — commits will not be authored as the company'
            )
          }
          return
        }
        reportDegradation(
          'secrets/company-token',
          `company GitHub identity unavailable: ${minted.because}`
        )
      })
    }
    mintCompanyToken()
    // Refreshed well inside the hour, so no spawn is handed a token with only
    // minutes left — SRS §6.1's window is itself an hour, and a credential
    // expiring mid-run would present as a permissions bug.
    companyTokenTimer = setInterval(mintCompanyToken, TOKEN_REFRESH_MS)
  }

  // Undo anything a force-killed run left in somebody else's repository. No
  // agent is live in a process that has just booted, so a recorded file can
  // only be a leftover (M1 carried item).
  const sweep = sweepInstalledSettings(db)
  if (sweep.restored.length > 0 || sweep.removed.length > 0) {
    console.info(
      `settings sweep: restored ${sweep.restored.length}, removed ${sweep.removed.length}`
    )
  }
  for (const failure of sweep.failed) {
    reportDegradation(
      `settings/restore:${failure.path}`,
      `sweep could not restore ${failure.path}: ${failure.reason}`
    )
  }

  // The Agora is a git repo committed only by this process (ADR-0004). It is
  // reconciled before anything can write to it.
  // The one git path (ADR-0004) also owns worktree isolation, and is told which
  // root it must never make a worktree of: the Agora's own.
  const worktrees = new Worktrees({
    runner: new ExecGitRunner(),
    forbiddenRoot: path.join(home.root, 'agora')
  })
  agora = new Agora({
    root: path.join(home.root, 'agora'),
    prompts,
    onCommitError: (failure) =>
      reportDegradation(
        'agora/commit',
        `gave up committing "${failure.subject}": ${failure.reason}`
      )
  })
  await agora.ensureRepo()
  const reconciled = await agora.reconcile()
  if (reconciled.sha) console.info(`agora reconciled at ${reconciled.sha.slice(0, 8)}`)

  // What was still wrong when the company last stopped (M8.2, Architect
  // decision 2026-09-03). Replayed entries are marked `carried`, never live:
  // they are what the record says, not what this session has observed. Read
  // from the TAIL — the newest events — because `readLog`'s cursor pages
  // forward from the oldest, which is register item B3.
  degradations.replay(agora.tailLog(DEGRADATION_REPLAY_LIMIT))
  // And the rows reported before this file was open reach it now, in order.
  for (const row of pendingDegradationRows.splice(0)) agora.appendLog(row)

  // The Watch's gate policy (SDD §9). Deny-by-default: an unconfigured
  // Ephesus, or one whose policy file will not parse, holds every gated action.
  gatePolicyPath = path.join(home.root, 'gate-policy.json')
  gates = new GateManager({
    policy: () => {
      const loaded = loadGatePolicy(gatePolicyPath)
      // A policy that cannot be read is a visible degradation, not a silent
      // deny — the Architect has to know why everything is suddenly held. But
      // only on CHANGE: the policy is re-read on every evaluation, and
      // re-reporting would evict every other entry from the bounded health
      // buffer, which is the opposite of invariant §7.
      if (loaded.warning !== lastPolicyWarning) {
        lastPolicyWarning = loaded.warning
        if (loaded.warning) reportDegradation('gates/policy-file', loaded.warning)
      }
      return loaded.policy
    },
    // ADR-0012's stricter-wins composition, wired into every submission
    // (FR-11.1, SDD §9). Null for an agent no profile owns, which sends the
    // decision to the global policy alone — never to a permissive default.
    profileAutonomy: (agentId, kind) => activations?.autonomyFor(agentId, kind) ?? null,
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`gate ${String(draft['event'] ?? 'event')}`)
    },
    onOpen: (gate) => {
      // The id, not the gate: this channel is a nudge and the panel re-reads
      // `watch:approvals`. Sending the whole gate would make it a second copy
      // of the queue that could disagree with main.
      ui.send(GATE_OPEN_CHANNEL, gate.id)
      // The avatar waves at the Watch post while a gate is open (SDD §6). The
      // transition was implemented and regression-tested in M1; this is the
      // package that finally makes it reachable in the running app.
      avatarDirector.apply(gate.agentId, { kind: 'gate-opened' })
      // SDD §4.2's `gates` field, written for the first time (carried from the
      // M3.3 review). Until this, "the harness refuses `→ done` while a gate is
      // open" was a rule guarding a field nobody ever filled.
      if (gate.taskId) ledger?.noteGate(gate.taskId, gate.id, true)
      // SDD §7.3: "worker notified with memo template ref". A held action the
      // agent is never told about is a stall it cannot act on (invariant §7).
      if (gate.memoTrigger !== null) noticeMemoOwed(gate)
    },
    onSettled: (gate, verdict) => {
      // Only when the LAST gate on that agent clears: an agent held behind two
      // gates must not walk back to its desk after the first verdict.
      if (!gates?.isBlocked(gate.agentId)) {
        avatarDirector.apply(gate.agentId, { kind: 'gate-verdict' })
      }
      if (gate.taskId) ledger?.noteGate(gate.taskId, gate.id, false)
      // UC-10 step 3's other half: an `outbound` gate the Architect decided
      // releases (or drops) the draft it was holding. `onVerdict` returns false
      // for a gate that held no draft, so every other gate kind passes through
      // here untouched.
      if (gate.kind === 'outbound') {
        void frontOffice?.onVerdict(gate.id, verdict === 'approved')
      }
      ui.send(GATE_OPEN_CHANNEL, null)
    },
    // Invariant §8: the words a refusal shows are a prompt surface.
    refusalReason: (because) => prompts.read(path.join('watch', `refusal-${because}.md`)).trim()
  })

  // SDD §9's three choke points, wired in ONE place so the scenario rig
  // exercises the shipped path instead of a copy of it.
  chokePoints = wireGateChokePoints({
    gates,
    prompts,
    // M5.1: the join that makes SDD §4.2's `gates` real in production. Every
    // gate this app opens is now recorded against the work it blocks, so the
    // `status → done` refusal finally guards a field something fills.
    taskOf: (agentId) => ledger?.boundTaskFor(agentId) ?? null,
    onError: (detail) => reportDegradation('gates/driver', detail),
    // The adapter owns the engine's phrasing (NFR-12); core only learns which
    // of the two situations it was.
    notificationKind: (agentId, payload) => {
      try {
        const card = agentManager?.card(agentId)
        if (!card) return null
        return engines.get(card.engine).notificationKind?.(payload) ?? null
      } catch {
        // Unknown reads as a permission prompt, which is the safe direction.
        return null
      }
    },
    autonomyFor: (agentId) =>
      activations?.autonomyFor(agentId, 'tool-permission') ??
      loadGatePolicy(gatePolicyPath).policy.autonomy,
    // Not gated is not unrecorded: an engine prompt the harness declined to put
    // in front of the Architect still belongs in the book of record, or
    // "autonomy" becomes a synonym for "unobserved".
    onUngated: (agentId, kind, message) => {
      agora?.appendLog({
        kind: 'gate',
        event: 'ungated',
        agentId,
        gateKind: 'tool-permission',
        because: kind,
        what: message
      })
      ui.send(LOG_APPEND_CHANNEL)
    }
  })

  // The circuit breaker (ADR-0011). Constructed before anything can spawn, so
  // no tool event arrives with nowhere to go.
  breaker = new Breaker({
    effects: {
      // GYM-002: hook boundary on `native` grade, queue-until-idle below it —
      // the choice and its record live in `watch/steer-notes.ts`.
      steer: (agentId, text) => steerNotes.steer(agentId, text),
      pauseDeliveries: (agentId, paused) => hermes?.setPaused(agentId, paused),
      interrupt: (agentId) => {
        try {
          agentManager?.interrupt(agentId)
        } catch (err) {
          reportDegradation(
            `breaker/interrupt:${agentId}`,
            `interrupt failed for ${agentId}: ${String(err)}`
          )
        }
      },
      stop: (agentId) => {
        try {
          agentManager?.kill(agentId)
        } catch (err) {
          reportDegradation(`breaker/stop:${agentId}`, `stop failed for ${agentId}: ${String(err)}`)
        }
      },
      avatar: (agentId, event) => avatarDirector.apply(agentId, event),
      // ADR-0011 rung 3's owed clause: the stopped agent's task returns to the
      // ledger as `stalled` with the breaker report, for Artemis to reassign.
      returnTask: (agentId, report) => {
        try {
          ledger?.stallTaskOf(agentId, report)
        } catch (err) {
          reportDegradation(
            `breaker/stall-task:${agentId}`,
            `could not stall the task of ${agentId}: ${String(err)}`
          )
        }
        // FR-14.5: a rung-3 stop on gym/stoa work reverts the company to
        // `directed` automatically, visibly, and on the ledger. The revert is
        // attributed to the breaker rather than to the Architect, so nobody
        // later reads it as a change of mind — and `everEnabled` is preserved,
        // because a safety stop is not a demotion.
        if (isImprovementWork(agentId)) {
          modes?.revertOnBreaker(`${agentId} stopped at rung ${String(report.rung)}`)
        }
      },
      // ADR-0011 rung 2: "lower its remaining budget". The set is consulted by
      // the budget watcher's agents() below, so the constraint lifts with the
      // rung and never touches the append-only ledger itself.
      constrainBudget: (agentId, constrained) => {
        if (constrained) constrainedBudgets.add(agentId)
        else constrainedBudgets.delete(agentId)
      }
    },
    // Invariant §8: the corrective sentence is config, not a literal here.
    steerText: (hit) =>
      prompts
        .render(path.join('watch', `steer-${steerTemplateFor(hit)}.md`), {
          ...Object.fromEntries(
            Object.entries(hit.detail).map(([key, value]) => [key, String(value)])
          )
        })
        .trim(),
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(
        `breaker ${String(draft['action'] ?? 'trip')} for ${String(draft['agentId'] ?? '')}`
      )
      if (draft['rung'] !== 0) {
        reportDegradation(
          `breaker/rung:${String(draft['agentId'])}`,
          `${String(draft['agentId'])} at rung ${String(draft['rung'])} (${String(draft['action'])})`
        )
      }
    },
    hookFidelity: (agentId) => {
      try {
        return agentManager?.card(agentId).hookFidelity ?? 'native'
      } catch {
        return 'native'
      }
    },
    budgetState: (agentId) => {
      const card = agentManager?.list().find((entry) => entry.agentId === agentId)
      if (!card || !costLedger) return null
      return costLedger.spendFor(agentId, card.dailyTokens).budget.state
    }
  })

  // The durable cost ledger (ADR-0011). Its storage is the app-local SQLite
  // file, so every figure survives a restart by construction — there is no
  // in-memory counter to zero (invariant §11).
  costLedger = new CostLedger({
    store: db,
    onFoldRestart: (source) =>
      reportDegradation(
        'budgets/transcript-shrank',
        `transcript ${source} shrank; re-folded from the start`
      ),
    // Money the engine reports (ADR-0011 `cost_usd`). Both of these are ways
    // the dollar figure can be less than the whole truth, and invariant §7 says
    // a figure that is not the whole truth has to say so where it is shown.
    onCostRegressed: (source, session, model) =>
      reportDegradation(
        'budgets/cost-regressed',
        `cost went backwards for ${model} in session ${session} (${source}); ` +
          `the transcript was replaced — earlier spend stands, nothing was corrected`
      ),
    // The live half of the money figure (the durable half is folded from
    // cost-state at session end). Read fresh on every call from the file the
    // status line rewrites — the ledger stores none of it.
    liveCost: (agent) => usageWatch?.liveCostFor(agent) ?? null,
    onCostIncomplete: (source) =>
      reportDegradation(
        'budgets/cost-incomplete',
        `${source}: the engine could not price every model it used; ` +
          `the cost shown is an understatement, not the full bill`
      )
  })

  // ADR-0023: the account's usage window, observed by every agent's status
  // line and read back here. Constructed before anything can spawn, so the
  // first agent's first render already has somewhere to land.
  // One report per agent: the windows are account-wide, but the live session
  // cost is not, and a single shared file would let the last agent to render
  // claim every other agent's spend.
  const usageStatusDir = path.join(home.root, 'usage')
  usageWatch = new UsageWatch({
    dir: usageStatusDir,
    thresholds: {
      ...DEFAULT_PACE_THRESHOLDS,
      ...(home.config.pacing?.slowAtPercent === undefined
        ? {}
        : { slowAtPercent: home.config.pacing.slowAtPercent }),
      ...(home.config.pacing?.holdAtPercent === undefined
        ? {}
        : { holdAtPercent: home.config.pacing.holdAtPercent })
    },
    onDegraded: (detail) => reportDegradation('usage/watch', detail),
    onPaceChange: (verdict, previous) => {
      // Only transitions reach the book of record, exactly as budget states do:
      // a company held at `slow` for two hours must not turn log.jsonl into a
      // metronome (SDD §4.3).
      agora?.appendLog({
        kind: 'budget',
        event: 'pace',
        pace: verdict.pace,
        because: verdict.because,
        from: previous?.pace ?? null,
        window: verdict.tightest?.window ?? null,
        usedPercent: verdict.tightest?.usedPercent ?? null,
        projectedPercent: verdict.tightest?.projectedPercent ?? null,
        resetsAt: verdict.resetsAt
      })
      ui.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`pace ${verdict.pace} (${verdict.because})`)
      // Anything but full speed is a degradation the Architect must be able to
      // see, or a paced company is indistinguishable from a hung one.
      // Cleared as deliberately as it is raised: a condition that ends and
      // says nothing leaves the Architect reading a stale warning all day.
      if (verdict.pace === 'full') degradations.clear('usage/pacing')
      if (verdict.pace !== 'full') {
        const tight = verdict.tightest
        reportDegradation(
          'usage/pacing',
          tight
            ? `company pacing ${verdict.pace}: ${tight.window} window at ${Math.round(
                tight.usedPercent
              )}%, resets ${new Date(tight.resetsAt).toISOString()}`
            : `company pacing ${verdict.pace} (${verdict.because})`
        )
      }
    }
  })
  usageWatch.start()

  engines.register(
    new ClaudeAdapter({
      prompts,
      hookShimPath: path.join(appRoot, 'shims', 'eph-hook.mjs'),
      // The statusline observation point (ADR-0023). Installed alongside the
      // hooks because it rides the same settings file and the same backup and
      // uninstall path — nothing new has to be cleaned up on the way out.
      usageShimPath: path.join(appRoot, 'shims', 'eph-usage.mjs'),
      usageStatusDir,
      settingsRegistry: db
    })
  )
  // ADR-0009's roster grows by an adapter and one registration; nothing in core
  // learns anything (NFR-12). Codex declares `pty-heuristic` and the agent card
  // says so — see the adapter's own comment for why.
  engines.register(new CodexAdapter({ prompts }))
  engines.register(new GeminiAdapter({ prompts }))
  // ADR-0013: the block cap is env-configurable; an invalid value can never
  // silently disable the cap — it is refused visibly and the default holds.
  const envCap = blockCapFromEnv(process.env)
  if (envCap.cap === undefined && envCap.invalid !== undefined) {
    reportDegradation(
      'autonomy/block-cap-env',
      `ignoring invalid ${BLOCK_CAP_ENV}="${envCap.invalid}" — default cap applies`
    )
  }

  // SDD §7.1: Artemis proposes, the harness validates and writes. Nothing here
  // decides what a good decomposition looks like — only whether a proposal is
  // well-formed and legal against the ledger as it stands (FR-5.2).
  ledger = new LedgerEndpoint({
    store: agora,
    knownAgents: () => hermes?.knownAgents() ?? [],
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
    },
    onChange: () => ui.send(TASKS_STATE_CHANNEL),
    onDegraded: (detail) => reportDegradation('agora/task-ledger', detail)
  })

  // The Odeon (ADR-0008, FR-7.2). Agents never write `odeon/` — SDD §2 gives
  // the directory to the harness, so an agent files from its own outbox and
  // this is the only thing that ever writes the archive.
  odeon = new Odeon({
    agoraRoot: agora.root,
    prompts,
    task: (taskId) => ledger?.tasks().tasks.find((row) => row.id === taskId) ?? null,
    recordDeck: (taskId, ref) => ledger?.noteDeck(taskId, ref),
    // A memo must answer a gate that really holds its filer (FR-7.3).
    gate: (gateId) => gates?.get(gateId) ?? null,
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
    },
    commitSoon: (subject) => agora?.commitSoon(subject)
  })

  // The Library (ADR-0006). Layer 1 is the markdown ground truth every spawn
  // carries; layer 2 is recall, on the best rung that will answer — MemPalace
  // (M4.3) above SQLite FTS above plain grep, every step down visible.
  const indexRoot = path.join(home.root, 'index')
  const fts = openFtsStore(indexRoot)
  if (fts.store === null) reportDegradation('library/fts', fts.because)
  // ADR-0016: MemPalace is an OPTIONAL external. It is probed, never installed
  // from here — a missing one degrades the ladder visibly and offers its
  // install command, exactly as a missing engine binary does (FR-1.6).
  // Local, not a module handle: nothing outside this block reads it yet, and a
  // module-level variable nobody consumes is the dead-wiring class the M3
  // close-out audit named. The Memory panel promotes it when it can re-probe.
  const mempalace = new MemPalaceIndex({
    palaceRoot: indexRoot,
    agoraRoot: agora.pathOf(),
    command: home.config.mempalaceCommand ?? MEMPALACE_BINARY,
    onDegraded: (detail) => reportDegradation('library/mempalace', detail)
  })
  library = new Library({
    agoraRoot: agora.pathOf(),
    prompts,
    indexes: [mempalace, new FtsIndex({ store: fts.store, because: fts.because })],
    onDegraded: (detail) => reportDegradation('library/driver', detail)
  })
  const probe = await mempalace.probe()
  if (probe.version === null) reportDegradation('library/mempalace-probe', probe.because)
  // Mtime-gated, so a boot with an unchanged corpus re-mines nothing (ADR-0006).
  // Not awaited: mining embeds, which takes seconds, and no boot step depends on
  // it — recall answers on whatever rung is ready when it is asked.
  void library
    .reindex()
    .catch((err: unknown) =>
      reportDegradation(
        'library/reindex',
        `reindex failed: ${err instanceof Error ? err.message : String(err)}`
      )
    )
  const recallRung = library.rung()
  if (recallRung.degraded !== null) {
    reportDegradation(
      'library/recall-rung',
      `recall on the ${recallRung.rung} rung — ${recallRung.degraded}`
    )
  }

  // ADR-0006 layer 3. The harness never summarizes: it asks the agent whose
  // memory it is, as a normal turn on a harness prompt, and applies the answer
  // the agent proposes back to `agent.library` (ADR-0005 rejects the alternative
  // outright).
  reflection = new ReflectionJob({
    library,
    prompts,
    reachableAgents: () => hermes?.knownAgents() ?? [],
    deliver: (message) => hermes?.deliverFromHarness(message),
    onDegraded: (detail) => reportDegradation('library/reflection', detail)
  })
  // The standup briefing (ADR-0008 §1, FR-7.1). The harness compiles facts;
  // Artemis narrates them. It never writes prose, and her narration is checked
  // sentence by sentence against the facts it issued before anything is
  // archived — which is what makes FR-7.1 a mechanism instead of an
  // instruction.
  briefing = new BriefingJob({
    prompts,
    gather: (sinceSeq) => ({
      events: agora?.readLog().filter((entry) => entry.seq > sinceSeq) ?? [],
      ledger: ledger?.tasks() ?? emptyTaskLedger,
      openGates: (gates?.list() ?? []).map((gate) => ({
        id: gate.id,
        agentId: gate.agentId
      })),
      openMemos: (odeon?.memos('open') ?? []).map((memo) => ({ memoId: memo.memoId })),
      // ADR-0011: cumulative spend is folded from the durable ledger, never
      // from a counter this process kept.
      spend: Object.keys(agora?.registry().agents ?? {}).map((agentId) => ({
        agentId,
        tokens: totalOfSpend(agentId)
      })),
      // FR-12.5: the standup reports the improvement slice.
      ...(gymnasium === null
        ? {}
        : {
            gymSlice: {
              ...gymnasium.slice(),
              open: gymnasium.rows().filter((row) => row.status === 'proposed').length,
              // FR-13.6 / FR-14.1: the Stoa's work and the company mode ride
              // the same standup section as the budget they share.
              ...(stoa === null
                ? {}
                : { stoa: { sources: stoa.sources().length, briefs: stoa.briefs().length } }),
              mode: modes?.mode() ?? 'directed'
            }
          })
    }),
    orchestrator: () => agora?.registry().orchestratorId ?? null,
    deliver: (message) => hermes?.deliverFromHarness(message),
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
    },
    onDegraded: (detail) => reportDegradation('odeon/briefing', detail)
  })

  // The meeting driver (ADR-0008 §4, FR-7.4). It owns who may speak, and
  // nothing else: Artemis chairs, the Architect interjects, and the driver
  // guarantees only that two people never hold the floor at once and that an
  // early answer is held rather than thrown away.
  meetings = new MeetingDriver({
    agoraRoot: agora.root,
    prompts,
    deliver: (message) => hermes?.deliverFromHarness(message),
    orchestrator: () => agora?.registry().orchestratorId ?? null,
    // SDD §6: attendees walk to the Odeon room. The station map already
    // sends the `meeting` tool class there, so this needs no new avatar state.
    onAttendance: (agentId, present) =>
      avatarDirector.apply(
        agentId,
        present ? { kind: 'pre-tool', toolClass: 'meeting' } : { kind: 'post-tool' }
      ),
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
    },
    onChange: () => ui.send(ODEON_QUEUE_CHANNEL)
  })

  // The org layer (FR-11.5, UC-12). It computes and archives; it never acts.
  // Every figure is folded from `log.jsonl` and the durable cost ledger on
  // each read — invariant §11 in a second place, because a metric nobody can
  // recompute is a metric nobody can argue with.
  org = new OrgLayer({
    agoraRoot: agora.root,
    gather: () => ({
      events: agora?.readLog() ?? [],
      agents: Object.keys(agora?.registry().agents ?? {}).sort(),
      spend: Object.keys(agora?.registry().agents ?? {}).map((agentId) => ({
        agentId,
        tokens: totalOfSpend(agentId)
      }))
    }),
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
    },
    commitSoon: (subject) => agora?.commitSoon(subject),
    onDegraded: (detail) => reportDegradation('odeon/org', detail)
  })

  // The Gymnasium (ADR-0015, FR-12). Its ledger seeds from the repository’s
  // own build-phase archive, so the improvement record is continuous from the
  // first commit rather than starting empty on the day the product ships.
  /**
   * Gym spend from the durable ledger, attributed by exact role (M6.7).
   *
   * `spendFor(...).cumulativeTotals` is the ledger's own durable read, so this
   * is a fold over the record rather than a counter a restart would zero.
   */
  const gymnasiumSpend = (): { readonly tokens: number; readonly source: string } => {
    const registry = agora?.registry().agents ?? {}
    const roster: AttributableAgent[] = Object.entries(registry).map(([agentId, entry]) => ({
      agentId,
      role: (entry as { role?: string }).role ?? ''
    }))
    const attributed = attributeSpend(roster, 'gymnasium', (agentId) =>
      // The ledger's own durable read — cumulative, so a restart cannot zero it
      // (invariant §11).
      tokensOf(costLedger?.spendFor(agentId, null).cumulativeTotals ?? ZERO_TOTALS)
    )
    return { tokens: attributed.tokens, source: attributed.source }
  }

  gymnasium = new Gymnasium({
    agoraRoot: agora.root,
    /**
     * The carried item from the M5 close-out, closed (FR-12.5, R3).
     *
     * The figure comes from the DURABLE ledger (invariant §11, ADR-0011), not
     * an in-memory counter, so a restart cannot reset it; and it is attributed
     * by exact ROLE, so a hire whose name merely contains "improver" is not
     * counted (the M5b audit's substring finding, one domain over). `source`
     * rides with it because the brief is read ALOUD, where there is no card to
     * hover: a bare total invites trust in a scope the listener cannot see.
     */
    gymSpend: () => gymnasiumSpend(),
    seedFrom: path.join(appRoot, 'docs', 'gymnasium'),
    // FR-13.4: a proposal citing a brief must cite one that exists.
    briefExists: (briefId) => stoa?.brief(briefId) !== null,
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
    },
    commitSoon: (subject) => agora?.commitSoon(subject),
    onDegraded: (detail) => reportDegradation('odeon/gymnasium', detail)
  })

  // The Stoa (ADR-0017, FR-13). Same seeding habit as the Gymnasium beside it:
  // the watchlist and the briefs the build phase already produced cross into
  // the running system together, so a seeded brief's source reference resolves.
  stoa = new Stoa({
    agoraRoot: agora.root,
    seedFrom: path.join(appRoot, 'docs', 'stoa'),
    // A watched source is checked out under the harness home, never inside the
    // Agora and never in `worktrees/` — those belong to the company's own
    // repositories (ADR-0004, NFR-17). Both roots are passed so the refusal is
    // checked rather than assumed.
    scratchRoot: path.join(home.root, 'scratch'),
    worktreesRoot: path.join(home.root, 'worktrees'),
    prompts: promptStore,
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
    },
    commitSoon: (subject) => agora?.commitSoon(subject),
    onDegraded: (detail) => reportDegradation('odeon/stoa', detail)
  })

  /**
   * Is this agent doing Gymnasium/Stoa work? (FR-14.5)
   *
   * Attributed by ROLE, which is what the roster actually records. A stop is
   * only allowed to revert the company mode when the stopped agent was one of
   * the two roles autonomy creates — otherwise a rung-3 stop on ordinary
   * mission work would switch off self-improvement for reasons that had
   * nothing to do with it, and the Architect would be left re-enabling a mode
   * that never misbehaved.
   */
  const isImprovementWork = (agentId: string): boolean => {
    // `agents` is a record keyed by id, not a list. The role test itself is
    // shared and exact (isImprovementRole — M5b close-out audit, finding 12).
    return isImprovementRole(agora?.registry().agents[agentId]?.role ?? '')
  }

  // The company mode (ADR-0018, FR-14). The switch that decides whether the
  // company acts without being asked, so it reads and writes `config.json`
  // through the same atomic path everything else does, and its gate reads only
  // the Gymnasium ledger and the `gym` events — never a computed cache.
  modes = new CompanyModes({
    // Read through `getHome()` rather than the boot-time snapshot: a mode set
    // during this run must be what the next read sees.
    read: () => ({
      mode: getHome().config.mode,
      everEnabled: getHome().config.everEnabledImproving ?? false
    }),
    write: (patch) => {
      saveConfig({ mode: patch.mode, everEnabledImproving: patch.everEnabled })
    },
    rows: () => gymnasium?.rows() ?? [],
    gymEvents: () =>
      (agora?.readLog() ?? [])
        .filter((entry) => entry['kind'] === 'gym')
        .map((entry) => ({
          event: entry['event'],
          gymId: entry['gymId'],
          evidence: entry['evidence']
        })),
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
    },
    recordOnLedger: (change) => gymnasium?.recordModeChange(change),
    onChanged: () => ui.send(LOG_APPEND_CHANNEL)
  })

  // The Stoa cadence (SDD §7.7): fires autonomously ONLY in `improving`
  // (FR-14.4). The gate is the scheduler's `enabled` predicate rather than a
  // check inside the job, so autonomy is switched off at the one place that
  // starts autonomous work — a job that policed itself would be a job that
  // could forget to.
  scheduler.add({
    id: 'stoa-cadence',
    everyMs: STOA_EVERY_MS,
    enabled: () => modes?.mode() === 'improving',
    // The SHIPPED tick (stoa-cadence.ts) — the suites exercise the same body
    // this wiring runs (M5b close-out audit, finding 5).
    run: () => {
      stoaCadenceTick({
        sources: () => stoa?.sources() ?? [],
        plan: (sourceId) => stoa?.plan(sourceId) ?? { ok: false },
        mode: () => modes?.mode() ?? 'directed',
        appendLog: (draft) => agora?.appendLog(draft)
      })
    }
  })

  // SDD §7.6's missing arrow: "row `landed` ─► scheduler books metric check".
  // Until M6.7 nothing booked one, so a landed change whose check nobody
  // remembered to run quietly counted as a success — the gamed-metric failure
  // ADR-0015 opens by warning about. The tick RAISES due checks on the record;
  // the measured value is still supplied through `measure()`, because booking a
  // check and deciding what the number was are different jobs.
  scheduler.add({
    id: 'gym-metric-check',
    everyMs: GYM_CHECK_EVERY_MS,
    // The SHIPPED tick (gym-cadence.ts), for the M5b reason: the suites
    // exercise the same body this wiring runs.
    run: () => {
      gymCadenceTick({
        rows: () => gymnasium?.rows() ?? [],
        today: () => new Date().toISOString().slice(0, 10),
        appendLog: (draft) => agora?.appendLog(draft),
        onDue: (check) => {
          reportDegradation(
            `odeon/gym-metric-due:${check.id}`,
            `gymnasium: ${check.id}'s metric check was due ${check.due} — ${check.metric}`
          )
        }
      })
    }
  })

  scheduler.add(reflection.trigger())
  // The scheduler’s second client (SDD §7.2).
  scheduler.add(briefing.trigger(STANDUP_EVERY_MS))
  // The scheduler's third client (FR-11.5's scheduled retro).
  scheduler.add(org.trigger(RETRO_EVERY_MS))
  scheduler.start()

  // Closing time (GYM-003): constructed before Hermes so the endpoint below can
  // hand acknowledgments to it. It only mails, watches and reports — the quit
  // path in `window-all-closed` decides whether to run it.
  closingTime = new ClosingTime({
    liveAgents: () =>
      agentManager
        ?.list()
        .filter((card) => card.lifecycle === 'running')
        .map((card) => card.agentId) ?? [],
    deliver: (message) => hermes?.deliverFromHarness(message),
    render: (kind, vars) =>
      prompts.render(path.join('hermes', `closing-time-${kind}.md`), vars).trim(),
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`shutdown ${String(draft['event'] ?? 'event')}`)
    }
  })

  // The Harbor's incident endpoint (FR-9.2, UC-09, SDD §7.5 — M7.4).
  // Constructed here, before Hermes, for the same reason closing time is: the
  // router hands triage reports to it. It never writes `tasks.json` — it mails
  // Artemis, and the task is hers to propose (FR-5.2).
  incidents = new IncidentEndpoint({
    bindings: () =>
      (activations?.instances() ?? []).flatMap((instance) =>
        instance.plan.triggers
          // On the machine-readable binding, never on `when` — `when` renders
          // "on ci" for display, and filtering it as 'ci' is what silently
          // dropped every CI failure as `incident-unclaimed` on the first real
          // repository this was pointed at.
          .filter((trigger) => trigger.event === 'ci')
          .map((trigger) => ({
            instanceId: instance.instanceId,
            agentId: trigger.agentId,
            playbook: trigger.playbook,
            repos: instance.plan.repos
          }))
      ),
    orchestratorId: () => agora?.registry().orchestratorId ?? ARTEMIS_AGENT_ID,
    // What the ledger actually holds, so a triage report cannot claim a task
    // that does not exist. Undefined when no ledger is up: an unverifiable
    // claim is let through rather than refused by a check that could not run.
    taskIds: () => (ledger?.tasks().tasks ?? []).map((row) => row.id),
    // Who reads a root cause back against the repository it describes.
    //
    // The rule itself is `verifierAgentFor` — a pure function over the same
    // activation plan the Architect approved, so it is reachable by a test
    // rather than copied into one. Picking "some other live agent" here was the
    // alternative and would have made the second opinion arrive from whoever
    // happened to be idle, which is availability, not independence.
    verifierFor: ({ incident, reportedBy }) =>
      verifierAgentFor(activations?.instances() ?? [], incident.instanceId, reportedBy),
    deliver: (message) => hermes?.deliverFromHarness(message),
    render: (kind, vars) => prompts.render(path.join('harbor', `incident-${kind}.md`), vars).trim(),
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`incident ${String(draft['event'] ?? 'event')}`)
    },
    // UC-09 step 4's announcement has no delivery leg: M6.9 is deferred and the
    // Herald has no production caller. The obligation surfaces as a visible
    // degradation (invariant §7) instead of being quietly dropped.
    onUnmetObligation: (what) => reportDegradation('incident/unmet-obligation', what),
    onEscalateNow: (incident, report) => {
      // UC-09 step 4's "UC-08 escalation with an incident summary", through
      // SDD §9's `needs_human` choke point — the surface that already exists
      // and is already wired to the approvals queue. The summary is the
      // AGENT'S sentence, not one composed here.
      chokePoints?.submitNeedsHuman({
        from: incident.agentId,
        subject: `severity-1 incident ${incident.key}: ${report.summary}`,
        conversation: incident.key
      })
    }
  })

  // The Front Office's outbound desk (FR-9.3, UC-10 step 3 — M7.5). The
  // autonomy it reads is the COMPOSED one the Watch already computed, so a
  // profile's request has been clamped against the global ceiling before it
  // gets here and there is no second opinion about it in this file.
  frontOffice = new FrontOffice({
    outboundAutonomy: (agentId) => activations?.autonomyFor(agentId, 'outbound') ?? null,
    openGate: (request) => {
      // UC-08's four-part packaging. The facts are the harness's; every word
      // around them is a prompt surface (invariant §8), because this is the
      // text the Architect reads when deciding whether the company speaks.
      const vars = {
        key: request.key,
        repo: request.draft.repo,
        target: request.draft.target,
        ref: String(request.draft.ref),
        body: request.draft.body
      }
      const outcome = gates?.submit({
        kind: 'outbound',
        agentId: request.agentId,
        packaging: {
          what: prompts.render(path.join('watch', 'outbound-what.md'), vars).trim(),
          why: prompts.render(path.join('watch', 'outbound-why.md'), vars).trim(),
          blastRadius: prompts.render(path.join('watch', 'outbound-blast.md'), vars).trim(),
          rollback: prompts.render(path.join('watch', 'outbound-rollback.md'), vars).trim()
        }
      })
      return outcome?.held === true ? outcome.gate.id : null
    },
    post: (permit) =>
      harbor?.postComment(permit) ?? Promise.resolve({ ok: false, because: 'no harbor' }),
    deliver: (message) => hermes?.deliverFromHarness(message),
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
    }
  })

  // ADR-0023's second, independent limit: a wake that runs too long in
  // WALL-CLOCK time is ended, whatever it cost in tokens. Constructed here,
  // beside Hermes, because Hermes issues the wakes this bounds.
  wakeClock = new WakeClock({
    capMs: home.config.pacing?.wakeCapMs ?? DEFAULT_WAKE_CAP_MS,
    interrupt: (agentId) => {
      try {
        agentManager?.interrupt(agentId)
      } catch (err) {
        reportDegradation(
          `usage/wake-interrupt:${agentId}`,
          `wake-cap interrupt failed for ${agentId}: ${String(err)}`
        )
      }
    },
    onOvertime: (agentId, ranMs, capMs) => {
      agora?.appendLog({
        kind: 'budget',
        event: 'wake-overtime',
        agentId,
        ranMs: Math.round(ranMs),
        capMs
      })
      ui.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`wake cap reached for ${agentId}`)
      reportDegradation(
        `usage/wake-cap:${agentId}`,
        `${agentId} ran one wake for ${Math.round(ranMs / 1000)}s (cap ${Math.round(
          capMs / 1000
        )}s); the turn was interrupted`
      )
    }
  })

  hermes = new Hermes({
    agora,
    prompts,
    // ADR-0023. The pace is computed fresh from the last observation and the
    // clock at the moment it is asked, so a window that reset a second ago
    // frees the company on the very next wake — the Architect's "if the weekly
    // limit is reset it will march forward".
    pace: () => usageWatch?.verdict().pace ?? 'full',
    ...(home.config.pacing?.slowWakeGapMs === undefined
      ? {}
      : { slowWakeGapMs: home.config.pacing.slowWakeGapMs }),
    onWakeDeferred: (agentId, detail) =>
      reportDegradation(
        `usage/wake-deferred:${agentId}`,
        `${agentId}: wake deferred (${detail.pace}), ${detail.pendingMail} message(s) still waiting${
          Number.isFinite(detail.waitMs) ? ` — ${Math.round(detail.waitMs / 1000)}s to go` : ''
        }`
      ),
    closing: (message) => closingTime?.noteReply(message) ?? false,
    // One address, two filings — the ADR-0008 pattern the Odeon endpoint
    // already uses. The Harbor is one subsystem (everything in and out), and
    // giving incidents and outbound drafts separate reserved ids would put two
    // harness identities where the design has one. Dispatch is on the subject
    // the agent wrote, and an unrecognised one is refused rather than guessed.
    /**
     * A crew member reporting on a scheduled sweep (ADR-0012 triggers).
     *
     * Recorded, not adjudicated: the trigger asked for work, not for a
     * decision. Until this existed the reply bounced, so the sweeps happened
     * and the company never heard the result — the same silence that made the
     * live run's action half so hard to read.
     */
    profiles: (message) => {
      agora?.appendLog({
        kind: 'profile',
        // A sweep that was REFUSED is not a sweep that reported, and the log
        // has to be able to tell them apart. "skipped, the workspace was
        // locked" is the most useful thing a scheduled duty can say, and until
        // the endpoint accepted a `refuse` at all it was the one answer that
        // bounced — so the distinction had never had to exist.
        event: message.act === 'refuse' ? 'sweep-refused' : 'sweep-reported',
        act: message.act,
        agentId: message.from,
        subject: message.subject.slice(0, 200),
        summary: message.body.slice(0, 2000)
      })
      ui.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`sweep report from ${message.from}`)
      return true
    },
    harbor: (message) => {
      if (message.subject === OUTBOUND_SUBJECT) {
        if (frontOffice === null) return false
        void frontOffice.onDraft(message)
        return true
      }
      if (incidents === null) return false
      // A verdict on a root cause is not a triage report and must not be
      // parsed as one. The endpoint answers the sender either way; what this
      // branch decides is WHICH conversation the message belongs to.
      if (message.subject === VERDICT_SUBJECT) {
        incidents.onVerdict(message)
        return true
      }
      incidents.onTriage(message)
      return true
    },
    ledger: (message) => ledger?.submit(message) ?? { ok: false, reasons: ['no ledger endpoint'] },
    // ADR-0008 filing endpoint. One address, three filings: the archive is one
    // subsystem, and giving each artifact its own reserved id would put three
    // harness identities where the design has one.
    odeon: (message) => {
      const archive = odeon
      if (archive === null) {
        return {
          ok: false,
          reasons: ['the odeon endpoint is not available'],
          subject: 'odeon-unavailable',
          body: JSON.stringify({ reasons: ['the odeon endpoint is not available'] })
        }
      }
      // A meeting reply is an `inform`, not a filing: the floor was handed out
      // as a `query` and ADR-0003's table makes the answer an `inform`.
      if (message.act === 'inform') {
        const outcome = meetings?.say(message.from, message.body) ?? {
          kind: 'refused' as const,
          reason: 'no meeting is open'
        }
        return {
          ok: outcome.kind !== 'refused',
          subject: `meeting: ${outcome.kind}`,
          body: JSON.stringify(outcome)
        }
      }
      // The SHIPPED dispatch, in one place, so the scenario rig exercises it
      // rather than a copy of it (the M2 close-out lesson).
      return wireOdeonEndpoint({
        odeon: archive,
        gymnasium,
        stoa,
        briefing,
        prompts: promptStore,
        mayDecide: (request) =>
          artemis?.mayDecide(request) ?? {
            allowed: false as const,
            because: 'no orchestrator is hired'
          },
        triageMemo,
        applyMemoVerdict,
        onQueueChanged: () => ui.send(ODEON_QUEUE_CHANNEL)
      })(message)
    },
    library: (message) => {
      if (!reflection) {
        // Read by an agent, so it is a prompt surface (invariant §8; the M4
        // close-out audit found the literal).
        return {
          ok: false,
          reasons: ['no library endpoint'],
          subject: prompts
            .render(path.join('library', 'unavailable-subject.md'), {})
            .trim()
            .slice(0, 200),
          body: prompts.render(path.join('library', 'unavailable.md'), {}).trim()
        }
      }
      const outcome = reflection.submit(message)
      return { ...outcome, ...reflection.replyText(message.from, outcome) }
    },
    // FR-3.7/ADR-0005: with Artemis hired, `to:"human"` reaches the Architect's
    // proxy rather than piling up in a queue nobody reads. Read per call, so a
    // respawn or a hire mid-run is picked up without restarting the router.
    context: () => ({
      knownAgents: hermes?.knownAgents() ?? [],
      orchestratorId: agora?.registry().orchestratorId ?? null
    }),
    // ADR-0013's second branch, real at last (the M2 carried item): an agent
    // with assigned work keeps going even when its inbox is empty.
    pendingTasksFor: (agentId) => ledger?.pendingFor(agentId) ?? 0,
    ...(envCap.cap === undefined ? {} : { blockCap: envCap.cap }),
    nudge: (agentId, text) => commandQueue.wake(agentId, text),
    /**
     * Whether the router may hand this agent its mail — a DELIVERY-plane fact,
     * deliberately not a floor one.
     *
     * This used to read the avatar phase, and that made a drawing the gate on
     * the company's communication. `avatar.ts`'s `stop` is inert unless the
     * agent was `working` or `thinking`, so any turn that called no tool went
     * `prompt-submitted → alert` and stayed there: never `idle`, never nudged
     * again, for the rest of the process's life. For an orchestrator whose turn
     * is "read the mail, reply" that is the common path, not an edge case, and
     * it is the twenty-minute silence in the 2026-09-01 live run. Only a
     * restart cured it.
     *
     * Both facts here are ones the delivery plane already owns, and — the
     * reason this is a fix rather than a different guess — both are BOUNDED.
     * `WakeClock.ended` closes on `stop` OR `session-end` with no phase guard,
     * and its cap timer force-closes an overrunning wake after
     * `DEFAULT_WAKE_CAP_MS` even when every hook is lost. So `runningMs`
     * returning to null is guaranteed; a phase returning to `idle` never was.
     *
     * The trade is deliberate: a missed `prompt-submitted` now means a nudge
     * arriving while the agent is mid-turn, where the engine queues it. That is
     * strictly better than silence forever, and `nudged` still keeps it to one
     * nudge per pending episode.
     */
    isIdle: (agentId) =>
      canDeliverWake(ptyManager.has(agentId), wakeClock?.runningMs(agentId) ?? null),
    // ADR-0013's pathology signal, emitted and logged from M2 with nothing
    // reading it — the M2 carried item. It now enters the breaker's ladder at
    // rung 1 like any other signal.
    onPathology: (agentId, blocks) => breaker?.notePathology(agentId, blocks),
    onNeedsHuman: ({ message }) =>
      // SDD §9 choke point 2. The message was delivered either way; this puts
      // the decision behind it in front of the Architect (UC-08 step 2).
      chokePoints?.submitNeedsHuman({
        from: message.from,
        subject: message.subject,
        conversation: message.conversation
      }),
    onBounced: ({ original, reason }) =>
      reportDegradation('hermes/bounce', `bounce [${original.id}] to "${original.to}": ${reason}`),
    // Trip signal #3: recurring hop-cap escalations on one conversation. A hop
    // cap is a DIVERT, not a bounce — the M3 close-out audit found the old
    // bounce-side sniff unreachable (no bounce reason mentions hops).
    onDiverted: ({ from, conversation }) => breaker?.noteHopCap(from, conversation),
    onSweepError: (err: unknown) =>
      reportDegradation(
        'hermes/sweep',
        `sweep failed: ${err instanceof Error ? err.message : String(err)}`
      ),
    // The author is told directly (Hermes returns the refusal to whoever wrote
    // the file), so the Architect-facing report exists to catch the case the
    // author CANNOT be told about — the only path by which an agent's work can
    // still end in silence, and therefore the one worth naming out loud
    // (invariant §7).
    onRejected: ({ file, reason, notice }) =>
      reportDegradation(
        'hermes/notice',
        notice
          ? `rejected ${file}: ${reason}`
          : `rejected ${file} with no author to tell: ${reason}`
      )
  })
  hermes.start()

  agentManager = new AgentManager({
    engines,
    hookServer,
    spawner: ptyManager,
    prompts,
    agoraRoot: agora.root,
    // The composed answer the Watch already computes for `tool-permission` —
    // the class that IS the engine's own permission prompt. Adapters turn it
    // into whatever their engine calls "ask me less", which is the only place
    // that prompt can be answered: `evaluateGate` refuses `tool-permission` by
    // construction, because the harness has no action to permit there.
    autonomyFor: (agentId) =>
      activations?.autonomyFor(agentId, 'tool-permission') ??
      loadGatePolicy(gatePolicyPath).policy.autonomy,
    onExitError: (agentId, err) =>
      reportDegradation(
        `agents/teardown:${agentId}`,
        `teardown [${agentId}]: ${err instanceof Error ? err.message : String(err)}`
      ),
    // A ghost that was parked did not crash. Asked rather than inferred from
    // the exit code, because a provider refusal and a crash look identical at
    // the pty seam — and the difference is whether a human needs to do anything.
    capacityParked: (agentId) => capacityWatch?.parked(agentId) !== null,
    rosterBudget: (agentId) => {
      try {
        return agora?.registry().agents[agentId]?.budget?.dailyTokens ?? null
      } catch {
        // A corrupt roster is already a visible degradation elsewhere; an
        // unreadable budget means "unbudgeted", never "unlimited".
        return null
      }
    },
    // ADR-0005 "prompt as policy": Artemis's standing context is text she is
    // handed like any other hire's role brief. The lifecycle never reads it.
    roleBrief: (card) => artemis?.roleBrief(card) ?? null,
    rosterSeats: () => {
      const seats = new Map<string, string>()
      try {
        for (const [agentId, entry] of Object.entries(agora?.registry().agents ?? {})) {
          if (entry) seats.set(agentId, entry.seat)
        }
      } catch {
        // A corrupt roster is a visible degradation elsewhere; seating falls
        // back to this session's own assignments rather than refusing a hire.
      }
      return seats
    },
    // ADR-0006 layer 2: how an agent asks what the company knows. Harness-owned
    // and engine-independent, so every adapter merely forwards it.
    recallCommand: `${process.execPath} ${path.join(appRoot, 'shims', 'eph-recall.mjs')}`,
    ghTokenCommand: `${process.execPath} ${path.join(appRoot, 'shims', 'eph-gh-token.mjs')}`,
    // ADR-0006 layer 1: what an agent remembers reaches its next spawn through
    // the Library, budgeted there rather than by whichever adapter runs it.
    memory: {
      seed: (agentId) => library?.seed(agentId) ?? false,
      layer: (agentId) => library?.layer(agentId) ?? { text: '', facts: { totalSections: 0 } }
    },
    // SDD §10: a dead agent's in-flight work goes back on the board.
    returnTasks: (agentId, because) => ledger?.returnTasksOf(agentId, because) ?? [],
    // UC-01 alternate 2a. Every git call still happens in `git.ts` — this is
    // the narrow slice of it the lifecycle is allowed to ask for (ADR-0004).
    worktrees: {
      pathFor: (agentId) => path.join(home.root, 'worktrees', agentId),
      // ENGINEERING-STANDARDS §2's agent branch convention, minus the `agent.`
      // id prefix so the branch reads `agent/mason` rather than `agent/agent.mason`.
      branchFor: (agentId) => `agent/${agentId.replace(/^agent\./, '')}`,
      create: (plan) => worktrees.create(plan),
      remove: (repo, worktreePath) => worktrees.remove(repo, worktreePath)
    },
    commitIdentity: () => companyGitHub?.gitIdentity() ?? null,
    // The broker answers first: an Architect who stored a GH_TOKEN by hand
    // meant it, and a minted token silently overriding it would make the stored
    // one impossible to test. The App fills the gap rather than taking over.
    resolveGrants: (declared) => {
      const fromBroker = secrets?.grantsFor(declared) ?? { env: {}, missing: [...declared] }
      const minted = companyGitHub?.token() ?? null
      if (minted === null || !fromBroker.missing.includes(GITHUB_TOKEN_GRANT)) return fromBroker
      return {
        env: { ...fromBroker.env, [GITHUB_TOKEN_GRANT]: minted },
        missing: fromBroker.missing.filter((name) => name !== GITHUB_TOKEN_GRANT)
      }
    },
    onGrantsMissing: (agentId, missing) =>
      reportDegradation(
        `secrets/missing-grant:${agentId}`,
        `${agentId} spawned without declared grant(s): ${missing.join(', ')}`
      ),
    onRosterChange: (agentId, entry) => {
      if (!agora) return
      try {
        const registry = agora.registry()
        const agents = { ...registry.agents }
        if (entry) agents[agentId] = entry
        else delete agents[agentId]
        agora.writeRegistry({ ...registry, agents })
        agora.commitSoon(`roster: ${agentId}`)
      } catch (err) {
        // A corrupt registry refuses overwrite (evidence preservation); the
        // company keeps running and the refusal is a visible degradation.
        reportDegradation(
          `agora/roster:${agentId}`,
          `roster update for ${agentId} refused: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
      // Durability is a commit, and it is queued rather than awaited: delivery
      // latency must never wait on git (ADR-0004).
      agora?.commitSoon(`log ${draft.kind} for ${String(draft['agentId'] ?? 'agent')}`)
    },
    onChange: (card: AgentCard) => {
      ui.send(AGENTS_STATE_CHANNEL, card)
      // FR-5.4: the orchestrator is brought back when it dies. Driven off the
      // same card stream the UI reads, so nothing else has to agree about who
      // is running.
      artemis?.noteCard(card)
      if (card.lifecycle === 'exited') {
        // A respawn starts at rung 0 with no span history.
        breaker?.forget(card.agentId)
        // One last fold BEFORE the session is forgotten: usage written in the
        // seconds between the final tick and the exit would otherwise never be
        // folded, and this spawn is never `running` under that session again.
        // Under-reporting is the ledger's one unforgivable failure.
        const spawn = agentManager?.spawnOf(card.agentId)
        const finalFold = spawn && budgetWatcher ? budgetWatcher.foldNow(spawn) : Promise.resolve()
        void finalFold
          .catch((err: unknown) =>
            reportDegradation(
              `budgets/final-fold:${card.agentId}`,
              `final fold for ${card.agentId} failed: ${err instanceof Error ? err.message : String(err)}`
            )
          )
          .finally(() => {
            costLedger?.clearSession(card.agentId)
            budgetWatcher?.forget(card.agentId)
            // NOT `capacityWatch.forget` — deliberately. An exit during a park
            // is a parked agent whose process died, and it is still owed a
            // continuation when capacity returns (`onResume` then takes the
            // respawn path). Forgetting here is how the agent would be lost.
          })
      }
      if (card.lifecycle === 'running' && !avatarDirector.get(card.agentId)) {
        avatarDirector.add(card.agentId)
        hermes?.ensureMailbox(card.agentId)
        hermes?.watch(card.agentId)
        // A respawn starts its Stop-hook block budget over (ADR-0013 guard 2).
        hermes?.resetSession(card.agentId)
      }
    }
  })

  ptyManager.onExit((id) => avatarDirector.handleExit(id))
  avatarDirector.start()

  // Spend is folded on a timer, not per hook: it is not a real-time quantity,
  // and a fold per tool call would re-read every transcript dozens of times a
  // Profile activation (ADR-0012, FR-9.4, M7.2). Built after the AgentManager
  // because it spawns through it, and after the scheduler because it arms
  // triggers on it. Every judgment it makes — the plan, the composed autonomy —
  // is `activationPlan`'s and was shown to the Architect before this ran.
  activations = new ProfileActivations({
    store: profiles,
    globalAutonomy: () => loadGatePolicy(gatePolicyPath).policy.autonomy,
    spawn: (request) => {
      if (agentManager === null) return Promise.reject(new Error('agents: not started'))
      return agentManager.spawn(request)
    },
    kill: (agentId) => agentManager?.kill(agentId),
    addTrigger: (trigger) => scheduler.add(trigger),
    removeTrigger: (triggerId) => scheduler.remove(triggerId),
    targetExists: (target) => {
      try {
        return statSync(target).isDirectory()
      } catch {
        return false
      }
    },
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`profile ${String(draft['event'] ?? 'event')}`)
    },
    onTriggerFired: (instanceId, triggerId, agentId, playbook) => {
      // SDD §7.5's first arrow: a profile trigger becomes work for the agent
      // it names. The playbook is handed over as a REFERENCE — the harness
      // never reads a runbook and never summarizes one (ADR-0005, ADR-0012).
      agora?.appendLog({
        kind: 'profile',
        event: 'trigger-fired',
        instanceId,
        triggerId,
        agentId,
        playbook
      })
      ui.send(LOG_APPEND_CHANNEL)

      // …and the agent is actually told. Logging the fire and stopping there
      // would leave the health watcher and the dependency updater spawned and
      // never asked for anything — two of FR-9.2's four components inert
      // behind a green suite, which is the one failure mode this build has
      // already paid for once.
      const instance = activations
        ?.instances()
        .find((candidate) => candidate.instanceId === instanceId)
      hermes?.deliverFromHarness(
        triggerWakeMessage(
          {
            instanceId,
            triggerId,
            agentId,
            playbook,
            profile: instance?.plan.profile ?? instanceId,
            targetPath: instance?.plan.targetPath ?? ''
          },
          (kind, vars) => prompts.render(path.join('profiles', `trigger-${kind}.md`), vars),
          new Date()
        )
      )
    }
  })

  harbor = new GitHubHarbor({
    repos: () => [
      ...new Set((activations?.instances() ?? []).flatMap((instance) => instance.plan.repos))
    ],
    onLogEvent: (draft) => {
      // FR-10.3: every inbound item lands in `log.jsonl` tagged `remote`.
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
    },
    onDegraded: (what) => reportDegradation('harbor/ingest', what)
  })
  // The probe first (ADR-0009's subprocess discipline): until `gh` answers,
  // the Harbor reports itself unavailable rather than returning empty queues
  // that would read as "nothing to do".
  void harbor.probe().then(() => harbor?.ingest())
  scheduler.add({
    id: 'harbor-github',
    everyMs: HARBOR_INGEST_EVERY_MS,
    // Only when something is actually watching a repository. An ingestion
    // cadence that ran against an empty list would still shell out to `gh`
    // every ten minutes for nothing.
    enabled: () => (activations?.instances() ?? []).some((i) => i.plan.repos.length > 0),
    run: async () => {
      const view = await harbor?.ingest()
      if (view === undefined) return
      // UC-09 step 1, wired: what came in through the port becomes an incident
      // for whoever is on call for that repository. Only repositories that
      // actually ANSWERED — `ingest` deliberately keeps a failed repo's stale
      // queue rather than blanking it (so a blind repo and an idle one do not
      // look alike), and re-raising yesterday's items because `gh` is down
      // would wake the crew for news that is not new.
      incidents?.raise(view.repos.filter((row) => row.failure === null).flatMap((row) => row.items))
    }
  })

  // minute for a figure nobody reads that often (SDD §11).
  budgetWatcher = new BudgetWatcher({
    ledger: costLedger,
    agents: () =>
      (agentManager?.liveSpawns() ?? []).map((spawn) =>
        // Rung 2's tightened envelope (ADR-0011): a constrained agent runs on
        // half its daily budget until the breaker recovers it.
        constrainedBudgets.has(spawn.agentId) && spawn.dailyTokens !== null
          ? { ...spawn, dailyTokens: Math.floor(spawn.dailyTokens * CONSTRAINED_BUDGET_FACTOR) }
          : spawn
      ),
    onBudgetChange: (agentId, verdict) => {
      // Only transitions reach the book of record; a breached agent must not
      // turn log.jsonl into a metronome (SDD §4.3 kind `budget`).
      agora?.appendLog({
        kind: 'budget',
        agentId,
        state: verdict.state,
        spent: verdict.spent,
        remaining: verdict.remaining,
        projected: verdict.projected,
        because: verdict.because
      })
      ui.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`budget ${verdict.state} for ${agentId}`)
      if (verdict.state !== 'ok') {
        reportDegradation(
          `budgets/state:${agentId}`,
          `${agentId} budget ${verdict.state} (${verdict.because})`
        )
      }
      // Trip signal #4 (ADR-0011): the budget feeds the breaker, and the
      // breaker IS the enforcement — steer, then constrain (which halves the
      // remaining budget), then stop, whose terminus the ADR gives as "Artemis
      // decides reassignment".
      //
      // A breach no longer also opens a gate, and that is a correction rather
      // than a loosening. ADR-0011 never specified one: the gate came from
      // FR-11.1's "spend above threshold", whose threshold is the POLICY's
      // `maxSpendTokens` — wiring a hire's `dailyTokens` to it conflated two
      // different numbers. And the gate never stopped any spending: it
      // discarded `submit()`'s answer, so it moved an avatar and interrupted a
      // human while the agent carried on regardless. On the live run it fired
      // for all three crew inside a minute, which is a limit behaving as a
      // notification.
      breaker?.evaluate(agentId)
    },
    onDegraded: (detail) => reportDegradation('budgets/watch', detail)
  })
  budgetWatcher.start()

  // Provider capacity (`watch/capacity.ts`). Built beside the budget watcher
  // and deliberately NOT inside it: they read the same transcripts to answer
  // opposite questions, and this one must keep answering while a parked agent's
  // spend has stopped changing.
  //
  // Nothing here kills, ghosts, or restarts on a refusal. A usage limit is a
  // normal event in the life of a company meant to run for days — the correct
  // response is to stop asking, say so where the Architect can see it, and come
  // back. Every act below is one of those three.
  /**
   * The continuation an agent reads when capacity returns (invariant §8: the
   * words are a file the Architect can edit, never a literal here).
   *
   * Returns null when the template will not read, and the caller then continues
   * NOTHING rather than inventing a sentence. A resume prompt the harness made
   * up is a resume prompt nobody reviewed, and this one tells an agent what to
   * do with half-finished work.
   */
  const capacityResumeText = (detail: string): string | null => {
    try {
      return prompts.render(path.join('watch', 'capacity-resume.md'), { detail }).trim()
    } catch (err) {
      reportDegradation(
        'capacity/resume-prompt',
        'the capacity resume prompt is unreadable, so no agent will be continued: ' +
          `${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  }

  capacityWatch = new CapacityWatch({
    agents: () => agentManager?.liveSpawns() ?? [],
    alive: (agentId) => ptyManager.has(agentId),
    onPark: (row) => {
      agora?.appendLog({
        kind: 'capacity',
        event: 'parked',
        agentId: row.agentId,
        limitKind: row.limit.kind,
        // The engine's own sentence, verbatim: "out of usage credits" and "rate
        // limited" want different things from a human, and a harness that
        // paraphrased them would erase that difference.
        detail: row.limit.detail,
        recordId: row.limit.recordId,
        sessionId: row.limit.sessionId,
        at: row.limit.at,
        resetsAt: row.limit.resetsAt,
        attempts: row.attempts,
        retryAt: row.retryAt,
        processAlive: row.processAlive
      })
      ui.send(LOG_APPEND_CHANNEL)
      ui.send(CAPACITY_STATE_CHANNEL)
      agora?.commitSoon(`capacity parked ${row.agentId}`)
      // Invariant §7. A pause nobody can see is the failure mode this whole
      // system is built against, so it goes to the degradation banner as well
      // as to the strip.
      reportDegradation(
        `capacity/parked:${row.agentId}`,
        `${row.agentId} is waiting for provider capacity — ${row.limit.detail}`
      )
      // Mail stops rather than piling into a session that cannot answer it. It
      // is a pause, not a discard: the mailbox keeps everything and Hermes
      // resumes delivering when the park clears.
      hermes?.setPaused(row.agentId, true)
      // FR-5.4's ladder counts crashes and ends. A refusal is not a crash, and
      // restarting into one cannot succeed — every rung it burned would be a
      // rung missing for the real crash later.
      artemis?.holdForCapacity()
    },
    onResume: (row) => {
      const text = capacityResumeText(row.limit.detail)
      agora?.appendLog({
        kind: 'capacity',
        event: 'resuming',
        agentId: row.agentId,
        attempts: row.attempts,
        // Which of the two continuations ran. They are not equivalent and the
        // book of record must not imply they are: one carries the live
        // conversation, the other carries the engine session it was resumed
        // onto (ADR-0009 `resume`).
        via: row.processAlive ? 'live-session' : 'respawn',
        waitedMs: Date.parse(row.retryAt) - Date.parse(row.since),
        recordId: row.limit.recordId
      })
      ui.send(LOG_APPEND_CHANNEL)
      ui.send(CAPACITY_STATE_CHANNEL)
      agora?.commitSoon(`capacity resume ${row.agentId}`)
      hermes?.setPaused(row.agentId, false)
      if (row.processAlive) {
        // The process never died, so there is nothing to restart: the agent is
        // talked to, in the conversation it was already having. This is the
        // strongest form of "continue where you left off" available — no new
        // session, no re-injected identity, no lost context.
        if (text === null) return
        try {
          commandQueue.submit(row.agentId, text)
        } catch (err) {
          reportDegradation(
            `capacity/continue:${row.agentId}`,
            `could not continue ${row.agentId}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        return
      }
      // The process did not survive the wait. Now — and only now — the existing
      // resume path runs: `--resume <sessionId>` through `AgentManager.respawn`
      // (ADR-0009 `ResumeSupport`), the same machinery crash recovery uses.
      void (async (): Promise<void> => {
        try {
          await agentManager?.respawn(row.agentId)
          // The continuation follows the respawn rather than riding it: the
          // engine session carries what the agent was doing, and this says what
          // to do about it. Held by the command queue until the fresh session
          // reports idle, which is exactly when it can be read.
          if (text !== null) commandQueue.submit(row.agentId, text)
        } catch (err) {
          reportDegradation(
            `capacity/respawn:${row.agentId}`,
            `could not respawn ${row.agentId} after capacity returned: ` +
              `${err instanceof Error ? err.message : String(err)}`
          )
        }
      })()
    },
    onClear: (row) => {
      agora?.appendLog({
        kind: 'capacity',
        event: 'cleared',
        agentId: row.agentId,
        attempts: row.attempts,
        since: row.since,
        recordId: row.limit.recordId
      })
      ui.send(LOG_APPEND_CHANNEL)
      ui.send(CAPACITY_STATE_CHANNEL)
      agora?.commitSoon(`capacity cleared ${row.agentId}`)
      hermes?.setPaused(row.agentId, false)
      // The ladder is only released once NOBODY is parked: releasing it while
      // another agent is still refused would let the next exit spend a rung on
      // the same limit this hold exists to absorb.
      if (capacityWatch && !capacityWatch.anyParked()) artemis?.releaseForCapacity()
    },
    onDegraded: (detail) => reportDegradation('capacity/watch', detail)
  })
  capacityWatch.start()

  // FR-5.1/5.4: Artemis is hired like any other agent — this module owns her
  // lifecycle and nothing about what she decides (ADR-0005).
  artemis = new Artemis({
    agents: agentManager,
    prompts,
    home: home.root,
    // She runs in the Agora, because `board.md` is hers to scribe (SDD §2).
    cwd: agora.root,
    setOrchestrator: (agentId) => {
      try {
        const registry = agora?.registry()
        if (registry) agora?.writeRegistry({ ...registry, orchestratorId: agentId })
        agora?.commitSoon(`roster: orchestrator ${agentId ?? 'cleared'}`)
      } catch (err) {
        reportDegradation(
          'agora/orchestrator-id',
          `orchestrator id not recorded: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      ui.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`log ${draft.kind} ${String(draft['event'] ?? '')}`)
    },
    onDegraded: (detail) => reportDegradation('artemis/driver', detail)
  })

  registerIpc({
    ptyManager,
    agents: agentManager,
    avatars: avatarDirector,
    commands: commandQueue,
    agora,
    secrets,
    gates,
    humanQueue: () => hermes?.humanQueue() ?? [],
    dismissFromHumanQueue: (messageId) => hermes?.dismissFromHumanQueue(messageId) ?? false,
    capacity: () => capacityWatch?.view() ?? { parked: [], since: null, retryAt: null },
    breakerState: () =>
      (agentManager?.list() ?? [])
        .filter((card) => card.lifecycle !== 'exited')
        .map((card) => breaker?.stateFor(card.agentId))
        .filter((state): state is NonNullable<typeof state> => state !== undefined),
    // Exited agents are INCLUDED: their cumulative figure is precisely what the
    // durable ledger exists to preserve, and hiding it behind a liveness filter
    // would put it out of reach of the only IPC that can show it (FR-11.2).
    // ADR-0023: the pace and the window behind it, computed fresh at call time
    // exactly as the ledger's figures are — the renderer polls, so a snapshot
    // held anywhere would just be a staler copy of this.
    usage: () => ({
      verdict: usageWatch?.verdict() ?? {
        pace: 'full' as const,
        because: 'unobserved' as const,
        tightest: null,
        resetsAt: null,
        windows: []
      },
      observed: usageWatch?.observed() ?? null,
      at: Date.now()
    }),
    budgets: () =>
      (agentManager?.list() ?? [])
        .map((card) =>
          costLedger?.spendFor(
            card.agentId,
            card.dailyTokens,
            engines.get(card.engine).transcripts ? 'engine' : 'none'
          )
        )
        .filter((spend): spend is NonNullable<typeof spend> => spend !== undefined),
    pendingMailFor,
    hooksState: (): HooksState => ({
      endpoint: hookServer.endpoint(),
      driftWarnings: hookServer.driftWarnings(),
      failure: hookFailure
    }),
    agoraHealth: (): AgoraHealth => ({
      fileWarnings: agora?.fileWarnings() ?? [],
      commitFailures: agora?.commitFailures() ?? [],
      runtime: degradations.list().map((entry) => ({
        at: entry.lastSeen,
        source: entry.source,
        detail: entry.detail,
        cause: entry.cause,
        count: entry.count,
        since: entry.since,
        freshness: entry.freshness
      }))
    }),
    // The Library's surface (ADR-0006). The renderer is a projection: it gets
    // these views and every write goes back through main (invariant §2).
    memoryView: (agentId) =>
      library?.memoryView(agentId) ?? {
        agentId,
        path: '',
        text: '',
        sections: 0,
        archive: [],
        reflection: { due: false, because: 'the Library is not available', chars: 0 }
      },
    recall: async (query, scope, limit) =>
      library
        ? library.recall(query, scope, limit)
        : {
            schemaVersion: RECALL_SCHEMA_VERSION,
            query,
            rung: 'grep' as const,
            hits: [],
            degraded: 'the Library is not available'
          },
    knowledge: () => library?.knowledge() ?? [],
    briefs: () => odeon?.briefs() ?? [],
    gymLedger: () =>
      (gymnasium?.rows() ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        metric: row.metric,
        proposedAt: row.proposedAt,
        decidedAt: row.decidedAt,
        outcome: row.outcome
      })),
    gymProposal: (id) => gymnasium?.proposalDoc(id) ?? null,
    // FR-12.3 / R1: `architect` is supplied HERE, by main, because a call on
    // the window bridge is the Architect with certainty. The renderer never
    // names a decider, so there is nothing for it to claim.
    gymVerdict: (id, verdict) =>
      gymnasium?.verdict(id, verdict, 'architect') ?? {
        ok: false,
        reason: 'the gymnasium is not available'
      },
    gymMetricResult: (id, measured) =>
      gymnasium?.measure(id, measured) ?? { ok: false, reason: 'the gymnasium is not available' },
    gymMode: () => {
      const gate = modes?.gate() ?? { met: false, missing: ['the mode driver is not available'] }
      return {
        mode: modes?.mode() ?? 'directed',
        gateMet: gate.met,
        missing: [...gate.missing],
        everEnabled: getHome().config.everEnabledImproving ?? false
      }
    },
    // FR-14.2 / R1 again: `architect` is supplied HERE, by main. This is the
    // switch that decides whether the company acts without being asked, so the
    // renderer names no actor and there is nothing for it to claim.
    gymSetMode: (mode) =>
      modes?.setMode(mode, 'architect') ?? {
        ok: false,
        reason: 'the mode driver is not available',
        missing: []
      },
    stoaWatchlist: () => {
      const list = stoa?.watchlist() ?? { sources: [], retired: [] }
      // Field-picked, not spread: the response is the VIEW type and nothing
      // more — a spread leaked `registeredBy`, a field the projection does not
      // declare (M5b close-out audit, finding 13; the projection and the type
      // must agree even when the leak is harmless).
      const view = (
        entry: (typeof list.sources)[number],
        over: { retired: boolean; blocked: string | null }
      ): SourceView => ({
        id: entry.id,
        url: entry.url,
        kind: entry.kind,
        tags: [...entry.tags],
        license: entry.license,
        pin: entry.pin,
        registeredAt: entry.registeredAt,
        notes: entry.notes,
        retired: over.retired,
        blocked: over.blocked,
        intakeBlocked: checkIntake(entry).allowed ? null : checkIntake(entry).because
      })
      // Retired rows are listed too, marked — the desk shows a struck-through
      // row rather than a hole where a source used to be (FR-13.1's habit).
      return [
        ...list.sources.map((entry) =>
          view(entry, {
            retired: false,
            blocked: checkStudiable(entry).allowed ? null : checkStudiable(entry).because
          })
        ),
        ...list.retired.map((entry) =>
          view(entry, { retired: true, blocked: 'retired from the watchlist' })
        )
      ]
    },
    // FR-13.1 / R1: `architect` is supplied HERE, by main, because a call on
    // the window bridge is the Architect with certainty. The renderer never
    // names a registrar, so there is nothing for it to claim.
    stoaRegister: (draft) =>
      stoa?.register({ ...draft, tags: [...draft.tags] }, 'architect') ?? {
        ok: false,
        reason: 'the stoa is not available'
      },
    stoaRetire: (id) =>
      stoa?.retire(id, 'architect') ?? { ok: false, reason: 'the stoa is not available' },
    stoaBriefs: () => (stoa?.briefs() ?? []).map((row) => ({ ...row })),
    stoaBrief: (id) => stoa?.brief(id) ?? null,
    profilesList: () => profiles.list(),
    profilesInspect: (name) => profiles.load(name),
    // `activations` is built in boot() before IPC is registered; the fallbacks
    // are what a caller gets if that order ever changes — a refusal that names
    // the reason, never a silent success or a crash mid-activation.
    profilesPreview: (request) =>
      activations?.preview(request) ?? { ok: false, reasons: ['profiles: not started'] },
    // Remembered on success only: a chip that reproduces the Architect's own
    // failed attempt is worse than an empty form.
    profilesActivate: async (request) => {
      // ADR-0021: the Architect's activation is the consent, and it is recorded
      // in the engine's own trust store BEFORE the crew is hired — the prompt it
      // answers appears before any session begins, so an agent that meets it has
      // no hook to report with and simply parks forever. Logged either way:
      // pre-trusting must never be a thing that happened quietly.
      for (const adapter of engines.list()) {
        if (!adapter.trustWorkspace) continue
        const trusted = adapter.trustWorkspace(request.target.path)
        agora?.appendLog({
          kind: 'profile',
          event: 'workspace-trusted',
          engine: adapter.id,
          target: targetRef(request.target),
          ...(trusted.ok
            ? { granted: !trusted.alreadyTrusted, path: trusted.path }
            : { granted: false, because: trusted.because })
        })
        if (!trusted.ok) {
          reportDegradation(
            `profiles/workspace-trust:${adapter.id}`,
            `${adapter.id}: workspace not trusted — ${trusted.because}`
          )
        }
      }
      const result = await (activations?.activate(request) ??
        Promise.resolve({ ok: false as const, reasons: ['profiles: not started'] }))
      if (result.ok) {
        try {
          knownTargets?.remember(request, new Date().toISOString())
        } catch (err) {
          // The activation succeeded; failing to write a convenience list must
          // not turn that into a refusal the Architect has to reason about.
          reportDegradation(
            'profiles/known-targets-write',
            `known-targets.json not written: ${
              err instanceof Error ? err.message.split('\n')[0] : String(err)
            }`
          )
        }
      }
      return result
    },
    profilesDeactivate: (instanceId) =>
      activations?.deactivate(instanceId) ?? { ok: false, reason: 'profiles: not started' },
    profilesInstances: () => activations?.instances() ?? [],
    harborRepos: () =>
      harbor?.view() ?? {
        schemaVersion: HARBOR_SCHEMA_VERSION,
        ghVersion: null,
        unavailable: 'the Harbor has not started',
        repos: []
      },
    // Sharing (FR-10.4 — M7.6). `inspect` writes nothing; `install` writes
    // files and does NOT activate — an imported profile is inert until the
    // Architect activates it through `profiles:activate`.
    harborHireExport: (profile, hire) =>
      exchange?.exportHire(profile, hire) ?? { ok: false, reason: 'no profile store' },
    harborProfileExport: (name) =>
      exchange?.exportProfile(name) ?? { ok: false, reason: 'no profile store' },
    harborImportInspect: (blob) => {
      const inspected = exchange?.inspect(blob)
      if (inspected === undefined) return { ok: false, reasons: ['no profile store'] }
      if (!inspected.ok) return { ok: false, reasons: inspected.reasons }
      return {
        ok: true,
        kind: inspected.manifest.kind,
        // The RECOMPUTED manifest, never the one the envelope carried: what
        // the Architect confirms against has to be derived from the payload.
        manifest: inspected.manifest,
        replaces: inspected.replaces
      }
    },
    harborImportInstall: (blob) => {
      const result = exchange?.install(blob)
      if (result === undefined) return { ok: false, reasons: ['no profile store'] }
      if (result.ok) {
        agora?.appendLog({
          kind: 'profile',
          event: 'imported',
          profile: result.name,
          replaced: result.replaced
        })
        ui.send(LOG_APPEND_CHANNEL)
      }
      return result
    },
    orgChart: () => (org === null || agora === null ? [] : orgChartOf(agora.registry())),
    orgMetrics: () => {
      const report = org?.report() ?? {
        metrics: [],
        findings: [],
        window: { fromSeq: 0, toSeq: 0 }
      }
      return {
        metrics: report.metrics.map((row) => ({ ...row })),
        findings: report.findings.map((row) => ({ what: row.what, refs: [...row.refs] }))
      }
    },
    retros: () => (org?.retros() ?? []).map((row) => ({ ...row })),
    generateRetro: () => org?.generate() ?? { ok: false, reason: 'the org layer is not available' },
    convene: (attendees, agenda) =>
      meetings?.convene({ attendees: [...attendees], agenda }) ?? {
        ok: false,
        reason: 'the odeon is not available'
      },
    meeting: () => {
      const state = meetings?.current() ?? null
      return state === null
        ? null
        : {
            id: state.id,
            agenda: state.agenda,
            attendees: [...state.attendees],
            floor: state.floor,
            transcript: state.transcript.map((turn) => ({ ...turn })),
            held: state.held.map((turn) => ({ ...turn })),
            status: state.status
          }
    },
    meetingSay: (text, to) =>
      meetings?.interject(text, to) ?? { kind: 'refused', reason: 'the odeon is not available' },
    meetingClose: (actions) =>
      meetings?.close(actions) ?? { ok: false, reason: 'the odeon is not available' },
    decks: () => odeon?.decks() ?? [],
    memos: (queue) =>
      (odeon?.memos(queue) ?? []).map((row) => ({
        memoId: row.memoId,
        markdown: row.markdown,
        decided: row.verdict !== null,
        verdict: row.verdict?.verdict ?? null,
        decidedBy: row.verdict?.decidedBy ?? null,
        countersigned: row.verdict?.countersigned ?? false
      })),
    decideMemo: (memoId, verdict, notes) => {
      // UC-06 step 4, the Architect bench. Architect-only by construction:
      // this arrives on the window bridge, which main knows IS the Architect —
      // nothing here takes a claimed identity from the caller.
      const archive = odeon
      if (archive === null) return { ok: false, reason: 'the odeon is not available' }
      const settled = archive.decideMemo({
        memoId,
        verdict,
        notes,
        decider: { kind: 'architect' }
      })
      if (!settled.ok) return settled
      applyMemoVerdict({
        gateId: settled.gateId,
        gateVerdict: settled.gateVerdict,
        verdict,
        memoId,
        notes,
        decidedBy: 'architect'
      })
      ui.send(ODEON_QUEUE_CHANNEL)
      return { ok: true, gateVerdict: settled.gateVerdict }
    },
    commentOnDeck: (ref, text) => {
      const outcome = odeon?.comment(ref, text, agora?.registry().orchestratorId ?? null) ?? {
        queued: false as const,
        because: 'the odeon is not available'
      }
      if (outcome.queued && outcome.message) hermes?.deliverFromHarness(outcome.message)
      return outcome.queued ? { queued: true, to: outcome.to } : outcome
    },
    deck: (ref) => odeon?.read(ref) ?? null,
    registerKnowledge: (name, text) => {
      if (!library) throw new Error('knowledge: the Library is not available')
      library.registerKnowledge(name, text)
      // ADR-0004: the Library wrote the file, the ONE committer commits it.
      // Queued, never awaited — the panel must never wait on git.
      agora?.commitSoon(`knowledge: ${name}`)
      return library.knowledge()
    }
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Last, and not awaited: a company whose orchestrator is slow to start is
  // still a usable company, and her failure is a degradation rather than a
  // boot error (FR-5.4).
  // The engine she is hired on is the registry's first registered adapter, so
  // adding one never leaves this line naming an engine that is not there.
  const orchestratorEngine = engines.list()[0]?.id
  if (orchestratorEngine) void artemis.start(orchestratorEngine)
  else reportDegradation('artemis/not-hired', 'no engine adapter registered; not hired')
}

/**
 * The quit sequence (M8.1, GYM-003, SDD §612).
 *
 * The order and the isolation live in `shutdown.ts`, where a test can drive
 * them. What is decided here is only what belongs to Electron: how the
 * Architect is asked, who counts as still working, and what has to stop.
 */
const quit = new QuitSequence({
  // Production's own answer to "who must pack up": the cards the lifecycle says
  // are running. A scenario may substitute this — it is the one leaf a rig
  // legitimately owns — but never the sequence around it.
  liveAgents: () =>
    agentManager
      ?.list()
      .filter((card) => card.lifecycle === 'running')
      .map((card) => card.agentId) ?? [],
  /**
   * Offered, never forced (SDD §612). The dialog copy is UI chrome rather than
   * an LLM prompt surface, so it may live in code — invariant §8 is about
   * LLM-facing prose. Asked asynchronously so the main thread keeps painting
   * while the Architect decides.
   */
  ask: async (live) => {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Ephesus',
      message: `${String(live.length)} agent(s) are still working.`,
      detail:
        'Closing time asks each agent to park its work and write down where it ' +
        'stopped before the floor shuts down. Quit now skips that.',
      buttons: ['Closing time', 'Quit now'],
      defaultId: 0,
      cancelId: 1
    })
    return response === 0 ? 'closing' : 'now'
  },
  closing: () => closingTime,
  agents: () => agentManager,
  steps: () => [
    { name: 'avatars', run: () => avatarDirector.stop() },
    { name: 'hermes', run: () => hermes?.stop() },
    { name: 'scheduler', run: () => scheduler.stop() },
    {
      name: 'company-token',
      run: () => {
        if (companyTokenTimer !== null) {
          clearInterval(companyTokenTimer)
          companyTokenTimer = null
        }
      }
    },
    { name: 'budgets', run: () => budgetWatcher?.stop() },
    { name: 'capacity', run: () => capacityWatch?.stop() },
    { name: 'usage', run: () => usageWatch?.stop() },
    { name: 'wake-clock', run: () => wakeClock?.stop() },
    // The PTYs die only after the unwind above has restored every settings file
    // the harness wrote into somebody's repository (ADR-0009).
    { name: 'ptys', run: () => ptyManager.killAll() },
    { name: 'hooks', run: () => hookServer.stop() },
    // Last, in this order: a commit still in flight is a record the book has not
    // got yet (ADR-0004), and the database has to outlive the drain.
    { name: 'agora-drain', run: () => agora?.drained() },
    { name: 'db', run: () => db?.close() }
  ],
  onDegraded: reportDegradation
})

/**
 * Every quit gesture runs the sequence, exactly once (Architect decision,
 * 2026-09-03; SDD §612 amended with it).
 *
 * Before M8.1 the only handler was `window-all-closed`, so menu Quit, Cmd-Q and
 * a taskbar close skipped closing time altogether and killed the agents
 * mid-thought — and on macOS that handler tore the company down while leaving
 * the app alive, so `activate` re-opened a window onto a dead company. Now the
 * window is just a window: closing the last one quits (off macOS), quitting
 * runs the sequence, and the sequence decides when the app may go.
 */
app.on('before-quit', (event) => {
  // The quit that ENDS the sequence is the one that is allowed through.
  if (quit.hasFinished()) return
  event.preventDefault()
  // A second gesture while it is running must not cut closing time short; the
  // protocol's own deadline is what bounds the wait (GYM-003).
  if (quit.hasStarted()) return
  void quit
    .run()
    .then((report) => {
      console.log(`quit: ${summarizeQuit(report)}`)
    })
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  // macOS keeps the company running with no window on screen, and `activate`
  // re-attaches the bridge to the new one. Everywhere else, closing the last
  // window means quit — which routes through `before-quit` rather than tearing
  // anything down here.
  if (process.platform !== 'darwin') app.quit()
})

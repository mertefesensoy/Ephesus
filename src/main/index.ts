import path from 'node:path'
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
  LOG_APPEND_CHANNEL,
  ODEON_QUEUE_CHANNEL,
  TASKS_STATE_CHANNEL,
  type AgoraHealth,
  type HooksState
} from '../shared/ipc'
import { sanitizeBounds } from '../shared/window-state'
import { AgentManager } from './agents'
import { Artemis } from './artemis'
import { ExecGitRunner, Worktrees } from './git'
import { randomBytes } from 'node:crypto'
import { composeMessage, makeMessageId } from '../shared/message'
import { ODEON_ENDPOINT } from '../shared/reserved'
import type { OpenGate } from '../shared/gates'
import { BriefingJob, STANDUP_EVERY_MS } from './briefing'
import { MeetingDriver } from './meeting'
import { Gymnasium } from './gymnasium'
import { Stoa } from './stoa'
import { checkIntake, checkStudiable } from '../shared/stoa'
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
import { CommandQueue } from './commands'
import { Hermes } from './hermes'
import { initHome } from './config'
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
import { safeStorageCipher } from './watch/cipher'
import { GateManager, loadGatePolicy, wireGateChokePoints } from './watch/gates'
import { CostLedger } from './watch/ledger'
import { SecretBroker } from './watch/secrets'
import { SteerNotes } from './watch/steer-notes'

let secrets: SecretBroker | null = null
let costLedger: CostLedger | null = null
let budgetWatcher: BudgetWatcher | null = null
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
      'scheduler',
      `${triggerId} failed: ${err instanceof Error ? err.message : String(err)}`
    )
})
let hermes: Hermes | null = null
let closingTime: ClosingTime | null = null
/** Set once the quit path has offered (or skipped) closing time. */
let closingOffered = false
let mainWindow: BrowserWindow | null = null
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

const RUNTIME_HEALTH_LIMIT = 50
const runtimeHealth: { at: number; source: string; detail: string }[] = []
function reportDegradation(source: string, detail: string): void {
  console.warn(`${source}: ${detail}`)
  runtimeHealth.push({ at: Date.now(), source, detail })
  if (runtimeHealth.length > RUNTIME_HEALTH_LIMIT) runtimeHealth.shift()
}

/**
 * The floor's only source of motion (ADR-0002). It is constructed before the
 * hook server has a chance to deliver anything, so no event can arrive with
 * nowhere to go.
 */
const commandQueue = new CommandQueue({
  sink: { write: (agentId, data) => ptyManager.write(agentId, data) },
  onChange: (state: CommandState) => mainWindow?.webContents.send(COMMANDS_STATE_CHANNEL, state)
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
    mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
    agora?.commitSoon(`breaker steer for ${agentId}`)
  }
})

const avatarDirector = new AvatarDirector({
  // The floor and the autonomy loop read the SAME fact about pending work, so
  // they can never disagree about whether an agent is done (ADR-0013).
  hasPendingWork: (agentId: string) => (hermes?.pendingMailCount(agentId) ? true : false),
  onChange: (agentId: string, snapshot: AvatarSnapshot) => {
    mainWindow?.webContents.send(AVATARS_STATE_CHANNEL, { agentId, snapshot })
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
        reportDegradation('gates', `${envelope.agentId} is waiting on a human decision`)
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
  onEventError: (err) =>
    reportDegradation(
      'hooks',
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
    mainWindow?.webContents.send(ODEON_QUEUE_CHANNEL)
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

  mainWindow = win
  ptyManager.attachSink(win.webContents)

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
  db.onUnreadableRow = (detail) => reportDegradation('ledger', detail)
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
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
    },
    onDegraded: (detail) => reportDegradation('secrets', detail)
  })

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
    reportDegradation('settings', `sweep could not restore ${failure.path}: ${failure.reason}`)
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
      reportDegradation('agora', `gave up committing "${failure.subject}": ${failure.reason}`)
  })
  await agora.ensureRepo()
  const reconciled = await agora.reconcile()
  if (reconciled.sha) console.info(`agora reconciled at ${reconciled.sha.slice(0, 8)}`)

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
        if (loaded.warning) reportDegradation('gates', loaded.warning)
      }
      return loaded.policy
    },
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`gate ${String(draft['event'] ?? 'event')}`)
    },
    onOpen: (gate) => {
      // The id, not the gate: this channel is a nudge and the panel re-reads
      // `watch:approvals`. Sending the whole gate would make it a second copy
      // of the queue that could disagree with main.
      mainWindow?.webContents.send(GATE_OPEN_CHANNEL, gate.id)
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
    onSettled: (gate) => {
      // Only when the LAST gate on that agent clears: an agent held behind two
      // gates must not walk back to its desk after the first verdict.
      if (!gates?.isBlocked(gate.agentId)) {
        avatarDirector.apply(gate.agentId, { kind: 'gate-verdict' })
      }
      if (gate.taskId) ledger?.noteGate(gate.taskId, gate.id, false)
      mainWindow?.webContents.send(GATE_OPEN_CHANNEL, null)
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
    onError: (detail) => reportDegradation('gates', detail)
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
          reportDegradation('breaker', `interrupt failed for ${agentId}: ${String(err)}`)
        }
      },
      stop: (agentId) => {
        try {
          agentManager?.kill(agentId)
        } catch (err) {
          reportDegradation('breaker', `stop failed for ${agentId}: ${String(err)}`)
        }
      },
      avatar: (agentId, event) => avatarDirector.apply(agentId, event),
      // ADR-0011 rung 3's owed clause: the stopped agent's task returns to the
      // ledger as `stalled` with the breaker report, for Artemis to reassign.
      returnTask: (agentId, report) => {
        try {
          ledger?.stallTaskOf(agentId, report)
        } catch (err) {
          reportDegradation('breaker', `could not stall the task of ${agentId}: ${String(err)}`)
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
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(
        `breaker ${String(draft['action'] ?? 'trip')} for ${String(draft['agentId'] ?? '')}`
      )
      if (draft['rung'] !== 0) {
        reportDegradation(
          'breaker',
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
      reportDegradation('budgets', `transcript ${source} shrank; re-folded from the start`)
  })

  engines.register(
    new ClaudeAdapter({
      prompts,
      hookShimPath: path.join(appRoot, 'shims', 'eph-hook.mjs'),
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
      'autonomy',
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
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
    },
    onChange: () => mainWindow?.webContents.send(TASKS_STATE_CHANNEL),
    onDegraded: (detail) => reportDegradation('agora', detail)
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
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
    },
    commitSoon: (subject) => agora?.commitSoon(subject)
  })

  // The Library (ADR-0006). Layer 1 is the markdown ground truth every spawn
  // carries; layer 2 is recall, on the best rung that will answer — MemPalace
  // (M4.3) above SQLite FTS above plain grep, every step down visible.
  const indexRoot = path.join(home.root, 'index')
  const fts = openFtsStore(indexRoot)
  if (fts.store === null) reportDegradation('library', fts.because)
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
    onDegraded: (detail) => reportDegradation('library', detail)
  })
  library = new Library({
    agoraRoot: agora.pathOf(),
    prompts,
    indexes: [mempalace, new FtsIndex({ store: fts.store, because: fts.because })],
    onDegraded: (detail) => reportDegradation('library', detail)
  })
  const probe = await mempalace.probe()
  if (probe.version === null) reportDegradation('library', probe.because)
  // Mtime-gated, so a boot with an unchanged corpus re-mines nothing (ADR-0006).
  // Not awaited: mining embeds, which takes seconds, and no boot step depends on
  // it — recall answers on whatever rung is ready when it is asked.
  void library
    .reindex()
    .catch((err: unknown) =>
      reportDegradation(
        'library',
        `reindex failed: ${err instanceof Error ? err.message : String(err)}`
      )
    )
  const recallRung = library.rung()
  if (recallRung.degraded !== null) {
    reportDegradation('library', `recall on the ${recallRung.rung} rung — ${recallRung.degraded}`)
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
    onDegraded: (detail) => reportDegradation('library', detail)
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
              open: gymnasium.rows().filter((row) => row.status === 'proposed').length
            }
          })
    }),
    orchestrator: () => agora?.registry().orchestratorId ?? null,
    deliver: (message) => hermes?.deliverFromHarness(message),
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
    },
    onDegraded: (detail) => reportDegradation('odeon', detail)
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
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
    },
    onChange: () => mainWindow?.webContents.send(ODEON_QUEUE_CHANNEL)
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
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
    },
    commitSoon: (subject) => agora?.commitSoon(subject),
    onDegraded: (detail) => reportDegradation('odeon', detail)
  })

  // The Gymnasium (ADR-0015, FR-12). Its ledger seeds from the repository’s
  // own build-phase archive, so the improvement record is continuous from the
  // first commit rather than starting empty on the day the product ships.
  gymnasium = new Gymnasium({
    agoraRoot: agora.root,
    seedFrom: path.join(appRoot, 'docs', 'gymnasium'),
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
    },
    commitSoon: (subject) => agora?.commitSoon(subject),
    onDegraded: (detail) => reportDegradation('odeon', detail)
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
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
    },
    commitSoon: (subject) => agora?.commitSoon(subject),
    onDegraded: (detail) => reportDegradation('odeon', detail)
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
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`shutdown ${String(draft['event'] ?? 'event')}`)
    }
  })

  hermes = new Hermes({
    agora,
    prompts,
    closing: (message) => closingTime?.noteReply(message) ?? false,
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
        onQueueChanged: () => mainWindow?.webContents.send(ODEON_QUEUE_CHANNEL)
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
    nudge: (agentId, text) => commandQueue.submit(agentId, text),
    isIdle: (agentId) => avatarDirector.get(agentId)?.phase === 'idle',
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
      reportDegradation('hermes', `bounce [${original.id}] to "${original.to}": ${reason}`),
    // Trip signal #3: recurring hop-cap escalations on one conversation. A hop
    // cap is a DIVERT, not a bounce — the M3 close-out audit found the old
    // bounce-side sniff unreachable (no bounce reason mentions hops).
    onDiverted: ({ from, conversation }) => breaker?.noteHopCap(from, conversation),
    onSweepError: (err: unknown) =>
      reportDegradation(
        'hermes',
        `sweep failed: ${err instanceof Error ? err.message : String(err)}`
      ),
    onRejected: ({ file, reason }) => reportDegradation('hermes', `rejected ${file}: ${reason}`)
  })
  hermes.start()

  agentManager = new AgentManager({
    engines,
    hookServer,
    spawner: ptyManager,
    prompts,
    agoraRoot: agora.root,
    onExitError: (agentId, err) =>
      reportDegradation(
        'agents',
        `teardown [${agentId}]: ${err instanceof Error ? err.message : String(err)}`
      ),
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
    resolveGrants: (declared) =>
      secrets?.grantsFor(declared) ?? { env: {}, missing: [...declared] },
    onGrantsMissing: (agentId, missing) =>
      reportDegradation(
        'secrets',
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
          'agora',
          `roster update for ${agentId} refused: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
      // Durability is a commit, and it is queued rather than awaited: delivery
      // latency must never wait on git (ADR-0004).
      agora?.commitSoon(`log ${draft.kind} for ${String(draft['agentId'] ?? 'agent')}`)
    },
    onChange: (card: AgentCard) => {
      mainWindow?.webContents.send(AGENTS_STATE_CHANNEL, card)
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
              'budgets',
              `final fold for ${card.agentId} failed: ${err instanceof Error ? err.message : String(err)}`
            )
          )
          .finally(() => {
            costLedger?.clearSession(card.agentId)
            budgetWatcher?.forget(card.agentId)
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
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`budget ${verdict.state} for ${agentId}`)
      if (verdict.state !== 'ok') {
        reportDegradation('budgets', `${agentId} budget ${verdict.state} (${verdict.because})`)
      }
      // SDD §9 choke point 3: spend is a harness-mediated action, so continuing
      // past a budget is the Architect's call, not the agent's.
      // Trip signal #4 (ADR-0011): the budget feeds the breaker directly.
      breaker?.evaluate(agentId)
      if (verdict.state === 'breached' || verdict.state === 'projected-breach') {
        chokePoints?.submitSpend(
          agentId,
          verdict.spent,
          verdict.state === 'breached' ? 'is exhausted' : 'is projected to be exhausted'
        )
      }
    },
    onDegraded: (detail) => reportDegradation('budgets', detail)
  })
  budgetWatcher.start()

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
          'agora',
          `orchestrator id not recorded: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      mainWindow?.webContents.send(LOG_APPEND_CHANNEL)
      agora?.commitSoon(`log ${draft.kind} ${String(draft['event'] ?? '')}`)
    },
    onDegraded: (detail) => reportDegradation('artemis', detail)
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
    breakerState: () =>
      (agentManager?.list() ?? [])
        .filter((card) => card.lifecycle !== 'exited')
        .map((card) => breaker?.stateFor(card.agentId))
        .filter((state): state is NonNullable<typeof state> => state !== undefined),
    // Exited agents are INCLUDED: their cumulative figure is precisely what the
    // durable ledger exists to preserve, and hiding it behind a liveness filter
    // would put it out of reach of the only IPC that can show it (FR-11.2).
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
    hooksState: (): HooksState => ({
      endpoint: hookServer.endpoint(),
      driftWarnings: hookServer.driftWarnings(),
      failure: hookFailure
    }),
    agoraHealth: (): AgoraHealth => ({
      fileWarnings: agora?.fileWarnings() ?? [],
      commitFailures: agora?.commitFailures() ?? [],
      runtime: [...runtimeHealth]
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
    stoaWatchlist: () => {
      const list = stoa?.watchlist() ?? { sources: [], retired: [] }
      // Retired rows are listed too, marked — the desk shows a struck-through
      // row rather than a hole where a source used to be (FR-13.1's habit).
      return [
        ...list.sources.map((entry) => ({
          ...entry,
          tags: [...entry.tags],
          retired: false,
          blocked: checkStudiable(entry).allowed ? null : checkStudiable(entry).because,
          intakeBlocked: checkIntake(entry).allowed ? null : checkIntake(entry).because
        })),
        ...list.retired.map((entry) => ({
          ...entry,
          tags: [...entry.tags],
          retired: true,
          blocked: 'retired from the watchlist',
          intakeBlocked: checkIntake(entry).allowed ? null : checkIntake(entry).because
        }))
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
      mainWindow?.webContents.send(ODEON_QUEUE_CHANNEL)
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
  else reportDegradation('artemis', 'no engine adapter registered; not hired')
}

/**
 * Closing time at the quit path (GYM-003) — offered, never forced. With live
 * agents on the floor the Architect chooses: let them park their work and
 * acknowledge (bounded by the protocol's hard deadline), or quit now — one
 * click, ungated, today's behavior. The dialog copy is UI chrome, not an LLM
 * prompt surface, so it may live here (invariant §8 is about LLM-facing prose).
 */
async function offerClosingTime(): Promise<void> {
  if (closingOffered) return
  closingOffered = true
  const closing = closingTime
  if (!closing || closing.inProgress()) return
  const live =
    agentManager
      ?.list()
      .filter((card) => card.lifecycle === 'running')
      .map((card) => card.agentId) ?? []
  if (live.length === 0) return

  const choice = dialog.showMessageBoxSync({
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
  if (choice !== 0) return

  try {
    const report = await closing.begin()
    if (report.missing.length > 0) {
      reportDegradation(
        'shutdown',
        `closing time: no acknowledgment from ${report.missing.join(', ')} by the deadline`
      )
    }
  } catch (err) {
    reportDegradation(
      'shutdown',
      `closing time failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

app.on('window-all-closed', () => {
  // Unwind spawns before the ptys die, so every settings file the harness wrote
  // into a repo is restored (ADR-0009) rather than left behind — and, first,
  // closing time (GYM-003): the one moment agents can still write down where
  // they stopped is before anything below runs.
  void offerClosingTime().then(() => teardown())
})

function teardown(): void {
  void agentManager
    ?.shutdown()
    .catch((err: unknown) => console.warn(`agents: shutdown failed: ${String(err)}`))
    .finally(() => {
      avatarDirector.stop()
      hermes?.stop()
      scheduler.stop()
      budgetWatcher?.stop()
      ptyManager.killAll()
      hookServer.stop().catch((err: unknown) => console.warn(`hooks: stop failed: ${String(err)}`))
      void agora?.drained().finally(() => db?.close())
      if (process.platform !== 'darwin') app.quit()
    })
  if (!agentManager) {
    avatarDirector.stop()
    hermes?.stop()
    scheduler.stop()
    budgetWatcher?.stop()
    ptyManager.killAll()
    hookServer.stop().catch((err: unknown) => console.warn(`hooks: stop failed: ${String(err)}`))
    db?.close()
    if (process.platform !== 'darwin') app.quit()
  }
}

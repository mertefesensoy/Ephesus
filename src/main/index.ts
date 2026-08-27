import path from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'
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
  type AgoraHealth,
  type HooksState
} from '../shared/ipc'
import { sanitizeBounds } from '../shared/window-state'
import { AgentManager } from './agents'
import { Agora } from './agora'
import { AvatarDirector } from './avatars'
import { CommandQueue } from './commands'
import { Hermes } from './hermes'
import { initHome } from './config'
import { AppDb } from './db'
import { ClaudeAdapter } from './engines/claude'
import { engines } from './engines'
import { HookServer } from './hooks'
import { registerIpc } from './ipc'
import { PromptStore } from './prompts'
import { PtyManager } from './pty'
import { PASS_THROUGH } from './pty-stream'
import { sweepInstalledSettings } from './settings-registry'
import { BudgetWatcher } from './watch/budgets'
import { safeStorageCipher } from './watch/cipher'
import { GateManager, loadGatePolicy, wireGateChokePoints } from './watch/gates'
import { CostLedger } from './watch/ledger'
import { SecretBroker } from './watch/secrets'

let secrets: SecretBroker | null = null
let costLedger: CostLedger | null = null
let budgetWatcher: BudgetWatcher | null = null
let gates: GateManager | null = null
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
let hermes: Hermes | null = null
let mainWindow: BrowserWindow | null = null
/** Non-null when the hook endpoint failed to bind — a visible state, not a crash. */
let hookFailure: string | null = null

/**
 * Runtime degradations, bounded and surfaced through `agora:health` so every
 * give-up is a visible UI state (invariant §7) — `console.warn` alone is a
 * developer console the Architect never sees.
 */
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

const avatarDirector = new AvatarDirector({
  // The floor and the autonomy loop read the SAME fact about pending work, so
  // they can never disagree about whether an agent is done (ADR-0013).
  hasPendingWork: (agentId: string) => (hermes?.pendingMailCount(agentId) ? true : false),
  onChange: (agentId: string, snapshot: AvatarSnapshot) => {
    mainWindow?.webContents.send(AVATARS_STATE_CHANNEL, { agentId, snapshot })
    // The queue flushes off the same snapshots the floor draws, so held text
    // goes out exactly when the avatar says the agent is free (FR-1.3).
    commandQueue.observe(agentId, snapshot)
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
    // The ledger learns which session a spawn is running under from the same
    // event plane the floor reads (ADR-0002) — the attribution key that lets
    // "session" and "cumulative" be told apart without a running total.
    if (envelope.sessionId) {
      costLedger?.noteSession(envelope.agentId, envelope.sessionId)
      // The Watch folds only the transcripts these sessions produced, so a
      // shared repo cannot cross-attribute spend between agents (ADR-0011).
      agentManager?.noteSession(envelope.agentId, envelope.sessionId)
    }

    // SDD §9 choke point 1: the engine is waiting on a human. Through M1 and
    // M2 this event was unmapped, so an agent stalled behind a permission
    // dialog was invisible — the floor simply stopped moving (M1 carried item).
    if (envelope.event === 'notification') {
      chokePoints?.submitNotification(envelope.agentId, envelope.payload)
      // Whether or not the policy would ever permit it, the engine is stalled
      // behind a dialog the harness cannot answer — the M1 carried item is
      // about that being *visible*, not about who may allow it (invariant §7).
      reportDegradation('gates', `${envelope.agentId} is waiting on a human decision`)
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
  onEventError: (err) =>
    reportDegradation(
      'hooks',
      `event handler failed: ${err instanceof Error ? err.message : String(err)}`
    )
})

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

void app.whenReady().then(async () => {
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
    },
    onSettled: (gate) => {
      // Only when the LAST gate on that agent clears: an agent held behind two
      // gates must not walk back to its desk after the first verdict.
      if (!gates?.isBlocked(gate.agentId)) {
        avatarDirector.apply(gate.agentId, { kind: 'gate-verdict' })
      }
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
    onError: (detail) => reportDegradation('gates', detail)
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
  // ADR-0013: the block cap is env-configurable; an invalid value can never
  // silently disable the cap — it is refused visibly and the default holds.
  const envCap = blockCapFromEnv(process.env)
  if (envCap.cap === undefined && envCap.invalid !== undefined) {
    reportDegradation(
      'autonomy',
      `ignoring invalid ${BLOCK_CAP_ENV}="${envCap.invalid}" — default cap applies`
    )
  }

  hermes = new Hermes({
    agora,
    prompts,
    ...(envCap.cap === undefined ? {} : { blockCap: envCap.cap }),
    nudge: (agentId, text) => commandQueue.submit(agentId, text),
    isIdle: (agentId) => avatarDirector.get(agentId)?.phase === 'idle',
    onPathology: (agentId, blocks) => {
      // The breaker (ADR-0011) consumes this in M3; until then it is at least
      // visible rather than an invisible overnight loop (R2).
      reportDegradation('autonomy', `${agentId} has been continued ${blocks} times this session`)
      agora?.appendLog({ kind: 'breaker', agentId, signal: 'stop-loop', blocks, rung: 1 })
    },
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
      if (card.lifecycle === 'exited') {
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
    agents: () => agentManager?.liveSpawns() ?? [],
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

  registerIpc({
    ptyManager,
    agents: agentManager,
    avatars: avatarDirector,
    commands: commandQueue,
    agora,
    secrets,
    gates,
    humanQueue: () => hermes?.humanQueue() ?? [],
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
    })
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Unwind spawns before the ptys die, so every settings file the harness wrote
  // into a repo is restored (ADR-0009) rather than left behind.
  void agentManager
    ?.shutdown()
    .catch((err: unknown) => console.warn(`agents: shutdown failed: ${String(err)}`))
    .finally(() => {
      avatarDirector.stop()
      hermes?.stop()
      budgetWatcher?.stop()
      ptyManager.killAll()
      void hookServer.stop()
      void agora?.drained().finally(() => db?.close())
      if (process.platform !== 'darwin') app.quit()
    })
  if (!agentManager) {
    avatarDirector.stop()
    hermes?.stop()
    budgetWatcher?.stop()
    ptyManager.killAll()
    void hookServer.stop()
    db?.close()
    if (process.platform !== 'darwin') app.quit()
  }
})

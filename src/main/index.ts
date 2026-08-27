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
import { safeStorageCipher } from './watch/cipher'
import { SecretBroker } from './watch/secrets'

let secrets: SecretBroker | null = null
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

  registerIpc({
    ptyManager,
    agents: agentManager,
    avatars: avatarDirector,
    commands: commandQueue,
    agora,
    secrets,
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
      ptyManager.killAll()
      void hookServer.stop()
      void agora?.drained().finally(() => db?.close())
      if (process.platform !== 'darwin') app.quit()
    })
  if (!agentManager) {
    avatarDirector.stop()
    hermes?.stop()
    ptyManager.killAll()
    void hookServer.stop()
    db?.close()
    if (process.platform !== 'darwin') app.quit()
  }
})

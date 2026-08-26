import path from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'
import type { AgentCard } from '../shared/agents'
import type { AvatarSnapshot } from '../shared/avatar'
import type { CommandState } from '../shared/commands'
import {
  AGENTS_STATE_CHANNEL,
  AVATARS_STATE_CHANNEL,
  COMMANDS_STATE_CHANNEL,
  type HooksState
} from '../shared/ipc'
import { sanitizeBounds } from '../shared/window-state'
import { AgentManager } from './agents'
import { Agora } from './agora'
import { AvatarDirector } from './avatars'
import { CommandQueue } from './commands'
import { initHome } from './config'
import { AppDb } from './db'
import { ClaudeAdapter } from './engines/claude'
import { engines } from './engines'
import { HookServer } from './hooks'
import { registerIpc } from './ipc'
import { PromptStore } from './prompts'
import { PtyManager } from './pty'
import { sweepInstalledSettings } from './settings-registry'

const ptyManager = new PtyManager()
let db: AppDb | null = null
let agentManager: AgentManager | null = null
let agora: Agora | null = null
let mainWindow: BrowserWindow | null = null
/** Non-null when the hook endpoint failed to bind — a visible state, not a crash. */
let hookFailure: string | null = null

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
  },
  onRejected: ({ agentId, status, reason }) => {
    console.warn(`hook rejected [${agentId ?? 'unknown-agent'}] ${status}: ${reason}`)
  }
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
    console.warn(`settings sweep: could not restore ${failure.path}: ${failure.reason}`)
  }

  // The Agora is a git repo committed only by this process (ADR-0004). It is
  // reconciled before anything can write to it.
  agora = new Agora({ root: path.join(home.root, 'agora'), prompts })
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
  agentManager = new AgentManager({
    engines,
    hookServer,
    spawner: ptyManager,
    prompts,
    agoraRoot: agora.root,
    onLogEvent: (draft) => {
      agora?.appendLog(draft)
      // Durability is a commit, and it is queued rather than awaited: delivery
      // latency must never wait on git (ADR-0004).
      void agora?.commit(`log ${draft.kind} for ${String(draft['agentId'] ?? 'agent')}`)
    },
    onChange: (card: AgentCard) => {
      mainWindow?.webContents.send(AGENTS_STATE_CHANNEL, card)
      if (card.lifecycle === 'running' && !avatarDirector.get(card.agentId)) {
        avatarDirector.add(card.agentId)
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
    hooksState: (): HooksState => ({
      endpoint: hookServer.endpoint(),
      driftWarnings: hookServer.driftWarnings(),
      failure: hookFailure
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
      ptyManager.killAll()
      void hookServer.stop()
      void agora?.drained().finally(() => db?.close())
      if (process.platform !== 'darwin') app.quit()
    })
  if (!agentManager) {
    avatarDirector.stop()
    ptyManager.killAll()
    void hookServer.stop()
    db?.close()
    if (process.platform !== 'darwin') app.quit()
  }
})

import path from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'
import type { AgentCard } from '../shared/agents'
import { AGENTS_STATE_CHANNEL } from '../shared/ipc'
import { sanitizeBounds } from '../shared/window-state'
import { AgentManager } from './agents'
import { initHome } from './config'
import { AppDb } from './db'
import { ClaudeAdapter } from './engines/claude'
import { engines } from './engines'
import { HookServer } from './hooks'
import { registerIpc } from './ipc'
import { PromptStore } from './prompts'
import { PtyManager } from './pty'

const ptyManager = new PtyManager()
let db: AppDb | null = null
let agentManager: AgentManager | null = null
let mainWindow: BrowserWindow | null = null

/**
 * The event plane's front door (ADR-0002). Until the Agora's `log.jsonl` lands
 * in M2 these two sinks are the book of record, so both say enough to find the
 * event again (ENGINEERING-STANDARDS §4 "errors carry refs"). Drift warnings are
 * also retained on the server for the UI to surface (FR-2.3).
 */
const hookServer = new HookServer({
  onEvent: ({ envelope, known, warning }) => {
    if (warning) console.warn(`hook drift [${envelope.agentId}/${envelope.event}]: ${warning}`)
    else if (!known) console.warn(`hook unknown [${envelope.agentId}]: ${envelope.event}`)
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
  const endpoint = await hookServer.start(home.root)
  console.info(`hook endpoint listening on ${endpoint}`)

  // `prompts/` and `shims/` ship beside the app; the harness home holds the
  // Architect-editable copies (invariant §8).
  const appRoot = app.getAppPath()
  const prompts = new PromptStore(path.join(home.root, 'prompts'), path.join(appRoot, 'prompts'))
  engines.register(
    new ClaudeAdapter({ prompts, hookShimPath: path.join(appRoot, 'shims', 'eph-hook.mjs') })
  )
  agentManager = new AgentManager({
    engines,
    hookServer,
    spawner: ptyManager,
    prompts,
    agoraRoot: path.join(home.root, 'agora'),
    onChange: (card: AgentCard) => mainWindow?.webContents.send(AGENTS_STATE_CHANNEL, card)
  })

  registerIpc(ptyManager, agentManager)
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
      ptyManager.killAll()
      void hookServer.stop()
      db?.close()
      if (process.platform !== 'darwin') app.quit()
    })
  if (!agentManager) {
    ptyManager.killAll()
    void hookServer.stop()
    db?.close()
    if (process.platform !== 'darwin') app.quit()
  }
})

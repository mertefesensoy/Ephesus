import path from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'
import { sanitizeBounds } from '../shared/window-state'
import { initHome } from './config'
import { AppDb } from './db'
import { HookServer } from './hooks'
import { registerIpc } from './ipc'
import { PtyManager } from './pty'

const ptyManager = new PtyManager()
let db: AppDb | null = null

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
  registerIpc(ptyManager)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  ptyManager.killAll()
  void hookServer.stop()
  db?.close()
  if (process.platform !== 'darwin') app.quit()
})

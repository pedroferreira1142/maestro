import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { FsService } from './FsService'
import { registerIpc } from './ipc'
import { Persistence } from './Persistence'
import { SessionManager } from './SessionManager'

let win: BrowserWindow | null = null
const getWin = (): BrowserWindow | null => win

const persistence = new Persistence()

function createWindow(): void {
  const bounds = persistence.state.window
  win = new BrowserWindow({
    x: bounds.x ?? undefined,
    y: bounds.y ?? undefined,
    width: bounds.width,
    height: bounds.height,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#16171a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (bounds.maximized) win.maximize()
  win.once('ready-to-show', () => win?.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const saveBounds = (): void => {
    if (!win) return
    const maximized = win.isMaximized()
    persistence.state.window.maximized = maximized
    if (!maximized) {
      const b = win.getBounds()
      persistence.state.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized }
    }
    persistence.scheduleSave()
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('closed', () => {
    win = null
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.pedroferreira.maestro')
    persistence.load()

    const fsService = new FsService(
      (sessionId, events) => getWin()?.webContents.send('fs:events', sessionId, events),
      () => persistence.state.settings.ignoreNames
    )
    const sessions = new SessionManager(persistence, fsService, getWin)
    registerIpc(sessions, fsService, persistence, getWin)

    createWindow()
    sessions.restoreAll()

    app.on('before-quit', () => {
      sessions.disposeAll()
      persistence.saveNow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

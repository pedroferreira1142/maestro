import { app, BrowserWindow, shell } from 'electron'
import { EventEmitter } from 'events'
import { join } from 'path'
import type { GameEvent } from '../shared/gamification'
import { AgentRegistryService } from './AgentRegistryService'
import { AutoExpandService } from './AutoExpand'
import { ConductorService } from './ConductorService'
import { FactoryService } from './FactoryService'
import { FeatureService } from './FeatureService'
import { FsService } from './FsService'
import { GamificationService } from './GamificationService'
import { registerIpc } from './ipc'
import { Persistence } from './Persistence'
import { SentinelService } from './Sentinels'
import { SessionManager } from './SessionManager'
import { TokenEfficiencyService } from './TokenEfficiency'
import { UsageService } from './UsageService'

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

    // Gamification: services push fire-and-forget GameEvents onto this bus; the
    // single GamificationService subscriber owns all XP/level/achievement logic
    // (one place for dedupe). `emitGame` is injected like `getWin` and defaults
    // to a no-op in each service, so a missing wire can never break a call site.
    const gameBus = new EventEmitter()
    const emitGame = (e: GameEvent): void => {
      try {
        gameBus.emit('game', e)
      } catch {
        // never let a game event affect the caller
      }
    }

    const fsService = new FsService(
      (sessionId, events) => getWin()?.webContents.send('fs:events', sessionId, events),
      () => persistence.state.settings.ignoreNames
    )
    const tokenEff = new TokenEfficiencyService(persistence)
    const sessions = new SessionManager(persistence, fsService, tokenEff, getWin, emitGame)
    const sentinels = new SentinelService(persistence, getWin, emitGame)
    const features = new FeatureService(persistence, sessions, emitGame)
    const autoExpand = new AutoExpandService(persistence, features, getWin, emitGame)
    const conductor = new ConductorService(persistence, sessions, features, autoExpand, getWin)
    const factory = new FactoryService(getWin, emitGame)
    const agentRegistry = new AgentRegistryService(persistence, getWin)
    const usage = new UsageService()
    const gamification = new GamificationService(getWin, () => {
      const t = usage.snapshot().total
      return t.inputTokens + t.outputTokens
    })
    gameBus.on('game', (e: GameEvent) => gamification.award(e))
    registerIpc(
      sessions,
      fsService,
      persistence,
      sentinels,
      features,
      autoExpand,
      conductor,
      factory,
      agentRegistry,
      tokenEff,
      gamification,
      usage,
      getWin
    )

    createWindow()
    sessions.restoreAll()
    sessions.startWatchdog()
    sentinels.start()
    autoExpand.start()
    tokenEff.start()
    factory.start()
    gamification.start()
    // Feed completed Conductor turns into the Factory's self-growth detector
    // and the gamification engine.
    conductor.onTurnComplete((messages) => {
      factory.considerConversation(messages)
      emitGame({ type: 'conductor.turn' })
    })

    // macOS convention: closing the window keeps the app (and its PTYs)
    // running; clicking the dock icon brings the window back.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    app.on('before-quit', () => {
      tokenEff.dispose()
      agentRegistry.dispose()
      gamification.dispose()
      factory.dispose()
      conductor.dispose()
      autoExpand.dispose()
      sentinels.dispose()
      sessions.disposeAll()
      persistence.saveNow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

import { app } from 'electron'
import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { AppStateFile, DEFAULT_CATEGORIES, DEFAULT_SETTINGS, SessionConfig } from '../shared/types'

const DEFAULT_STATE: AppStateFile = {
  schemaVersion: 1,
  sessions: [],
  activeSessionId: null,
  window: { x: null, y: null, width: 1400, height: 900, maximized: false },
  settings: DEFAULT_SETTINGS,
  categories: DEFAULT_CATEGORIES
}

/**
 * Upgrade a persisted session to the multi-terminal shape. Pre-terminals
 * sessions carried `claudeArgs`/`startMode` and an implicit single claude
 * terminal; fold those into one `claude` TerminalConfig.
 */
function migrateSession(raw: Record<string, unknown>): SessionConfig {
  if (Array.isArray(raw.terminals) && raw.terminals.length > 0) {
    return { activeTerminalId: null, categoryId: null, ...raw } as unknown as SessionConfig
  }
  const id = randomUUID()
  const terminal = {
    id,
    kind: 'claude' as const,
    title: 'claude',
    order: 0,
    claudeArgs: Array.isArray(raw.claudeArgs) ? (raw.claudeArgs as string[]) : [],
    startMode: raw.startMode === 'fresh' ? ('fresh' as const) : ('continue' as const)
  }
  const { claudeArgs: _a, startMode: _s, ...rest } = raw
  return {
    categoryId: null,
    ...(rest as Record<string, unknown>),
    terminals: [terminal],
    activeTerminalId: id
  } as unknown as SessionConfig
}

export class Persistence {
  private file = join(app.getPath('userData'), 'sessions.json')
  private timer: NodeJS.Timeout | null = null
  state: AppStateFile = DEFAULT_STATE

  /**
   * One-time import from the pre-rename userData dir ("claude-session-manager",
   * the app's old package name): if our sessions.json doesn't exist yet but the
   * old one does, copy it over so existing sessions survive the rename to Maestro.
   */
  private migrateLegacyStateFile(): void {
    try {
      if (existsSync(this.file)) return
      const legacy = join(app.getPath('userData'), '..', 'claude-session-manager', 'sessions.json')
      if (!existsSync(legacy)) return
      mkdirSync(dirname(this.file), { recursive: true })
      copyFileSync(legacy, this.file)
    } catch {
      // best-effort; a fresh state is an acceptable fallback
    }
  }

  load(): AppStateFile {
    this.migrateLegacyStateFile()
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      this.state = {
        ...DEFAULT_STATE,
        ...raw,
        window: { ...DEFAULT_STATE.window, ...(raw.window ?? {}) },
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        categories: Array.isArray(raw.categories) ? raw.categories : DEFAULT_CATEGORIES,
        sessions: Array.isArray(raw.sessions) ? raw.sessions.map(migrateSession) : []
      }
    } catch {
      this.state = structuredClone(DEFAULT_STATE)
    }
    return this.state
  }

  /** Debounced save — call freely on any state change. */
  scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), 500)
  }

  saveNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('Failed to persist state:', err)
    }
  }
}

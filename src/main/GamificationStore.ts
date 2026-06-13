import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { DEFAULT_GAME_STATE, GameState, QuestProgress } from '../shared/gamification'

/**
 * Persists gamification progress (XP, streak, achievements, daily quests,
 * lifetime counters) to its OWN file (userData/gamification.json), separate
 * from sessions.json. Atomic (temp + rename), debounced writes; mirrors
 * FactoryStore / ConductorStore.
 */
export class GamificationStore {
  private file = join(app.getPath('userData'), 'gamification.json')
  private timer: NodeJS.Timeout | null = null
  private state: GameState = structuredClone(DEFAULT_GAME_STATE)

  /** Load saved progress (best-effort; defaults on any error, back-compat via spread). */
  load(): GameState {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<GameState>
      const s: GameState = { ...structuredClone(DEFAULT_GAME_STATE), ...(raw ?? {}) }
      // Coerce nested objects/arrays AND their inner fields, so a hand-edited or
      // older file can never feed NaN / string values into the award engine.
      const num = (v: unknown, fallback: number): number =>
        typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : fallback
      if (!s.streak || typeof s.streak !== 'object') s.streak = { current: 0, longest: 0, lastDay: '' }
      s.streak.current = num(s.streak.current, 0)
      s.streak.longest = num(s.streak.longest, 0)
      if (typeof s.streak.lastDay !== 'string') s.streak.lastDay = ''
      if (!s.achievements || typeof s.achievements !== 'object' || Array.isArray(s.achievements)) {
        s.achievements = {}
      }
      if (!Array.isArray(s.todaysQuests)) s.todaysQuests = []
      s.todaysQuests = s.todaysQuests
        .filter((q) => q && typeof q.id === 'string')
        .map((q) => ({ id: q.id, target: num(q.target, 1), progress: num(q.progress, 0), rewarded: !!q.rewarded }))
      if (!s.counters || typeof s.counters !== 'object' || Array.isArray(s.counters)) s.counters = {}
      for (const k of Object.keys(s.counters)) {
        s.counters[k as keyof typeof s.counters] = num(s.counters[k as keyof typeof s.counters], 0)
      }
      s.nightTurns = num(s.nightTurns, 0)
      s.earlyTurns = num(s.earlyTurns, 0)
      s.xp = num(s.xp, 0)
      if (!s.createdAt) s.createdAt = Date.now()
      this.state = s
    } catch {
      this.state = structuredClone(DEFAULT_GAME_STATE)
      this.state.createdAt = Date.now()
    }
    return this.state
  }

  get(): GameState {
    return this.state
  }

  set(state: GameState): void {
    this.state = state
    this.scheduleSave()
  }

  private scheduleSave(): void {
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
      console.error('Failed to persist gamification state:', err)
    }
  }
}

// Re-export for callers that only import from the store.
export type { GameState, QuestProgress }

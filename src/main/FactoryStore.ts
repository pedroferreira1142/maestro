import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  FactoryArtifact,
  FactoryGrowthMeta,
  FactoryLesson,
  FactoryRun,
  FactoryState,
  FactorySuggestion,
  FactoryTopic
} from '../shared/types'

const EMPTY: FactoryState = { artifacts: [], topics: [], lessons: [], suggestions: [] }

const EMPTY_GROWTH: FactoryGrowthMeta = {
  lastScannedAt: {},
  lastAutoProposeAt: 0,
  lastDetectAt: 0,
  turnsSinceDetect: 0,
  judgeDay: '',
  judgeCallsToday: 0
}

/**
 * Persists the factory registry (generated artifacts + the topics-to-pursue
 * backlog + lessons-learned) AND the scan-run audit trail to its OWN file
 * (userData/factory.json), separate from sessions.json. Writes are atomic
 * (temp + rename) and debounced; mirrors ConductorStore.
 */
export class FactoryStore {
  private file = join(app.getPath('userData'), 'factory.json')
  private timer: NodeJS.Timeout | null = null
  private state: FactoryState = { ...EMPTY }
  private runs: FactoryRun[] = []
  private growth: FactoryGrowthMeta = { ...EMPTY_GROWTH }

  /** Load the saved registry (best-effort; an empty registry on any error). */
  load(): FactoryState {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      this.state = {
        artifacts: Array.isArray(raw?.artifacts) ? (raw.artifacts as FactoryArtifact[]) : [],
        topics: Array.isArray(raw?.topics) ? (raw.topics as FactoryTopic[]) : [],
        lessons: Array.isArray(raw?.lessons) ? (raw.lessons as FactoryLesson[]) : [],
        // Back-compat: older factory.json files have no `suggestions` key.
        suggestions: Array.isArray(raw?.suggestions)
          ? (raw.suggestions as FactorySuggestion[])
          : []
      }
      this.runs = Array.isArray(raw?.runs) ? (raw.runs as FactoryRun[]) : []
      this.growth =
        raw?.growth && typeof raw.growth === 'object'
          ? { ...EMPTY_GROWTH, ...(raw.growth as Partial<FactoryGrowthMeta>) }
          : { ...EMPTY_GROWTH }
      // A spread lets an explicit `lastScannedAt: null` (corrupted file) override
      // the default; coerce non-objects back to {} so the auto-propose comparator
      // can't throw on a null receiver.
      if (
        !this.growth.lastScannedAt ||
        typeof this.growth.lastScannedAt !== 'object' ||
        Array.isArray(this.growth.lastScannedAt)
      ) {
        this.growth.lastScannedAt = {}
      }
    } catch {
      this.state = { ...EMPTY }
      this.runs = []
      this.growth = { ...EMPTY_GROWTH }
    }
    return this.state
  }

  get(): FactoryState {
    return this.state
  }

  /** The persisted run audit trail (call after load()). */
  loadRuns(): FactoryRun[] {
    return this.runs
  }

  /** Self-growth bookkeeping (call after load()). */
  loadGrowth(): FactoryGrowthMeta {
    return this.growth
  }

  /** Replace the registry and schedule a save. */
  set(state: FactoryState): void {
    this.state = state
    this.scheduleSave()
  }

  /** Replace the run audit trail and schedule a save. */
  setRuns(runs: FactoryRun[]): void {
    this.runs = runs
    this.scheduleSave()
  }

  /** Replace the self-growth bookkeeping and schedule a save. */
  setGrowth(growth: FactoryGrowthMeta): void {
    this.growth = growth
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
      writeFileSync(
        tmp,
        JSON.stringify({ ...this.state, runs: this.runs, growth: this.growth }, null, 2),
        'utf8'
      )
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('Failed to persist factory registry:', err)
    }
  }
}

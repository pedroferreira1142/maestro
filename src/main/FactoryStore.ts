import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { FactoryArtifact, FactoryLesson, FactoryState, FactoryTopic } from '../shared/types'

const EMPTY: FactoryState = { artifacts: [], topics: [], lessons: [] }

/**
 * Persists the factory registry (generated artifacts + the topics-to-pursue
 * backlog + lessons-learned) to its OWN file (userData/factory.json), separate
 * from sessions.json. Writes are atomic (temp + rename) and debounced; mirrors
 * ConductorStore.
 */
export class FactoryStore {
  private file = join(app.getPath('userData'), 'factory.json')
  private timer: NodeJS.Timeout | null = null
  private state: FactoryState = { ...EMPTY }

  /** Load the saved registry (best-effort; an empty registry on any error). */
  load(): FactoryState {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      this.state = {
        artifacts: Array.isArray(raw?.artifacts) ? (raw.artifacts as FactoryArtifact[]) : [],
        topics: Array.isArray(raw?.topics) ? (raw.topics as FactoryTopic[]) : [],
        lessons: Array.isArray(raw?.lessons) ? (raw.lessons as FactoryLesson[]) : []
      }
    } catch {
      this.state = { ...EMPTY }
    }
    return this.state
  }

  get(): FactoryState {
    return this.state
  }

  /** Replace the registry and schedule a save. */
  set(state: FactoryState): void {
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
      console.error('Failed to persist factory registry:', err)
    }
  }
}

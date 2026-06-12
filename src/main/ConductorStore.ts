import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { ConductorMessage } from '../shared/types'

/** Keep the conversation bounded; oldest turns are dropped past this. */
const MAX_MESSAGES = 100

/**
 * Persists the Conductor conversation to its OWN file
 * (userData/conductor.json), deliberately separate from sessions.json so the
 * app's session state never carries chat content (NFR-5). Writes are atomic
 * (temp + rename) and debounced; mirrors Persistence.saveNow.
 */
export class ConductorStore {
  private file = join(app.getPath('userData'), 'conductor.json')
  private timer: NodeJS.Timeout | null = null
  private messages: ConductorMessage[] = []

  /** Load the saved conversation (best-effort; a fresh thread on any error). */
  load(): ConductorMessage[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(raw)) this.messages = raw as ConductorMessage[]
    } catch {
      this.messages = []
    }
    return this.messages
  }

  list(): ConductorMessage[] {
    return this.messages
  }

  /** Replace the conversation, trim to the cap, and schedule a save. */
  set(messages: ConductorMessage[]): void {
    this.messages = messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages
    this.scheduleSave()
  }

  clear(): void {
    this.messages = []
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
      writeFileSync(tmp, JSON.stringify(this.messages, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('Failed to persist conductor conversation:', err)
    }
  }
}

import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

/** Most recent raw PTY output kept on disk per terminal (~200 KB). */
export const SCROLLBACK_MAX_BYTES = 200 * 1024

/**
 * Minimum gap between disk writes for one terminal. A throttle, not a trailing
 * debounce: continuous output must still hit disk about once a second, and a
 * timer that resets on every chunk would never fire.
 */
const WRITE_INTERVAL_MS = 1000

interface PendingWrite {
  timer: NodeJS.Timeout
  snapshot: () => string
}

/**
 * Persists the tail of each terminal's PTY ring buffer to
 * <userData>/scrollback/<terminalId>.txt so a restarted app can replay the
 * previous run's output. Writes are atomic (tmp + rename, like Persistence)
 * and throttled per terminal; reads are best-effort — any unreadable file is
 * treated as "no history".
 */
export class ScrollbackStore {
  private dir = join(app.getPath('userData'), 'scrollback')

  /** Terminals with unwritten output, keyed by id; the latest snapshot wins. */
  private pending = new Map<string, PendingWrite>()

  private fileOf(terminalId: string): string {
    return join(this.dir, `${terminalId}.txt`)
  }

  /**
   * Saved scrollback for a terminal, or '' when missing or unreadable. The
   * content is re-capped on load so an oversized or hand-edited file can't
   * balloon the ring buffer.
   */
  load(terminalId: string): string {
    try {
      return tail(readFileSync(this.fileOf(terminalId), 'utf8'))
    } catch {
      return ''
    }
  }

  /**
   * Mark a terminal's scrollback dirty. The first call starts that terminal's
   * write countdown; further calls before it fires only swap in the newer
   * snapshot function, so the buffer state at write time is what lands on disk.
   */
  markDirty(terminalId: string, snapshot: () => string): void {
    const entry = this.pending.get(terminalId)
    if (entry) {
      entry.snapshot = snapshot
      return
    }
    this.pending.set(terminalId, {
      timer: setTimeout(() => this.flush(terminalId), WRITE_INTERVAL_MS),
      snapshot
    })
  }

  /** Drop a terminal's scrollback file and cancel any pending write. */
  delete(terminalId: string): void {
    const entry = this.pending.get(terminalId)
    if (entry) clearTimeout(entry.timer)
    this.pending.delete(terminalId)
    try {
      rmSync(this.fileOf(terminalId), { force: true })
    } catch {
      // best-effort; prune() sweeps leftovers on next launch
    }
  }

  /** Write everything still pending — call on app quit. */
  flushAll(): void {
    for (const terminalId of [...this.pending.keys()]) this.flush(terminalId)
  }

  /**
   * Delete files for terminals that no longer exist (e.g. a session closed
   * right before a crash skipped its delete()).
   */
  prune(liveTerminalIds: Set<string>): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return // no scrollback dir yet
    }
    for (const name of names) {
      // Keep exactly "<liveId>.txt"; anything else (gone terminals, stale
      // .tmp files from an interrupted write) is swept.
      const keep = name.endsWith('.txt') && liveTerminalIds.has(name.slice(0, -4))
      if (keep) continue
      try {
        rmSync(join(this.dir, name), { force: true })
      } catch {
        // best-effort
      }
    }
  }

  private flush(terminalId: string): void {
    const entry = this.pending.get(terminalId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(terminalId)
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = this.fileOf(terminalId)
      const tmp = file + '.tmp'
      writeFileSync(tmp, tail(entry.snapshot()), 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      console.error('Failed to persist scrollback:', err)
    }
  }
}

/**
 * Last SCROLLBACK_MAX_BYTES of text. When truncation cuts mid-stream, the
 * fragment up to the next newline is dropped too, so the replay doesn't open
 * with half an escape sequence.
 */
function tail(text: string): string {
  if (text.length <= SCROLLBACK_MAX_BYTES) return text
  const cut = text.slice(-SCROLLBACK_MAX_BYTES)
  const nl = cut.indexOf('\n')
  return nl === -1 ? cut : cut.slice(nl + 1)
}

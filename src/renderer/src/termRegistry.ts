import type { Terminal } from '@xterm/xterm'
import type { IBufferLine } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'
import type { SessionInfo } from '../../shared/types'
import { useStore } from './store'

interface TermEntry {
  term: Terminal
  search: SearchAddon
}

/** Live xterm instances (+ their search addons) by terminal id. */
const terms = new Map<string, TermEntry>()

export function registerTerm(id: string, term: Terminal, search: SearchAddon): void {
  terms.set(id, { term, search })
}

export function unregisterTerm(id: string): void {
  terms.delete(id)
}

function defaultActive(session: SessionInfo): string {
  return session.config.activeTerminalId ?? session.terminals[0]?.config.id ?? 'terminal'
}

/**
 * Return keyboard focus to the active session's visible terminal — unless the
 * user is typing somewhere else (input/textarea/select, a dialog) or the
 * active tab is a file viewer rather than a terminal. Focus sitting in another
 * terminal doesn't count as "elsewhere": xterm's hidden helper textarea may
 * always be taken over (that's just a terminal-to-terminal switch).
 */
export function focusActiveTerminal(): void {
  const st = useStore.getState()
  if (
    st.pendingNewSession ||
    st.pendingWorktree ||
    st.categoriesOpen ||
    st.actionEditor ||
    st.globalSearchOpen ||
    st.paletteOpen
  )
    return
  const el = document.activeElement as HTMLElement | null
  if (
    el &&
    !el.classList.contains('xterm-helper-textarea') &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  )
    return
  const session = st.sessions.find((s) => s.config.id === st.activeId)
  if (!session) return
  const tab = st.viewers[session.config.id]?.active ?? defaultActive(session)
  terms.get(tab)?.term.focus()
}

/**
 * Serialize one terminal's full scrollback buffer to plain text. Soft-wrapped
 * rows are joined into single logical lines (same continuation handling as
 * searchBuffer) and trailing blank lines are trimmed. Buffer cells hold the
 * *rendered* output, so the result is naturally free of ANSI escapes.
 * Returns null when no live xterm is registered for the id.
 */
export function getTranscript(terminalId: string): string | null {
  const entry = terms.get(terminalId)
  if (!entry) return null
  const buf = entry.term.buffer.active
  const lines: string[] = []
  let row = 0
  while (row < buf.length) {
    let text = ''
    for (let r = row; ; r++) {
      const line = buf.getLine(r)
      if (!line) {
        row = r + 1
        break
      }
      const wrapped = !!buf.getLine(r + 1)?.isWrapped
      text += line.translateToString(!wrapped)
      row = r + 1
      if (!wrapped) break
    }
    lines.push(text)
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}

// ---------- global scrollback search ----------

/** One occurrence of a query in a terminal's scrollback buffer. */
export interface BufferMatch {
  /** Buffer row (absolute, scrollback included) where the match starts. */
  row: number
  /** Buffer column where the match starts. */
  col: number
  /** Full text of the logical (unwrapped) line containing the match. */
  text: string
  /** Match start index within `text`. */
  index: number
}

/**
 * Map a string index within a buffer row's translated text back to the buffer
 * column, accounting for wide characters (CJK/emoji occupy two buffer cells
 * but one string position) and zero-width trailing cells.
 */
function stringIndexToBufferCol(line: IBufferLine, strIndex: number): number {
  let s = 0
  for (let col = 0; col < line.length; col++) {
    if (s >= strIndex) return col
    const cell = line.getCell(col)
    if (!cell) break
    if (cell.getWidth() === 0) continue // right half of a wide char
    s += cell.getChars().length || 1 // empty cell renders as one space
  }
  return Math.max(0, Math.min(strIndex, line.length - 1))
}

/**
 * Case-insensitively search one terminal's live scrollback for `query`.
 * Wrapped rows are joined into logical lines (the same way the search addon
 * does), so matches inside wrapped output are found and previews show the
 * whole line.
 */
export function searchBuffer(terminalId: string, query: string, maxMatches: number): BufferMatch[] {
  const entry = terms.get(terminalId)
  if (!entry || !query) return []
  const buf = entry.term.buffer.active
  const q = query.toLowerCase()
  const out: BufferMatch[] = []
  let row = 0
  while (row < buf.length && out.length < maxMatches) {
    // Join this row with its wrapped continuations into one logical line,
    // recording each row's starting offset within the joined string.
    const startRow = row
    const offsets: number[] = [0]
    let text = ''
    for (let r = row; ; r++) {
      const line = buf.getLine(r)
      if (!line) {
        row = r + 1
        break
      }
      const wrapped = !!buf.getLine(r + 1)?.isWrapped
      text += line.translateToString(!wrapped)
      row = r + 1
      if (!wrapped) break
      offsets.push(text.length)
    }
    if (!text) continue
    const lower = text.toLowerCase()
    let idx = lower.indexOf(q)
    while (idx !== -1 && out.length < maxMatches) {
      let part = 0
      while (part < offsets.length - 1 && idx >= offsets[part + 1]) part++
      const matchRow = startRow + part
      const line = buf.getLine(matchRow)
      const col = line ? stringIndexToBufferCol(line, idx - offsets[part]) : 0
      out.push({ row: matchRow, col, text, index: idx })
      idx = lower.indexOf(q, idx + q.length)
    }
  }
  return out
}

/**
 * Highlight and scroll to one specific match via the terminal's search addon.
 * The addon starts scanning from the current selection's *start* when its
 * cached term was reset, so anchoring a 1-cell selection at the match makes
 * findNext land exactly on it (selecting it and scrolling it into view).
 */
export function selectMatch(terminalId: string, query: string, match: BufferMatch): void {
  const entry = terms.get(terminalId)
  if (!entry) return
  const { term, search } = entry
  // The buffer may have shifted since the scan (live output); clamp the anchor
  // so select() stays valid — findNext then lands on the nearest occurrence.
  const row = Math.max(0, Math.min(match.row, term.buffer.active.length - 1))
  const col = Math.max(0, Math.min(match.col, term.cols - 1))
  search.clearDecorations()
  term.clearSelection()
  term.select(col, row, 1)
  search.findNext(query)
  term.focus()
}

/**
 * Jump to the longest-waiting 'needs-attention' terminal: activate its session,
 * select its tab and put keyboard focus in it. If the currently viewed terminal
 * is itself a queue entry (e.g. the hotkey was just pressed), advance to the
 * next entry in wait order instead, wrapping around to the oldest.
 */
export function jumpToAttentionTerminal(): void {
  const st = useStore.getState()
  const queue = st.attentionQueue
  if (queue.length === 0) return
  const activeTab = st.activeId ? st.viewers[st.activeId]?.active : undefined
  const idx = queue.findIndex((e) => e.sessionId === st.activeId && e.terminalId === activeTab)
  const target = queue[(idx + 1) % queue.length] // not viewing an entry (idx -1) → oldest
  st.setActive(target.sessionId)
  st.setActiveTab(target.sessionId, target.terminalId)
  // A terminal that just became visible focuses itself; the deferred call covers
  // wrapping back onto the already-visible one (and steals focus from another
  // terminal — see the helper-textarea exception above).
  setTimeout(focusActiveTerminal, 0)
}

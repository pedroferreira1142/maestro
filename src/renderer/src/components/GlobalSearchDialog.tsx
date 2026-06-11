import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionInfo, TerminalInfo } from '../../../shared/types'
import { orderedSessions, useStore } from '../store'
import { focusActiveTerminal, searchBuffer, selectMatch, type BufferMatch } from '../termRegistry'

const MIN_QUERY = 2
const MAX_PER_TERMINAL = 50
const MAX_TOTAL = 300
const DEBOUNCE_MS = 150

interface Hit {
  session: SessionInfo
  terminal: TerminalInfo
  match: BufferMatch
}

/** Preview of the matched line: a window around the match, the hit marked. */
function Snippet({ match, length }: { match: BufferMatch; length: number }): JSX.Element {
  const start = Math.max(0, match.index - 32)
  const before = (start > 0 ? '…' : '') + match.text.slice(start, match.index)
  const hit = match.text.slice(match.index, match.index + length)
  const after = match.text.slice(match.index + length, match.index + length + 160)
  return (
    <span className="gs-snippet">
      {before}
      <mark>{hit}</mark>
      {after}
    </span>
  )
}

/**
 * Ctrl+Shift+F palette: searches the live xterm scrollback of every open
 * session's terminals at once, lists matches grouped by session; selecting a
 * match switches to that session/terminal and drives its search addon to
 * highlight and scroll to the hit.
 */
export function GlobalSearchDialog(): JSX.Element {
  const closeGlobalSearch = useStore((s) => s.closeGlobalSearch)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [searched, setSearched] = useState(false)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  // Debounced scan of every registered terminal's scrollback, session order.
  useEffect(() => {
    if (query.trim().length < MIN_QUERY) {
      setHits([])
      setSearched(false)
      setSel(0)
      return
    }
    const t = setTimeout(() => {
      const found: Hit[] = []
      for (const session of orderedSessions(useStore.getState().sessions)) {
        for (const terminal of session.terminals) {
          if (found.length >= MAX_TOTAL) break
          const cap = Math.min(MAX_PER_TERMINAL, MAX_TOTAL - found.length)
          for (const match of searchBuffer(terminal.config.id, query, cap)) {
            found.push({ session, terminal, match })
          }
        }
      }
      setHits(found)
      setSearched(true)
      setSel(0)
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  // Keep the keyboard-selected row visible.
  useEffect(() => {
    listRef.current?.querySelector('.gs-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  // Group consecutive hits by session (hits are produced in session order).
  const groups = useMemo(() => {
    const out: { session: SessionInfo; items: { hit: Hit; flatIndex: number }[] }[] = []
    hits.forEach((hit, flatIndex) => {
      const last = out[out.length - 1]
      if (last && last.session.config.id === hit.session.config.id)
        last.items.push({ hit, flatIndex })
      else out.push({ session: hit.session, items: [{ hit, flatIndex }] })
    })
    return out
  }, [hits])

  const close = (): void => {
    closeGlobalSearch()
    setTimeout(focusActiveTerminal, 0)
  }

  const jump = (hit: Hit): void => {
    const st = useStore.getState()
    st.setActive(hit.session.config.id)
    st.setActiveTab(hit.session.config.id, hit.terminal.config.id)
    closeGlobalSearch()
    // Defer until the tab switch rendered and the terminal refit, so the
    // search addon selects and scrolls while the terminal is visible.
    const { match, terminal } = hit
    const q = query
    setTimeout(() => selectMatch(terminal.config.id, q, match), 60)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (hits[sel]) jump(hits[sel])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  return (
    <div
      className="gs-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="gs-palette">
        <div className="gs-input-row">
          <input
            ref={inputRef}
            value={query}
            placeholder="Search all sessions…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {searched && (
            <span className="gs-count">
              {hits.length >= MAX_TOTAL ? `first ${MAX_TOTAL}` : hits.length}{' '}
              {hits.length === 1 ? 'match' : 'matches'}
            </span>
          )}
        </div>
        {hits.length > 0 && (
          <div className="gs-results" ref={listRef}>
            {groups.map((g) => (
              <div key={g.session.config.id}>
                <div className="gs-group-header">
                  <span
                    className="gs-dot"
                    style={{ background: g.session.config.color ?? 'var(--dim)' }}
                  />
                  <span>{g.session.config.name}</span>
                  <span className="gs-group-count">{g.items.length}</span>
                </div>
                {g.items.map(({ hit, flatIndex }) => (
                  <div
                    key={`${hit.terminal.config.id}:${hit.match.row}:${hit.match.col}`}
                    className={`gs-row${flatIndex === sel ? ' sel' : ''}`}
                    onMouseEnter={() => setSel(flatIndex)}
                    onClick={() => jump(hit)}
                  >
                    {hit.session.terminals.length > 1 && (
                      <span className="gs-term">{hit.terminal.config.title}</span>
                    )}
                    <Snippet match={hit.match} length={query.length} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {searched && hits.length === 0 && <div className="gs-empty">No matches in any session</div>}
        {!searched && (
          <div className="gs-empty">
            Type at least {MIN_QUERY} characters to search every session’s scrollback
          </div>
        )}
        <div className="gs-hint">
          <span>↑↓ navigate · Enter jump to match · Esc close</span>
        </div>
      </div>
    </div>
  )
}

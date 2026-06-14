import { useEffect, useRef, useState } from 'react'
import type { ConversationSearchHit } from '../../../shared/types'
import { useStore } from '../store'
import { focusActiveTerminal } from '../termRegistry'

const MIN_QUERY = 2
const DEBOUNCE_MS = 200

function basename(folder: string): string {
  const parts = folder.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? folder
}

/** Relative "time ago" for a last-activity timestamp (ms epoch). */
function timeAgo(at: number): string {
  if (!at) return ''
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

/** Normalize a folder path for comparison (slashes; case-insensitive on Windows). */
function normPath(p: string): string {
  const n = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return window.api.platform === 'win32' ? n.toLowerCase() : n
}

/** Snippet with the first case-insensitive occurrence of `query` highlighted. */
function Snippet({ text, query }: { text: string; query: string }): JSX.Element {
  const idx = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (idx === -1) return <span className="gs-snippet">{text}</span>
  return (
    <span className="gs-snippet">
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </span>
  )
}

/**
 * Ctrl+Shift+H palette: full-text search across every past Claude conversation
 * on disk (~/.claude/projects), newest-activity first. Selecting a hit continues
 * that conversation: if its working directory is already an open session, that
 * session is focused and its Resume picker opens (pre-highlighting the hit, so
 * it is only resumed after the user confirms); otherwise the new-session flow
 * starts for that folder, pre-selected to resume. Read-only — searching never
 * writes; continuation only happens on confirm.
 */
export function ConversationRecallDialog(): JSX.Element {
  const close = useStore((s) => s.closeHistoryRecall)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ConversationSearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  // Debounced search through main; guarded against out-of-order responses.
  useEffect(() => {
    if (query.trim().length < MIN_QUERY) {
      setHits([])
      setSearched(false)
      setSel(0)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void window.api.searchConversations(query).then((found) => {
        if (cancelled) return
        setHits(found)
        setSearched(true)
        setSel(0)
      })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  // Keep the keyboard-selected row visible.
  useEffect(() => {
    listRef.current?.querySelector('.hr-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const dismiss = (): void => {
    close()
    setTimeout(focusActiveTerminal, 0)
  }

  const choose = (hit: ConversationSearchHit): void => {
    const st = useStore.getState()
    const session = hit.cwd
      ? st.sessions.find((s) => normPath(s.config.folder) === normPath(hit.cwd))
      : undefined
    st.closeHistoryRecall()
    if (session) {
      // Folder already open: focus it and confirm via its Resume picker
      // (pre-highlighting this conversation). No terminal restart on click.
      st.setActive(session.config.id)
      st.openResumePicker(session.config.id, hit.conversationId)
    } else if (hit.cwd) {
      // No open session for this folder: start the new-session flow, pre-resumed.
      void st.resumeConversationInNewSession(hit.cwd, hit.conversationId)
    }
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
      if (hits[sel]) choose(hits[sel])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      dismiss()
    }
  }

  return (
    <div
      className="gs-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss()
      }}
    >
      <div className="gs-palette">
        <div className="gs-input-row">
          <input
            ref={inputRef}
            value={query}
            placeholder="Search all past Claude conversations…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {searched && (
            <span className="gs-count">
              {hits.length} {hits.length === 1 ? 'conversation' : 'conversations'}
            </span>
          )}
        </div>
        {hits.length > 0 && (
          <div className="gs-results" ref={listRef}>
            {hits.map((hit, i) => (
              <div
                key={hit.conversationId}
                className={`hr-row${i === sel ? ' sel' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(hit)}
              >
                <div className="hr-head">
                  <span className="hr-repo">{basename(hit.cwd) || hit.cwd || 'unknown folder'}</span>
                  <span className="hr-ago">{timeAgo(hit.lastActivityAt)}</span>
                  <span className="hr-count">
                    {hit.matchCount} {hit.matchCount === 1 ? 'match' : 'matches'}
                  </span>
                </div>
                <Snippet text={hit.snippet} query={query.trim()} />
              </div>
            ))}
          </div>
        )}
        {searched && hits.length === 0 && (
          <div className="gs-empty">No past conversation contains “{query.trim()}”</div>
        )}
        {!searched && (
          <div className="gs-empty">
            Type at least {MIN_QUERY} characters to search every past conversation
          </div>
        )}
        <div className="gs-hint">
          <span>↑↓ navigate · Enter continue conversation · Esc close</span>
        </div>
      </div>
    </div>
  )
}

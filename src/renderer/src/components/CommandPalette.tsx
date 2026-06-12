import { useEffect, useMemo, useRef, useState } from 'react'
import type { DirEntry, RepoCheckpoint } from '../../../shared/types'
import { orderedSessions, useStore } from '../store'
import { focusActiveTerminal } from '../termRegistry'
import { promptAndCheckpoint } from './GitPanel'
import { copyTranscript, exportTranscript, transcriptTarget } from '../transcript'
import { STATUS_GLYPH } from './SessionSidebar'

/** Case-insensitive subsequence ("fuzzy") match: query chars appear in order. */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let i = 0
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++
  }
  return i === q.length
}

/** Cap on files collected by the session-folder walk (huge repos stay snappy). */
const FILE_WALK_LIMIT = 4000

interface PaletteItem {
  key: string
  label: string
  /** Secondary text: 'branch → baseBranch' for tasks, the shell for actions. */
  sub?: string
  /** Live status glyph (sessions only), same mapping as the sidebar. */
  glyph?: { char: string; status: string }
  run(): void
}

interface Section {
  title: string
  items: PaletteItem[]
}

/**
 * Walk the session folder breadth-first via the explorer's readDir IPC,
 * skipping ignored directories, until the limit is hit. Returns relPaths.
 */
async function walkSessionFiles(
  sessionId: string,
  ignore: Set<string>,
  isCancelled: () => boolean
): Promise<string[] | null> {
  const out: string[] = []
  const queue: string[] = ['']
  while (queue.length > 0 && out.length < FILE_WALK_LIMIT) {
    const rel = queue.shift()!
    let entries: DirEntry[] = []
    try {
      entries = await window.api.readDir(sessionId, rel)
    } catch {
      // unreadable directory — skip it
    }
    if (isCancelled()) return null
    for (const e of entries) {
      if (e.isDir) {
        if (!ignore.has(e.name)) queue.push(e.relPath)
      } else if (out.length < FILE_WALK_LIMIT) {
        out.push(e.relPath)
      }
    }
  }
  return out
}

/**
 * The Ctrl+K command palette: fuzzy-search across sessions/tasks, saved
 * actions, and the active session's files. Mounted only while open.
 */
export function CommandPalette(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const actions = useStore((s) => s.actions)
  const viewers = useStore((s) => s.viewers)
  const recent = useStore((s) => s.recent)
  const close = useStore((s) => s.closePalette)

  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  /** Files found by walking the session folder; null until the first walk ends. */
  const [walked, setWalked] = useState<string[] | null>(null)
  /** Recent checkpoints of the active session's repo, for the Restore commands. */
  const [checkpoints, setCheckpoints] = useState<RepoCheckpoint[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Load the active repo's checkpoints once on open, for the Restore commands.
  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    void window.api.listCheckpoints(activeId).then((cps) => {
      if (!cancelled) setCheckpoints(cps)
    })
    return () => {
      cancelled = true
    }
  }, [activeId])

  // Focus the search input on open; hand focus back to the terminal on close.
  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      // Deferred so the palette is out of the DOM (and paletteOpen false)
      // before focusActiveTerminal runs its guards.
      setTimeout(focusActiveTerminal, 0)
    }
  }, [])

  // Folder walk: kicked off the first time the query reaches 2 characters,
  // then reused (filtering happens in render). Cancelled if the palette closes.
  const wantWalk = query.trim().length >= 2
  useEffect(() => {
    if (!wantWalk || walked !== null || !activeId) return
    let cancelled = false
    const ignore = new Set(useStore.getState().settings?.ignoreNames ?? [])
    void walkSessionFiles(activeId, ignore, () => cancelled).then((files) => {
      if (files) setWalked(files)
    })
    return () => {
      cancelled = true
    }
  }, [wantWalk, walked, activeId])

  const sections = useMemo<Section[]>(() => {
    const st = useStore.getState()
    const q = query.trim()
    const matches = (hay: string): boolean => q === '' || fuzzyMatch(q, hay)
    const out: Section[] = []

    const sessionItems: PaletteItem[] = []
    for (const s of orderedSessions(sessions)) {
      const wt = s.config.worktree ?? null
      const sub = wt ? `${wt.branch} → ${wt.baseBranch}` : undefined
      if (!matches(sub ? `${s.config.name} ${sub}` : s.config.name)) continue
      sessionItems.push({
        key: `session:${s.config.id}`,
        label: s.config.name,
        sub,
        glyph: { char: STATUS_GLYPH[s.status], status: s.status },
        run: () => {
          st.setActive(s.config.id)
          st.closePalette()
        }
      })
    }
    if (sessionItems.length > 0) out.push({ title: 'Sessions', items: sessionItems })

    const commandItems: PaletteItem[] = []
    const BROADCAST_LABEL = 'Broadcast prompt to sessions…'
    if (matches(BROADCAST_LABEL)) {
      commandItems.push({
        key: 'command:broadcast',
        label: BROADCAST_LABEL,
        run: () => {
          st.closePalette()
          st.openBroadcast()
        }
      })
    }
    const CHECKPOINT_LABEL = 'Checkpoint working tree…'
    if (activeId && matches(CHECKPOINT_LABEL)) {
      commandItems.push({
        key: 'command:checkpoint',
        label: CHECKPOINT_LABEL,
        sub: 'snapshot for safe restore',
        run: () => {
          st.closePalette()
          promptAndCheckpoint(activeId)
        }
      })
    }
    if (commandItems.length > 0) out.push({ title: 'Commands', items: commandItems })

    if (activeId) {
      const actionItems: PaletteItem[] = actions
        .filter((a) => matches(a.name))
        .map((a) => ({
          key: `action:${a.id}`,
          label: a.name,
          sub: a.shell === 'claude' ? 'claude prompt' : a.shell,
          run: () => {
            st.closePalette()
            void st.runAction(activeId, a.id)
          }
        }))
      if (actionItems.length > 0) out.push({ title: 'Actions', items: actionItems })

      // Transcript actions on the active session's focused terminal (falls
      // back to its first terminal when a file/diff tab is focused).
      const session = sessions.find((s) => s.config.id === activeId)
      const term = session ? transcriptTarget(session) : null
      if (term) {
        const transcriptItems: PaletteItem[] = [
          {
            key: 'transcript:export',
            label: 'Export transcript',
            sub: term.config.title,
            run: () => {
              st.closePalette()
              void exportTranscript(activeId, term.config.id)
            }
          },
          {
            key: 'transcript:copy',
            label: 'Copy transcript',
            sub: term.config.title,
            run: () => {
              st.closePalette()
              copyTranscript(term.config.id)
            }
          }
        ].filter((it) => matches(it.label))
        if (transcriptItems.length > 0) out.push({ title: 'Transcript', items: transcriptItems })
      }

      // Restore the working tree to a recent checkpoint.
      const checkpointItems: PaletteItem[] = checkpoints
        .filter((c) => matches(`restore ${c.label}`))
        .map((c) => ({
          key: `checkpoint:${c.id}`,
          label: `Restore: ${c.label}`,
          sub: new Date(c.createdAt).toLocaleString(),
          run: () => {
            st.closePalette()
            void st.restoreCheckpoint(activeId, c.id, c.label)
          }
        }))
      if (checkpointItems.length > 0) out.push({ title: 'Checkpoints', items: checkpointItems })

      // Open tabs first, then recently changed files, then walk results —
      // deduplicated; the walk only contributes once the query has 2+ chars.
      const seen = new Set<string>()
      const filePaths: string[] = []
      const push = (p: string): void => {
        if (!seen.has(p)) {
          seen.add(p)
          filePaths.push(p)
        }
      }
      for (const tab of viewers[activeId]?.tabs ?? []) push(tab)
      for (const e of recent[activeId] ?? []) push(e.relPath)
      if (q.length >= 2) for (const p of walked ?? []) push(p)
      const fileItems: PaletteItem[] = filePaths
        .filter((p) => matches(p))
        .map((p) => ({
          key: `file:${p}`,
          label: p,
          run: () => {
            st.openFile(activeId, p)
            st.closePalette()
          }
        }))
      if (fileItems.length > 0) out.push({ title: 'Files', items: fileItems })
    }
    return out
  }, [sessions, actions, viewers, recent, activeId, query, walked, checkpoints])

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections])
  const sel = flat.length === 0 ? -1 : Math.min(highlight, flat.length - 1)

  // Filtering changed the list — snap the highlight back to the top.
  useEffect(() => {
    setHighlight(0)
  }, [query])

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-palette-index="${sel}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (flat.length > 0) setHighlight((sel + 1) % flat.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length > 0) setHighlight((sel - 1 + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (sel >= 0) flat[sel].run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  let index = -1
  return (
    <div className="palette-overlay" onClick={close}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search sessions, actions, files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {/* Keep focus in the search input — a mousedown on the list must not blur it. */}
        <div className="palette-list" ref={listRef} onMouseDown={(e) => e.preventDefault()}>
          {flat.length === 0 && <div className="palette-empty">No results</div>}
          {sections.map((sec) => (
            <div className="palette-section" key={sec.title}>
              <div className="palette-section-title">{sec.title}</div>
              {sec.items.map((it) => {
                index++
                const i = index
                return (
                  <div
                    key={it.key}
                    data-palette-index={i}
                    className={`palette-item${i === sel ? ' sel' : ''}`}
                    onClick={it.run}
                  >
                    <span className={`glyph${it.glyph ? ` status-${it.glyph.status}` : ''}`}>
                      {it.glyph?.char ?? ''}
                    </span>
                    <span className="palette-label">{it.label}</span>
                    {it.sub && <span className="palette-sub">{it.sub}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

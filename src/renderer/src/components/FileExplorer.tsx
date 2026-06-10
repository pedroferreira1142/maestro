import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirEntry, SessionInfo } from '../../../shared/types'
import { fsBus } from '../fsBus'
import { useStore } from '../store'

const FLASH_MS = 8000

// Stable fallback: a selector must never return a fresh reference per call,
// or useSyncExternalStore re-renders forever (React #185).
const NO_RECENT: never[] = []

interface MenuState {
  x: number
  y: number
  relPath: string
  isDir: boolean
}

function parentOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? '' : relPath.slice(0, idx)
}

export function FileExplorer({ session }: { session: SessionInfo }): JSX.Element {
  const id = session.config.id
  const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(session.config.expandedPaths)
  )
  const [showIgnored, setShowIgnored] = useState(false)
  const [flash, setFlash] = useState<Record<string, number>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  const loadedRef = useRef(new Set<string>())
  const settings = useStore((s) => s.settings)
  const recent = useStore((s) => s.recent[id]) ?? NO_RECENT
  const openFile = useStore((s) => s.openFile)

  const ignoreSet = new Set(settings?.ignoreNames ?? [])

  const loadDir = useCallback(
    async (rel: string): Promise<void> => {
      try {
        const entries = await window.api.readDir(id, rel)
        loadedRef.current.add(rel)
        setDirs((prev) => ({ ...prev, [rel]: entries }))
      } catch {
        // folder vanished — tree row will disappear with the parent reload
      }
    },
    [id]
  )

  useEffect(() => {
    void loadDir('')
    for (const p of session.config.expandedPaths) void loadDir(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    return fsBus.on(id, (events) => {
      const reload = new Set<string>()
      const now = Date.now()
      const flashes: Record<string, number> = {}
      for (const ev of events) {
        if (ev.kind !== 'change') reload.add(parentOf(ev.relPath))
        if (ev.kind === 'change' || ev.kind === 'add') flashes[ev.relPath] = now
      }
      if (Object.keys(flashes).length) {
        setFlash((prev) => ({ ...prev, ...flashes }))
        setTimeout(() => {
          setFlash((prev) => {
            const cutoff = Date.now() - FLASH_MS
            return Object.fromEntries(Object.entries(prev).filter(([, t]) => t > cutoff))
          })
        }, FLASH_MS + 200)
      }
      for (const d of reload) {
        if (loadedRef.current.has(d)) void loadDir(d)
      }
    })
  }, [id, loadDir])

  const persistExpanded = (next: Set<string>): void => {
    void window.api.updateSession(id, { expandedPaths: [...next] })
  }

  const toggleDir = (relPath: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) {
        next.delete(relPath)
        void window.api.unwatchPath(id, relPath)
      } else {
        next.add(relPath)
        void loadDir(relPath)
        void window.api.watchPath(id, relPath)
      }
      persistExpanded(next)
      return next
    })
  }

  const copyPath = (relPath: string, absolute: boolean): void => {
    const winRel = relPath.replace(/\//g, '\\')
    window.api.clipboardWrite(absolute ? `${session.config.folder}\\${winRel}` : winRel)
  }

  const renderDir = (rel: string, depth: number): JSX.Element[] => {
    const entries = dirs[rel]
    if (!entries) {
      return [
        <div key={`${rel}/…`} className="tree-loading" style={{ paddingLeft: 12 + depth * 14 }}>
          …
        </div>
      ]
    }
    return entries
      .filter((e) => showIgnored || !ignoreSet.has(e.name))
      .map((e) => {
        const pad = 8 + depth * 14
        if (e.isDir) {
          const isOpen = expanded.has(e.relPath)
          return (
            <div key={e.relPath}>
              <div
                className="tree-row dir"
                style={{ paddingLeft: pad }}
                onClick={() => toggleDir(e.relPath)}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  setMenu({ x: ev.clientX, y: ev.clientY, relPath: e.relPath, isDir: true })
                }}
              >
                <span className="chevron">{isOpen ? '▾' : '▸'}</span>
                <span className="tree-name">{e.name}</span>
              </div>
              {isOpen && renderDir(e.relPath, depth + 1)}
            </div>
          )
        }
        const isFlash = flash[e.relPath] !== undefined
        return (
          <div
            key={e.relPath}
            className={`tree-row file${isFlash ? ' flash' : ''}`}
            style={{ paddingLeft: pad }}
            onClick={() => openFile(id, e.relPath)}
            onDoubleClick={() => void window.api.openInEditor(id, e.relPath)}
            onContextMenu={(ev) => {
              ev.preventDefault()
              setMenu({ x: ev.clientX, y: ev.clientY, relPath: e.relPath, isDir: false })
            }}
          >
            <span className="tree-name">{e.name}</span>
            {isFlash && <span className="flash-dot">⚡</span>}
          </div>
        )
      })
  }

  return (
    <div className="explorer" onClick={() => menu && setMenu(null)}>
      <div className="explorer-header">
        <span className="explorer-title" title={session.config.folder}>
          {session.config.name}
        </span>
        <button
          className={`btn ghost${showIgnored ? ' on' : ''}`}
          title={showIgnored ? 'Hide ignored folders' : 'Show ignored folders'}
          onClick={() => setShowIgnored((v) => !v)}
        >
          👁
        </button>
      </div>
      <div className="explorer-tree">{renderDir('', 0)}</div>
      {recent.length > 0 && (
        <div className="recent">
          <div className="recent-header">Recent changes</div>
          {recent.map((ev) => (
            <div
              key={ev.relPath}
              className="recent-row"
              title={ev.relPath}
              onClick={() => openFile(id, ev.relPath)}
            >
              <span className="flash-dot">⚡</span>
              <span className="recent-name">{ev.relPath.split('/').pop()}</span>
              <span className="recent-age">{Math.max(0, Math.round((Date.now() - ev.at) / 1000))}s</span>
            </div>
          ))}
        </div>
      )}
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {!menu.isDir && (
            <button onClick={() => { openFile(id, menu.relPath); setMenu(null) }}>Open</button>
          )}
          <button
            onClick={() => { void window.api.openInEditor(id, menu.relPath); setMenu(null) }}
          >
            Open in editor
          </button>
          <button
            onClick={() => { void window.api.revealInExplorer(id, menu.relPath); setMenu(null) }}
          >
            Reveal in File Explorer
          </button>
          <button onClick={() => { copyPath(menu.relPath, true); setMenu(null) }}>Copy path</button>
          <button onClick={() => { copyPath(menu.relPath, false); setMenu(null) }}>
            Copy relative path
          </button>
        </div>
      )}
    </div>
  )
}

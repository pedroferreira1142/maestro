import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { TerminalInfo } from '../../../shared/types'
import { useStore } from '../store'
import { registerTerm, unregisterTerm } from '../termRegistry'

const TERM_THEME = {
  background: '#16171a',
  foreground: '#d7d8db',
  cursor: '#d97757',
  selectionBackground: '#3b4252',
  black: '#1e2227',
  red: '#e5484d',
  green: '#4cc38a',
  yellow: '#e2b93d',
  blue: '#58a6ff',
  magenta: '#bf7af0',
  cyan: '#39c5cf',
  white: '#d7d8db',
  brightBlack: '#6e7178',
  brightRed: '#ff6369',
  brightGreen: '#3dd68c',
  brightYellow: '#f0c000',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff'
}

/**
 * With a custom background image, xterm's own background goes fully
 * transparent (#RRGGBBAA) so the image shows through the translucent
 * .term-container behind it; otherwise the usual solid dark background.
 */
function themeFor(hasBackground: boolean): typeof TERM_THEME {
  return hasBackground ? { ...TERM_THEME, background: '#16171a00' } : TERM_THEME
}

interface Props {
  sessionId: string
  terminal: TerminalInfo
  visible: boolean
}

/** Quote a path for pasting into a CLI prompt. */
function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p
}

export function TerminalHost({ sessionId, terminal, visible }: Props): JSX.Element {
  const id = terminal.config.id
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const restartTerminal = useStore((s) => s.restartTerminal)
  const attachClipboardImage = useStore((s) => s.attachClipboardImage)
  const attachDroppedFile = useStore((s) => s.attachDroppedFile)
  const settings = useStore((s) => s.settings)
  const hasBackground = useStore((s) => s.backgroundDataUrl !== null)
  const isClaude = terminal.config.kind === 'claude'

  // Paste: in claude terminals an image on the clipboard becomes an attachment
  // (saved to disk, path pasted) so the CLI can read it and the history below
  // the explorer shows it; otherwise paste the clipboard text as usual.
  const pasteSmart = async (term: Terminal): Promise<void> => {
    if (isClaude) {
      const info = await attachClipboardImage(sessionId)
      if (info) {
        term.paste(quotePath(info.absPath) + ' ')
        return
      }
    }
    const text = await window.api.clipboardRead()
    if (text) term.paste(text)
  }

  useEffect(() => {
    const term = new Terminal({
      scrollback: settings?.scrollbackLines ?? 10000,
      fontFamily: settings?.fontFamily ?? '"Cascadia Mono", Consolas, monospace',
      fontSize: settings?.fontSize ?? 14,
      cursorBlink: true,
      allowProposedApi: true,
      allowTransparency: true,
      theme: themeFor(useStore.getState().backgroundDataUrl !== null)
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.api.openExternal(uri)))
    term.open(containerRef.current!)
    termRef.current = term
    registerTerm(id, term, search)
    fitRef.current = fit
    searchRef.current = search

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      const ctrl = ev.ctrlKey
      const shift = ev.shiftKey
      const key = ev.key.toLowerCase()
      if (ctrl && shift && key === 'c') {
        const sel = term.getSelection()
        if (sel) window.api.clipboardWrite(sel)
        return false
      }
      if (ctrl && !shift && key === 'c' && term.hasSelection()) {
        window.api.clipboardWrite(term.getSelection())
        term.clearSelection()
        return false
      }
      // Plain Ctrl+V must also go through pasteSmart in claude terminals, or a
      // clipboard image would silently paste as nothing (xterm only sees text).
      // preventDefault, or Chromium's native paste would insert the text twice.
      if (ctrl && key === 'v' && (shift || isClaude)) {
        ev.preventDefault()
        void pasteSmart(term)
        return false
      }
      if (ctrl && !shift && key === 'f') {
        setShowSearch(true)
        setTimeout(() => searchInputRef.current?.focus(), 0)
        return false
      }
      // App-level shortcuts: skip xterm handling, let them bubble to the window listener.
      if (ctrl && (ev.key === 'Tab' || /^[1-9]$/.test(ev.key))) return false
      if ((ctrl || ev.metaKey) && !shift && (ev.key === '`' || ev.code === 'Backquote'))
        return false
      if (ctrl && shift && ['n', 'w', 'e', 'f'].includes(key)) return false
      if (ctrl && !shift && key === 'b') return false
      return true
    })

    term.onData((d) => window.api.ptyWrite(id, d))
    term.onResize(({ cols, rows }) => window.api.ptyResize(id, cols, rows))

    // Subscribe before attach: main only forwards live data after the attach
    // snapshot, so buffering until replay lands gives a gapless ordered stream.
    let replayed = false
    const pending: string[] = []
    const unsub = window.api.onPtyData((sid, data) => {
      if (sid !== id) return
      if (replayed) term.write(data)
      else pending.push(data)
    })
    void window.api.ptyAttach(id).then((replay) => {
      if (replay) term.write(replay)
      for (const d of pending) term.write(d)
      pending.length = 0
      replayed = true
      if (containerRef.current?.offsetParent) fit.fit()
    })

    const ro = new ResizeObserver(() => {
      // offsetParent is null while display:none — fitting then would corrupt cols/rows
      if (containerRef.current?.offsetParent) fit.fit()
    })
    ro.observe(containerRef.current!)

    return () => {
      unsub()
      ro.disconnect()
      unregisterTerm(id)
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // React to the background being set/removed while the terminal is open.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = themeFor(hasBackground)
  }, [hasBackground])

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        termRef.current?.focus()
      })
    }
  }, [visible])

  const onContextMenu = (): void => {
    const term = termRef.current
    if (!term) return
    if (term.hasSelection()) {
      window.api.clipboardWrite(term.getSelection())
      term.clearSelection()
    } else {
      void pasteSmart(term)
    }
  }

  // Dropped image files become attachments; their paths are pasted for the CLI.
  const onDrop = (ev: React.DragEvent): void => {
    ev.preventDefault()
    setDragOver(false)
    if (!isClaude) return
    const term = termRef.current
    if (!term) return
    void (async () => {
      for (const file of Array.from(ev.dataTransfer.files)) {
        const info = await attachDroppedFile(sessionId, file)
        if (info) term.paste(quotePath(info.absPath) + ' ')
      }
      term.focus()
    })()
  }

  const closeSearch = (): void => {
    setShowSearch(false)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  const ended = terminal.status === 'exited' || terminal.status === 'error'

  return (
    <div
      className={`term-wrap${dragOver && isClaude ? ' drag-over' : ''}`}
      style={{ display: visible ? 'block' : 'none' }}
      onDragOver={(ev) => {
        ev.preventDefault()
        if (isClaude) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="term-container" ref={containerRef} onContextMenu={onContextMenu} />
      {dragOver && isClaude && (
        <div className="term-drop-hint">Drop image to attach</div>
      )}
      {showSearch && (
        <div className="term-search">
          <input
            ref={searchInputRef}
            value={query}
            placeholder="Search terminal…"
            onChange={(e) => {
              setQuery(e.target.value)
              searchRef.current?.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) searchRef.current?.findPrevious(query)
              else if (e.key === 'Enter') searchRef.current?.findNext(query)
              else if (e.key === 'Escape') closeSearch()
            }}
          />
          <button className="btn ghost" onClick={closeSearch}>
            ✕
          </button>
        </div>
      )}
      {ended && (
        <div className="term-overlay">
          <div className="term-overlay-card">
            <p>
              {terminal.status === 'error'
                ? `${terminal.config.kind} failed to start`
                : `${terminal.config.kind} exited${
                    terminal.exitCode !== null ? ` (code ${terminal.exitCode})` : ''
                  }`}
            </p>
            <div className="row">
              {isClaude ? (
                <>
                  <button className="btn" onClick={() => void restartTerminal(id, 'resume')}>
                    Restart — resume conversation
                  </button>
                  <button className="btn" onClick={() => void restartTerminal(id, 'fresh')}>
                    Restart fresh
                  </button>
                </>
              ) : (
                <button className="btn" onClick={() => void restartTerminal(id, 'fresh')}>
                  Restart
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

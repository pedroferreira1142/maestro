import { useEffect } from 'react'
import { ActionDialog } from './components/ActionDialog'
import { AutoExpandDialog } from './components/AutoExpandDialog'
import { BackgroundDialog } from './components/BackgroundDialog'
import { CategoriesDialog } from './components/CategoriesDialog'
import { CommandPalette } from './components/CommandPalette'
import { FeaturesDialog } from './components/FeaturesDialog'
import { FileExplorer } from './components/FileExplorer'
import { FileViewer } from './components/FileViewer'
import { NewSessionDialog } from './components/NewSessionDialog'
import { SentinelDialog } from './components/SentinelDialog'
import { WorktreeTaskDialog } from './components/WorktreeTaskDialog'
import { SessionSidebar } from './components/SessionSidebar'
import { StatusBar } from './components/StatusBar'
import { TabStrip } from './components/TabStrip'
import { TerminalHost } from './components/TerminalHost'
import { fsBus } from './fsBus'
import { useStore } from './store'
import { focusActiveTerminal } from './termRegistry'
import type { SessionInfo } from '../../shared/types'

function defaultActive(session: SessionInfo): string {
  return session.config.activeTerminalId ?? session.terminals[0]?.config.id ?? 'terminal'
}

export default function App(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const explorerVisible = useStore((s) => s.explorerVisible)
  const viewers = useStore((s) => s.viewers)
  const epochs = useStore((s) => s.epochs)
  const settings = useStore((s) => s.settings)
  const pendingNewSession = useStore((s) => s.pendingNewSession)
  const pendingWorktree = useStore((s) => s.pendingWorktree)
  const categoriesOpen = useStore((s) => s.categoriesOpen)
  const actionEditor = useStore((s) => s.actionEditor)
  const sentinelEditor = useStore((s) => s.sentinelEditor)
  const featuresSessionId = useStore((s) => s.featuresSessionId)
  const autoExpandSessionId = useStore((s) => s.autoExpandSessionId)
  const backgroundDataUrl = useStore((s) => s.backgroundDataUrl)
  const backgroundDialogOpen = useStore((s) => s.backgroundDialogOpen)
  const paletteOpen = useStore((s) => s.paletteOpen)

  const active = sessions.find((s) => s.config.id === activeId) ?? null
  const activeViewer = activeId ? viewers[activeId] : undefined
  const activeTab =
    activeViewer?.active ?? (active ? defaultActive(active) : 'terminal')
  const activeTabIsTerminal = active?.terminals.some((t) => t.config.id === activeTab) ?? false

  useEffect(() => {
    void useStore.getState().init()
    const unsubs = [
      window.api.onSessionsChanged(() => void useStore.getState().refresh()),
      window.api.onStatusChange((id, status) => useStore.getState().applyStatus(id, status)),
      window.api.onFsEvents((id, events) => {
        fsBus.emit(id, events)
        useStore.getState().applyFsEvents(id, events)
      }),
      window.api.onSentinelRuns((id, runs) => useStore.getState().applySentinelRuns(id, runs)),
      window.api.onAutoExpandRuns((id, runs) => useStore.getState().applyAutoExpandRuns(id, runs)),
      window.api.onFocusSession((id, terminalId) => {
        const st = useStore.getState()
        st.setActive(id)
        if (terminalId) st.setActiveTab(id, terminalId)
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const st = useStore.getState()
      // Ctrl everywhere; Cmd also accepted on macOS (Cmd+Tab stays the OS's).
      const ctrl = ev.ctrlKey || (window.api.platform === 'darwin' && ev.metaKey)
      const shift = ev.shiftKey
      if (!ctrl) return
      if (ev.key === 'Tab') {
        ev.preventDefault()
        st.cycleSession(shift ? -1 : 1)
      } else if (!shift && /^[1-9]$/.test(ev.key)) {
        ev.preventDefault()
        st.jumpToSession(Number(ev.key) - 1)
      } else if (shift && ev.key.toLowerCase() === 'n') {
        ev.preventDefault()
        void st.newSession()
      } else if (shift && ev.key.toLowerCase() === 'w') {
        ev.preventDefault()
        if (st.activeId) void st.closeSession(st.activeId)
      } else if (!shift && ev.key.toLowerCase() === 't') {
        ev.preventDefault()
        if (st.activeId) void st.addTerminal(st.activeId, 'claude')
      } else if (shift && ev.key.toLowerCase() === 't') {
        ev.preventDefault()
        if (st.activeId) void st.newWorktreeTask(st.activeId)
      } else if (!shift && ev.key.toLowerCase() === 'b') {
        ev.preventDefault()
        st.toggleExplorer()
      } else if (!shift && ev.key.toLowerCase() === 'k') {
        ev.preventDefault()
        st.togglePalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    // Chromium leaves keyboard focus on whatever button/tab was last clicked,
    // so the next Space/Enter re-activates it instead of typing into the chat.
    // After any click on app chrome, hand focus back to the visible terminal.
    // Deferred so React first flushes the click's state updates (dialogs that
    // open and autofocus an input must win the focus check).
    const onClick = (): void => {
      setTimeout(focusActiveTerminal, 0)
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [])

  if (!settings) return <div className="app loading">Loading…</div>

  return (
    <div className={`app${backgroundDataUrl ? ' has-bg' : ''}`}>
      {backgroundDataUrl && (
        <div
          className="app-bg"
          style={{
            backgroundImage: `url(${backgroundDataUrl})`,
            opacity: settings.backgroundOpacity ?? 0.3
          }}
        />
      )}
      <SessionSidebar />
      {explorerVisible && active && <FileExplorer key={active.config.id} session={active} />}
      <div className="main">
        {sessions.length === 0 ? (
          <div className="welcome">
            <h1>Maestro</h1>
            <p>Run Claude Code on several repos at once — one window, zero lost context.</p>
            <button className="btn primary" onClick={() => void useStore.getState().newSession()}>
              Open a repo to start a session
            </button>
            <p className="hint">Ctrl+Shift+N · new session — Ctrl+Tab · switch — Ctrl+B · explorer</p>
          </div>
        ) : (
          <>
            {active && <TabStrip session={active} />}
            <div className="content">
              {sessions.flatMap((s) => {
                const v = viewers[s.config.id]
                const isActive = s.config.id === activeId
                const tab = v?.active ?? defaultActive(s)
                return s.terminals.map((t) => (
                  <TerminalHost
                    key={`${t.config.id}:${epochs[t.config.id] ?? 0}`}
                    sessionId={s.config.id}
                    terminal={t}
                    visible={isActive && tab === t.config.id}
                  />
                ))
              })}
              {active && !activeTabIsTerminal && (
                <FileViewer
                  key={`${active.config.id}:${activeTab}`}
                  sessionId={active.config.id}
                  relPath={activeTab}
                />
              )}
            </div>
            {active && <StatusBar session={active} />}
          </>
        )}
      </div>
      {pendingNewSession && <NewSessionDialog />}
      {pendingWorktree && <WorktreeTaskDialog />}
      {categoriesOpen && <CategoriesDialog />}
      {actionEditor && <ActionDialog />}
      {sentinelEditor && <SentinelDialog />}
      {featuresSessionId && <FeaturesDialog />}
      {autoExpandSessionId && <AutoExpandDialog />}
      {backgroundDialogOpen && <BackgroundDialog />}
      {paletteOpen && <CommandPalette />}
    </div>
  )
}

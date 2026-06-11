import { useState } from 'react'
import type { SessionInfo, SessionStatus } from '../../../shared/types'
import { orderedSessions, useStore } from '../store'
import { UsageWidget } from './UsageWidget'

const STATUS_GLYPH: Record<SessionStatus, string> = {
  starting: '◌',
  working: '⟳',
  'needs-attention': '●',
  idle: '○',
  exited: '✕',
  error: '!'
}

function SessionEntry({ session, index }: { session: SessionInfo; index: number }): JSX.Element {
  const activeId = useStore((s) => s.activeId)
  const setActive = useStore((s) => s.setActive)
  const closeSession = useStore((s) => s.closeSession)
  const categories = useStore((s) => s.categories)
  const setSessionCategory = useStore((s) => s.setSessionCategory)
  const newWorktreeTask = useStore((s) => s.newWorktreeTask)
  const mergeWorktree = useStore((s) => s.mergeWorktree)
  const removeWorktreeTask = useStore((s) => s.removeWorktreeTask)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(session.config.name)

  const id = session.config.id
  const isActive = id === activeId
  const worktree = session.config.worktree ?? null
  const category = categories.find((c) => c.id === session.config.categoryId) ?? null

  const commitRename = (): void => {
    setEditing(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== session.config.name) {
      void window.api.updateSession(id, { name: trimmed })
    } else {
      setName(session.config.name)
    }
  }

  return (
    <div
      className={`session-entry status-${session.status}${isActive ? ' active' : ''}${
        worktree ? ' worktree' : ''
      }`}
      style={session.config.color ? { borderLeftColor: session.config.color } : undefined}
      title={`${session.config.folder}\n${session.status} · Ctrl+${index + 1}`}
      onClick={() => setActive(id)}
    >
      <span className={`glyph status-${session.status}`}>{STATUS_GLYPH[session.status]}</span>
      <div className="session-meta">
        {editing ? (
          <input
            className="rename-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') {
                setName(session.config.name)
                setEditing(false)
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="session-name" onDoubleClick={() => setEditing(true)}>
            {worktree && <span className="worktree-mark">⑂ </span>}
            {session.config.name}
          </span>
        )}
        <span className="session-folder">{session.config.folder}</span>
        <div className="session-sub" onClick={(e) => e.stopPropagation()}>
          {worktree ? (
            <>
              <span className="worktree-branch" title={`${worktree.branch} → ${worktree.baseBranch}`}>
                {worktree.branch} → {worktree.baseBranch}
              </span>
              <button
                className="btn ghost merge-btn"
                title={`Merge ${worktree.branch} into ${worktree.baseBranch}`}
                onClick={() => void mergeWorktree(id)}
              >
                Merge
              </button>
            </>
          ) : (
            <span
              className="session-category"
              style={category?.color ? { color: category.color } : undefined}
            >
              <span className="cat-dot" style={{ background: category?.color ?? 'var(--dim)' }} />
              <select
                value={session.config.categoryId ?? ''}
                title="Repo category — changing it restarts the claude terminal"
                onChange={(e) => void setSessionCategory(id, e.target.value || null)}
              >
                <option value="">no category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </span>
          )}
          {session.terminals.length > 1 && (
            <span className="session-termcount">{session.terminals.length} terminals</span>
          )}
        </div>
      </div>
      {!worktree && (
        <button
          className="btn ghost fork"
          title="New parallel task (git worktree)"
          onClick={(e) => {
            e.stopPropagation()
            void newWorktreeTask(id)
          }}
        >
          ⑂
        </button>
      )}
      <button
        className="btn ghost close"
        title={worktree ? 'Remove worktree task' : 'Close session'}
        onClick={(e) => {
          e.stopPropagation()
          if (worktree) void removeWorktreeTask(id)
          else void closeSession(id)
        }}
      >
        ✕
      </button>
    </div>
  )
}

export function SessionSidebar(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const newSession = useStore((s) => s.newSession)
  const openCategories = useStore((s) => s.openCategories)
  const openFeatures = useStore((s) => s.openFeatures)
  const openAutoExpand = useStore((s) => s.openAutoExpand)
  const openBackgroundDialog = useStore((s) => s.openBackgroundDialog)
  const ordered = orderedSessions(sessions)

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>Sessions</span>
        <span className="row">
          <button
            className="btn ghost"
            title="Features & specs for the active session"
            disabled={!activeId}
            onClick={() => activeId && void openFeatures(activeId)}
          >
            ✦
          </button>
          <button
            className="btn ghost"
            title="Auto-expand features for the active session"
            disabled={!activeId}
            onClick={() => activeId && void openAutoExpand(activeId)}
          >
            ⚡
          </button>
          <button className="btn ghost" title="Background image" onClick={openBackgroundDialog}>
            ◫
          </button>
          <button className="btn ghost" title="Manage repo categories" onClick={openCategories}>
            ⚙
          </button>
          <button
            className="btn ghost"
            title="New session (Ctrl+Shift+N)"
            onClick={() => void newSession()}
          >
            ＋
          </button>
        </span>
      </div>
      <div className="sidebar-list">
        {ordered.map((s, i) => (
          <SessionEntry key={s.config.id} session={s} index={i} />
        ))}
      </div>
      <UsageWidget />
    </div>
  )
}

import { useRef, useState } from 'react'
import type { SessionInfo, SessionStatus, WorktreeMeta } from '../../../shared/types'
import { orderedSessions, useStore } from '../store'
import { UsageWidget } from './UsageWidget'

export const STATUS_GLYPH: Record<SessionStatus, string> = {
  starting: '◌',
  working: '⟳',
  'needs-attention': '●',
  idle: '○',
  exited: '✕',
  error: '!'
}

/** Max conflicted file paths listed in the badge tooltip before '+N more'. */
const TOOLTIP_FILE_CAP = 10

type ReadinessKind = 'checking' | 'unknown' | 'none' | 'clean' | 'conflicts'

/**
 * Merge-readiness badge for a worktree task: tells the outcome of the Merge
 * button before it is clicked. Reads the state the store polls/caches; a click
 * forces an immediate re-check (shown with a pulsing 'checking' appearance).
 */
function MergeBadge({ sessionId, worktree }: { sessionId: string; worktree: WorktreeMeta }): JSX.Element {
  const state = useStore((s) => s.worktreeStates[sessionId])
  const checking = useStore((s) => s.worktreeChecking[sessionId] ?? false)
  const refreshWorktreeState = useStore((s) => s.refreshWorktreeState)

  let kind: ReadinessKind
  if (!state) kind = 'checking' // first check still in flight
  else if (!state.folderExists || state.ahead < 0) kind = 'unknown'
  else if (state.ahead === 0) kind = 'none'
  else if (state.conflictFiles === null) kind = 'unknown'
  else if (state.conflictFiles.length > 0) kind = 'conflicts'
  else kind = 'clean'

  const dirty = (state?.dirty ?? 0) > 0
  const label =
    kind === 'checking'
      ? '…'
      : kind === 'unknown'
        ? 'unknown'
        : kind === 'none'
          ? 'no commits'
          : kind === 'clean'
            ? 'clean'
            : `conflicts (${state?.conflictFiles?.length ?? 0})`

  const lines: string[] = []
  if (kind === 'conflicts' && state?.conflictFiles) {
    lines.push(`Merging ${worktree.branch} into ${worktree.baseBranch} would conflict in:`)
    for (const f of state.conflictFiles.slice(0, TOOLTIP_FILE_CAP)) lines.push(`  ${f}`)
    if (state.conflictFiles.length > TOOLTIP_FILE_CAP) {
      lines.push(`  +${state.conflictFiles.length - TOOLTIP_FILE_CAP} more`)
    }
  } else if (kind === 'clean' && state) {
    lines.push(`${state.ahead} commit(s) ahead of ${worktree.baseBranch} — no conflicts predicted`)
  } else if (kind === 'none') {
    lines.push(`No commits beyond ${worktree.baseBranch} yet`)
  } else if (kind === 'unknown') {
    lines.push('Merge readiness unknown — the prediction could not be computed')
  } else {
    lines.push('Checking merge readiness…')
  }
  if (state && state.dirty > 0) {
    lines.push(`${state.dirty} uncommitted file(s) in the worktree`)
  }
  lines.push('Click to re-check')

  return (
    <button
      className={`merge-badge ${kind}${checking ? ' checking' : ''}`}
      title={lines.join('\n')}
      onClick={(e) => {
        e.stopPropagation()
        void refreshWorktreeState(sessionId)
      }}
    >
      {label}
      {dirty && <span className="merge-badge-dirty">•</span>}
    </button>
  )
}

/**
 * Popover listing a session's queued prompts, with add/delete/reorder. Fixed-
 * positioned next to its anchor button — the sidebar list scrolls, so an
 * absolutely-positioned child would be clipped.
 */
function QueuePopover({
  session,
  anchor,
  onClose
}: {
  session: SessionInfo
  anchor: DOMRect
  onClose: () => void
}): JSX.Element {
  const queueAdd = useStore((s) => s.queueAdd)
  const queueRemove = useStore((s) => s.queueRemove)
  const queueMove = useStore((s) => s.queueMove)
  const [text, setText] = useState('')

  const id = session.config.id
  const queue = session.config.promptQueue ?? []
  const top = Math.min(anchor.top, Math.max(8, window.innerHeight - 360))
  const left = anchor.right + 8

  const add = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    void queueAdd(id, trimmed)
  }

  return (
    <div
      className="queue-overlay"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="queue-popover" style={{ top, left }} onClick={(e) => e.stopPropagation()}>
        <div className="queue-popover-title">Prompt queue · {session.config.name}</div>
        <div className="queue-popover-hint">
          Sent to claude, in order, whenever it has been idle for a few seconds.
        </div>
        <div className="queue-list">
          {queue.length === 0 && <div className="queue-empty">No prompts queued.</div>}
          {queue.map((q, i) => (
            <div className="queue-item" key={q.id}>
              <span className="queue-item-pos">{i + 1}.</span>
              <span className="queue-item-text" title={q.text}>
                {q.text}
              </span>
              <button
                className="btn ghost"
                title="Move up"
                disabled={i === 0}
                onClick={() => void queueMove(id, q.id, -1)}
              >
                ↑
              </button>
              <button
                className="btn ghost"
                title="Move down"
                disabled={i === queue.length - 1}
                onClick={() => void queueMove(id, q.id, 1)}
              >
                ↓
              </button>
              <button
                className="btn ghost"
                title="Delete prompt"
                onClick={() => void queueRemove(id, q.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="queue-add-row">
          <input
            autoFocus
            placeholder="Queue a follow-up prompt…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
              if (e.key === 'Escape') onClose()
            }}
          />
          <button className="btn" disabled={!text.trim()} onClick={add}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
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
  const [queueAnchor, setQueueAnchor] = useState<DOMRect | null>(null)
  const queueBtnRef = useRef<HTMLButtonElement>(null)

  const id = session.config.id
  const isActive = id === activeId
  const worktree = session.config.worktree ?? null
  const category = categories.find((c) => c.id === session.config.categoryId) ?? null
  const queueCount = session.config.promptQueue?.length ?? 0

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
              <MergeBadge sessionId={id} worktree={worktree} />
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
      <button
        ref={queueBtnRef}
        className={`btn ghost queue-btn${queueCount > 0 ? ' has-items' : ''}`}
        title="Prompt queue — sent to claude when it goes idle"
        onClick={(e) => {
          e.stopPropagation()
          setQueueAnchor(queueBtnRef.current?.getBoundingClientRect() ?? null)
        }}
      >
        ☰{queueCount > 0 && <span className="queue-badge">{queueCount}</span>}
      </button>
      {queueAnchor && (
        <QueuePopover session={session} anchor={queueAnchor} onClose={() => setQueueAnchor(null)} />
      )}
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
  const openBroadcast = useStore((s) => s.openBroadcast)
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
          <button
            className="btn ghost"
            title="Broadcast a prompt to multiple sessions"
            onClick={openBroadcast}
          >
            ⇶
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

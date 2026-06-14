import { useEffect, useState } from 'react'
import type { ConversationSummary } from '../../../shared/types'
import { useStore } from '../store'

/** Relative "time ago" label for a conversation's last activity. */
function timeAgo(at: number): string {
  if (!at) return 'unknown'
  const secs = Math.max(0, (Date.now() - at) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(at).toLocaleDateString()
}

/** Fetch (once per folder) the prior conversations for a repo folder. */
function useConversations(folder: string): { conversations: ConversationSummary[]; loading: boolean } {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    setLoading(true)
    void window.api.listConversations(folder).then((list) => {
      if (!live) return
      setConversations(list)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [folder])
  return { conversations, loading }
}

/**
 * Lists a folder's prior conversations as clickable rows. `selectedId` (when
 * provided) highlights one; clicking a row calls `onPick(id)`. Shows a loading
 * line and an explicit empty state rather than erroring.
 */
export function ConversationList({
  folder,
  selectedId,
  onPick
}: {
  folder: string
  selectedId?: string | null
  onPick: (id: string) => void
}): JSX.Element {
  const { conversations, loading } = useConversations(folder)
  if (loading) return <div className="conv-empty">Loading past conversations…</div>
  if (conversations.length === 0) {
    return <div className="conv-empty">No past conversations for this repo.</div>
  }
  return (
    <div className="conv-list">
      {conversations.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`conv-item${selectedId === c.id ? ' sel' : ''}`}
          title={c.preview || c.id}
          onClick={() => onPick(c.id)}
        >
          <span className="conv-preview">{c.preview || '(no preview available)'}</span>
          <span className="conv-meta">
            {timeAgo(c.lastActivityAt)} · {c.messageCount} message{c.messageCount === 1 ? '' : 's'}
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * Standalone modal for an existing session's 'Resume a different conversation'
 * action. Picking a conversation respawns that session's claude on it.
 */
export function ResumePickerDialog(): JSX.Element {
  const picker = useStore((s) => s.resumePicker)!
  const close = useStore((s) => s.closeResumePicker)
  const resumeConversation = useStore((s) => s.resumeConversation)
  const session = useStore((s) => s.sessions.find((x) => x.config.id === picker.sessionId))

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Resume a different conversation</h2>
        {session && (
          <div className="modal-folder" title={picker.folder}>
            {session.config.name} · {picker.folder}
          </div>
        )}
        <div className="field-hint">
          Pick a past conversation for this repo. Its claude terminal restarts on that conversation
          ({'→'} <code>--resume</code>); the current conversation is left as-is.
        </div>
        <ConversationList
          folder={picker.folder}
          selectedId={picker.conversationId}
          onPick={(id) => void resumeConversation(picker.sessionId, id)}
        />
        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { orderedSessions, useStore } from '../store'
import { StatusIcon } from './Icon'

/**
 * Dialog that queues one prompt onto several sessions at once. Only sessions
 * with a claude terminal are listed — the prompt queue can only ever dispatch
 * to a claude tab. Sending goes through the existing per-session queue, so an
 * idle session picks the prompt up within seconds and a busy one keeps it
 * queued until its next idle (queued prompts persist like any other).
 */
export function BroadcastDialog(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const close = useStore((s) => s.closeBroadcast)
  const broadcastPrompt = useStore((s) => s.broadcastPrompt)
  const [text, setText] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const targets = useMemo(
    () =>
      orderedSessions(sessions).filter((s) =>
        s.terminals.some((t) => t.config.kind === 'claude')
      ),
    [sessions]
  )
  // Intersect with targets so stale ids (a session closed while the dialog is
  // open) never count toward — or get sent in — the broadcast.
  const selected = targets.filter((s) => checked.has(s.config.id))
  const allChecked = targets.length > 0 && selected.length === targets.length

  const toggle = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = (): void => {
    setChecked(allChecked ? new Set() : new Set(targets.map((s) => s.config.id)))
  }

  const send = (): void => {
    const trimmed = text.trim()
    if (!trimmed || selected.length === 0) return
    close()
    void broadcastPrompt(
      selected.map((s) => s.config.id),
      trimmed
    )
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        <h2>Broadcast prompt</h2>

        <div className="field">
          <span className="broadcast-list-header">
            Sessions
            <button className="btn ghost" disabled={targets.length === 0} onClick={toggleAll}>
              {allChecked ? 'Deselect all' : 'Select all'}
            </button>
          </span>
          <div className="broadcast-list">
            {targets.length === 0 && (
              <div className="broadcast-empty">No sessions with a claude terminal.</div>
            )}
            {targets.map((s) => {
              const wt = s.config.worktree ?? null
              return (
                <label className="broadcast-row" key={s.config.id}>
                  <input
                    type="checkbox"
                    checked={checked.has(s.config.id)}
                    onChange={() => toggle(s.config.id)}
                  />
                  <StatusIcon status={s.status} />
                  <span className="broadcast-name">{s.config.name}</span>
                  {wt && (
                    <span className="broadcast-sub">
                      {wt.branch} → {wt.baseBranch}
                    </span>
                  )}
                </label>
              )
            })}
          </div>
        </div>

        <label className="field">
          <span>Prompt</span>
          <textarea
            autoFocus
            rows={4}
            placeholder="Prompt to queue on every selected session…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="field-hint">
          Queued per session: an idle claude receives it within a few seconds, a busy one when it
          next sits idle.
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!text.trim() || selected.length === 0}
            onClick={send}
          >
            Send to {selected.length} session{selected.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}

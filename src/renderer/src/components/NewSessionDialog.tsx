import { useState } from 'react'
import { useStore } from '../store'
import { ConversationList } from './ResumePicker'

const COLORS = ['#d97757', '#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#e5484d']

/** Shown after a folder is picked: name, category (auto-suggested), and color. */
export function NewSessionDialog(): JSX.Element {
  const categories = useStore((s) => s.categories)
  const confirm = useStore((s) => s.confirmNewSession)
  const cancel = useStore((s) => s.cancelNewSession)
  // Mounted only while pendingNewSession is non-null, so this is safe.
  const pending = useStore.getState().pendingNewSession!

  const [name, setName] = useState(pending.defaultName)
  const [color, setColor] = useState<string | null>(null)
  const [categoryId, setCategoryId] = useState<string | null>(pending.suggestedCategoryId)
  // null = start a fresh session (the default); else resume this conversation.
  const [resumeId, setResumeId] = useState<string | null>(null)

  const submit = (): void => {
    void confirm({
      name: name.trim() || pending.defaultName,
      color,
      categoryId,
      resumeConversationId: resumeId
    })
  }

  return (
    <div className="modal-overlay" onClick={cancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New session</h2>
        <div className="modal-folder" title={pending.folder}>
          {pending.folder}
        </div>

        <label className="field">
          <span>Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') cancel()
            }}
          />
        </label>

        <label className="field">
          <span>Category</span>
          <select
            value={categoryId ?? ''}
            onChange={(e) => setCategoryId(e.target.value || null)}
          >
            <option value="">None (claude defaults)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {categoryId && pending.suggestedCategoryId === categoryId && (
          <div className="field-hint">Auto-detected from the repo contents — change if wrong.</div>
        )}

        <div className="field">
          <span>Color</span>
          <div className="swatches">
            <button
              type="button"
              className={`swatch none${color === null ? ' sel' : ''}`}
              title="No color"
              onClick={() => setColor(null)}
            />
            {COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch${color === c ? ' sel' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <div className="field">
          <span>Conversation</span>
          <button
            type="button"
            className={`conv-item conv-fresh${resumeId === null ? ' sel' : ''}`}
            onClick={() => setResumeId(null)}
          >
            <span className="conv-preview">Start a fresh conversation</span>
            <span className="conv-meta">No resume flag — claude starts clean</span>
          </button>
          <ConversationList folder={pending.folder} selectedId={resumeId} onPick={setResumeId} />
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            {resumeId ? 'Resume' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

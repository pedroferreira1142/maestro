import { useState } from 'react'
import type { Feature, FeatureStatus, Spec } from '../../../shared/types'
import { useStore } from '../store'

const STATUS_LABEL: Record<FeatureStatus, string> = {
  draft: 'Draft',
  implementing: 'Implementing',
  merged: 'Done'
}

function newSpec(text = ''): Spec {
  return { id: crypto.randomUUID(), text, done: false }
}

/**
 * One feature card: edits title/description/specs locally and persists via the
 * store on Save. "Implement" first saves the current edits, then asks Maestro to
 * spin off a worktree task session to build the specs.
 */
function FeatureCard({ feature }: { feature: Feature }): JSX.Element {
  const saveFeature = useStore((s) => s.saveFeature)
  const deleteFeature = useStore((s) => s.deleteFeature)
  const implementFeature = useStore((s) => s.implementFeature)
  const setActive = useStore((s) => s.setActive)
  const closeFeatures = useStore((s) => s.closeFeatures)
  const sessions = useStore((s) => s.sessions)

  const [title, setTitle] = useState(feature.title)
  const [description, setDescription] = useState(feature.description)
  const [specs, setSpecs] = useState<Spec[]>(feature.specs)
  const [busy, setBusy] = useState(false)

  const merged = (): Feature => ({
    ...feature,
    title: title.trim() || feature.title,
    description,
    specs: specs.filter((s) => s.text.trim()).map((s) => ({ ...s, text: s.text.trim() }))
  })

  const dirty =
    title !== feature.title ||
    description !== feature.description ||
    JSON.stringify(specs) !== JSON.stringify(feature.specs)

  const hasRealSpec = specs.some((s) => s.text.trim())
  const taskSession = feature.taskSessionId
    ? sessions.find((s) => s.config.id === feature.taskSessionId)
    : null

  const updateSpec = (id: string, patch: Partial<Spec>): void =>
    setSpecs((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const save = async (): Promise<void> => {
    setBusy(true)
    await saveFeature(merged())
    setBusy(false)
  }

  const implement = async (): Promise<void> => {
    if (!hasRealSpec) return
    if (
      feature.status === 'implementing' &&
      !window.confirm('This feature already has a task session. Spin off another one?')
    ) {
      return
    }
    setBusy(true)
    try {
      await saveFeature(merged()) // persist edits so the spec file/prompt are current
      await implementFeature(feature.id) // on success: closes the dialog, focuses new session
    } finally {
      // On success the dialog has unmounted; on failure (handled in the store) we
      // re-enable the buttons so the user can retry.
      setBusy(false)
    }
  }

  const remove = (): void => {
    if (!window.confirm(`Delete feature "${feature.title}"?`)) return
    void deleteFeature(feature.id)
  }

  const openTask = (): void => {
    if (!taskSession) return
    closeFeatures()
    setActive(taskSession.config.id)
  }

  return (
    <div className={`feature-card status-${feature.status}`}>
      <div className="feature-card-head">
        <input
          className="feature-title"
          value={title}
          placeholder="Feature title"
          onChange={(e) => setTitle(e.target.value)}
        />
        <span className={`feature-status status-${feature.status}`}>
          {STATUS_LABEL[feature.status]}
        </span>
      </div>

      <textarea
        className="feature-desc"
        rows={2}
        placeholder="What is this feature and why?"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      <div className="spec-list">
        {specs.map((spec) => (
          <div className="spec-row" key={spec.id}>
            <input
              type="checkbox"
              checked={spec.done}
              title="Mark this spec satisfied"
              onChange={(e) => updateSpec(spec.id, { done: e.target.checked })}
            />
            <input
              className="spec-text"
              value={spec.text}
              placeholder="A requirement, e.g. 'persists across restarts'"
              onChange={(e) => updateSpec(spec.id, { text: e.target.value })}
            />
            <button
              className="btn ghost"
              title="Remove spec"
              onClick={() => setSpecs((list) => list.filter((s) => s.id !== spec.id))}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="btn ghost spec-add" onClick={() => setSpecs((list) => [...list, newSpec()])}>
          ＋ Add spec
        </button>
      </div>

      <div className="feature-actions">
        <button className="btn ghost danger" onClick={remove} style={{ marginRight: 'auto' }}>
          Delete
        </button>
        {taskSession && (
          <button className="btn ghost" onClick={openTask}>
            ↪ Open task
          </button>
        )}
        <button className="btn" onClick={() => void save()} disabled={!dirty || busy}>
          Save
        </button>
        <button
          className="btn primary"
          onClick={() => void implement()}
          disabled={!hasRealSpec || busy}
          title={hasRealSpec ? 'Spin off a worktree task to build these specs' : 'Add a spec first'}
        >
          {feature.status === 'implementing' ? 'Re-implement' : 'Implement'}
        </button>
      </div>
    </div>
  )
}

/** New-feature inline form, shown at the top of the dialog. */
function NewFeature({ sessionId }: { sessionId: string }): JSX.Element {
  const saveFeature = useStore((s) => s.saveFeature)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')

  const create = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed) return
    await saveFeature({
      id: crypto.randomUUID(),
      sessionId,
      title: trimmed,
      description: '',
      specs: [],
      status: 'draft',
      taskSessionId: null,
      createdAt: Date.now()
    })
    setTitle('')
    setOpen(false)
  }

  if (!open) {
    return (
      <button className="btn primary new-feature-btn" onClick={() => setOpen(true)}>
        ＋ New feature
      </button>
    )
  }

  return (
    <div className="new-feature-row">
      <input
        autoFocus
        placeholder="Feature title, e.g. 'Dark mode toggle'"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create()
          if (e.key === 'Escape') {
            setTitle('')
            setOpen(false)
          }
        }}
      />
      <button className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <button className="btn primary" onClick={() => void create()} disabled={!title.trim()}>
        Create
      </button>
    </div>
  )
}

/**
 * Centered popup for managing a session's features and their specs. Each
 * feature can be implemented, which spins off a git-worktree sub-session whose
 * claude is auto-prompted to build the specs.
 */
export function FeaturesDialog(): JSX.Element {
  const close = useStore((s) => s.closeFeatures)
  // Mounted only while featuresSessionId is non-null, so this is safe.
  const sessionId = useStore((s) => s.featuresSessionId)!
  const features = useStore((s) => s.features)
  const session = useStore((s) => s.sessions.find((x) => x.config.id === sessionId))

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Features &amp; Specs</h2>
        <div className="field-hint">
          Plan features for <strong>{session?.config.name ?? 'this session'}</strong>. Define a
          feature and its specs, then <strong>Implement</strong> it — Maestro creates a worktree
          task session and has claude build the specs from a spec file written into it.
        </div>

        <NewFeature sessionId={sessionId} />

        <div className="feature-list">
          {features.length === 0 ? (
            <div className="feature-empty">No features yet. Create one to get started.</div>
          ) : (
            features.map((f) => <FeatureCard key={f.id} feature={f} />)
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
